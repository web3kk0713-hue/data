const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const SERIES_COLORS = ["#ff2670", "#7916f3", "#00a7a7", "#8a9b00", "#d56b00"];
const VENUE_ORDER = { Binance: 1, XYZ: 2, PARA: 3 };
const PAGE_SIZE = 14;
const RATE_SCALE = 1_000_000_000_000;
const METRIC_META = {
  net: {
    label: "净资费",
    summaryLabel: "区间净资费",
    definition: "净资费 = 所选区间内全部已结算费率之和。",
    direction: "ALL",
  },
  positive: {
    label: "正资费",
    summaryLabel: "区间正资费",
    definition: "正资费 = 所选区间内正费率之和。",
    direction: "POS",
  },
  negative: {
    label: "负资费",
    summaryLabel: "区间负资费",
    definition: "负资费 = 所选区间内负费率之和，并保留负号。",
    direction: "NEG",
  },
};
const PERIOD_META = {
  today: { label: "当日累计", cellPrefix: "当日" },
  all: { label: "上线以来累计", cellPrefix: "累计" },
};
const COMPARISON_VENUES = ["Binance", "XYZ"];
const COMPARISON_VENUE_META = {
  Binance: { color: "#ff2670" },
  XYZ: { color: "#7916f3" },
};
const COMPARISON_RANGE_META = {
  "24h": { label: "24小时", durationMs: 24 * 60 * 60 * 1000 },
  "7d": { label: "7天", durationMs: 7 * 24 * 60 * 60 * 1000 },
  "14d": { label: "14天", durationMs: 14 * 24 * 60 * 60 * 1000 },
  all: { label: "上线以来", durationMs: null },
  custom: { label: "自定义", durationMs: null },
};
const COMPARISON_RATE_SCALE = 1_000_000_000_000n;
const COMPARISON_YEAR_MS = 365n * 24n * 60n * 60n * 1000n;

const FUNDING_SERIES = [
  { asset: "CXMT", venue: "Binance", contract: "CXMTUSDT", listingStartMs: 1787029200000, provider: "binance" },
  { asset: "CXMT", venue: "XYZ", contract: "xyz:CXMT", listingStartMs: 1787029200000, provider: "hyperliquid" },
  { asset: "UNITREE", venue: "Binance", contract: "UNITREEUSDT", listingStartMs: 1787107500000, provider: "binance" },
  { asset: "UNITREE", venue: "XYZ", contract: "xyz:UNITREE", listingStartMs: 1787107500000, provider: "hyperliquid" },
  { asset: "UNITREE", venue: "PARA", contract: "para:UNITREE", listingStartMs: 1787107500000, provider: "hyperliquid" },
];

const CLOSED_RANGES_2026 = [
  ["2026-01-01", "2026-01-04"], ["2026-02-14", "2026-02-23"],
  ["2026-02-28", "2026-02-28"], ["2026-04-04", "2026-04-06"],
  ["2026-05-01", "2026-05-05"], ["2026-05-09", "2026-05-09"],
  ["2026-06-19", "2026-06-21"], ["2026-09-20", "2026-09-20"],
  ["2026-09-25", "2026-09-27"], ["2026-10-01", "2026-10-07"],
  ["2026-10-10", "2026-10-10"],
];

function classifyAShareSession(timestampMs) {
  // China Standard Time has no daylight-saving adjustment.
  const china = new Date(timestampMs + 8 * 60 * 60 * 1000);
  const year = china.getUTCFullYear();
  const month = String(china.getUTCMonth() + 1).padStart(2, "0");
  const day = String(china.getUTCDate()).padStart(2, "0");
  const dateText = `${year}-${month}-${day}`;
  const weekday = china.getUTCDay();
  const minute = china.getUTCHours() * 60 + china.getUTCMinutes();
  if (weekday === 0 || weekday === 6) return { code: "WEEKEND", label: "周末休市", isOpen: false };
  if (CLOSED_RANGES_2026.some(([start, end]) => start <= dateText && dateText <= end)) {
    return { code: "HOLIDAY", label: "官方休市日", isOpen: false };
  }
  if (555 <= minute && minute < 565) return { code: "OPEN_AUCTION", label: "开盘集合竞价", isOpen: true };
  if (570 <= minute && minute < 690) return { code: "CONTINUOUS_AM", label: "上午连续竞价", isOpen: true };
  if (690 <= minute && minute < 780) return { code: "MIDDAY_BREAK", label: "午间休市", isOpen: false };
  if (780 <= minute && minute < 897) return { code: "CONTINUOUS_PM", label: "下午连续竞价", isOpen: true };
  if (897 <= minute && minute < 900) return { code: "CLOSE_AUCTION", label: "收盘集合竞价", isOpen: true };
  return { code: "OFF_HOURS", label: "盘前/盘后休市", isOpen: false };
}

