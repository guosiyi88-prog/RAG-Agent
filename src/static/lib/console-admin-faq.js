/**
 * FAQ 草稿面板（`09#06` / A5：未命中池 → 草稿 → 审批 → 入索引）。
 *
 * 这张面板补的是 `kb_drafts` 表"有表没界面"的窟窿 —— 它从第一版建表起就在
 * （`sql/001_init.sql` 第 10 节），三年没有消费者，正是 `core/admin-store.ts` 里 R26 说的
 * "有数据、没消费，一个月后就是第二个死池子"。所以这里两块都必须有出口：
 *
 *   1. **未命中池**（`v_no_hit`）：哪些问题反复没答案、已经起过几份草稿 → 只读。
 *      这一块**不给"起稿"按钮**：起稿要在具体那一单的上下文里写（工单详情的「转 FAQ 草稿」），
 *      而这个聚合视图里没有会话、没有 AI 当时怎么答的 —— 从这个列表直接起稿只能写出一句空话。
 *   2. **草稿待审**：`lead` 驳回、`admin` 通过；通过后答案被切块写进 `chunks`，
 *      下次同类问题 AI 直接从索引里答出来。
 *
 * 一个模块、一个出口：`mount(host, ctx) → unmount`。父容器只给一个空 `<div>`；所有网络都走
 * `ctx.api`（票据、401 清场、403 只提示都在那一层，本模块看不见票据）。
 *
 * 三条约束（与 `console-admin-reports.js` 同一套，为了能在 node 里断言）：
 *   1. **顶层零副作用**：不出现宿主对象、不发请求、不引用任何别的模块。可测的判定全部是导出纯函数，
 *      DOM 只活在 `mount()` 里（`tests/web-admin-faq.test.ts` 有一条静态断言盯着这一点）。
 *   2. **判定只写一遍**：`canApprove` / `canReject` 既给按钮用、也给"为什么点不了"的提示用。
 *      按钮禁用只是**免挫败**，接口层（`src/api/roles.ts` 的 `ROUTE_MIN_ROLE`）仍然会再判一次。
 *   3. **审批之后重新拉取，不前端硬删**：`total`、分页与"这条还在不在"都由服务端说了算。
 *
 * 与后端的对应：
 *   草稿列表  `GET  /api/console/drafts?status=draft|approved|rejected&page=&size=`（`agent` 起）
 *   通过      `POST /api/console/drafts/:id/approve`（`admin`；同步切块入索引）
 *   驳回      `POST /api/console/drafts/:id/reject`（`lead`）
 *   未命中池  `GET  /api/console/no-hit?limit=20`（`lead` 起）
 */

/* ───────────────────────── 常量 ───────────────────────── */

/** 一页多少条 = 后端 `FAQ_PAGE_SIZE_DEFAULT`（`core/faq-store.ts`）。查询串里显式发 `size`。 */
export const PAGE_SIZE = 20;

/** 默认只看待审（最该被处理的那一档）。 */
export const DEFAULT_STATUS = "draft";

/** 状态清单（顺序即 Tab 顺序）= 后端 `FAQ_STATUS_VALUES`。 */
export const STATUS_OPTIONS = Object.freeze([
  ["draft", "待审"],
  ["approved", "已通过"],
  ["rejected", "已驳回"],
]);

const STATUS_VALUES = Object.freeze(STATUS_OPTIONS.map(([value]) => value));
const STATUS_LABEL = Object.freeze({ draft: "待审", approved: "已通过", rejected: "已驳回" });

/** 数据源 = 后端 `FAQ_SOURCE_VALUES`（`no_hit|manual|ticket`）。 */
const SOURCE_LABEL = Object.freeze({ no_hit: "未命中池", ticket: "工单", manual: "手工" });

/** 母语名自显（与用户端顶部语言菜单、故障卡面板的 Tab 同一套写法）。 */
const LANG_LABEL = Object.freeze({
  zh: "中文",
  en: "English",
  de: "Deutsch",
  nl: "Nederlands",
  es: "Español",
});

/** 未命中池一次看多少条 = 后端 `FAQ_NO_HIT_LIMIT_DEFAULT`。 */
export const NO_HIT_LIMIT = 20;

