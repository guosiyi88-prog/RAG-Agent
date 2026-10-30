/**
 * 看板面板（`09#05` 的一半，挂在 `console-admin-shell.js` 的骨架上）。
 *
 * 契约（与骨架文件头逐字一致）：
 *   export function mount(host, ctx) -> unmount
 *   ctx = { api(path, init?) -> {ok,data?,error?}, role, toast, onSignOut }
 *
 * 结构：**数字卡片（口径）+ 四张内联 SVG 图（趋势与分布）**。
 * 图表走 A 方案：自己画 SVG，不引图表库（提示词 §6），几何与构建在 `./chart-svg.js`。
 *
 * 数据口径全部来自接口回显（`window` / `exclude_demo`），前端不自己记"我刚发了什么"，
 * 也不自己算百分比（`refusal_rate` / `merge_rate` 是后端算好的 0–1 小数）。
 * 时间序列与语言直方图要显式要：`GET /api/console/stats?series=7d|30d` 才返回
 * `series` / `fault_langs`（不带这个参数的老后端形状照旧可用，图退化成"暂无数据"）。
 */

import { formatSla } from "./console-sla.js";
import { buildLangBars, buildRefusalLine, buildStatusBar, buildTicketsBars } from "./chart-svg.js";

/** 时间窗（与 `src/core/ticket-queue.ts` 的 `STATS_WINDOW_VALUES` 同集同序）。 */
export const BOARD_WINDOWS = Object.freeze([
  ["today", "今天"],
  ["week", "近 7 天"],
  ["all", "全部"],
]);

/** 默认窗口与接口默认值一致（`api/console.ts` 的 `parseStatsQuery`：`window` 缺省 `all`）。 */
export const DEFAULT_WINDOW = "all";

/**
 * 时间窗 → 时间序列窗口（`series=7d|30d`，接口只认这两个值）。
 *
 * 映射原则：序列必须**盖住**当前窗口，否则图上会缺掉"今天"那一段。
 *   今天 → 7d（没有 1d 这个档，7 天最短）
 *   近 7 天 → 7d
 *   全部 → 30d（"全部"没有上界，30 天是接口给得最长的档；图注里写明天数）
 * 于是首屏（`window=all`）拿的是 30 天序列 —— 图上标了天数，看到的人不会误读。
 */
export const SERIES_FOR_WINDOW = Object.freeze({ today: "7d", week: "7d", all: "30d" });

/** 认不出的窗口回落 `7d`：宁可画短一点，也不发一个后端会 400 的取值。 */
export function seriesForWindow(window) {
  return SERIES_FOR_WINDOW[window] ?? "7d";
}

const EMPTY = "—";

/** 各图没有东西可画时的兜底文案（都含"暂无数据"，一处改全处跟着改）。 */
export const CHART_EMPTY_TEXT = Object.freeze({
  tickets: "暂无数据：这段时间没有工单。",
  status: "暂无数据：窗口内还没有工单。",
  refusal: "暂无数据：至少要有两天运行记录才画得出趋势。",
  langs: "暂无数据：还没有已发布的故障码。",
});

