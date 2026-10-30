/**
 * 故障反馈待审面板（`09#04` 的反馈闭环；`docs/prdv1.2/05-api.md` §5.7 / D16·D26·R26）。
 *
 * 这张面板存在的理由写在 `core/admin-store.ts` 的反馈面文件头：`v_no_hit` 是现成的反例 ——
 * 有数据、没消费，一个月后就是第二个死池子。所以后端的两条通路（列表 + 处置）必须有界面，
 * 而且默认视图是"还没处置的"（`status=new`），处置完那一行就从默认列表里消失。
 *
 * 一个模块、一个出口：`mount(host, ctx) → unmount`。父容器只给一个空 `<div>`；所有网络都走
 * `ctx.api`（票据、401 清场、403 只提示都在那一层，本模块看不见票据）。
 *
 * 三条约束（与 `console-admin-faults.js` / `console-admin-board.js` 同一套，为了能在 node 里断言）：
 *   1. **顶层零副作用**：不出现宿主对象、不发请求、不引用任何别的模块。可测的判定全部是导出纯函数，
 *      DOM 只活在 `mount()` 里。`tests/web-admin-reports.test.ts` 有一条静态断言盯着这一点。
 *   2. **判定只写一遍**：`canResolve` 既给按钮用、也给"为什么点不了"的提示用。按钮禁用只是
 *      **免挫败**，接口层（`src/api/roles.ts` 的 `ROUTE_MIN_ROLE`）仍然会再判一次。
 *   3. **处置之后重新拉取，不前端硬删**：`total`、分页与"这条还在不在"都由服务端说了算；
 *      本地把行删掉会让 `total` 与列表对不上，翻页也会跳。
 *
 * 与后端的对应：
 *   列表 `GET /api/admin/fault-reports?status=new|merged|rejected&page=&size=`（`lead` 起）
 *   处置 `PATCH /api/admin/fault-reports/:id` body `{ action: "merge" | "reject" }`（`lead` 起）
 *
 * **`merge` 只改状态，不在这里建码**：一个 PATCH 顺手写 `fault_codes` 会让"谁写的这条码"
 * 在审计里对不上（建码的审计是 `fault.create`，处置的审计是 `fault_report.merge`）。
 * 所以合并的提示是"请到「故障卡」面板新建一条 draft"。
 */

/* ───────────────────────── 常量 ───────────────────────── */

/**
 * 一页多少条 = `src/core/ticket-queue.ts` 的 `QUEUE_PAGE_SIZE_DEFAULT`（`api/params.ts` 的
 * `size` 缺省值就是它）。前端算页数必须和这个数一致，否则"共 3 页"点完是空页。
 * 查询串里**显式**带上 `size`：两处默认值将来各改一半时，面板至少还是自洽的。
 */
export const PAGE_SIZE = 20;

/** 默认只看待审（与 `api/admin.ts` 的 `parseReportQuery` 缺省一致）。 */
export const DEFAULT_STATUS = "new";

/** 状态清单（顺序即 Tab 顺序）= 后端 `FAULT_REPORT_STATUS_VALUES`。 */
export const STATUS_OPTIONS = Object.freeze([
  ["new", "待审"],
  ["merged", "已合并"],
  ["rejected", "已忽略"],
]);

const STATUS_VALUES = Object.freeze(STATUS_OPTIONS.map(([value]) => value));
const STATUS_LABEL = Object.freeze({ new: "待审", merged: "已合并", rejected: "已忽略" });

/** 数据源 = 后端 `FAULT_REPORT_SOURCE_VALUES`（`page|chat|ticket`）。 */
const SOURCE_LABEL = Object.freeze({ page: "故障码页", chat: "对话", ticket: "工单" });

/** 母语名自显（与用户端顶部语言菜单、故障卡面板的 Tab 同一套写法）。 */
const LANG_LABEL = Object.freeze({
  zh: "中文",
  en: "English",
  de: "Deutsch",
  nl: "Nederlands",
  es: "Español",
});

/** 合并后要说的那一步。这句话在三个地方出现（面板说明、按钮 title、成功提示），只写一遍。 */
export const MERGE_HINT = "合并只改状态，不会自动生成故障码；请到「故障卡」面板新建一条 draft";

const ACTIONS = Object.freeze(["merge", "reject"]);

/* ───────────────────────── 小工具 ───────────────────────── */

