const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const SERIES_COLORS = ["#ff2670", "#7916f3", "#00a7a7", "#8a9b00", "#d56b00"];
const VENUE_ORDER = { Binance: 1, XYZ: 2, PARA: 3 };
const PAGE_SIZE = 14;
const METRIC_META = {
  net: { label: "累计净资费", direction: "ALL" },
  positive: { label: "累计正资费", direction: "POS" },
  negative: { label: "累计负资费", direction: "NEG" },
};

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

function normalizeFundingRow(series, raw) {
  const timestampMs = Number(raw.fundingTime ?? raw.time);
  const session = classifyAShareSession(timestampMs);
  return {
    timestamp_ms: timestampMs,
    timestamp: new Date(timestampMs).toISOString(),
    asset: series.asset,
    venue: series.venue,
    contract: series.contract,
    funding_rate: Number(raw.fundingRate),
    premium: raw.premium == null ? null : Number(raw.premium),
    mark_price: raw.markPrice == null ? null : Number(raw.markPrice),
    rate_type: raw.rateType ?? null,
    session: session.isOpen ? "OPEN" : "CLOSED",
    market_state: session.code,
    market_state_label: session.label,
  };
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
      metrics.positive.total += row.funding_rate;
      metrics.positive[key] += row.funding_rate;
    } else if (row.funding_rate < 0) {
      metrics.negative.total += row.funding_rate;
      metrics.negative[key] += row.funding_rate;
    }
    metrics.net.total += row.funding_rate;
    metrics.net[key] += row.funding_rate;
  });
  return {
    count: rows.length,
    first_timestamp: rows[0]?.timestamp ?? null,
    last_timestamp: rows.at(-1)?.timestamp ?? null,
    metrics,
  };
}

function buildStaticPayload(records, sources) {
  const ordered = [...records].sort((a, b) => a.asset.localeCompare(b.asset)
    || a.venue.localeCompare(b.venue) || a.timestamp_ms - b.timestamp_ms);
  const running = new Map();
  ordered.forEach((row) => {
    const key = `${row.asset}|${row.venue}`;
    const value = running.get(key) || { positive: 0, negative: 0, net: 0 };
    if (row.funding_rate > 0) value.positive += row.funding_rate;
    if (row.funding_rate < 0) value.negative += row.funding_rate;
    value.net += row.funding_rate;
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
        return { venue: series.venue, contract: series.contract, ...summarizeRows(rows) };
      }),
    };
  });
  const liveCount = sources.filter((source) => source.mode === "live").length;
  return {
    generated_at: new Date().toISOString(),
    mode: liveCount === sources.length ? "live" : liveCount ? "mixed" : "snapshot",
    last_record_at: ordered.length ? new Date(Math.max(...ordered.map((row) => row.timestamp_ms))).toISOString() : null,
    record_count: ordered.length,
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
  metric: "net",
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
    $("#comparison-chart").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}<br />请检查网络，或等待 GitHub 快照恢复。</div>`;
    $("#asset-stack").innerHTML = "";
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

function renderOverview() {
  $("#overview-metric").value = state.metric;
  $("#record-count").textContent = `${state.data.record_count.toLocaleString("zh-CN")} 条结算`;
  const summaries = flattenSummaries();
  const maxMagnitude = Math.max(...summaries.map((row) => Math.abs(row.metrics[state.metric].total)), 1e-12);
  const grouped = state.data.assets.map((asset) => {
    const rows = asset.venues.map((venue) => {
      const metric = venue.metrics[state.metric];
      const width = Math.abs(metric.total) / maxMagnitude * 100;
      const tooltip = [
        `${asset.asset} · ${venue.venue}`,
        `${METRIC_META[state.metric].label} ${formatPct(metric.total)}`,
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
  const rows = [...asset.venues]
    .sort((a, b) => (VENUE_ORDER[a.venue] || 99) - (VENUE_ORDER[b.venue] || 99))
    .map((venue) => `<button class="venue-summary-row" type="button" data-drill data-asset="${escapeHtml(asset.asset)}" data-venue="${escapeHtml(venue.venue)}">
      <span class="venue-id"><strong>${escapeHtml(venue.venue)}</strong><small>${venue.count} 条 · ${escapeHtml(venue.contract)}</small></span>
      ${renderMetricCell("正资费", venue.metrics.positive)}
      ${renderMetricCell("负资费", venue.metrics.negative)}
      ${renderMetricCell("净资费", venue.metrics.net)}
      <svg class="row-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.3 5.3 16 12l-6.7 6.7-1.4-1.4 5.3-5.3-5.3-5.3 1.4-1.4Z" /></svg>
    </button>`).join("");
  return `<section class="panel asset-card" aria-labelledby="asset-${escapeHtml(asset.asset)}">
    <div class="asset-card-head">
      <div class="asset-title"><span class="asset-symbol">${initials}</span><div><h2 id="asset-${escapeHtml(asset.asset)}">${escapeHtml(asset.asset)}</h2><p>统计起点 ${beijingDate(asset.listing_start)}</p></div></div>
      <span class="venue-count">${asset.venues.length} 个场所</span>
    </div>
    <div class="venue-summary-head"><span>场所</span><span>累计正资费</span><span>累计负资费</span><span>累计净资费</span><span></span></div>
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
      showChartTooltip(`${button.dataset.tooltip}\n再次点击进入详情`, event, button, { mobile: true });
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
    if (row.funding_rate > 0) value.positive += row.funding_rate;
    if (row.funding_rate < 0) value.negative += row.funding_rate;
    value.net += row.funding_rate;
    running.set(key, value);
    return { ...row, view_positive: value.positive, view_negative: value.negative, view_net: value.net };
  });
}

function renderDetails() {
  if (!state.data) return;
  $("#filter-asset").value = state.asset;
  syncVenueOptions();
  $("#filter-session").value = state.session;
  $("#filter-direction").value = state.direction;
  const rows = selectedRecords();
  $("#details-subtitle").textContent = `${state.asset === "ALL" ? "全部标的" : state.asset} · ${state.venue === "ALL" ? "全部场所" : state.venue} · ${rows.length} 条结算`;
  renderLineChart(rows);
  renderTable(rows);
}

function renderLineChart(rows) {
  const container = $("#line-chart");
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">当前筛选没有结算记录。</div>';
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
      lines.push(`${name}  ${exact ? `本次 ${formatPct(latest.funding_rate)}` : "此刻无结算"}  · 净 ${formatPct(latest.view_net)}`);
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
  $("#trend-subtitle").textContent = `过滤后累计 · ${rows.length} 个结算点 · 北京时间`;
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
}));

$("#overview-metric").addEventListener("change", (event) => {
  state.metric = event.target.value;
  renderOverview();
});

$("#refresh-button").addEventListener("click", () => loadDashboard(true));
$("#theme-toggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

[["asset", "#filter-asset"], ["venue", "#filter-venue"], ["session", "#filter-session"], ["direction", "#filter-direction"]].forEach(([key, selector]) => {
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
  if (event.key === "Escape") hideChartTooltip();
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("[data-bar]")) clearArmedBar(false);
  if (!event.target.closest("[data-bar], #line-chart")) hideChartTooltip();
});

let resizeTimer;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (state.view === "details" && state.data) renderLineChart(selectedRecords());
  }, 120);
});

initTheme();
scheduleRefresh();
loadDashboard(false);