/** 未命中池的空态/说明：这句话在面板说明与成功提示里都用，只写一遍。 */
export const NO_HIT_HINT = "这些是反复没答案的问题。要补一条答案，请打开对应工单、点「转 FAQ 草稿」——起稿需要当时的上下文。";

/* ───────────────────────── 小工具 ───────────────────────── */

/** 唯一的转义出口：问题、答案、语言、来源都是外部输入（前两个是用户与坐席打的字）。 */
export function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

/** 时间：本地 `YYYY-MM-DD HH:MM`（不用 Intl，免得同一串在不同环境给出不同形状）。 */
export function formatStamp(value) {
  const text = String(value ?? "");
  if (text === "") return "—";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function statusLabel(status) {
  const key = String(status ?? "");
  return STATUS_LABEL[key] ?? (key === "" ? "—" : key);
}

/** 来源：认识的翻中文，不认识的原样带回（宁可显示后端原文，也不编一句看起来合理的话）。 */
export function sourceLabel(source) {
  const raw = String(source ?? "");
  const key = raw.trim().toLowerCase();
  return SOURCE_LABEL[key] ?? (raw === "" ? "—" : raw);
}

export function langLabel(lang) {
  const raw = String(lang ?? "");
  const key = raw.trim().toLowerCase();
  return LANG_LABEL[key] ?? (raw === "" ? "—" : raw);
}

/* ───────────────────────── 能力判定 ───────────────────────── */

const isManager = (role) => {
  const value = typeof role === "string" ? role.trim().toLowerCase() : "";
  return value === "lead" || value === "admin";
};

/**
 * 这一行能不能**通过**。返回 `{ visible, enabled, reason }`：`visible` 决定画不画，
 * `enabled` 决定能不能点，`reason` 是"为什么不能点"（画在 title 上）。
 *
 * 三个门槛与后端**同集**：角色 `admin`（`ROUTE_MIN_ROLE` 里是 `admin`）、状态必须是 `draft`
 * （core 对已通过的幂等回 `changed:[]`、对已驳回的回 409）。未知角色按最低档 —— 与
 * `src/auth.ts` 的 `requireRole` 同口径。
 */
export function canApprove(row, role) {
  const status = String(row?.status ?? DEFAULT_STATUS);
  if (!isManager(role)) {
    return { visible: false, enabled: false, reason: "审批草稿需要坐席主管（lead）或管理员角色。" };
  }
  if (String(role).trim().toLowerCase() !== "admin") {
    return { visible: true, enabled: false, reason: "通过会把答案写进用户能检索到的索引，需要管理员角色。" };
  }
  if (status !== "draft") {
    return { visible: true, enabled: false, reason: `这份草稿已经处理过（${statusLabel(status)}），不能再改。` };
  }
  return { visible: true, enabled: true, reason: "" };
}

/** 这一行能不能**驳回**（`lead` 起；状态必须是 `draft`）。 */
export function canReject(row, role) {
  const status = String(row?.status ?? DEFAULT_STATUS);
  if (!isManager(role)) {
    return { visible: false, enabled: false, reason: "处置草稿需要坐席主管（lead）或管理员角色。" };
  }
  if (status !== "draft") {
    return { visible: true, enabled: false, reason: `这份草稿已经处理过（${statusLabel(status)}），不能再改。` };
  }
  return { visible: true, enabled: true, reason: "" };
}

/* ───────────────────────── 查询与分页 ───────────────────────── */

/** 筛选 → 查询串。状态一律发（默认 `draft`）；空 / 非法状态回落默认值，不把拼错的值发给后端。 */
export function buildDraftQuery(filters, page = 1) {
  const source = filters ?? {};
  const wanted = String(source.status ?? "");
  const status = STATUS_VALUES.includes(wanted) ? wanted : DEFAULT_STATUS;
  const wantedPage = Math.trunc(Number(page));
  const current = Number.isFinite(wantedPage) && wantedPage > 0 ? wantedPage : 1;
  const params = new URLSearchParams();
  params.set("status", status);
  params.set("page", String(current));
  params.set("size", String(PAGE_SIZE));
  return params.toString();
}

/** 未命中池的查询串：只带一个 `limit`（它没有分页，前 N 条就是一个屏幕的事）。 */
export function buildNoHitQuery(limit = NO_HIT_LIMIT) {
  const wanted = Math.trunc(Number(limit));
  const value = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, NO_HIT_LIMIT) : NO_HIT_LIMIT;
  return `limit=${value}`;
}