/** 唯一的转义出口：码、产线、摘录、语言全都是外部输入（摘录是用户打的字）。 */
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

/** 来源：认识的翻中文，不认识的原样带回（宁可显示后端的原文，也不编一句看起来合理的话）。 */
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

/**
 * 这一行能不能处置。返回 `{ visible, enabled, reason }`：
 * `visible` 决定画不画按钮，`enabled` 决定能不能点，`reason` 是"为什么不能点"（画在 title 上）。
 *
 * 两个门槛与后端**同集**：角色 `lead` 起（`ROUTE_MIN_ROLE` 里这两条都是 `lead`）；
 * 状态必须是 `new`（`resolveFaultReport` 对已处置的行回 409 `CONFLICT`）。
 * 未知角色按最低档处理 —— 与 `src/auth.ts` 的 `requireRole` 同口径。
 */
export function canResolve(row, role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  const status = String(row?.status ?? DEFAULT_STATUS);
  if (normalized !== "lead" && normalized !== "admin") {
    return { visible: false, enabled: false, reason: "处置待审反馈需要坐席主管（lead）或管理员角色。" };
  }
  if (status !== "new") {
    return { visible: true, enabled: false, reason: `这条反馈已经处置过（${statusLabel(status)}），不能再改。` };
  }
  return { visible: true, enabled: true, reason: "" };
}

/**
 * 处置体：只认 `merge` / `reject` 两个字符串（后端 `FAULT_REPORT_ACTION_VALUES`）。
 * 不认识的动作回 `null`，**绝不**回一个看起来合理的 `{ action: "reject" }` —— 猜错方向
 * 等于把一条待审反馈静默丢掉。终态由 action 推导，客户端没有机会直接写 `status`。
 */
export function resolveBody(action) {
  const value = String(action ?? "").trim();
  return ACTIONS.includes(value) ? { action: value } : null;
}

/* ───────────────────────── 查询与分页 ───────────────────────── */

/** 筛选 → 查询串。状态一律发（默认 `new`）；空 / 非法状态回落默认值，不把拼错的值发给后端。 */
export function buildReportQuery(filters, page = 1) {
  const source = filters ?? {};
  const wantedStatus = String(source.status ?? "");
  const status = STATUS_VALUES.includes(wantedStatus) ? wantedStatus : DEFAULT_STATUS;
  const wantedPage = Math.trunc(Number(page));
  const current = Number.isFinite(wantedPage) && wantedPage > 0 ? wantedPage : 1;
  const params = new URLSearchParams();
  params.set("status", status);
  params.set("page", String(current));
  params.set("size", String(PAGE_SIZE));
  return params.toString();
}

/**
 * 分页信息：`{ total, page, pages, hasPrev, hasNext, text }`。
 * `page` 夹在 `[1, pages]`（`total=0` 时是 1 页）：把 `page` 交给调用方之前先夹住，
 * 按钮的禁用与"第 x / y 页"就用同一个数，不会出现"显示第 3 页、上一页还是灰的"。
 */
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

/* ───────────────────────── 状态文案 ───────────────────────── */

/** 空列表的文案：要区分"没有待审的"与"还没处置过任何一条"（后者不是异常）。 */
export function emptyText(status) {
  const key = String(status ?? DEFAULT_STATUS);
  if (key === "new") return "没有待审反馈。用户查了不存在的故障码时会自动上报一条。";
  if (key === "merged") return "还没有已合并的反馈。";
  if (key === "rejected") return "还没有已忽略的反馈。";
  return "这里没有反馈。";
}

/** 错误码 → 面板上能直接显示的一句话（后端 message 是英文给日志看的）。 */
export function errorText(error) {
  const code = String(error?.code ?? "");
  const message = typeof error?.message === "string" ? error.message : "";
  if (code === "FORBIDDEN") return "权限不足：查看与处置待审反馈需要坐席主管（lead）或管理员角色。";
  if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID") return "登录状态已失效，请重新登录。";
  if (code === "NETWORK") return "连不上服务端，请确认服务已启动。";
  if (code === "NOT_FOUND") return "这条反馈不存在了（可能已被删除），请刷新列表。";
  if (code === "CONFLICT") return message === "" ? "这条反馈已被处置，列表已刷新。" : message;
  if (code === "VALIDATION") return message === "" ? "参数不合法。" : message;
  if (/^HTTP_5\d\d$/.test(code)) return "服务端出错了，这一屏的数据可能不是最新。";
  return message === "" ? "请求失败。" : message;
}

