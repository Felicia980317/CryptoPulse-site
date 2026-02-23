const fmt = new Intl.DateTimeFormat("zh-Hant", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

const IMPORTANCE_TEXT = { high: "高", medium: "中", low: "低" };
const STATUS_TEXT = { upcoming: "未來", recent: "近期 / 已公布" };
const COUNTRY_TEXT = { US: "美國", JP: "日本" };
const SIGNAL_CATEGORY_TEXT = { flow: "資金流", regulation: "監管", risk: "風險", macro: "宏觀", market: "市場" };
const SIGNAL_IMPACT_TEXT = { high: "高", medium: "中", low: "低" };
const UPSTASH_URL = "https://guided-spider-19708.upstash.io";
const UPSTASH_READ_TOKEN = "Akz8AAIgcDE18SAeYebRfjHOi1t_RtbOFNv2r3NHF0kLYfDIUMnEOw";
const UPSTASH_KEY = "crypto_dashboard:latest";

let dashboardData = null;
let onlyHighImpact = false;

function badgeClass(level = "low") {
  if (level === "high") return "badge high";
  if (level === "medium") return "badge medium";
  return "badge low";
}

function statusClass(status = "recent") {
  return status === "upcoming" ? "upcoming" : "recent";
}

function stripHtml(text = "") {
  return String(text).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function toTimestamp(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : -1;
}

function biasClass(text = "") {
  const t = String(text);
  if (/待確認|待公布|待判讀|判讀中|待AI評估/i.test(t)) return "bias-muted";
  if (/偏漲|偏多|上漲|多頭|\bup\b/i.test(t)) return "bias-up";
  if (/偏跌|偏空|下跌|空頭|\bdown\b/i.test(t)) return "bias-down";
  return "bias-side";
}

function biasSpan(text = "") {
  return `<span class="${biasClass(text)}">${text || "震盪"}</span>`;
}

function colorizeBiasWords(text = "") {
  return stripHtml(text)
    .replace(/待公布後判讀|待公布|待確認|待判讀|判讀中|待AI評估/g, '<span class="bias-muted">$&</span>')
    .replace(/偏漲|偏多|上漲|多頭/g, '<span class="bias-up">$&</span>')
    .replace(/偏跌|偏空|下跌|空頭/g, '<span class="bias-down">$&</span>')
    .replace(/震盪/g, '<span class="bias-side">$&</span>');
}

function toNumber(value) {
  const num = Number(String(value ?? "").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(num) ? num : null;
}

function buildRateCutOutlook(data) {
  const concrete = data.rateCutData;
  if (concrete?.mode === "concrete") {
    return {
      mode: "concrete",
      probability: Math.round(Number(concrete.nextCutProbability ?? 0)),
      monthLabel: concrete.nextMonthLabel || "待定",
      eventTitle: "聯邦基金利率路徑",
      basis: `觀測日：${concrete.observationDate ? fmt.format(new Date(concrete.observationDate)) : "未知"}`,
      sourceName: concrete.sourceName || "市場隱含機率",
      sourceUrl: concrete.sourceUrl || "",
      firstLikelyCutMonth: concrete.firstLikelyCutMonth || null,
      firstLikelyCutProbability: concrete.firstLikelyCutProbability ?? null
    };
  }

  const macroEvents = data.macroEvents || [];

  const upcomingFomc = macroEvents
    .filter((event) => event.country === "US" && event.eventType === "central-bank" && event.status === "upcoming")
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))[0] || null;

  const recentFomc = macroEvents
    .filter((event) => event.country === "US" && event.eventType === "central-bank" && event.status === "recent")
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))[0] || null;

  const recentCpi = macroEvents
    .filter((event) => event.eventType === "cpi" && event.status === "recent")
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))[0] || null;

  const recentNfp = macroEvents
    .filter((event) => event.eventType === "nfp" && event.status === "recent")
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))[0] || null;

  let score = 45;

  const recentRate = toNumber(recentFomc?.result?.actual);
  const previousRate = toNumber(recentFomc?.result?.previous);
  if (recentRate !== null && previousRate !== null) {
    if (recentRate < previousRate) score += 15;
    if (recentRate > previousRate) score -= 15;
  }

  if (recentCpi?.result?.shortTermBias === "偏漲") score += 10;
  if (recentCpi?.result?.shortTermBias === "偏跌") score -= 10;

  if (recentNfp?.result?.shortTermBias === "偏漲") score += 10;
  if (recentNfp?.result?.shortTermBias === "偏跌") score -= 10;

  const riskBear = (data.globalRiskSignals || []).filter((signal) => signal.shortTermBias === "偏跌").length;
  const riskBull = (data.globalRiskSignals || []).filter((signal) => signal.shortTermBias === "偏漲").length;
  if (riskBear > riskBull) score -= 5;
  if (riskBull > riskBear) score += 5;

  const probability = Math.max(5, Math.min(95, score));

  if (!upcomingFomc?.datetime) {
    return {
      mode: "model",
      probability,
      monthLabel: "待定",
      eventTitle: "下一次 FOMC",
      basis: "模型：FOMC/CPI/NFP/外部風險"
    };
  }

  const nextDate = new Date(upcomingFomc.datetime);
  const basis = [
    `FOMC：${recentFomc?.result?.actual || "未提供"}`,
    `CPI短線：${recentCpi?.result?.shortTermBias || "未提供"}`,
    `NFP短線：${recentNfp?.result?.shortTermBias || "未提供"}`,
    `外部風險偏向：${riskBear > riskBull ? "偏空" : riskBull > riskBear ? "偏多" : "中性"}`
  ].join(" / ");

  return {
    mode: "model",
    probability,
    monthLabel: `${nextDate.getFullYear()}年${nextDate.getMonth() + 1}月`,
    eventTitle: upcomingFomc.title,
    basis
  };
}