/** 分页信息：`{ total, page, pages, hasPrev, hasNext, text }`；`page` 先夹进 `[1, pages]`。 */
export function pageInfo(total, page) {
  const count = Math.max(0, Math.trunc(Number(total) || 0));
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const wanted = Math.trunc(Number(page) || 1);
  const current = Math.min(Math.max(1, wanted), pages);
  return {
    total: count,
    page: current,
    pages,
    hasPrev: current > 1,
    hasNext: current < pages,
    text: `第 ${current} / ${pages} 页 · 共 ${count} 条`,
  };
}

/* ───────────────────────── 文案 ───────────────────────── */

/** 空列表的文案：要区分"没有待审的"与"还没起过草稿"（后者不是异常）。 */
export function emptyText(status) {
  const key = String(status ?? DEFAULT_STATUS);
  if (key === "draft") return "没有待审草稿。坐席在工单详情点「转 FAQ 草稿」会生成一条。";
  if (key === "approved") return "还没有通过的草稿。";
  if (key === "rejected") return "还没有驳回的草稿。";
  return "这里没有草稿。";
}

/** 错误码 → 面板上能直接显示的一句话（后端 message 是英文给日志看的）。 */
export function errorText(error) {
  const code = String(error?.code ?? "");
  const message = typeof error?.message === "string" ? error.message : "";
  if (code === "FORBIDDEN") return "权限不足：通过需要管理员，驳回需要坐席主管。";
  if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID") return "登录状态已失效，请重新登录。";
  if (code === "NETWORK") return "连不上服务端，请确认服务已启动。";
  if (code === "NOT_FOUND") return "这份草稿不存在了，请刷新列表。";
  if (code === "CONFLICT") return message === "" ? "这份草稿已被处理，列表已刷新。" : message;
  if (code === "VALIDATION") return message === "" ? "参数不合法。" : message;
  if (code === "EMBED_UNAVAILABLE") return "嵌入服务暂时不可用，审批未生效，请稍后重试。";
  if (/^HTTP_5\d\d$/.test(code)) return "服务端出错了，这一屏的数据可能不是最新。";
  return message === "" ? "请求失败。" : message;
}

/**
 * 把 `ctx.api` 的返回值归一成 `{ ok, data } | { ok: false, error }`
 * （两种挂载都认：契约上的信封，以及"成功直接回 data、失败抛错"的 `console.js` 版）。
 */
export async function callApi(api, path, init) {
  if (typeof api !== "function") {
    return { ok: false, error: { code: "NETWORK", message: "缺少 ctx.api" } };
  }
  let result;
  try {
    result = await api(path, init);
  } catch (error) {
    const code = typeof error?.code === "string" && error.code !== "" ? error.code : "NETWORK";
    return { ok: false, error: { code, message: String(error?.message ?? "请求失败") } };
  }
  if (result !== null && typeof result === "object" && "ok" in result) {
    if (result.ok === true) return { ok: true, data: result.data ?? {} };
    return { ok: false, error: result.error ?? { code: "UNKNOWN", message: "请求失败" } };
  }
  return { ok: true, data: result ?? {} };
}

/* ───────────────────────── 列表 HTML（纯字符串） ───────────────────────── */

/**
 * 草稿行。列固定六格：`问题 | 语言 | 来源 | 状态 | 提交时间 | 操作`。
 * 两个按钮都带 `data-draft-id` 与 `data-draft-act`；`role` 只影响禁用（`canApprove`/`canReject`）。
 * 问题全文进 `title`（列表只有一行高，截断是必然的）。
 */