/**
 * 把 `ctx.api` 的返回值归一成 `{ ok, data } | { ok: false, error }`。
 *
 * 两种挂载都认：契约上的 `api()` 回信封（`{ ok, data }`），而坐席端现有的 `api()` 成功时
 * 直接回 `data`、失败时**抛**（`console.js` 那一层；骨架的 `panelApi` 又会把它包成信封）。
 * 一份适配代码，胜过让两侧各记住一种约定。
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
 * 表格行。列固定七格：`code | 产线 | 来源 | 语言 | 摘录 | 上报时间 | 操作`。
 *
 * 两个按钮都带 `data-report-id`（处置哪一条）与 `data-report-act`（做什么）。`role` 只影响
 * 按钮是否禁用（`canResolve`）；即便有人手工点，接口层还会再判一次 403 / 409。
 */
export function reportsRowsHtml(items, role = "lead") {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item) => {
      const id = String(item?.id ?? "");
      const quote = typeof item?.quote === "string" ? item.quote.trim() : "";
      const permission = canResolve(item, role);
      const disabled = permission.enabled ? "" : " disabled";
      const mergeReason = permission.reason === "" ? MERGE_HINT : permission.reason;
      const rejectReason = permission.reason === "" ? "标记为忽略：不会生成故障码，也不能再改成合并" : permission.reason;
      const buttons = permission.visible
        ? `<button class="admin-report-btn" type="button" data-report-act="merge" data-report-id="${esc(id)}" title="${esc(mergeReason)}"${disabled}>合并</button>
      <button class="admin-report-btn is-danger" type="button" data-report-act="reject" data-report-id="${esc(id)}" title="${esc(rejectReason)}"${disabled}>忽略</button>`
        : "—";
      return `<tr class="admin-report-row" data-report-row="${esc(id)}">
  <td class="admin-report-code">${esc(item?.code ?? "")}</td>
  <td>${esc(item?.product_line ?? "")}</td>
  <td>${esc(sourceLabel(item?.source))}</td>
  <td>${esc(langLabel(item?.lang))}</td>
  <td class="admin-report-quote"${quote === "" ? "" : ` title="${esc(quote)}"`}>${quote === "" ? "—" : esc(quote)}</td>
  <td class="admin-report-time">${esc(formatStamp(item?.created_at))}</td>
  <td class="admin-report-ops">${buttons}</td>
</tr>`;
    })
    .join("");
}

/* ───────────────────────── 挂载 ───────────────────────── */