function makeNode(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 计数：认不出的值显示破折号，**不要**显示 `undefined` / `NaN`（看板上的假数字会被当成事实）。 */
export function countText(value) {
  if (value === null || value === undefined) return EMPTY;
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : EMPTY;
}

/**
 * 比率：接口给的 0–1 小数（`refusal_rate` 三位小数、`merge_rate` 同量纲）走百分比；
 * 已经像百分数（>1）的值原样显示，不再乘 100 —— 猜错一次就是差 100 倍的看板。
 */
export function rateText(value) {
  if (value === null || value === undefined) return EMPTY;
  const number = Number(value);
  if (!Number.isFinite(number)) return EMPTY;
  if (number > 1 || number < 0) return number.toFixed(1);
  return `${(number * 100).toFixed(1)}%`;
}

/** 平均剩余秒数复用工单队列的格式化（`超时 2m` / `2h 14m` / `无截止`），两处口径不能分叉。 */
export function slaLeftText(value) {
  if (value === null || value === undefined) return EMPTY;
  const number = Number(value);
  if (!Number.isFinite(number)) return EMPTY;
  return formatSla(number).text;
}

function windowLabel(key) {
  const found = BOARD_WINDOWS.find(([value]) => value === key);
  return found === undefined ? key : found[1];
}

/** 一张卡片：标签 + 数值 +（可选）口径说明。 */
function card(doc, label, value, note) {
  const box = makeNode(doc, "div", "admin-card");
  box.appendChild(makeNode(doc, "div", "admin-card-label", label));
  box.appendChild(makeNode(doc, "div", "admin-card-value", value));
  if (typeof note === "string" && note !== "") box.appendChild(makeNode(doc, "div", "admin-card-note", note));
  return box;
}

/**
 * 统计体 → 卡片 DOM（纯函数：入参 → 节点，不发请求；`tests/web-admin-shell.test.ts` 直接喂 JSON 断言）。
 *
 * `reports`（反馈待审计）是**另一个流**正在加到 `GET /api/console/stats` 的字段，这里按"有没有"处理：
 * 字段不存在就不画那三张卡片，绝不显示 `undefined`，也绝不因为缺失而抛错。
 */
export function cardsFor(doc, stats) {
  const body = stats !== null && typeof stats === "object" ? stats : {};
  const byStatus = body.tickets_by_status !== null && typeof body.tickets_by_status === "object" ? body.tickets_by_status : {};
  const scope = `口径：${windowLabel(String(body.window ?? DEFAULT_WINDOW))} · ${
    body.exclude_demo === false ? "含演示工单" : "已排除演示工单"
  }`;

  const cards = [
    card(doc, "工单总数", countText(body.tickets_total), scope),
    card(doc, "待处理", countText(body.tickets_pending), `待处理 + 已认领 + 已升级`),
    card(doc, "已关闭", countText(byStatus.closed), `未关闭：${countText(body.tickets_pending)}`),
  ];

  const runsTotal = Number(body.runs_total);
  const runsRefused = Number(body.runs_refused);
  cards.push(
    card(
      doc,
      "拒答率",
      Number.isFinite(runsTotal) && runsTotal === 0 ? EMPTY : rateText(body.refusal_rate),
      Number.isFinite(runsTotal)
        ? `${Number.isFinite(runsRefused) ? runsRefused : 0} / ${runsTotal} 轮拒答`
        : "没有运行记录",
    ),
  );

  cards.push(card(doc, "平均剩余 SLA", slaLeftText(body.sla_seconds_left_avg), "仅未关闭且有截止时间的单"));

  const reports = body.reports;
  if (reports !== null && reports !== undefined && typeof reports === "object") {
    // 三个字段各自独立：后端分批上线，只给了 `merge_rate` 时不该凭空画出另外两张 "—" 的卡片。
    const given = (key) => reports[key] !== undefined && reports[key] !== null;
    if (given("new")) cards.push(card(doc, "待审计反馈", countText(reports.new), "未处理的用户反馈"));
    if (given("last24h")) {
      cards.push(card(doc, "24 小时新增", countText(reports.last24h), "同口径时间窗之外，固定 24 小时"));
    }
    if (given("merge_rate")) cards.push(card(doc, "合并率", rateText(reports.merge_rate), "已并入知识库的反馈占比"));
  }

  return cards;
}

/**
 * 这个 DOM 能不能画 SVG。判据只有 `createElementNS`：没有它 `createElement("svg")`
 * 出来的是 HTMLUnknownElement（屏幕上一片空白）。
 *
 * 没有 SVG 时**连 `series` 一起不要**：一个画不出来的响应纯属白花一次鉴权往返。
 * 真实的浏览器都有它；`tests/web-admin-shell.test.ts` 的假 DOM 没有，于是那边
 * 的请求串保持卡片时代的样子（同时那条测试的 URL 断言也不受影响）。
 */
export function canDrawCharts(doc) {
  return typeof doc?.createElementNS === "function";
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 一张图卡：标题 + 图（画不出来时换成一句"暂无数据"）+ 口径说明。 */
function chartCard(doc, title, note, svg, emptyText) {
  const box = makeNode(doc, "div", "admin-card admin-chart");
  box.appendChild(makeNode(doc, "div", "admin-card-label", title));
  if (svg !== null && svg !== undefined) box.appendChild(svg);
  else box.appendChild(makeNode(doc, "p", "admin-note", emptyText));
  if (typeof note === "string" && note !== "") box.appendChild(makeNode(doc, "p", "admin-card-note", note));
  return box;
}

/**
 * 统计体 → 四张图卡（纯函数：入参 → 节点，不发请求）。
 *
 * 四张图各自独立降级：`series` / `fault_langs` / `tickets_by_status` 缺哪个就哪张写"暂无数据"，
 * 其余照画（后端分批上线时不能整块空着）。任何一步都不许产出 `NaN` —— `chart-svg.js`
 * 的几何函数已经把非数字当 0 / 断点处理。
 */
export function chartBlocksFor(doc, stats) {
  const body = stats !== null && typeof stats === "object" ? stats : {};
  const series = Array.isArray(body.series) ? body.series : [];
  const days = series.length;

  const tickets = series.map((point) => ({
    day: String(point?.day ?? ""),
    value: Math.max(0, numberOr(point?.tickets, 0)),
  }));

  const refusal = series.map((point) => {
    const runs = Math.max(0, numberOr(point?.runs, 0));
    return {
      day: String(point?.day ?? ""),
      runs,
      refused: Math.max(0, numberOr(point?.refused, 0)),
      // `runs = 0` 那天的 `refusal_rate` 后端给 0，但那是"没有数据"不是"没拒答"：
      // 这里换成 null，折线当场断开（画成 0% 会让看板上的人以为那天答得特别好）。
      value: runs === 0 ? null : Math.min(Math.max(numberOr(point?.refusal_rate, 0), 0), 1),
    };
  });

  return [
    chartCard(
      doc,
      "工单量趋势",
      `${days === 0 ? "时间序列未返回" : `${days} 天 · 按创建日`} · 已排除演示工单`,
      buildTicketsBars(doc, tickets),
      CHART_EMPTY_TEXT.tickets,
    ),
    chartCard(
      doc,
      "工单状态分布",
      "四段之和 = 窗口内工单数；蓝色=已认领、紫=已升级、绿=已关闭",
      buildStatusBar(doc, body.tickets_by_status),
      CHART_EMPTY_TEXT.status,
    ),
    chartCard(
      doc,
      "拒答率趋势",
      "只有出过运行记录的那天连线；没有运行记录的日子断开（不是 0%）",
      buildRefusalLine(doc, refusal),
      CHART_EMPTY_TEXT.refusal,
    ),
    chartCard(
      doc,
      "故障码语言完整度",
      "只统计已发布；一门语「齐」要求含义与处理步骤都非空",
      buildLangBars(doc, body.fault_langs),
      CHART_EMPTY_TEXT.langs,
    ),
  ];
}

export function mount(host, ctx) {
  const doc = host?.ownerDocument ?? globalThis.document;
  // 失败提示统一由骨架的 `ctx.api` 负责（403/401/网络三条各有口径），本面板只在页内写状态文本。
  const api = typeof ctx?.api === "function" ? ctx.api : async () => ({ ok: false, error: { code: "NETWORK", message: "没有可用的请求出口" } });
  const role = typeof ctx?.role === "string" ? ctx.role : "agent";
  const chartsEnabled = canDrawCharts(doc);

  let current = DEFAULT_WINDOW;
  let alive = true;
  let seq = 0;
  // 卸载时一次性摘掉所有监听（事件委托挂在 host 上，用 signal 比手工 remove 更不容易漏）
  const controller = new AbortController();

  const head = makeNode(doc, "div", "admin-head");
  head.appendChild(makeNode(doc, "h2", "admin-title", "看板"));
  const tabs = makeNode(doc, "div", "tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "时间窗");
  const tabNodes = new Map();
  for (const [value, label] of BOARD_WINDOWS) {
    const button = makeNode(doc, "button", "tab-btn", label);
    button.type = "button";
    button.dataset.window = value;
    button.setAttribute("role", "tab");
    tabs.appendChild(button);
    tabNodes.set(value, button);
  }
  head.appendChild(tabs);
  host.appendChild(head);

  const note = makeNode(
    doc,
    "p",
    "admin-note",
    "数字按工单创建时间统计，默认已排除 8 张演示工单（tags 含 demo）。图表是静态 SVG，悬停看当天数值；只读看板，没有下钻与导出。",
  );
  host.appendChild(note);

  const stateNode = makeNode(doc, "div", "admin-state");
  stateNode.setAttribute("role", "status");
  host.appendChild(stateNode);

  const cardBox = makeNode(doc, "div", "admin-cards");
  host.appendChild(cardBox);

  // 图表网格：样式落在行内（面板的 CSS 归 `console.css`，本批不动那个文件），
  // 但引用的仍然只有令牌（`--s3` 是间距令牌，不是色值）。
  const chartBox = makeNode(doc, "div", "admin-charts");
  chartBox.setAttribute("style", "display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:var(--s3)");
  host.appendChild(chartBox);

  const note2 = makeNode(doc, "p", "admin-note", `当前账号角色：${role}。权限不足的操作会由接口返回 403。`);
  host.appendChild(note2);

  function syncTabs() {
    for (const [value, button] of tabNodes) {
      const on = value === current;
      button.setAttribute("aria-selected", String(on));
      button.classList.toggle("is-active", on);
    }
  }

  function renderCards(stats) {
    cardBox.replaceChildren();
    for (const node of cardsFor(doc, stats)) cardBox.appendChild(node);
  }

  function renderCharts(stats) {
    chartBox.replaceChildren();
    if (!chartsEnabled) return;
    for (const node of chartBlocksFor(doc, stats)) chartBox.appendChild(node);
  }

  async function load() {
    const token = ++seq;
    stateNode.className = "admin-state is-loading";
    stateNode.textContent = "加载中…";
    // `series` 只在能画图的 DOM 上要（见 `canDrawCharts`）；窗口与序列一起切，
    // 否则图上看的是 30 天、卡片算的是今天，同一屏两个口径。
    const query = `exclude_demo=true&window=${encodeURIComponent(current)}${
      chartsEnabled ? `&series=${seriesForWindow(current)}` : ""
    }`;
    const result = await api(`/api/console/stats?${query}`);
    if (!alive || token !== seq) return; // 已经切走 / 已经换了时间窗：旧响应不能盖新结果
    if (!result?.ok) {
      stateNode.className = "admin-state is-error";
      stateNode.textContent = result?.error?.message ?? "看板数据加载失败。";
      cardBox.replaceChildren();
      chartBox.replaceChildren();
      return;
    }
    stateNode.className = "admin-state";
    stateNode.textContent = "";
    renderCards(result.data);
    renderCharts(result.data);
  }

  host.addEventListener(
    "click",
    (event) => {
      // 不用 `instanceof Element`：这条判定要能在没有 DOM 的环境里跑（`tests/web-admin-shell.test.ts`
      // 用假 DOM 把本模块完整跑一遍）。鸭子类型判断 `closest` 就够，也不比 `instanceof` 松。
      const target = event?.target;
      if (target === null || target === undefined || typeof target.closest !== "function") return;
      const button = target.closest("[data-window]");
      if (button === null || button === undefined) return;
      const value = String(button.dataset.window ?? "");
      if (value === "" || value === current) return;
      current = value;
      syncTabs();
      void load();
    },
    { signal: controller.signal },
  );

  syncTabs();
  void load();

  return function unmount() {
    alive = false;
    seq += 1;
    controller.abort();
    host.replaceChildren();
  };
}

export default mount;