export function draftsRowsHtml(items, role = "lead") {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item) => {
      const id = String(item?.id ?? "");
      const question = typeof item?.question === "string" ? item.question.trim() : "";
      const approve = canApprove(item, role);
      const reject = canReject(item, role);
      const buttons = approve.visible || reject.visible
        ? `${approve.visible ? `<button class="admin-report-btn" type="button" data-draft-act="approve" data-draft-id="${esc(id)}" title="${esc(approve.reason === "" ? "通过：切块写入索引，用户下次就能检索到" : approve.reason)}"${approve.enabled ? "" : " disabled"}>通过</button>` : ""}${
            reject.visible
              ? `<button class="admin-report-btn is-danger" type="button" data-draft-act="reject" data-draft-id="${esc(id)}" title="${esc(reject.reason === "" ? "驳回：不进知识库，草稿留档" : reject.reason)}"${reject.enabled ? "" : " disabled"}>驳回</button>`
              : ""
          }`
        : "—";
      const reviewer = typeof item?.reviewer === "string" && item.reviewer !== "" ? item.reviewer : "";
      return `<tr class="admin-report-row" data-draft-row="${esc(id)}">
  <td class="admin-faq-question"${question === "" ? "" : ` title="${esc(question)}"`}>${question === "" ? "—" : esc(question)}</td>
  <td>${esc(langLabel(item?.lang))}</td>
  <td>${esc(sourceLabel(item?.source))}</td>
  <td>${esc(statusLabel(item?.status))}${reviewer === "" ? "" : ` · ${esc(reviewer)}`}</td>
  <td class="admin-report-time">${esc(formatStamp(item?.created_at))}</td>
  <td class="admin-report-ops">${buttons}</td>
</tr>`;
    })
    .join("");
}

/** 未命中池行：`问题 | 语言 | 次数 | 最近 | 已有草稿`（只读，没有操作列）。 */
export function noHitRowsHtml(items) {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item) => {
      const question = typeof item?.question === "string" ? item.question.trim() : "";
      const draftCount = Math.max(0, Math.trunc(Number(item?.draft_count) || 0));
      return `<tr class="admin-report-row">
  <td class="admin-faq-question"${question === "" ? "" : ` title="${esc(question)}"`}>${question === "" ? "—" : esc(question)}</td>
  <td>${esc(langLabel(item?.lang))}</td>
  <td class="admin-report-time">${esc(String(Number(item?.hits) || 0))}</td>
  <td class="admin-report-time">${esc(formatStamp(item?.last_at))}</td>
  <td>${draftCount === 0 ? "—" : String(draftCount)}</td>
</tr>`;
    })
    .join("");
}

/* ───────────────────────── 挂载 ───────────────────────── */

/**
 * `host` 是一个空 `<div>`；`ctx` 见骨架文件头。返回卸载函数（摘监听、清内容）。
 * 这里才开始碰 DOM —— 文件顶层一个宿主对象都没有，所以在 node 里加载本模块是安全的。
 */