function probabilitySpan(probability) {
  const cls = probability >= 60 ? "bias-up" : probability <= 40 ? "bias-down" : "bias-side";
  return `<span class="${cls}">${probability}%</span>`;
}

function translateRiskText(text = "") {
  const clean = stripHtml(text)
    .replace(/\s+-\s+[^-]+$/g, "")
    .trim();

  if (/Supreme Court.*reversal.*Trump.*tariff.*clarity/i.test(clean)) {
    return "美國最高法院推翻川普關稅措施，可能讓政策方向更明確";
  }

  let translated = clean;
  const replacements = [
    [/Supreme Court/gi, "美國最高法院"],
    [/Trump(?:'s)?/gi, "川普"],
    [/tariffs?/gi, "關稅"],
    [/reversal/gi, "推翻"],
    [/could bring/gi, "可能帶來"],
    [/clarity/gi, "更明確方向"],
    [/policy/gi, "政策"],
    [/trade/gi, "貿易"],
    [/war/gi, "戰爭"],
    [/sanctions?/gi, "制裁"],
    [/interest rates?/gi, "利率"],
    [/Fed/gi, "聯準會"],
    [/FOMC/gi, "FOMC"],
    [/BOJ/gi, "日本央行"],
    [/crypto/gi, "加密市場"]
  ];

  for (const [pattern, replacement] of replacements) {
    translated = translated.replace(pattern, replacement);
  }

  return translated;
}

async function loadData() {
  const upstashResponse = await fetch(`${UPSTASH_URL}/get/${UPSTASH_KEY}`, {
    headers: {
      Authorization: `Bearer ${UPSTASH_READ_TOKEN}`
    }
  });

  if (!upstashResponse.ok) {
    throw new Error("無法從 Upstash 載入最新資料");
  }

  const payload = await upstashResponse.json();
  const result = payload?.result;

  if (typeof result === "string") {
    return JSON.parse(result);
  }

  if (result && typeof result === "object") {
    return result;
  }

  throw new Error("Upstash 回傳資料格式異常");
}

function renderMeta(data) {
  document.getElementById("meta").textContent = `最後更新：${fmt.format(new Date(data.generatedAt))}（UTC 來源整合）`;
}

function renderOverallTrend(data) {
  const el = document.getElementById("overall-trend");
  const overview = data.marketOverview || {};
  const short = overview.shortTermTrend || "待AI評估";
  const mid = overview.midTermTrend || "待AI評估";
  const long = overview.longTermTrend || "待AI評估";
  const shortReason = overview.shortTrendReason || "短線理由尚未生成";
  const midReason = overview.midTrendReason || "中線理由尚未生成";
  const longReason = overview.longTrendReason || "長線理由尚未生成";
  const external = overview.externalRiskBias || "外部風險中性";
  const model = `${overview.trendModelMeta?.mode || "fallback"}/${overview.trendModelMeta?.model || "rule-based"}`;

  el.innerHTML = `
    <h3>短/中/長線總趨勢（模型評估）</h3>
    <div class="trend-badges">
      <div>短線（1-7天）：${biasSpan(short)}</div>
      <div>中線（2-6週）：${biasSpan(mid)}</div>
      <div>長線（1-3個月）：${biasSpan(long)}</div>
    </div>
    <div class="kv">
      <div><strong>短線判斷：</strong>${colorizeBiasWords(shortReason)}</div>
      <div><strong>中線判斷：</strong>${colorizeBiasWords(midReason)}</div>
      <div><strong>長線判斷：</strong>${colorizeBiasWords(longReason)}</div>
      <div><strong>外部風險：</strong>${biasSpan(external)}</div>
      <div><strong>模型：</strong>${model}</div>
    </div>
  `;
}

function renderOverview(data) {
  const root = document.getElementById("overview-cards");
  root.innerHTML = "";

  const overview = data.marketOverview || {};
  const whale = data.whaleTrend || {};
  const nextHigh = overview.nextHighImpact;
  const rateCutOutlook = buildRateCutOutlook(data);

  const highRisk = (data.cryptoSignals || [])
    .filter((signal) => signal.impact === "high")
    .sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null;

  const latestExternal = (data.globalRiskSignals || [])
    .sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null;

  const latestExternalText = latestExternal
    ? translateRiskText(latestExternal.keyChange || latestExternal.title)
    : "目前外部風險訊號偏少";
  const latestExternalTimeText = latestExternal?.time ? fmt.format(new Date(latestExternal.time)) : "未知";

  const nextEventText = nextHigh?.datetime
    ? `${fmt.format(new Date(nextHigh.datetime))} ${nextHigh.title}`
    : "未來 7 天暫無高影響事件";

  const cards = [
    {
      title: rateCutOutlook.mode === "concrete" ? "降息機率（市場隱含）" : "降息機率（模型估算）",
      valueHtml: probabilitySpan(rateCutOutlook.probability),
      subLines: rateCutOutlook.mode === "concrete"
        ? [
          `可能時點：${rateCutOutlook.monthLabel}（${rateCutOutlook.eventTitle}）`,
          `${rateCutOutlook.basis}`,
          `來源：${rateCutOutlook.sourceName}${rateCutOutlook.firstLikelyCutMonth ? `；首次達 50% 月份：${rateCutOutlook.firstLikelyCutMonth}（${Math.round(rateCutOutlook.firstLikelyCutProbability || 0)}%）` : ""}`
        ]
        : [
          `可能時點：${rateCutOutlook.monthLabel}（${rateCutOutlook.eventTitle}）`,
          `依據：${rateCutOutlook.basis || "FOMC/CPI/NFP/外部風險"}`,
          "模型評估（非官方機率）"
        ],
      targetId: "macro-section"
    },
    {
      title: "下一個高影響事件",
      valueHtml: nextEventText,
      subLines: [nextHigh?.result?.cryptoImpact || "重點看事件前後 1-2 小時波動"],
      targetId: "macro-section"
    },
    {
      title: "高風險重點",
      valueHtml: highRisk ? stripHtml(highRisk.keyChange || highRisk.zhTitle || highRisk.title) : "目前無高風險訊號",
      subLines: highRisk ? [`短線（1-7天）：${stripHtml(highRisk.shortTermBias || "震盪")}`] : [],
      targetId: "crypto-section"
    },
    {
      title: "外部風險重點",
      valueHtml: latestExternalText,
      subLines: latestExternal
        ? [
          `時間：${latestExternalTimeText}`,
          `短線（1-7天）：${stripHtml(latestExternal.shortTermBias || "震盪")}`
        ]
        : [],
      targetId: "risk-section"
    },
    {
      title: "巨鯨風向",
      valueHtml: biasSpan(whale.trend || "中性"),
      subLines: [whale.summary || "無足夠資料"],
      targetId: "whale-section"
    }
  ];

  cards.forEach((item) => {
    const card = document.createElement("article");
    card.className = "card";
    const titleHtml = item.targetId
      ? `<h3><a class="overview-link" href="#${item.targetId}">${item.title}</a></h3>`
      : `<h3>${item.title}</h3>`;
    const valueHtml = item.targetId
      ? `<a class="overview-link metric metric-link" href="#${item.targetId}">${item.valueHtml}</a>`
      : `<div class="metric">${item.valueHtml}</div>`;
    const normalizedSubLines = Array.isArray(item.subLines)
      ? item.subLines.filter(Boolean)
      : (item.sub ? String(item.sub).split("｜").map((part) => part.trim()).filter(Boolean) : []);
    const subHtml = normalizedSubLines.length
      ? `<div class="kv">${normalizedSubLines.map((line) => `<div>${colorizeBiasWords(line)}</div>`).join("")}</div>`
      : "";
    card.innerHTML = `${titleHtml}${valueHtml}${subHtml}`;
    root.appendChild(card);
  });
}

function renderAi(data) {
  const list = document.getElementById("ai-insights");
  list.innerHTML = "";
  (data?.aiSummary?.keyInsights || []).forEach((item) => {
    const li = document.createElement("li");
    li.innerHTML = colorizeBiasWords(item);
    list.appendChild(li);
  });
}

function renderWindows(data) {
  const root = document.getElementById("key-windows");
  const note = document.getElementById("key-windows-note");
  root.innerHTML = "";

  if (!data.keyWindows || data.keyWindows.length === 0) {
    note.textContent = data.keyWindowsNote || "未來 7 天暫無高影響窗口。";
    return;
  }

  note.textContent = "";

  data.keyWindows.forEach((item) => {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3>${item.title}</h3>
      <div>${fmt.format(new Date(item.datetime))}</div>
      <div class="kv">${item.country} / ${item.why}</div>
    `;
    root.appendChild(card);
  });
}

function renderMacro(data) {
  const body = document.getElementById("macro-body");
  body.innerHTML = "";

  const now = Date.now();
  const pastWindow = 1000 * 60 * 60 * 24 * 90;
  const futureWindow = 1000 * 60 * 60 * 24 * 365;

  const visibleEvents = (data.macroEvents || []).filter((event) => {
    const t = new Date(event.datetime).getTime();
    return t >= now - pastWindow && t <= now + futureWindow;
  });

  visibleEvents.forEach((event) => {
    const hasPublished = Boolean(event.result && event.result.actual);
    const resultText = hasPublished
      ? `${event.result.actual}${event.result.unit && event.result.unit !== "-" ? ` ${event.result.unit}` : ""}`
      : "尚未公布";

    const analysisText = hasPublished ? (event.result?.analysis || "") : "等待公布後更新";

    const impactLine = hasPublished
      ? `對幣市：${event.result?.cryptoImpact || "等待補充"}｜短線：${biasSpan(event.result?.shortTermBias || "震盪")}`
      : `<span class="bias-muted">對幣市：待公布後判讀｜短線：待確認</span>`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmt.format(new Date(event.datetime))}</td>
      <td>${COUNTRY_TEXT[event.country] || event.country}</td>
      <td><a href="${event.source}" target="_blank" rel="noreferrer">${event.title}</a></td>
      <td><span class="${badgeClass(event.importance)}">${IMPORTANCE_TEXT[event.importance] || event.importance}</span></td>
      <td><span class="${statusClass(event.status)}">${STATUS_TEXT[event.status] || event.status}</span></td>
      <td>${resultText}</td>
      <td class="analysis">${analysisText}<div class="impact-inline">${impactLine}</div></td>
    `;
    body.appendChild(tr);
  });
}

function renderSignals(data) {
  const root = document.getElementById("crypto-signals");
  root.innerHTML = "";

  let signals = data.cryptoSignals || [];
  if (onlyHighImpact) signals = signals.filter((signal) => signal.impact === "high");
  signals = [...signals].sort((a, b) => toTimestamp(b.time) - toTimestamp(a.time));

  signals.forEach((signal) => {
    const summary = stripHtml(signal.zhSummary || signal.summary || "");
    const impactText = stripHtml(signal.cryptoImpact || "市場影響評估中");
    const analysisText = stripHtml(signal.cryptoAnalysis || "等待更多資料補充分析");
    const changeText = stripHtml(signal.keyChange || "關鍵變化整理中");
    const shortBias = stripHtml(signal.shortTermBias || "震盪");
    const mergedHint = Number(signal.mergedCount || 1) > 1
      ? `<div class="kv"><div>已整合同類訊息 ${signal.mergedCount} 則</div></div>`
      : "";

    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3><a href="${signal.source}" target="_blank" rel="noreferrer">${signal.zhTitle || signal.title}</a></h3>
      <div>${fmt.format(new Date(signal.time))}</div>
      <div class="kv">
        <div>分類：${SIGNAL_CATEGORY_TEXT[signal.category] || signal.category}</div>
        <div>影響：${SIGNAL_IMPACT_TEXT[signal.impact] || signal.impact}</div>
        <div>短線（1-7天）：${biasSpan(shortBias)}</div>
      </div>
      <p class="change"><strong>具體變化：</strong>${changeText}</p>
      <p>${summary}</p>
      <p class="impact"><strong>對虛擬幣影響：</strong>${impactText}</p>
      <p class="analysis-note"><strong>交易分析：</strong>${colorizeBiasWords(analysisText)}</p>
      ${mergedHint}
    `;
    root.appendChild(card);
  });
}

function renderWhale(data) {
  const root = document.getElementById("whale-trend");
  const whale = data.whaleTrend || {};
  const details = whale.details || [];

  const detailList = details.length === 0
    ? "<div class=\"kv\">近期無可用巨鯨明確紀錄。</div>"
    : `<ul class=\"whale-list\">${details
      .map((item) => `<li><div><strong>${fmt.format(new Date(item.time))}</strong></div><div>主體：${stripHtml(item.actor)}</div><div>動作：${stripHtml(item.action)}</div><div>短線（1-7天）：${biasSpan(stripHtml(item.bias || "震盪"))}</div></li>`)
      .join("")}</ul>`;

  root.innerHTML = `
    <h3>巨鯨風向：${biasSpan(whale.trend || "中性")}</h3>
    <div class="kv"><div>${whale.summary || "近期無足夠巨鯨線索"}</div></div>
    <div class="kv"><div>偏多：${whale.bull ?? 0}</div><div>偏空：${whale.bear ?? 0}</div><div>中性：${whale.neutral ?? 0}</div></div>
    ${detailList}
  `;
}

function renderGlobalRisks(data) {
  const root = document.getElementById("global-risks");
  root.innerHTML = "";

  const risks = [...(data.globalRiskSignals || [])]
    .sort((a, b) => toTimestamp(b.time) - toTimestamp(a.time))
    .slice(0, 8);
  if (risks.length === 0) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = "<h3>目前外部風險訊號偏少</h3><p>仍建議持續觀察川普政策、戰爭與制裁消息。</p>";
    root.appendChild(card);
    return;
  }

  risks.forEach((risk) => {
    const translatedChange = translateRiskText(risk.keyChange || risk.title);
    const mergedHint = Number(risk.mergedCount || 1) > 1
      ? `<div class="kv"><div>已整合同類事件 ${risk.mergedCount} 則</div></div>`
      : "";
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3><a href="${risk.source}" target="_blank" rel="noreferrer">${risk.title}</a></h3>
      <div>${fmt.format(new Date(risk.time))}</div>
      <p class="change"><strong>具體變化：</strong>${translatedChange}</p>
      <p class="impact"><strong>對虛擬幣影響：</strong>${stripHtml(risk.cryptoImpact)}</p>
      <div class="kv"><div><strong>短線（1-7天）方向：</strong>${biasSpan(stripHtml(risk.shortTermBias || "震盪"))}</div></div>
      ${mergedHint}
    `;
    root.appendChild(card);
  });
}

function renderAll(data) {
  renderMeta(data);
  renderOverallTrend(data);
  renderOverview(data);
  renderAi(data);
  renderWindows(data);
  renderMacro(data);
  renderSignals(data);
  renderWhale(data);
  renderGlobalRisks(data);
}

function bindControls() {
  const checkbox = document.getElementById("only-high-impact");
  checkbox.addEventListener("change", (event) => {
    onlyHighImpact = Boolean(event.target.checked);
    if (dashboardData) renderAll(dashboardData);
  });
}

async function bootstrap() {
  try {
    const data = await loadData();
    dashboardData = data;
    bindControls();
    renderAll(data);
  } catch (error) {
    document.body.innerHTML = `<main class="container"><h1>資料載入失敗</h1><p>${error.message}</p></main>`;
  }
}

bootstrap();