function chinaDateKey(timestampMs) {
  const china = new Date(Number(timestampMs) + 8 * 60 * 60 * 1000);
  const year = china.getUTCFullYear();
  const month = String(china.getUTCMonth() + 1).padStart(2, "0");
  const day = String(china.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeFundingRow(series, raw) {
  const timestampMs = Number(raw.fundingTime ?? raw.time);
  const session = classifyAShareSession(timestampMs);
  const fundingRateRaw = String(raw.fundingRate);
  return {
    timestamp_ms: timestampMs,
    timestamp: new Date(timestampMs).toISOString(),
    asset: series.asset,
    venue: series.venue,
    contract: series.contract,
    funding_rate: Number(fundingRateRaw),
    funding_rate_raw: fundingRateRaw,
    premium: raw.premium == null ? null : Number(raw.premium),
    mark_price: raw.markPrice == null ? null : Number(raw.markPrice),
    rate_type: raw.rateType ?? null,
    session: session.isOpen ? "OPEN" : "CLOSED",
    market_state: session.code,
    market_state_label: session.label,
  };
}

function addRate(left, right) {
  return Math.round((Number(left) + Number(right)) * RATE_SCALE) / RATE_SCALE;
}

async function fetchBinanceHistory(series) {
  const rows = [];
  let cursor = series.listingStartMs;
  for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
    const url = new URL("https://fapi.binance.com/fapi/v1/fundingRate");
    url.searchParams.set("symbol", series.contract);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("limit", "1000");
    const response = await fetch(url, { cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error(`Binance ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error("Binance 返回格式异常");
    rows.push(...page);
    if (!page.length || page.length < 1000) break;
    const nextCursor = Number(page.at(-1).fundingTime) + 1;
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
  }
  return rows;
}

async function fetchHyperliquidHistory(series) {
  const rows = [];
  const endTime = Date.now();
  let cursor = series.listingStartMs;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const response = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fundingHistory", coin: series.contract, startTime: cursor, endTime }),
    });
    if (!response.ok) throw new Error(`Hyperliquid ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error("Hyperliquid 返回格式异常");
    rows.push(...page);
    if (!page.length || page.length < 500) break;
    const nextCursor = Number(page.at(-1).time) + 1;
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
  }
  const unique = new Map(rows.map((row) => [`${row.coin}|${row.time}`, row]));
  return [...unique.values()].sort((a, b) => Number(a.time) - Number(b.time));
}

function summarizeRows(rows) {
  const bucket = () => ({ total: 0, open: 0, closed: 0 });
  const metrics = { positive: bucket(), negative: bucket(), net: bucket() };
  rows.forEach((row) => {
    const key = row.session === "OPEN" ? "open" : "closed";
    if (row.funding_rate > 0) {
      metrics.positive.total = addRate(metrics.positive.total, row.funding_rate);
      metrics.positive[key] = addRate(metrics.positive[key], row.funding_rate);
    } else if (row.funding_rate < 0) {
      metrics.negative.total = addRate(metrics.negative.total, row.funding_rate);
      metrics.negative[key] = addRate(metrics.negative[key], row.funding_rate);
    }
    metrics.net.total = addRate(metrics.net.total, row.funding_rate);
    metrics.net[key] = addRate(metrics.net[key], row.funding_rate);
  });
  return {
    count: rows.length,
    first_timestamp: rows[0]?.timestamp ?? null,
    last_timestamp: rows.at(-1)?.timestamp ?? null,
    metrics,
  };
}

function buildStaticPayload(records, sources) {
  const generatedAt = new Date();
  const todayDate = chinaDateKey(generatedAt.getTime());
  const ordered = [...records].sort((a, b) => a.asset.localeCompare(b.asset)
    || a.venue.localeCompare(b.venue) || a.timestamp_ms - b.timestamp_ms);
  const running = new Map();
  ordered.forEach((row) => {
    const key = `${row.asset}|${row.venue}`;
    const value = running.get(key) || { positive: 0, negative: 0, net: 0 };
    if (row.funding_rate > 0) value.positive = addRate(value.positive, row.funding_rate);
    if (row.funding_rate < 0) value.negative = addRate(value.negative, row.funding_rate);
    value.net = addRate(value.net, row.funding_rate);
    running.set(key, value);
    row.cumulative_positive = value.positive;
    row.cumulative_negative = value.negative;
    row.cumulative_net = value.net;
  });
  const assets = ["CXMT", "UNITREE"].map((asset) => {
    const configured = FUNDING_SERIES.filter((series) => series.asset === asset);
    return {
      asset,
      listing_start_ms: configured[0].listingStartMs,
      listing_start: new Date(configured[0].listingStartMs).toISOString(),
      venues: configured.map((series) => {
        const rows = ordered.filter((row) => row.asset === asset && row.venue === series.venue);
        const todayRows = rows.filter((row) => chinaDateKey(row.timestamp_ms) === todayDate);
        return {
          venue: series.venue,
          contract: series.contract,
          ...summarizeRows(rows),
          today: summarizeRows(todayRows),
        };
      }),
    };
  });
  const liveCount = sources.filter((source) => source.mode === "live").length;
  return {
    generated_at: generatedAt.toISOString(),
    mode: liveCount === sources.length ? "live" : liveCount ? "mixed" : "snapshot",
    last_record_at: ordered.length ? new Date(Math.max(...ordered.map((row) => row.timestamp_ms))).toISOString() : null,
    record_count: ordered.length,
    today_date: todayDate,
    today_record_count: ordered.filter((row) => chinaDateKey(row.timestamp_ms) === todayDate).length,
    session_definition: {
      timezone: "Asia/Shanghai",
      classification: "settlement timestamp",
      calendar: "SSE/SZSE 2026 market-level calendar",
      open: ["09:15-09:25", "09:30-11:30", "13:00-14:57", "14:57-15:00"],
      closed: ["09:25-09:30", "11:30-13:00", "15:00-09:15", "weekends", "official holidays"],
    },
    sources,
    assets,
    records: ordered,
  };
}

async function loadPublishedSnapshot() {
  const response = await fetch(`./data/funding.json?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`静态快照 ${response.status}`);
  return response.json();
}

async function loadStaticDashboard() {
  let snapshot = null;
  try { snapshot = await loadPublishedSnapshot(); } catch (_) { snapshot = null; }
  const batches = await Promise.all(FUNDING_SERIES.map(async (series) => {
    try {
      const raw = series.provider === "binance"
        ? await fetchBinanceHistory(series)
        : await fetchHyperliquidHistory(series);
      const rows = raw
        .map((row) => normalizeFundingRow(series, row))
        .filter((row) => row.timestamp_ms >= series.listingStartMs);
      if (!rows.length) throw new Error("在线源返回空记录");
      return { rows, status: { asset: series.asset, venue: series.venue, contract: series.contract, mode: "live", rows: rows.length, message: null } };
    } catch (error) {
      const rows = (snapshot?.records || []).filter((row) => row.asset === series.asset && row.venue === series.venue);
      return { rows, status: { asset: series.asset, venue: series.venue, contract: series.contract, mode: "snapshot", rows: rows.length, message: error.message } };
    }
  }));
  const records = batches.flatMap((batch) => batch.rows);
  if (!records.length) throw new Error("官方在线源不可用，且发布快照为空");
  return buildStaticPayload(records, batches.map((batch) => batch.status));
}

// Chart map: comparison = categorical magnitude; detail = ordered cumulative path.
// Both preserve exact signed values and use the same filtered record model as the table.
const state = {
  data: null,
  view: "overview",
  period: "today",
  metric: "net",
  compareAsset: "CXMT",
  compareRange: "7d",
  compareCustomStartMs: null,
  compareCustomEndMs: null,
  compareTimeDraft: false,
  compareTooltipPinned: false,
  asset: "ALL",
  venue: "ALL",
  session: "ALL",
  direction: "ALL",
  sortRate: false,
  page: 1,
  refreshSeconds: 60,
  timer: null,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatPct(value, digits = 6) {
  const number = Number(value || 0);
  if (Math.abs(number) < 1e-12) return `${(0).toFixed(digits)}%`;
  return `${number > 0 ? "+" : ""}${(number * 100).toFixed(digits)}%`;
}

function formatCompactPct(value) {
  return formatPct(value, 6);
}

let armedBar = null;
let armedBarTimer = null;

function isCoarsePointer() {
  return window.matchMedia("(hover: none), (pointer: coarse)").matches;
}

function clearArmedBar(hideTooltip = false) {
  window.clearTimeout(armedBarTimer);
  if (armedBar) armedBar.removeAttribute("data-touch-armed");
  $$('[data-bar-touch-detail]').forEach((detail) => detail.remove());
  armedBar = null;
  if (hideTooltip) hideChartTooltip();
}

function hideChartTooltip() {
  const tooltip = $("#chart-tooltip");
  tooltip.classList.remove("is-visible", "is-mobile", "is-shared");
  $$(".shared-cursor.is-visible").forEach((cursor) => cursor.classList.remove("is-visible"));
  tooltip.style.removeProperty("left");
  tooltip.style.removeProperty("right");
  tooltip.style.removeProperty("top");
  tooltip.style.removeProperty("bottom");
  tooltip.style.removeProperty("width");
  tooltip.style.removeProperty("max-width");
}

function showChartTooltip(content, event = null, anchor = null, options = {}) {
  const tooltip = $("#chart-tooltip");
  tooltip.textContent = content;
  tooltip.classList.add("is-visible");
  tooltip.classList.toggle("is-mobile", Boolean(options.mobile));
  tooltip.classList.toggle("is-shared", Boolean(options.shared));
  tooltip.style.removeProperty("left");
  tooltip.style.removeProperty("right");
  tooltip.style.removeProperty("top");
  tooltip.style.removeProperty("bottom");
  tooltip.style.removeProperty("width");
  tooltip.style.removeProperty("max-width");

  const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);
  const gap = 10;
  const viewportPadding = 8;
  const anchorRect = anchor?.getBoundingClientRect();
  const originX = event?.clientX ?? (anchorRect ? anchorRect.left + anchorRect.width / 2 : window.innerWidth / 2);
  const originY = event?.clientY ?? (anchorRect ? anchorRect.top + anchorRect.height / 2 : window.innerHeight / 2);

  let left;
  let top;
  if (options.placement === "chart" && anchorRect) {
    const chartRect = anchor.closest(".line-chart")?.getBoundingClientRect() ?? anchorRect;
    const chartWidth = Math.max(220, chartRect.width - gap * 2);
    tooltip.style.maxWidth = `${Math.min(360, chartWidth)}px`;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const cursorOnRight = originX > chartRect.left + chartRect.width / 2;
    left = cursorOnRight ? chartRect.left + gap : chartRect.right - tooltipWidth - gap;
    const minimumTop = Math.max(viewportPadding, chartRect.top + gap);
    const maximumTop = Math.min(window.innerHeight - viewportPadding - tooltipHeight, chartRect.bottom - gap - tooltipHeight);
    top = maximumTop >= minimumTop ? minimumTop : clamp(chartRect.top + gap, viewportPadding, window.innerHeight - tooltipHeight - viewportPadding);
    left = clamp(left, Math.max(viewportPadding, chartRect.left + gap), Math.min(window.innerWidth - tooltipWidth - viewportPadding, chartRect.right - tooltipWidth - gap));
  } else if (options.mobile && anchorRect) {
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    left = anchorRect.left + anchorRect.width / 2 - tooltipWidth / 2;
    const above = anchorRect.top - tooltipHeight - gap;
    const below = anchorRect.bottom + gap;
    if (above >= viewportPadding) top = above;
    else if (below + tooltipHeight <= window.innerHeight - viewportPadding) top = below;
    else top = clamp(originY - tooltipHeight / 2, viewportPadding, window.innerHeight - tooltipHeight - viewportPadding);
  } else {
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    left = originX + gap;
    top = originY + gap;
    if (left + tooltipWidth > window.innerWidth - viewportPadding) left = originX - tooltipWidth - gap;
    if (top + tooltipHeight > window.innerHeight - viewportPadding) top = originY - tooltipHeight - gap;
  }

  tooltip.style.left = `${clamp(left, viewportPadding, window.innerWidth - tooltip.offsetWidth - viewportPadding)}px`;
  tooltip.style.top = `${clamp(top, viewportPadding, window.innerHeight - tooltip.offsetHeight - viewportPadding)}px`;
}

function beijingDate(value, includeSeconds = false) {
  if (!value) return "—";
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined,
    hour12: false,
  }).format(date).replaceAll("/", "-");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function setLoading(loading) {
  const button = $("#refresh-button");
  button.disabled = loading;
  button.classList.toggle("is-loading", loading);
}

function setConnectionState(kind, label, timeLabel) {
  $("#freshness-label").textContent = label;
  $("#freshness-time").textContent = timeLabel;
  $("#sidebar-status").textContent = label;
  [$("#top-status-dot"), $("#sidebar-status-dot")].forEach((dot) => {
    dot.className = "status-dot";
    if (kind) dot.classList.add(`is-${kind}`);
  });
}

async function loadDashboard(force = false) {
  setLoading(true);
  if (!state.data) setConnectionState("", "正在连接", "获取 Binance 与 Hyperliquid");
  try {
    state.data = await loadStaticDashboard();
    renderAll();
    const modeLabel = state.data.mode === "live" ? "在线数据" : state.data.mode === "mixed" ? "部分在线" : "快照回退";
    setConnectionState(
      state.data.mode === "live" ? "live" : state.data.mode === "mixed" ? "mixed" : "error",
      modeLabel,
      `最近结算 ${beijingDate(state.data.last_record_at)}`,
    );
    $("#footer-status").textContent = `${modeLabel} · 生成于 ${beijingDate(state.data.generated_at, true)}`;
    if (force) showToast(`已刷新：${modeLabel}`);
  } catch (error) {
    setConnectionState("error", "连接失败", error.message);
    $("#comparison-summary").innerHTML = "";
    $("#comparison-chart-stage").innerHTML = `<div class="chart-empty">${escapeHtml(error.message)}<br />请检查网络，或等待 GitHub 快照恢复。</div>`;
    showToast(error.message);
  } finally {
    setLoading(false);
  }
}

function renderAll() {
  if (!state.data) return;
  renderOverview();
  renderDetails();
  $("#source-status-list").innerHTML = state.data.sources.map((source) => `<span class="source-chip is-${escapeHtml(source.mode)}" title="${escapeHtml(source.message || "在线源正常")}"><i></i>${escapeHtml(source.asset)} · ${escapeHtml(source.venue)} · ${source.mode === "live" ? "在线" : "快照"}</span>`).join("");
}

function flattenSummaries() {
  return state.data.assets.flatMap((asset) =>
    asset.venues.map((venue) => ({ asset: asset.asset, listing_start: asset.listing_start, ...venue })),
  );
}

function emptySummary() {
  const bucket = () => ({ total: 0, open: 0, closed: 0 });
  return { count: 0, first_timestamp: null, last_timestamp: null, metrics: { positive: bucket(), negative: bucket(), net: bucket() } };
}

function activeVenueSummary(venue) {
  return state.period === "today" ? (venue.today || emptySummary()) : venue;
}

function activeMetricLabel(metric = state.metric) {
  return `${PERIOD_META[state.period].label}${METRIC_META[metric].label}`;
}

function activeRecordCount() {
  if (state.period === "all") return state.data.record_count;
  return state.data.today_record_count ?? state.data.records.filter((row) => chinaDateKey(row.timestamp_ms) === state.data.today_date).length;
}

function comparisonRoundDiv(numerator, denominator) {
  if (denominator === 0n) return 0n;
  const negative = (numerator < 0n) !== (denominator < 0n);
  const left = numerator < 0n ? -numerator : numerator;
  const right = denominator < 0n ? -denominator : denominator;
  const rounded = (left + right / 2n) / right;
  return negative ? -rounded : rounded;
}

function comparisonDecimalToUnits(value) {
  const text = String(value ?? "0").trim();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!match) throw new Error(`无法解析资金费率：${text}`);
  const sign = match[1] === "-" ? -1n : 1n;
  const integer = match[2];
  const fraction = match[3] || "";
  const exponent = Number(match[4] || 0);
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const decimalPlaces = fraction.length - exponent;
  const units = decimalPlaces <= 12
    ? BigInt(digits) * 10n ** BigInt(12 - decimalPlaces)
    : comparisonRoundDiv(BigInt(digits), 10n ** BigInt(decimalPlaces - 12));
  return sign * units;
}

function comparisonFormatUnitsPct(units, decimals = 6) {
  const displayScale = 10n ** BigInt(decimals);
  const scaled = comparisonRoundDiv(units * 100n * displayScale, COMPARISON_RATE_SCALE);
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const whole = absolute / displayScale;
  const fraction = String(absolute % displayScale).padStart(decimals, "0");
  const sign = negative ? "-" : scaled > 0n ? "+" : "";
  return `${sign}${whole}.${fraction}%`;
}

function comparisonFormatPp(units) {
  return comparisonFormatUnitsPct(units).replace("%", " pp");
}

function comparisonUnitsToNumber(units) {
  return Number(units) / Number(COMPARISON_RATE_SCALE);
}

function comparisonValueClass(units) {
  if (units > 0n) return "is-positive";
  if (units < 0n) return "is-negative";
  return "";
}

function comparisonAnnualizedAt(units, startMs, timestampMs, eventCount) {
  const durationMs = timestampMs - startMs;
  if (durationMs <= 0 || eventCount < 1) return null;
  return comparisonRoundDiv(units * COMPARISON_YEAR_MS, BigInt(Math.round(durationMs)));
}

function beijingDateTimeInput(timestampMs) {
  const china = new Date(timestampMs + 8 * 60 * 60 * 1000);
  const year = china.getUTCFullYear();
  const month = String(china.getUTCMonth() + 1).padStart(2, "0");
  const day = String(china.getUTCDate()).padStart(2, "0");
  const hour = String(china.getUTCHours()).padStart(2, "0");
  const minute = String(china.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function parseBeijingDateTime(value, inclusiveEnd = false) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0"] = match;
  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second));
  return Number.isFinite(timestamp) ? timestamp + (inclusiveEnd ? 999 : 0) : null;
}

function comparisonSourceFor(venue) {
  return state.data.sources.find((source) => source.asset === state.compareAsset && source.venue === venue) || null;
}

function comparisonDataBounds() {
  const venueBounds = COMPARISON_VENUES.map((venue) => {
    const rows = state.data.records
      .filter((row) => row.asset === state.compareAsset && row.venue === venue)
      .sort((left, right) => left.timestamp_ms - right.timestamp_ms);
    return { first: rows[0]?.timestamp_ms, last: rows.at(-1)?.timestamp_ms };
  });
  const availableBounds = venueBounds.filter((bound) => Number.isFinite(bound.first) && Number.isFinite(bound.last));
  if (!availableBounds.length) return null;
  const listingStart = FUNDING_SERIES.find((series) => series.asset === state.compareAsset)?.listingStartMs;
  return {
    first: Number.isFinite(listingStart) ? listingStart : Math.min(...availableBounds.map((bound) => bound.first)),
    last: Math.max(...availableBounds.map((bound) => bound.last)),
  };
}

function comparisonWindow() {
  const bounds = comparisonDataBounds();
  if (!bounds) return null;
  let start = bounds.first;
  let end = bounds.last;
  if (state.compareRange === "custom") {
    start = Math.max(bounds.first, state.compareCustomStartMs ?? bounds.first);
    end = Math.min(bounds.last, state.compareCustomEndMs ?? bounds.last);
  } else {
    const duration = COMPARISON_RANGE_META[state.compareRange].durationMs;
    if (duration != null) start = Math.max(bounds.first, end - duration);
  }
  if (start >= end) return null;
  return { start, end, hours: (end - start) / 3_600_000 };
}

function buildComparisonSeries(venue, selectedWindow) {
  const allRows = state.data.records
    .filter((row) => row.asset === state.compareAsset
      && row.venue === venue)
    .sort((left, right) => left.timestamp_ms - right.timestamp_ms);
  const available = allRows.length > 0;
  const rows = allRows.filter((row) => row.timestamp_ms >= selectedWindow.start
    && row.timestamp_ms <= selectedWindow.end);
  let positive = 0n;
  let negative = 0n;
  let net = 0n;
  let count = 0;
  let lastSettlementMs = null;
  const points = available
    ? [{ timestamp_ms: selectedWindow.start, positive, negative, net, count, lastSettlementMs, event: null }]
    : [];
  rows.forEach((row) => {
    const rateUnits = comparisonDecimalToUnits(row.funding_rate_raw ?? row.funding_rate);
    if (rateUnits > 0n) positive += rateUnits;
    if (rateUnits < 0n) negative += rateUnits;
    net += rateUnits;
    count += 1;
    lastSettlementMs = row.timestamp_ms;
    points.push({ timestamp_ms: row.timestamp_ms, positive, negative, net, count, lastSettlementMs, event: row });
  });
  if (available && points.at(-1).timestamp_ms < selectedWindow.end) {
    points.push({ timestamp_ms: selectedWindow.end, positive, negative, net, count, lastSettlementMs, event: null, extension: true });
  }
  const selectedUnits = available ? { positive, negative, net }[state.metric] : null;
  return {
    venue,
    color: COMPARISON_VENUE_META[venue].color,
    available,
    rows,
    points,
    positive,
    negative,
    net,
    selectedUnits,
    annualizedUnits: available ? comparisonAnnualizedAt(selectedUnits, selectedWindow.start, selectedWindow.end, count) : null,
    latest: rows.at(-1) || null,
    source: comparisonSourceFor(venue),
  };
}

function currentComparisonView() {
  const selectedWindow = comparisonWindow();
  if (!selectedWindow) return null;
  return { window: selectedWindow, series: COMPARISON_VENUES.map((venue) => buildComparisonSeries(venue, selectedWindow)) };
}

function renderComparisonSummary(view) {
  const summaryHtml = (series) => {
    if (!series.available) {
      return `<article class="venue-summary is-unavailable" style="--venue-color:${series.color}">
        <div class="venue-identity">
          <div class="venue-name"><i></i><strong>${series.venue}</strong></div>
          <small>暂无可用结算数据</small>
        </div>
        <div class="summary-metric"><span>${METRIC_META[state.metric].summaryLabel}</span><strong>—</strong></div>
        <div class="summary-metric"><span>年化</span><strong>—</strong></div>
      </article>`;
    }
    const latestLabel = series.latest
      ? `${series.rows.length} 次 · 最新 ${beijingDate(series.latest.timestamp_ms)}`
      : "区间内未结算";
    const annualized = series.annualizedUnits == null ? "—" : comparisonFormatUnitsPct(series.annualizedUnits, 2);
    return `<article class="venue-summary" style="--venue-color:${series.color}">
      <div class="venue-identity">
        <div class="venue-name"><i></i><strong>${series.venue}</strong></div>
        <small>${latestLabel}</small>
      </div>
      <div class="summary-metric">
        <span>${METRIC_META[state.metric].summaryLabel}</span>
        <strong class="${comparisonValueClass(series.selectedUnits)}">${comparisonFormatUnitsPct(series.selectedUnits)}</strong>
        <small>${beijingDate(view.window.start)} 起</small>
      </div>
      <div class="summary-metric">
        <span>年化</span>
        <strong class="${series.annualizedUnits == null ? "" : comparisonValueClass(series.annualizedUnits)}">${annualized}</strong>
      </div>
    </article>`;
  };
  const [binance, xyz] = view.series;
  const spread = binance.available && xyz.available ? xyz.selectedUnits - binance.selectedUnits : null;
  $("#comparison-summary").innerHTML = `${summaryHtml(binance)}
    <div class="spread-summary">
      <span>XYZ − Binance</span>
      <strong class="${spread == null ? "" : comparisonValueClass(spread)}">${spread == null ? "—" : comparisonFormatPp(spread)}</strong>
    </div>
    ${summaryHtml(xyz)}`;
}

function comparisonNiceDomain(values) {
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) {
    min -= 0.00001;
    max += 0.00001;
  }
  const span = max - min;
  return { min: min - span * 0.09, max: max + span * 0.09 };
}

function comparisonLinePath(points, metric, x, y) {
  const coordinates = points.map((point) => ({
    x: x(point.timestamp_ms),
    y: y(comparisonUnitsToNumber(point[metric])),
  }));
  if (!coordinates.length) return "";
  if (coordinates.length === 1) return `M${coordinates[0].x.toFixed(2)},${coordinates[0].y.toFixed(2)}`;

  const intervals = coordinates.slice(1).map((point, index) => point.x - coordinates[index].x);
  const secants = coordinates.slice(1).map((point, index) => (point.y - coordinates[index].y) / intervals[index]);
  const slopes = new Array(coordinates.length);
  slopes[0] = secants[0];
  slopes[slopes.length - 1] = secants.at(-1);
  for (let index = 1; index < coordinates.length - 1; index += 1) {
    const previous = secants[index - 1];
    const next = secants[index];
    if (previous === 0 || next === 0 || Math.sign(previous) !== Math.sign(next)) {
      slopes[index] = 0;
      continue;
    }
    const previousInterval = intervals[index - 1];
    const nextInterval = intervals[index];
    const previousWeight = 2 * nextInterval + previousInterval;
    const nextWeight = nextInterval + 2 * previousInterval;
    slopes[index] = (previousWeight + nextWeight) / (previousWeight / previous + nextWeight / next);
  }

  const commands = [`M${coordinates[0].x.toFixed(2)},${coordinates[0].y.toFixed(2)}`];
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const current = coordinates[index];
    const next = coordinates[index + 1];
    const interval = intervals[index];
    commands.push(`C${(current.x + interval / 3).toFixed(2)},${(current.y + slopes[index] * interval / 3).toFixed(2)} ${(next.x - interval / 3).toFixed(2)},${(next.y - slopes[index + 1] * interval / 3).toFixed(2)} ${next.x.toFixed(2)},${next.y.toFixed(2)}`);
  }
  return commands.join(" ");
}

function comparisonCarryPath(point, end, metric, x, y) {
  if (!point || point.timestamp_ms >= end) return "";
  return `M${x(point.timestamp_ms).toFixed(2)},${y(comparisonUnitsToNumber(point[metric])).toFixed(2)} H${x(end).toFixed(2)}`;
}

function comparisonPlaceEndLabels(series, metric, y, top, bottom) {
  const labels = series.map((item) => ({ item, y: y(comparisonUnitsToNumber(item.points.at(-1)[metric])) }));
  labels.sort((left, right) => left.y - right.y);
  const minimumGap = 25;
  labels.forEach((label, index) => {
    label.labelY = Math.max(top + 12, label.y);
    if (index > 0) label.labelY = Math.max(label.labelY, labels[index - 1].labelY + minimumGap);
  });
  for (let index = labels.length - 1; index >= 0; index -= 1) {
    const maximumY = bottom - 12 - (labels.length - 1 - index) * minimumGap;
    labels[index].labelY = Math.min(labels[index].labelY, maximumY);
  }
  return labels;
}

function latestComparisonPointAt(points, timestamp) {
  let low = 0;
  let high = points.length - 1;
  let found = points[0];
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].timestamp_ms <= timestamp) {
      found = points[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function nearestComparisonIndex(timeline, target) {
  let low = 0;
  let high = timeline.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (timeline[middle] < target) low = middle + 1;
    else high = middle;
  }
  if (low > 0 && Math.abs(timeline[low - 1] - target) <= Math.abs(timeline[low] - target)) return low - 1;
  return low;
}

function positionComparisonTooltip(tooltip, event, anchor) {
  const viewportGap = 12;
  const anchorRect = anchor.getBoundingClientRect();
  const pointX = event?.clientX ?? (anchorRect.left + anchorRect.width * 0.62);
  const pointY = event?.clientY ?? (anchorRect.top + 28);
  let left = pointX + 14;
  let top = pointY + 14;
  const rect = tooltip.getBoundingClientRect();
  if (left + rect.width > window.innerWidth - viewportGap) left = pointX - rect.width - 14;
  if (top + rect.height > window.innerHeight - viewportGap) top = pointY - rect.height - 14;
  tooltip.style.left = `${Math.max(viewportGap, Math.min(left, window.innerWidth - rect.width - viewportGap))}px`;
  tooltip.style.top = `${Math.max(viewportGap, Math.min(top, window.innerHeight - rect.height - viewportGap))}px`;
}

function showComparisonTooltip(timestamp, observations, event, anchor, selectedWindow) {
  const tooltip = $("#comparison-tooltip");
  const spread = observations.length === 2 ? observations[1].units - observations[0].units : null;
  tooltip.innerHTML = `<div class="comparison-tooltip-time">${beijingDate(timestamp, true)}</div>
    ${observations.map(({ series, point, units }) => {
      const annualized = comparisonAnnualizedAt(units, selectedWindow.start, timestamp, point.count);
      return `<div class="comparison-tooltip-row" style="--row-color:${series.color}">
        <i></i><div class="comparison-tooltip-venue"><span>${series.venue}</span></div>
        <strong>${comparisonFormatUnitsPct(units)}</strong>
        <small class="comparison-tooltip-apr">年化 ${annualized == null ? "—" : comparisonFormatUnitsPct(annualized, 2)}</small>
      </div>`;
    }).join("")}
    ${spread == null ? "" : `<div class="comparison-tooltip-spread"><span>XYZ − Binance</span><strong>${comparisonFormatPp(spread)}</strong></div>`}`;
  tooltip.classList.add("is-visible");
  positionComparisonTooltip(tooltip, event, anchor);
}

function hideComparisonTooltip(cursor = null) {
  $("#comparison-tooltip").classList.remove("is-visible");
  cursor?.classList.remove("is-visible");
}

function bindComparisonChartInteractions({ container, view, timeline, x, y }) {
  const overlay = $("[data-comparison-overlay]", container);
  const cursor = $("[data-comparison-cursor]", container);
  const crosshair = $(".comparison-chart-crosshair", cursor);
  const markerLayer = $("[data-comparison-markers]", cursor);
  let keyboardIndex = timeline.length - 1;
  let pressTimer = null;
  let touchGesture = null;
  let touchFrame = null;
  let pendingTouchPoint = null;
  let suppressNextClick = false;

  const show = (timestamp, event = null, pin = false) => {
    const cursorX = x(timestamp);
    crosshair.setAttribute("x1", cursorX);
    crosshair.setAttribute("x2", cursorX);
    const observations = view.series.filter((series) => series.available).map((series) => {
      const point = latestComparisonPointAt(series.points, timestamp);
      return { series, point, units: point[state.metric] };
    });
    markerLayer.innerHTML = observations.map(({ series, point }) => `<circle class="comparison-shared-marker" cx="${cursorX}" cy="${y(comparisonUnitsToNumber(point[state.metric]))}" r="4" fill="${series.color}" />`).join("");
    cursor.classList.add("is-visible");
    keyboardIndex = timeline.indexOf(timestamp);
    overlay.setAttribute("aria-valuenow", String(keyboardIndex));
    overlay.setAttribute("aria-valuetext", observations.map(({ series, units }) => `${series.venue} ${comparisonFormatUnitsPct(units)}`).join("；"));
    showComparisonTooltip(timestamp, observations, event, overlay, view.window);
    if (pin) state.compareTooltipPinned = true;
  };

  const timestampFromPointer = (event) => {
    const rect = overlay.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    return timeline[nearestComparisonIndex(timeline, view.window.start + ratio * (view.window.end - view.window.start))];
  };

  const clearPressTimer = () => {
    window.clearTimeout(pressTimer);
    pressTimer = null;
  };

  const clearTouchFrame = () => {
    if (touchFrame != null) window.cancelAnimationFrame(touchFrame);
    touchFrame = null;
    pendingTouchPoint = null;
  };

  const scheduleTouchShow = (event) => {
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const latest = coalesced.length ? coalesced[coalesced.length - 1] : event;
    pendingTouchPoint = { clientX: latest.clientX, clientY: latest.clientY };
    if (touchFrame != null) return;
    touchFrame = window.requestAnimationFrame(() => {
      const point = pendingTouchPoint;
      touchFrame = null;
      pendingTouchPoint = null;
      if (!point || !touchGesture?.scrubbing) return;
      show(timestampFromPointer(point), point, true);
    });
  };

  const resetTouchGesture = () => {
    clearPressTimer();
    clearTouchFrame();
    try {
      if (touchGesture && overlay.hasPointerCapture(touchGesture.pointerId)) overlay.releasePointerCapture(touchGesture.pointerId);
    } catch (_) {
      // Synthetic test events may not create pointer capture.
    }
    overlay.classList.remove("is-scrubbing");
    container.classList.remove("is-scrubbing");
    touchGesture = null;
  };

  const finishTouchGesture = (event = null) => {
    const wasScrubbing = Boolean(touchGesture?.scrubbing);
    if (wasScrubbing && event) show(timestampFromPointer(event), event, true);
    if (wasScrubbing) {
      suppressNextClick = true;
      window.setTimeout(() => { suppressNextClick = false; }, 650);
    }
    resetTouchGesture();
  };

  const cancelTouchGesture = () => {
    resetTouchGesture();
    suppressNextClick = false;
    state.compareTooltipPinned = false;
    hideComparisonTooltip(cursor);
  };

  overlay.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    clearPressTimer();
    touchGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      scrubbing: false,
    };
    pressTimer = window.setTimeout(() => {
      if (!touchGesture || touchGesture.pointerId !== event.pointerId) return;
      touchGesture.scrubbing = true;
      state.compareTooltipPinned = true;
      overlay.classList.add("is-scrubbing");
      container.classList.add("is-scrubbing");
      try { overlay.setPointerCapture(event.pointerId); } catch (_) { /* Pointer capture is progressive enhancement. */ }
      const point = { clientX: touchGesture.lastX, clientY: touchGesture.lastY };
      show(timestampFromPointer(point), point, true);
    }, 300);
  });

  overlay.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch" && touchGesture?.pointerId === event.pointerId) {
      touchGesture.lastX = event.clientX;
      touchGesture.lastY = event.clientY;
      if (!touchGesture.scrubbing) {
        const deltaX = Math.abs(event.clientX - touchGesture.startX);
        const deltaY = Math.abs(event.clientY - touchGesture.startY);
        const verticalScrollIntent = deltaY > 8 && deltaY > deltaX * 1.2;
        const leftLongPressArea = Math.hypot(deltaX, deltaY) > 18;
        if (verticalScrollIntent || leftLongPressArea) {
          cancelTouchGesture();
        }
        return;
      }
      event.preventDefault();
      scheduleTouchShow(event);
      return;
    }
    if (event.pointerType !== "touch" && !state.compareTooltipPinned) show(timestampFromPointer(event), event, false);
  });
  overlay.addEventListener("pointerup", (event) => {
    if (event.pointerType === "touch" && touchGesture?.pointerId === event.pointerId) finishTouchGesture(event);
  });
  overlay.addEventListener("pointercancel", (event) => {
    if (event.pointerType !== "touch" || touchGesture?.pointerId !== event.pointerId) return;
    cancelTouchGesture();
  });
  overlay.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "touch" && !state.compareTooltipPinned) hideComparisonTooltip(cursor);
  });
  overlay.addEventListener("click", (event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      return;
    }
    state.compareTooltipPinned = !state.compareTooltipPinned;
    show(timestampFromPointer(event), event, state.compareTooltipPinned);
  });
  overlay.addEventListener("focus", () => show(timeline[keyboardIndex], null, false));
  overlay.addEventListener("blur", () => {
    if (!state.compareTooltipPinned) hideComparisonTooltip(cursor);
  });
  overlay.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") {
      state.compareTooltipPinned = false;
      hideComparisonTooltip(cursor);
      return;
    }
    keyboardIndex = Math.max(0, Math.min(timeline.length - 1, keyboardIndex + (event.key === "ArrowRight" ? 1 : -1)));
    show(timeline[keyboardIndex], null, false);
  });
}

function renderComparisonChart(view) {
  const container = $("#comparison-chart-stage");
  const availableSeries = view.series.filter((series) => series.available && series.points.length > 0);
  if (!availableSeries.length || availableSeries.every((series) => series.rows.length === 0)) {
    container.innerHTML = '<div class="chart-empty">所选时间范围暂无结算记录。</div>';
    $("#latest-key").classList.remove("is-live");
    $("#latest-key-label").textContent = "暂无结算";
    return;
  }
  const width = Math.max(280, Math.round(container.clientWidth || 1100));
  const compact = width < 680;
  const height = compact ? 380 : 450;
  const margin = compact
    ? { top: 24, right: 22, bottom: 38, left: width < 320 ? 62 : 70 }
    : { top: 26, right: 126, bottom: 42, left: 88 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const { start, end } = view.window;
  const values = availableSeries.flatMap((series) => series.points.map((point) => comparisonUnitsToNumber(point[state.metric])));
  const domain = comparisonNiceDomain(values);
  const x = (timestamp) => margin.left + (timestamp - start) / (end - start) * plotWidth;
  const y = (value) => margin.top + (domain.max - value) / (domain.max - domain.min) * plotHeight;
  const tickValues = Array.from({ length: 5 }, (_, index) => domain.min + (domain.max - domain.min) * index / 4);
  const grids = tickValues.map((tick) => `<line class="comparison-chart-grid" x1="${margin.left}" y1="${y(tick)}" x2="${width - margin.right}" y2="${y(tick)}" />
    <text class="comparison-chart-axis" x="${margin.left - 11}" y="${y(tick) + 3}" text-anchor="end">${comparisonFormatUnitsPct(BigInt(Math.round(tick * Number(COMPARISON_RATE_SCALE))), 6)}</text>`).join("");
  const zeroLine = domain.min <= 0 && domain.max >= 0
    ? `<line class="comparison-chart-zero" x1="${margin.left}" y1="${y(0)}" x2="${width - margin.right}" y2="${y(0)}" />`
    : "";
  const bounds = comparisonDataBounds();
  const reachesLatest = Boolean(bounds && view.window.end === bounds.last);
  const latestVisibleTimestamp = Math.max(...availableSeries.map((series) => series.latest?.timestamp_ms ?? -Infinity));
  const latestVisibleSeries = availableSeries.filter((series) => series.latest?.timestamp_ms === latestVisibleTimestamp);
  const latestKey = $("#latest-key");
  if (Number.isFinite(latestVisibleTimestamp) && latestVisibleSeries.length > 0) {
    latestKey.style.setProperty("--latest-color", availableSeries.length === 1 ? availableSeries[0].color : "var(--ink)");
    $("#latest-key-label").textContent = "各场所最新";
  } else {
    latestKey.style.removeProperty("--latest-color");
    $("#latest-key-label").textContent = "暂无结算";
  }
  const timeline = [...new Set([start, end, ...availableSeries.flatMap((series) => series.rows.map((row) => row.timestamp_ms))])].sort((left, right) => left - right);
  const paths = availableSeries.map((series) => {
    const realPoints = series.points.filter((point) => !point.extension);
    const latestReal = realPoints.findLast((point) => point.event);
    const carryAnchor = latestReal || realPoints.at(-1);
    const displayEnd = latestReal?.timestamp_ms ?? end;
    const displayPoints = timeline
      .filter((timestamp) => timestamp <= displayEnd)
      .map((timestamp) => ({ ...latestComparisonPointAt(series.points, timestamp), timestamp_ms: timestamp }));
    const mainPath = comparisonLinePath(displayPoints, state.metric, x, y);
    const carry = comparisonCarryPath(carryAnchor, end, state.metric, x, y);
    const pulse = Boolean(latestReal && bounds && reachesLatest && series.source?.mode === "live");
    const latestMarker = latestReal
      ? `<g class="comparison-latest-marker${pulse ? " is-live" : ""}" transform="translate(${x(latestReal.timestamp_ms).toFixed(2)} ${y(comparisonUnitsToNumber(latestReal[state.metric])).toFixed(2)})" style="--point-color:${series.color}">
          <g class="comparison-latest-pulse"><circle cx="0" cy="0" r="9" /></g>
          <circle class="comparison-latest-dot" cx="0" cy="0" r="4.9" />
        </g>`
      : "";
    return `<path class="comparison-chart-line-underlay" d="${mainPath}" stroke="${series.color}" />
      <path class="comparison-chart-line" d="${mainPath}" stroke="${series.color}" />
      ${carry ? `<path class="comparison-chart-carry" d="${carry}" stroke="${series.color}" />` : ""}
      ${latestMarker}`;
  }).join("");
  latestKey.classList.toggle("is-live", Boolean(reachesLatest && latestVisibleSeries.some((series) => series.source?.mode === "live")));
  const labelPlacements = compact ? [] : comparisonPlaceEndLabels(availableSeries, state.metric, y, margin.top, height - margin.bottom);
  const endLabels = labelPlacements.map(({ item, y: actualY, labelY }) => {
    const labelX = width - margin.right + 12;
    const value = item.points.at(-1)[state.metric];
    return `<path d="M${width - margin.right + 2},${actualY} L${labelX - 4},${labelY}" stroke="${item.color}" stroke-opacity=".42" fill="none" />
      <rect class="comparison-label-bg" x="${labelX}" y="${labelY - 11}" width="106" height="22" rx="7" style="--label-color:${item.color}" />
      <text class="comparison-end-label" x="${labelX + 8}" y="${labelY + 3}">${item.venue} ${comparisonFormatUnitsPct(value)}</text>`;
  }).join("");
  const tickCount = compact ? 3 : 5;
  const xTicks = Array.from({ length: tickCount }, (_, index) => start + (end - start) * index / (tickCount - 1));
  const xLabels = xTicks.map((tick, index) => `<text class="comparison-chart-axis" x="${x(tick)}" y="${height - 12}" text-anchor="${index === 0 ? "start" : index === tickCount - 1 ? "end" : "middle"}">${beijingDate(tick).slice(5, 16)}</text>`).join("");
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="comparison-svg-title comparison-svg-desc">
    <title id="comparison-svg-title">${state.compareAsset} ${METRIC_META[state.metric].label}对比图</title>
    <desc id="comparison-svg-desc">Binance 与 XYZ 使用无过冲平滑线连接共享结算时间点；每个可交互时刻采用该场所最近累计值。</desc>
    ${grids}${zeroLine}${paths}${endLabels}${xLabels}
    <g class="comparison-shared-cursor" data-comparison-cursor aria-hidden="true">
      <line class="comparison-chart-crosshair" y1="${margin.top}" y2="${height - margin.bottom}" />
      <g data-comparison-markers></g>
    </g>
    <rect class="comparison-chart-overlay" data-comparison-overlay x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" tabindex="0" role="slider" aria-label="共享时间游标" aria-valuemin="0" aria-valuemax="${timeline.length - 1}" aria-valuenow="${timeline.length - 1}" />
  </svg>`;
  bindComparisonChartInteractions({ container, view, timeline, x, y });
}

function clearComparisonTimeError() {
  const error = $("#range-error");
  error.hidden = true;
  error.textContent = "";
  [$("#range-start"), $("#range-end")].forEach((input) => input.setAttribute("aria-invalid", "false"));
}

function showComparisonTimeError(message) {
  const error = $("#range-error");
  error.textContent = message;
  error.hidden = false;
  [$("#range-start"), $("#range-end")].forEach((input) => input.setAttribute("aria-invalid", "true"));
}

function syncComparisonTimeInputs(selectedWindow) {
  const bounds = comparisonDataBounds();
  if (!bounds) return;
  const startInput = $("#range-start");
  const endInput = $("#range-end");
  startInput.min = beijingDateTimeInput(bounds.first);
  endInput.min = beijingDateTimeInput(bounds.first);
  startInput.max = beijingDateTimeInput(bounds.last);
  endInput.max = beijingDateTimeInput(bounds.last);
  if (!state.compareTimeDraft) {
    startInput.value = beijingDateTimeInput(selectedWindow.start);
    endInput.value = beijingDateTimeInput(selectedWindow.end);
  }
}

function markComparisonTimeDraft() {
  state.compareTimeDraft = true;
  $$('[data-range]').forEach((button) => {
    button.classList.remove("is-active");
    button.setAttribute("aria-pressed", "false");
  });
  $("#range-context").textContent = "自定义时段 · 北京时间";
  clearComparisonTimeError();
}

function commitComparisonTimeWindow() {
  const start = parseBeijingDateTime($("#range-start").value, false);
  const end = parseBeijingDateTime($("#range-end").value, true);
  const bounds = comparisonDataBounds();
  if (!start || !end || !bounds) {
    showComparisonTimeError("请选择完整的开始和结束时间");
    return;
  }
  if (start < bounds.first || end > bounds.last + 999) {
    showComparisonTimeError("时间超出两个场所的可比较范围");
    return;
  }
  if (start >= end) {
    showComparisonTimeError("开始时间必须早于结束时间");
    return;
  }
  clearComparisonTimeError();
  state.compareCustomStartMs = start;
  state.compareCustomEndMs = end;
  state.compareRange = "custom";
  state.compareTimeDraft = false;
  renderOverview();
}

function renderOverview() {
  if (!state.data) return;
  state.compareTooltipPinned = false;
  hideComparisonTooltip();
  $$('[data-compare-asset]').forEach((button) => {
    const active = button.dataset.compareAsset === state.compareAsset;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $$('[data-metric]').forEach((button) => {
    const active = button.dataset.metric === state.metric;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $$('[data-range]').forEach((button) => {
    const active = !state.compareTimeDraft && button.dataset.range === state.compareRange;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const view = currentComparisonView();
  $("#comparison-title").textContent = `${state.compareAsset} · 费率对比`;
  $("#comparison-chart-heading").textContent = `累计${METRIC_META[state.metric].label}`;
  $("#mobile-filter-summary").textContent = `${state.compareAsset} · ${state.compareRange === "custom" ? "自定义" : COMPARISON_RANGE_META[state.compareRange].label}`;
  if (!view) {
    $("#comparison-summary").innerHTML = "";
    $("#comparison-chart-stage").innerHTML = '<div class="chart-empty">所选时间范围暂无可用数据。</div>';
    $("#record-count").textContent = "0 条结算";
    $("#latest-key").classList.remove("is-live");
    $("#latest-key-label").textContent = "暂无结算";
    showComparisonTimeError("该时段没有可比较数据");
    return;
  }
  $("#range-context").textContent = state.compareTimeDraft
    ? "自定义时段 · 北京时间"
    : `${COMPARISON_RANGE_META[state.compareRange].label}${state.compareRange === "custom" ? "时段" : ""} · 北京时间`;
  syncComparisonTimeInputs(view.window);
  $("#record-count").textContent = `${view.series.reduce((total, series) => total + series.rows.length, 0)} 条结算`;
  renderComparisonSummary(view);
  renderComparisonChart(view);
}

function renderLegacyOverview() {
  $$("[data-period]").forEach((button) => {
    const active = button.dataset.period === state.period;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $$("[data-metric]").forEach((button) => {
    const active = button.dataset.metric === state.metric;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#period-note").textContent = state.period === "today" ? `${state.data.today_date} · 北京时间` : "各标的 Binance 正式上线起";
  $("#comparison-title").textContent = `${PERIOD_META[state.period].label}资费对比`;
  $("#comparison-subtitle").textContent = state.period === "today"
    ? `${state.data.today_date} · 条长表示当日累计规模，数值保留正负方向。`
    : "条长表示上线以来累计规模，数值保留正负方向。";
  const recordCount = activeRecordCount();
  $("#record-count").textContent = state.period === "today"
    ? `${recordCount.toLocaleString("zh-CN")} 条今日结算`
    : `${recordCount.toLocaleString("zh-CN")} 条累计结算`;
  const summaries = flattenSummaries();
  const maxMagnitude = Math.max(...summaries.map((row) => Math.abs(activeVenueSummary(row).metrics[state.metric].total)), 1e-12);
  const grouped = state.data.assets.map((asset) => {
    const rows = asset.venues.map((venue) => {
      const metric = activeVenueSummary(venue).metrics[state.metric];
      const width = Math.abs(metric.total) / maxMagnitude * 100;
      const tooltip = [
        `${asset.asset} · ${venue.venue}`,
        `${activeMetricLabel()} ${formatPct(metric.total)}`,
        `开盘 ${formatPct(metric.open)} · 休市 ${formatPct(metric.closed)}`,
      ].join("\n");
      return `<button class="bar-row" type="button" data-bar data-asset="${escapeHtml(asset.asset)}" data-venue="${escapeHtml(venue.venue)}" data-tooltip="${escapeHtml(tooltip)}">
        <span>${escapeHtml(venue.venue)}</span>
        <span class="bar-track" aria-hidden="true"><span class="bar-fill" style="width:${width.toFixed(3)}%"></span></span>
        <strong class="bar-value">${formatPct(metric.total)}</strong>
      </button>`;
    }).join("");
    return `<section class="bar-group" aria-label="${escapeHtml(asset.asset)}">
      <div class="bar-group-heading"><strong>${escapeHtml(asset.asset)}</strong><span>${asset.venues.length} 个场所</span></div>
      ${rows}
    </section>`;
  }).join("");
  $("#comparison-chart").innerHTML = grouped;
  bindBarInteractions();
  $("#asset-stack").innerHTML = state.data.assets.map(renderAssetCard).join("");
  $$("[data-drill]").forEach((button) => button.addEventListener("click", () => drillDown(button.dataset.asset, button.dataset.venue)));
}

function renderAssetCard(asset) {
  const initials = asset.asset === "UNITREE" ? "UT" : "CX";
  const periodPrefix = PERIOD_META[state.period].cellPrefix;
  const rows = [...asset.venues]
    .sort((a, b) => (VENUE_ORDER[a.venue] || 99) - (VENUE_ORDER[b.venue] || 99))
    .map((venue) => {
      const summary = activeVenueSummary(venue);
      return `<button class="venue-summary-row" type="button" data-drill data-asset="${escapeHtml(asset.asset)}" data-venue="${escapeHtml(venue.venue)}">
        <span class="venue-id"><strong>${escapeHtml(venue.venue)}</strong><small>${summary.count} 条 · ${escapeHtml(venue.contract)}</small></span>
        ${renderMetricCell(`${periodPrefix}正资费`, summary.metrics.positive)}
        ${renderMetricCell(`${periodPrefix}负资费`, summary.metrics.negative)}
        ${renderMetricCell(`${periodPrefix}净资费`, summary.metrics.net)}
        <svg class="row-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.3 5.3 16 12l-6.7 6.7-1.4-1.4 5.3-5.3-5.3-5.3 1.4-1.4Z" /></svg>
      </button>`;
    }).join("");
  const periodNote = state.period === "today" ? `当日 ${state.data.today_date}` : `统计起点 ${beijingDate(asset.listing_start)}`;
  return `<section class="panel asset-card" aria-labelledby="asset-${escapeHtml(asset.asset)}">
    <div class="asset-card-head">
      <div class="asset-title"><span class="asset-symbol">${initials}</span><div><h2 id="asset-${escapeHtml(asset.asset)}">${escapeHtml(asset.asset)}</h2><p>${periodNote}</p></div></div>
      <span class="venue-count">${asset.venues.length} 个场所</span>
    </div>
    <div class="venue-summary-head"><span>场所</span><span>${periodPrefix}正资费</span><span>${periodPrefix}负资费</span><span>${periodPrefix}净资费</span><span></span></div>
    ${rows}
  </section>`;
}

function renderMetricCell(label, metric) {
  return `<span class="metric-cell"><small>${label}</small><strong>${formatCompactPct(metric.total)}</strong><small>开 ${formatCompactPct(metric.open)} · 休 ${formatCompactPct(metric.closed)}</small></span>`;
}

function bindBarInteractions() {
  $$('[data-bar]').forEach((button) => {
    button.addEventListener("pointerdown", (event) => { button.dataset.pointerType = event.pointerType || "mouse"; });
    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") showChartTooltip(button.dataset.tooltip, event, button);
    });
    button.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "touch") showChartTooltip(button.dataset.tooltip, event, button);
    });
    button.addEventListener("focus", () => {
      if (!isCoarsePointer()) showChartTooltip(button.dataset.tooltip, null, button);
    });
    button.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "touch" && armedBar !== button) hideChartTooltip();
    });
    button.addEventListener("blur", hideChartTooltip);
    button.addEventListener("click", (event) => {
      const touchClick = button.dataset.pointerType === "touch" || (event.detail > 0 && isCoarsePointer());
      if (!touchClick) {
        drillDown(button.dataset.asset, button.dataset.venue, METRIC_META[state.metric].direction);
        return;
      }
      event.preventDefault();
      if (armedBar === button) {
        clearArmedBar(true);
        drillDown(button.dataset.asset, button.dataset.venue, METRIC_META[state.metric].direction);
        return;
      }
      clearArmedBar(false);
      armedBar = button;
      button.setAttribute("data-touch-armed", "true");
      button.insertAdjacentHTML("afterend", `<div class="bar-touch-detail" data-bar-touch-detail role="status">${escapeHtml(button.dataset.tooltip)}<small>再次点击该场所进入详情</small></div>`);
      armedBarTimer = window.setTimeout(() => clearArmedBar(true), 5000);
    });
  });
}

function drillDown(asset, venue, direction = "ALL") {
  state.asset = asset;
  state.venue = venue;
  state.session = "ALL";
  state.direction = direction;
  state.page = 1;
  setView("details");
  renderDetails();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setView(view) {
  state.view = view;
  clearArmedBar(true);
  state.compareTooltipPinned = false;
  hideComparisonTooltip();
  $("#overview-view").hidden = view !== "overview";
  $("#details-view").hidden = view !== "details";
  $$('[data-view]').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function syncVenueOptions() {
  const select = $("#filter-venue");
  const venues = state.asset === "ALL"
    ? ["Binance", "XYZ", "PARA"]
    : state.data.assets.find((asset) => asset.asset === state.asset).venues.map((venue) => venue.venue);
  if (state.venue !== "ALL" && !venues.includes(state.venue)) state.venue = "ALL";
  select.innerHTML = `<option value="ALL">全部</option>${venues.map((venue) => `<option value="${escapeHtml(venue)}">${escapeHtml(venue)}</option>`).join("")}`;
  select.value = state.venue;
}

function selectedRecords() {
  const filtered = state.data.records.filter((row) => {
    if (state.period === "today" && chinaDateKey(row.timestamp_ms) !== state.data.today_date) return false;
    if (state.asset !== "ALL" && row.asset !== state.asset) return false;
    if (state.venue !== "ALL" && row.venue !== state.venue) return false;
    if (state.session !== "ALL" && row.session !== state.session) return false;
    if (state.direction === "POS" && row.funding_rate <= 0) return false;
    if (state.direction === "NEG" && row.funding_rate >= 0) return false;
    if (state.direction === "ZERO" && row.funding_rate !== 0) return false;
    return true;
  });
  const running = new Map();
  return [...filtered].sort((a, b) => a.timestamp_ms - b.timestamp_ms).map((row) => {
    const key = `${row.asset}|${row.venue}`;
    const value = running.get(key) || { positive: 0, negative: 0, net: 0 };
    if (row.funding_rate > 0) value.positive = addRate(value.positive, row.funding_rate);
    if (row.funding_rate < 0) value.negative = addRate(value.negative, row.funding_rate);
    value.net = addRate(value.net, row.funding_rate);
    running.set(key, value);
    return { ...row, view_positive: value.positive, view_negative: value.negative, view_net: value.net };
  });
}

function renderDetails() {
  if (!state.data) return;
  $("#filter-period").value = state.period;
  $("#filter-asset").value = state.asset;
  syncVenueOptions();
  $("#filter-session").value = state.session;
  $("#filter-direction").value = state.direction;
  const rows = selectedRecords();
  const periodLabel = state.period === "today" ? `当日 ${state.data.today_date}` : "上线以来";
  $("#details-subtitle").textContent = `${periodLabel} · ${state.asset === "ALL" ? "全部标的" : state.asset} · ${state.venue === "ALL" ? "全部场所" : state.venue} · ${rows.length} 条结算`;
  $("#trend-title").textContent = `${PERIOD_META[state.period].label}净资费路径`;
  $("#column-positive").textContent = `${PERIOD_META[state.period].cellPrefix}正`;
  $("#column-negative").textContent = `${PERIOD_META[state.period].cellPrefix}负`;
  $("#column-net").textContent = `${PERIOD_META[state.period].cellPrefix}净`;
  $("#trend-subtitle").textContent = `${PERIOD_META[state.period].label} · ${rows.length} 个结算点 · 北京时间`;
  renderLineChart(rows);
  renderTable(rows);
}

function renderLineChart(rows) {
  const container = $("#line-chart");
  if (!rows.length) {
    const message = state.period === "today" ? `${state.data.today_date} 暂无符合条件的结算记录。` : "当前筛选没有结算记录。";
    container.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
    $("#series-legend").innerHTML = "";
    return;
  }
  const grouped = new Map();
  rows.forEach((row) => {
    const key = `${row.asset} · ${row.venue}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  });
  const series = [...grouped.entries()].map(([name, points]) => [
    name,
    [...points].sort((a, b) => a.timestamp_ms - b.timestamp_ms),
  ]);
  const timeline = [...new Set(rows.map((row) => row.timestamp_ms))].sort((a, b) => a - b);
  const width = Math.max(320, Math.round(container.clientWidth || 980));
  const compact = width < 560;
  const height = compact ? 220 : 300;
  const margin = compact
    ? { top: 16, right: 10, bottom: 32, left: 74 }
    : { top: 18, right: 20, bottom: 34, left: 92 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const minX = Math.min(...rows.map((row) => row.timestamp_ms));
  const maxX = Math.max(...rows.map((row) => row.timestamp_ms));
  const yValues = rows.map((row) => row.view_net).concat([0]);
  let minY = Math.min(...yValues);
  let maxY = Math.max(...yValues);
  if (minY === maxY) { minY -= 0.001; maxY += 0.001; }
  const pad = (maxY - minY) * 0.09;
  minY -= pad;
  maxY += pad;
  const x = (value) => margin.left + (maxX === minX ? plotWidth / 2 : (value - minX) / (maxX - minX) * plotWidth);
  const y = (value) => margin.top + (maxY - value) / (maxY - minY) * plotHeight;
  const ticks = Array.from({ length: 5 }, (_, index) => minY + (maxY - minY) * index / 4);
  const grid = ticks.map((tick) => `<line class="chart-grid" x1="${margin.left}" y1="${y(tick)}" x2="${width - margin.right}" y2="${y(tick)}"/><text class="chart-axis" x="${margin.left - 10}" y="${y(tick) + 3}" text-anchor="end">${formatPct(tick, 6)}</text>`).join("");
  const zero = minY <= 0 && maxY >= 0 ? `<line class="chart-zero" x1="${margin.left}" y1="${y(0)}" x2="${width - margin.right}" y2="${y(0)}"/>` : "";
  const paths = series.map(([name, points], index) => {
    const color = SERIES_COLORS[index % SERIES_COLORS.length];
    const path = points.map((point, pointIndex) => {
      const pointX = x(point.timestamp_ms).toFixed(2);
      const pointY = y(point.view_net).toFixed(2);
      return pointIndex ? `H${pointX}V${pointY}` : `M${pointX},${pointY}`;
    }).join(" ");
    const last = points.at(-1);
    return `<path class="chart-line" d="${path}" stroke="${color}"/><circle class="chart-dot" cx="${x(last.timestamp_ms)}" cy="${y(last.view_net)}" r="4" fill="${color}"></circle>`;
  }).join("");
  const xTicks = Array.from({ length: 4 }, (_, index) => minX + (maxX - minX) * index / 3);
  const xLabels = xTicks.map((tick, index) => `<text class="chart-axis" x="${x(tick)}" y="${height - 8}" text-anchor="${index === 0 ? "start" : index === 3 ? "end" : "middle"}">${beijingDate(tick).slice(5, 16)}</text>`).join("");
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="line-chart-title line-chart-desc"><title id="line-chart-title">累计净资费路径</title><desc id="line-chart-desc">${series.length} 个序列，共 ${rows.length} 个结算点；移动或点击共享时间游标可比较同一时刻。</desc>${grid}${zero}${paths}<g class="shared-cursor" data-shared-cursor aria-hidden="true"><line class="chart-crosshair" y1="${margin.top}" y2="${height - margin.bottom}"></line><g data-shared-markers></g></g><rect class="chart-overlay" data-line-overlay x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" tabindex="0" role="slider" aria-label="共享时间游标" aria-valuemin="0" aria-valuemax="${timeline.length - 1}" aria-valuenow="${timeline.length - 1}"></rect>${xLabels}</svg>`;

  const overlay = $('[data-line-overlay]', container);
  const cursor = $('[data-shared-cursor]', container);
  const crosshair = cursor.querySelector(".chart-crosshair");
  const markerLayer = cursor.querySelector('[data-shared-markers]');
  let keyboardIndex = timeline.length - 1;

  const latestAt = (points, timestamp) => {
    let low = 0;
    let high = points.length - 1;
    let found = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (points[middle].timestamp_ms <= timestamp) {
        found = points[middle];
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  };

  const nearestTimelineIndex = (target) => {
    let low = 0;
    let high = timeline.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (timeline[middle] < target) low = middle + 1;
      else high = middle;
    }
    if (low > 0 && Math.abs(timeline[low - 1] - target) <= Math.abs(timeline[low] - target)) return low - 1;
    return low;
  };

  const showSharedTimestamp = (timestamp, event = null, mobile = false) => {
    const cursorX = x(timestamp);
    crosshair.setAttribute("x1", cursorX);
    crosshair.setAttribute("x2", cursorX);
    const lines = [beijingDate(timestamp, true)];
    const markers = [];
    series.forEach(([name, points], index) => {
      const latest = latestAt(points, timestamp);
      if (!latest) {
        lines.push(`${name}  尚未开始`);
        return;
      }
      const exact = latest.timestamp_ms === timestamp;
      const netLabel = state.period === "today" ? "日内净" : "累计净";
      lines.push(`${name}  ${exact ? `本次 ${formatPct(latest.funding_rate)}` : "此刻无结算"}  · ${netLabel} ${formatPct(latest.view_net)}`);
      markers.push(`<circle class="shared-marker" cx="${cursorX}" cy="${y(latest.view_net)}" r="4" fill="${SERIES_COLORS[index % SERIES_COLORS.length]}"></circle>`);
    });
    markerLayer.innerHTML = markers.join("");
    cursor.classList.add("is-visible");
    keyboardIndex = timeline.indexOf(timestamp);
    overlay.setAttribute("aria-valuenow", keyboardIndex);
    overlay.setAttribute("aria-valuetext", lines.join("；"));
    showChartTooltip(lines.join("\n"), event, overlay, { mobile, shared: true, placement: "chart" });
  };

  const timestampFromPointer = (event) => {
    const rect = overlay.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    return timeline[nearestTimelineIndex(minX + ratio * (maxX - minX))];
  };

  overlay.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "touch") showSharedTimestamp(timestampFromPointer(event), event, false);
  });
  overlay.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "touch") {
      cursor.classList.remove("is-visible");
      hideChartTooltip();
    }
  });
  overlay.addEventListener("click", (event) => {
    const mobile = event.detail > 0 && isCoarsePointer();
    showSharedTimestamp(timestampFromPointer(event), event, mobile);
  });
  overlay.addEventListener("focus", () => {
    if (!isCoarsePointer()) showSharedTimestamp(timeline[keyboardIndex], null, false);
  });
  overlay.addEventListener("blur", () => {
    if (!isCoarsePointer()) {
      cursor.classList.remove("is-visible");
      hideChartTooltip();
    }
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    keyboardIndex = Math.max(0, Math.min(timeline.length - 1, keyboardIndex + (event.key === "ArrowRight" ? 1 : -1)));
    showSharedTimestamp(timeline[keyboardIndex], null, isCoarsePointer());
  });
  $("#series-legend").innerHTML = series.map(([name], index) => `<span class="legend-item"><i class="legend-swatch" style="background:${SERIES_COLORS[index % SERIES_COLORS.length]}"></i>${escapeHtml(name)}</span>`).join("");
}

function renderTable(rows) {
  const sorted = state.sortRate
    ? [...rows].sort((a, b) => Math.abs(b.funding_rate) - Math.abs(a.funding_rate))
    : [...rows].sort((a, b) => b.timestamp_ms - a.timestamp_ms);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  state.page = Math.min(state.page, totalPages);
  const pageRows = sorted.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  $("#funding-table-body").innerHTML = pageRows.length ? pageRows.map((row) => `<tr>
    <td>${beijingDate(row.timestamp)}</td><td>${escapeHtml(row.asset)}</td><td>${escapeHtml(row.venue)}</td>
    <td><span class="session-pill ${row.session === "CLOSED" ? "is-closed" : ""}">${escapeHtml(row.market_state_label)}</span></td>
    <td class="numeric">${formatPct(row.funding_rate)}</td><td class="numeric">${formatPct(row.view_positive)}</td><td class="numeric">${formatPct(row.view_negative)}</td><td class="numeric">${formatPct(row.view_net)}</td>
  </tr>`).join("") : '<tr><td colspan="8"><div class="empty-state">当前筛选没有数据。</div></td></tr>';
  $("#page-label").textContent = `${sorted.length} 条 · 第 ${state.page}/${totalPages} 页`;
  $("#page-prev").disabled = state.page <= 1;
  $("#page-next").disabled = state.page >= totalPages;
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("fundingDashboardTheme", theme);
}

function initTheme() {
  const saved = localStorage.getItem("fundingDashboardTheme");
  setTheme(saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
}

function scheduleRefresh() {
  window.clearInterval(state.timer);
  state.timer = null;
  if (state.refreshSeconds > 0) {
    state.timer = window.setInterval(() => loadDashboard(false), state.refreshSeconds * 1000);
  }
}

$$('[data-view]').forEach((button) => button.addEventListener("click", () => {
  setView(button.dataset.view);
  if (button.dataset.view === "details") renderDetails();
  else renderOverview();
}));

$("#mobile-filter-toggle").addEventListener("click", (event) => {
  const overview = $("#overview-view");
  const expanded = !overview.classList.contains("is-filter-open");
  overview.classList.toggle("is-filter-open", expanded);
  event.currentTarget.setAttribute("aria-expanded", String(expanded));
});

$("#open-raw-details").addEventListener("click", () => {
  setView("details");
  renderDetails();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

for (const nativeEvent of ["contextmenu", "dragstart", "selectstart"]) {
  $("#comparison-chart-stage").addEventListener(nativeEvent, (event) => event.preventDefault(), true);
}

$$('[data-compare-asset]').forEach((button) => button.addEventListener("click", () => {
  state.compareAsset = button.dataset.compareAsset;
  state.compareTimeDraft = false;
  clearComparisonTimeError();
  renderOverview();
}));

$$('[data-range]').forEach((button) => button.addEventListener("click", () => {
  state.compareRange = button.dataset.range;
  state.compareTimeDraft = false;
  clearComparisonTimeError();
  renderOverview();
}));

[$("#range-start"), $("#range-end")].forEach((input) => {
  input.addEventListener("input", markComparisonTimeDraft);
  input.addEventListener("change", commitComparisonTimeWindow);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") commitComparisonTimeWindow();
  });
});

$$("[data-metric]").forEach((button) => button.addEventListener("click", () => {
  state.metric = button.dataset.metric;
  clearArmedBar(true);
  renderOverview();
}));

$$('[data-period]').forEach((button) => button.addEventListener("click", () => {
  state.period = button.dataset.period;
  state.page = 1;
  clearArmedBar(true);
  renderOverview();
  if (state.view === "details") renderDetails();
}));

$("#refresh-button").addEventListener("click", () => loadDashboard(true));
$("#theme-toggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

[["period", "#filter-period"], ["asset", "#filter-asset"], ["venue", "#filter-venue"], ["session", "#filter-session"], ["direction", "#filter-direction"]].forEach(([key, selector]) => {
  $(selector).addEventListener("change", (event) => {
    state[key] = event.target.value;
    if (key === "asset") syncVenueOptions();
    state.page = 1;
    renderDetails();
  });
});

$("#sort-rate").addEventListener("click", (event) => {
  state.sortRate = !state.sortRate;
  event.currentTarget.setAttribute("aria-pressed", String(state.sortRate));
  state.page = 1;
  renderTable(selectedRecords());
});

$("#page-prev").addEventListener("click", () => { if (state.page > 1) { state.page -= 1; renderTable(selectedRecords()); } });
$("#page-next").addEventListener("click", () => { state.page += 1; renderTable(selectedRecords()); });
$("#refresh-interval").addEventListener("change", (event) => {
  state.refreshSeconds = Number(event.target.value);
  scheduleRefresh();
  showToast(state.refreshSeconds ? `自动更新：${state.refreshSeconds} 秒` : "已暂停自动更新");
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    state.compareTooltipPinned = false;
    hideComparisonTooltip($("[data-comparison-cursor]"));
    hideChartTooltip();
  }
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("[data-bar]")) clearArmedBar(false);
  if (!event.target.closest("[data-bar], #line-chart")) hideChartTooltip();
  if (!event.target.closest("#comparison-chart-stage, #comparison-tooltip")) {
    state.compareTooltipPinned = false;
    hideComparisonTooltip($("[data-comparison-cursor]"));
  }
});

let resizeTimer;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (state.view === "details" && state.data) renderLineChart(selectedRecords());
    if (state.view === "overview" && state.data) {
      const view = currentComparisonView();
      if (view) renderComparisonChart(view);
    }
  }, 120);
});

initTheme();
scheduleRefresh();
loadDashboard(false);