export function mount(host, ctx) {
  if (host === null || typeof host !== "object" || typeof host.appendChild !== "function") {
    return () => {};
  }
  const doc = host.ownerDocument;
  if (doc === null || doc === undefined || typeof doc.createElement !== "function") return () => {};

  const config = ctx ?? {};
  const api = typeof config.api === "function" ? config.api : null;
  const role = typeof config.role === "string" && config.role !== "" ? config.role : "agent";
  const toast = typeof config.toast === "function" ? config.toast : () => {};

  const state = {
    status: DEFAULT_STATUS,
    page: 1,
    total: 0,
    items: [],
    noHit: [],
    busy: false,
    alive: true,
    seq: 0,
    noHitSeq: 0,
  };

  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /* 头部：标题 + 状态 Tab */
  const head = make("div", "admin-head");
  head.appendChild(make("h2", "admin-title", "FAQ 草稿"));
  const tabs = make("div", "tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "草稿状态");
  const tabNodes = new Map();
  for (const [value, label] of STATUS_OPTIONS) {
    const button = make("button", "tab-btn", label);
    button.type = "button";
    button.dataset.draftStatus = value;
    button.setAttribute("role", "tab");
    tabs.appendChild(button);
    tabNodes.set(value, button);
  }
  head.appendChild(tabs);
  host.appendChild(head);

  host.appendChild(
    make(
      "p",
      "admin-note",
      "通过会把答案切块写进索引（用户下次问同样的问题就能检索到）；驳回只留档，不影响现有答案。",
    ),
  );

  const stateNode = make("div", "admin-state");
  stateNode.setAttribute("role", "status");
  host.appendChild(stateNode);

  /* 草稿表 */
  const thead = doc.createElement("thead");
  thead.innerHTML = `<tr>
    <th scope="col">问题</th><th scope="col">语言</th><th scope="col">来源</th>
    <th scope="col">状态</th><th scope="col">提交时间</th><th scope="col">操作</th>
  </tr>`;
  const rowsNode = doc.createElement("tbody");
  rowsNode.setAttribute("data-draft", "rows");
  const table = doc.createElement("table");
  table.className = "admin-report-table";
  table.appendChild(thead);
  table.appendChild(rowsNode);
  const tableWrap = make("div", "admin-report-wrap");
  tableWrap.appendChild(table);
  host.appendChild(tableWrap);

  /* 分页 + 刷新 */
  const pager = make("div", "admin-report-pager");
  const prevButton = make("button", "admin-report-btn", "上一页");
  prevButton.type = "button";
  prevButton.dataset.draftAct = "prev";
  const infoNode = make("span", "admin-report-page");
  const nextButton = make("button", "admin-report-btn", "下一页");
  nextButton.type = "button";
  nextButton.dataset.draftAct = "next";
  const reloadButton = make("button", "admin-report-btn", "刷新");
  reloadButton.type = "button";
  reloadButton.dataset.draftAct = "reload";
  for (const node of [prevButton, infoNode, nextButton, reloadButton]) pager.appendChild(node);
  host.appendChild(pager);

  /* 未命中池（第二节） */
  const noHitTitle = make("h3", "admin-section-title", "未命中池");
  host.appendChild(noHitTitle);
  host.appendChild(make("p", "admin-note", NO_HIT_HINT));
  const noHitState = make("div", "admin-state");
  noHitState.setAttribute("role", "status");
  host.appendChild(noHitState);

  const noHitHead = doc.createElement("thead");
  noHitHead.innerHTML = `<tr>
    <th scope="col">问题</th><th scope="col">语言</th><th scope="col">次数</th>
    <th scope="col">最近</th><th scope="col">已有草稿</th>
  </tr>`;
  const noHitRows = doc.createElement("tbody");
  noHitRows.setAttribute("data-faq", "no-hit-rows");
  const noHitTable = doc.createElement("table");
  noHitTable.className = "admin-report-table";
  noHitTable.appendChild(noHitHead);
  noHitTable.appendChild(noHitRows);
  const noHitWrap = make("div", "admin-report-wrap");
  noHitWrap.appendChild(noHitTable);
  host.appendChild(noHitWrap);

  function setState(text, tone) {
    stateNode.className = `admin-state${tone === undefined || tone === "" ? "" : ` ${tone}`}`;
    stateNode.textContent = text;
  }

  function setNoHitState(text, tone) {
    noHitState.className = `admin-state${tone === undefined || tone === "" ? "" : ` ${tone}`}`;
    noHitState.textContent = text;
  }

  function syncTabs() {
    for (const [value, button] of tabNodes) {
      const on = value === state.status;
      button.setAttribute("aria-selected", String(on));
      button.classList.toggle("is-active", on);
    }
  }

  function paint() {
    rowsNode.innerHTML = draftsRowsHtml(state.items, role);
    const info = pageInfo(state.total, state.page);
    infoNode.textContent = info.text;
    prevButton.disabled = !info.hasPrev;
    nextButton.disabled = !info.hasNext;
    reloadButton.disabled = state.busy;
    syncTabs();
  }

  function paintNoHit() {
    noHitRows.innerHTML = noHitRowsHtml(state.noHit);
    setNoHitState(state.noHit.length === 0 ? "未命中池是空的：最近没有反复答不出的问题。" : "", "");
  }

  async function load() {
    const token = ++state.seq;
    setState("正在加载…", "is-loading");
    const result = await callApi(api, `/api/console/drafts?${buildDraftQuery(state, state.page)}`, {
      method: "GET",
    });
    if (!state.alive || token !== state.seq) return; // 已经切走 / 已经换了筛选：旧响应不能盖新结果
    if (!result.ok) {
      state.items = [];
      state.total = 0;
      paint();
      setState(errorText(result.error), "is-error");
      return;
    }
    const items = Array.isArray(result.data?.items) ? result.data.items : [];
    const total = Number(result.data?.total);
    state.items = items;
    state.total = Number.isFinite(total) ? total : items.length;
    const info = pageInfo(state.total, state.page);
    if (state.page > info.pages) {
      state.page = info.pages; // 处置后总数变少：回到最后一页，不停在空页上
      await load();
      return;
    }
    paint();
    setState(items.length === 0 ? emptyText(state.status) : "", "");
  }

  /**
   * 未命中池：403 是**预期内**的（`agent` 看不到；本面板对 agent 不可达，但降权之后可能撞上），
   * 所以只把那一节标成"权限不足"，不让整块面板变红 —— 上半部分的草稿列表仍然可用。
   */
  async function loadNoHit() {
    const token = ++state.noHitSeq;
    setNoHitState("正在加载…", "is-loading");
    const result = await callApi(api, `/api/console/no-hit?${buildNoHitQuery()}`, { method: "GET" });
    if (!state.alive || token !== state.noHitSeq) return;
    if (!result.ok) {
      state.noHit = [];
      paintNoHit();
      setNoHitState(errorText(result.error), "is-error");
      return;
    }
    state.noHit = Array.isArray(result.data?.items) ? result.data.items : [];
    paintNoHit();
  }

  async function resolve(id, action) {
    if (id === "" || state.busy) return;
    const row = state.items.find((item) => String(item?.id) === id);
    const permission = action === "approve" ? canApprove(row, role) : canReject(row, role);
    if (!permission.enabled) {
      // 没权限时按钮本来就是禁用的，走到这里只可能是键盘 / 脚本触发：说清原因，不打请求。
      toast(permission.reason === "" ? "这份草稿现在不能处置。" : permission.reason);
      return;
    }
    state.busy = true;
    paint();
    const result = await callApi(
      api,
      `/api/console/drafts/${encodeURIComponent(id)}/${action === "approve" ? "approve" : "reject"}`,
      { method: "POST" },
    );
    if (!state.alive) return;
    state.busy = false;
    if (!result.ok) {
      const code = String(result.error?.code ?? "");
      if (code === "CONFLICT" || code === "NOT_FOUND") {
        await load(); // 别人已经处置过 / 这条没了：先把最新状态拉回来，再说明发生了什么
        if (!state.alive) return;
      }
      setState(errorText(result.error), "is-error");
      // 通过失败多半是索引侧（嵌入不可用 / 正文重复）：一定要说清"审批没生效"。
      if (action === "approve") toast("审批未生效，草稿仍是待审");
      return;
    }
    const changed = Array.isArray(result.data?.changed) ? result.data.changed : [];
    if (action === "approve") {
      toast(changed.length === 0 ? "这份草稿已经是通过态" : "已通过：答案已切块写入索引");
    } else {
      toast(changed.length === 0 ? "这份草稿已经是驳回态" : "已驳回");
    }
    await load();
    if (!state.alive) return;
    void loadNoHit(); // 通过/驳回都会改变"已有草稿"那一列的语义，顺手刷新
  }

  function setStatus(value) {
    const next = STATUS_VALUES.includes(value) ? value : DEFAULT_STATUS;
    if (next === state.status) return;
    state.status = next;
    state.page = 1;
    syncTabs();
    void load();
  }

  function run(name, id) {
    if (name === "prev") {
      const info = pageInfo(state.total, state.page);
      if (!info.hasPrev) return;
      state.page = info.page - 1;
      void load();
      return;
    }
    if (name === "next") {
      const info = pageInfo(state.total, state.page);
      if (!info.hasNext) return;
      state.page = info.page + 1;
      void load();
      return;
    }
    if (name === "reload") {
      void load();
      void loadNoHit();
      return;
    }
    if (name === "approve" || name === "reject") void resolve(id, name);
  }

  function onClick(event) {
    // 不用 `instanceof Element`：这条判定要能在没有 DOM 的环境里跑（测试用假 DOM）。
    const target = event?.target;
    if (target === null || target === undefined || typeof target.closest !== "function") return;

    const tab = target.closest("[data-draft-status]");
    if (tab !== null && tab !== undefined) {
      setStatus(String(tab.dataset.draftStatus ?? ""));
      return;
    }

    const action = target.closest("[data-draft-act]");
    if (action === null || action === undefined) return;
    if (action.disabled === true) return;
    run(String(action.dataset.draftAct ?? ""), String(action.dataset.draftId ?? ""));
  }

  host.addEventListener("click", onClick);

  syncTabs();
  paint();
  void load();
  void loadNoHit();

  return function unmount() {
    state.alive = false;
    state.seq += 1; // 让在途请求的回填全部落空
    state.noHitSeq += 1;
    host.removeEventListener("click", onClick);
    host.replaceChildren();
  };
}

export default mount;