/**
 * `host` 是一个空 `<div>`；`ctx` 见文件头。返回卸载函数（摘监听、清内容）。
 * 这里才开始碰 DOM —— 文件顶层一个宿主对象都没有，所以在 node 里加载本模块是安全的。
 *
 * `host` 不合法（`null` / 不是元素 / 拿不到宿主文档）时返回 no-op 卸载函数：骨架崩了整页就白屏，
 * 而"面板画不出来"最多是这一屏空着。
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
    busy: false,
    alive: true,
    seq: 0,
  };

  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /* 头部：标题 + 状态 Tab（Tab 只换 `status`，不换页面位置） */
  const head = make("div", "admin-head");
  head.appendChild(make("h2", "admin-title", "待审反馈"));
  const tabs = make("div", "tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "反馈状态");
  const tabNodes = new Map();
  for (const [value, label] of STATUS_OPTIONS) {
    const button = make("button", "tab-btn", label);
    button.type = "button";
    button.dataset.reportStatus = value;
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
      `${MERGE_HINT}。「摘录」是用户查码时的短摘录（≤200 字），不含问题原文。`,
    ),
  );

  const stateNode = make("div", "admin-state");
  stateNode.setAttribute("role", "status");
  host.appendChild(stateNode);

  /* 列表：表头是静态的，`<tbody>` 由 `reportsRowsHtml` 整块重画 */
  const thead = doc.createElement("thead");
  thead.innerHTML = `<tr>
    <th scope="col">code</th><th scope="col">产线</th><th scope="col">来源</th>
    <th scope="col">语言</th><th scope="col">摘录</th><th scope="col">上报时间</th><th scope="col">操作</th>
  </tr>`;
  const rowsNode = doc.createElement("tbody");
  rowsNode.setAttribute("data-report", "rows");
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
  prevButton.dataset.reportAct = "prev";
  const infoNode = make("span", "admin-report-page");
  const nextButton = make("button", "admin-report-btn", "下一页");
  nextButton.type = "button";
  nextButton.dataset.reportAct = "next";
  const reloadButton = make("button", "admin-report-btn", "刷新");
  reloadButton.type = "button";
  reloadButton.dataset.reportAct = "reload";
  for (const node of [prevButton, infoNode, nextButton, reloadButton]) pager.appendChild(node);
  host.appendChild(pager);

  function setState(text, tone) {
    stateNode.className = `admin-state${tone === undefined || tone === "" ? "" : ` ${tone}`}`;
    stateNode.textContent = text;
  }

  function syncTabs() {
    for (const [value, button] of tabNodes) {
      const on = value === state.status;
      button.setAttribute("aria-selected", String(on));
      button.classList.toggle("is-active", on);
    }
  }

  function paint() {
    rowsNode.innerHTML = reportsRowsHtml(state.items, role);
    const info = pageInfo(state.total, state.page);
    infoNode.textContent = info.text;
    prevButton.disabled = !info.hasPrev;
    nextButton.disabled = !info.hasNext;
    reloadButton.disabled = state.busy;
    syncTabs();
  }

  async function load() {
    const token = ++state.seq;
    setState("正在加载…", "is-loading");
    const result = await callApi(api, `/api/admin/fault-reports?${buildReportQuery(state, state.page)}`, {
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
      // 处置 / 换筛选之后总数变少：回到最后一页，而不是停在一个空页上
      state.page = info.pages;
      await load();
      return;
    }
    paint();
    setState(items.length === 0 ? emptyText(state.status) : "", "");
  }

  async function resolve(id, action) {
    const body = resolveBody(action);
    if (body === null || id === "" || state.busy) return;
    const row = state.items.find((item) => String(item?.id) === id);
    const permission = canResolve(row, role);
    if (!permission.enabled) {
      // 没权限时按钮本来就是禁用的，走到这里只可能是键盘 / 脚本触发：说清原因，不打请求。
      toast(permission.reason === "" ? "这条反馈现在不能处置。" : permission.reason);
      return;
    }
    state.busy = true;
    paint();
    const result = await callApi(api, `/api/admin/fault-reports/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
    });
    if (!state.alive) return;
    state.busy = false;
    if (!result.ok) {
      // 409 / 404 = 别人已经处置过或这条没了：先把最新状态拉回来，再说明发生了什么。
      const code = String(result.error?.code ?? "");
      if (code === "CONFLICT" || code === "NOT_FOUND") {
        await load();
        if (!state.alive) return;
      }
      setState(errorText(result.error), "is-error");
      return;
    }
    const changed = Array.isArray(result.data?.changed) ? result.data.changed : [];
    if (action === "merge") {
      toast(changed.length === 0 ? "这条反馈已经是合并态" : `已合并。${MERGE_HINT}`);
    } else {
      toast(changed.length === 0 ? "这条反馈已经是忽略态" : "已忽略");
    }
    // 重新拉取（不前端硬删）：`total`、分页与"还在不在"都由服务端决定
    await load();
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
      return;
    }
    if (name === "merge" || name === "reject") void resolve(id, name);
  }

  function onClick(event) {
    // 不用 `instanceof Element`：这条判定要能在没有 DOM 的环境里跑（测试用假 DOM）。
    const target = event?.target;
    if (target === null || target === undefined || typeof target.closest !== "function") return;

    const tab = target.closest("[data-report-status]");
    if (tab !== null && tab !== undefined) {
      setStatus(String(tab.dataset.reportStatus ?? ""));
      return;
    }

    const action = target.closest("[data-report-act]");
    if (action === null || action === undefined) return;
    if (action.disabled === true) return;
    run(String(action.dataset.reportAct ?? ""), String(action.dataset.reportId ?? ""));
  }

  host.addEventListener("click", onClick);

  syncTabs();
  paint();
  void load();

  return function unmount() {
    state.alive = false;
    state.seq += 1; // 让在途请求的回填全部落空
    host.removeEventListener("click", onClick);
    host.replaceChildren();
  };
}

export default mount;
