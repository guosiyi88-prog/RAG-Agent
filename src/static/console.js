/**
 * 坐席端控制器（`11-ui-console.md`；工单 `07-console-and-security` #02 的前端一半）。
 *
 * **中文字面量是刻意例外，不是漏做 i18n**：坐席端是内部工具，`12-i18n.md` 的文案表只覆盖用户端，
 * PRD 已把它写进已知限制。所以本文件没有 `data-i18n`、不产生任何 `console.*` 文案 key。
 *
 * 与 `user.js` 同一套风格：原生 ES module、无框架、无构建、无 npm 依赖。三层分工：
 *   `lib/console-sla.js`       SLA 倒计时（后端只给一次秒数，之后 30 秒一跳全在本地）
 *   `lib/console-route.js`     锚点 `#/ticket/<id>` 的解析与生成
 *   `lib/console-draft.js`     草稿的按单隔离 + 防抖落盘
 *   `lib/console-keys.js`      event → 动作（含"输入框里不劫持打字"）
 *   `lib/console-resolution.js` 关单结论的字符计数与阈值
 *   `lib/console-time.js`      本地时区的时间格式
 *   `lib/console-view.js`      入参 → HTML 字符串（唯一需要转义的地方）
 *   `lib/console-admin-shell.js` 角色 → 导航项、管理面板的懒加载与卸载（面板各自一个模块，切过去才 import）
 * 本文件只做请求、状态机与事件绑定。行数超过 `09-ui-tokens.md` §9 的"单个 JS ≤400 行"：
 * 那条是**移动端首屏**的下载/解析预算，坐席端是桌面内网工具；能拆的纯逻辑已经全拆到 `lib/console-*.js`，
 * 剩下的 Gate + 请求 + 队列 + 详情 + 路由 + 键盘 + 导航切面板本来就是一处状态机的几面，再切只会多一层 import 间接。
 *
 * 接口一律照 `05-api.md` §4.1–§4.3 的字段名逐字对接，不自创字段；后端没给的东西宁可显示
 * "耗时未记录"/"—"，也不猜一个看起来合理的值塞进去（猜错的值会被坐席当成事实）。
 */
import { formatSla, remainingSeconds, slaFor } from "./lib/console-sla.js";
import { linkFor, parseHash, ticketHash } from "./lib/console-route.js";
import { createDraftStore } from "./lib/console-draft.js";
import { ACTION, isEditableTarget, mapKey } from "./lib/console-keys.js";
import { countChars, isValidResolution, normalizeResolution, resolutionHint } from "./lib/console-resolution.js";
// 管理面板骨架（09#05）：角色 → 导航项、面板懒加载与卸载。面板实现各自一个模块，
// 路径表在骨架里（`PANEL_MODULES`），这里只认 `data-nav` 这个稳定键。
import {
  applyRoleToNav,
  createAdminShell,
  isAdminNav,
  normalizeRole,
  visibleNavItems,
} from "./lib/console-admin-shell.js";
import {
  actionsHtml,
  canDispatch,
  citeCardHtml,
  citesHtml,
  detailHtml,
  dispatchBody,
  faqDraftBody,
  faqHint,
  metaHtml,
  queueHtml,
  rowHtml,
  shouldDispatch,
  threadHtml,
} from "./lib/console-view.js";

/** 轮询 5s（11 §2.4）：低于这个数只是白白给 Redis 加热，高于它"新单几秒内出现"就不成立。 */
const POLL_MS = 5000;
/** SLA 每 30 秒本地重算一次，**不重新请求**（工单 07#02 第一条）。 */
const SLA_TICK_MS = 30000;
/** 新单高亮持续多久：PRD §2.4 写 300ms（闪一下），工单要求"几秒后自行消退"，取 4s。 */
const NEW_HIGHLIGHT_MS = 4000;
const SEARCH_DEBOUNCE_MS = 300;
const TOAST_MS = 3500;
/** 默认排除已关闭（05 §4.1 的 `status` 默认值）。 */
const DEFAULT_STATUS = "open,claimed,escalated";
const SIZE_CHOICES = [20, 50, 100];
/** `token` 这个键名沿用旧称，现在存的是**服务端会话票据**（`POST /api/auth/login` 的 `data.ticket`）；`staff` 只是显示名。 */
const STORE = { token: "wt:console:token", staff: "wt:console:staff", size: "wt:console:size" };

const state = {
  token: null,
  staffName: null,
  /** 会话角色（`GET /api/console/me` 的 `role`，未知按 agent 处理）。只决定导航显隐，不是安全边界。 */
  role: null,
  view: "queue", // queue | detail
  ticketId: null,
  items: [],
  total: 0,
  page: 1,
  size: 20,
  filter: { status: DEFAULT_STATUS, reason: "", q: "" },
  known: new Set(), // 上一次列表里的 id：用来找"新单"，也用来避免首屏把整页都闪一遍
  polledOnce: false,
  snapshots: new Map(), // id → { dueAt, secondsLeft, at }，本地倒计时的基线
  assigneeById: new Map(), // 本机认领过的单：PATCH 返回值不保证带名字时用它兜底
  /**
   * 派发用的人员列表（`GET /api/admin/staff`，`lead` 起）。**每次登录只取一次**：
   * 坐席名单在一个班次里几乎不变，而它只在详情页用一个下拉。
   * `staffError` 非空时下拉禁用并说明原因 —— 不做"看起来能选、选了没反应"。
   */
  staff: [],
  staffLoaded: false,
  staffLoading: false,
  staffError: "",
  /** 一次派发 PATCH 正在进行：整块下拉禁用，防连点重复派发（审计里会多出几条空记录）。 */
  dispatching: false,
  ticket: null,
  messages: [],
  detailFetchedAt: 0,
  detailError: null,
  detailLoading: false,
  threadSticky: true,
  selectedIndex: -1,
  queueLoading: false,
  pollTimer: 0,
  slaTimer: 0,
  toastTimer: 0,
  searchTimer: 0,
};

const ui = {}; // DOM 引用：缺元素按 null 跳过，一处缺失不该炸掉整页
const draft = createDraftStore(globalThis.localStorage);
/** 管理面板骨架（`lib/console-admin-shell.js`）：`bind()` 里建，`#admin-panel` 缺失时为 null。 */
let shell = null;

/* ───────────────────────── 小工具 ───────────────────────── */

const failure = (code, message) => Object.assign(new Error(message ?? code), { code });
const newTraceId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;

function toast(message) {
  if (!ui.toast) return;
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true;
  }, TOAST_MS);
}

/** 错误码 → 坐席看得懂的一句话。后端 error.message 是英文给日志看的，这里不直接甩给用户。 */
function hintFor(err) {
  const code = err?.code ?? "";
  if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID") return "会话已过期，请重新登录。";
  // 403 与 401 必须分开（D31）：权限不足不是"没登录"，清掉登录态会让人白登一遍。
  if (code === "FORBIDDEN") return "权限不足：这个操作需要更高的角色。";
  if (code === "NOT_FOUND") return "工单不存在，或坐席接口尚未上线（404）。";
  if (code === "TICKET_IMMUTABLE") return "工单已关闭，不能再修改。";
  if (code === "VALIDATION") return "参数不合法（关单结论至少 10 字）。";
  if (code === "RATE_LIMITED") return "请求过于频繁，请稍后再试。";
  if (code === "NOT_IMPLEMENTED") return "本期未开放。";
  // 409 是"状态不允许这个动作"（已升级/已被处置/正文重复）；后端 message 写的是人能读的那句，
  // 直接用它比这里编一句更准（`errors.ts` 的 CONFLICT 就是给这类场景的）。
  if (code === "CONFLICT") return err?.message ?? "这条数据的状态不允许这个动作。";
  if (code === "EMBED_UNAVAILABLE") return "嵌入服务暂时不可用，请稍后再试。";
  if (code === "NETWORK") return "连不上服务端，请看服务是否已启动。";
  return err?.message ?? "请求失败。";
}

/* ───────────────────────── 登录闸门 ───────────────────────── */

function showGate(message) {
  document.body.dataset.auth = "missing";
  stopPolling();
  if (!ui.gate) return;
  ui.gate.hidden = false;
  if (message) {
    ui.gateError.textContent = message;
    ui.gateError.hidden = false;
  }
  // 邮箱填好了就让焦点落在口令上：坐席只有一个账号，每次都要把光标从邮箱挪下去是纯摩擦。
  if ((ui.gateEmail?.value ?? "") !== "") ui.gatePassword?.focus();
  else ui.gateEmail?.focus();
}

function hideGate() {
  document.body.dataset.auth = "ok";
  if (!ui.gate) return;
  ui.gate.hidden = true;
  ui.gateError.hidden = true;
}

function onAuthLost() {
  // 保留已输入的邮箱、清掉口令：会话过期是常事（TTL 12h），让人重输一遍邮箱没有意义。
  const email = ui.gateEmail?.value ?? "";
  state.token = null;
  state.staffName = null;
  state.role = null;
  // 面板与导航一起收回最小可见：登录页底下不该还挂着一块"管理面板"，
  // 也不该让下一个账号看到上一个账号的角色渲染出来的导航项。
  closeAdminPanel();
  applyRole(null);
  globalThis.localStorage?.removeItem(STORE.token);
  globalThis.localStorage?.removeItem(STORE.staff);
  if (ui.agentName) ui.agentName.textContent = "坐席";
  if (ui.gateEmail && email !== "") ui.gateEmail.value = email;
  if (ui.gatePassword) ui.gatePassword.value = "";
  showGate("会话已过期，请重新登录。");
}

/** 登录失败的文案与"请求失败"必须分开：`AUTH_INVALID` 在这里的意思是"邮箱或口令不对"。 */
function hintForLogin(err) {
  const code = err?.code ?? "";
  if (code === "AUTH_INVALID" || code === "AUTH_REQUIRED") return "邮箱或口令不正确。";
  return hintFor(err);
}

async function submitGate(event) {
  event.preventDefault();
  const email = (ui.gateEmail?.value ?? "").trim();
  const password = ui.gatePassword?.value ?? "";
  if (email === "" || password === "") {
    ui.gateError.textContent = "请填写邮箱与口令";
    ui.gateError.hidden = false;
    return;
  }
  ui.gateSubmit.disabled = true;
  ui.gateError.hidden = true;
  try {
    // `anonymous: true`：登录本身不需要票据，且它的 401 不该触发"会话过期"那条清场逻辑。
    const data = await api("/api/auth/login", { method: "POST", body: { email, password }, anonymous: true });
    const ticket = typeof data?.ticket === "string" ? data.ticket : "";
    if (ticket === "") throw failure("AUTH_REQUIRED", "登录未返回票据");
    state.token = ticket;
    globalThis.localStorage?.setItem(STORE.token, ticket);
    const name = typeof data?.staff?.name === "string" ? data.staff.name : "";
    state.staffName = name === "" ? null : name;
    if (state.staffName !== null) globalThis.localStorage?.setItem(STORE.staff, state.staffName);
    // 角色就地取（登录响应里已经带 `staff.role`）：不再多打一次 `/api/console/me`。
    // 刷新页面时那条路由才走（`verifySession`），两条路都只认服务端给的 role，不猜。
    applyRole(data?.staff?.role);
    if (ui.agentName) ui.agentName.textContent = state.staffName ?? "坐席";
    if (ui.gatePassword) ui.gatePassword.value = "";
    hideGate();
    syncRoute();
  } catch (err) {
    // 与旧令牌时代不同：没有票据就什么都看不到（每条接口都要会话），所以失败一律停在登录页。
    // 429（同 IP 5 次/分钟）也走这里 —— 它比"口令错了"更该被看见。
    ui.gateError.textContent = hintForLogin(err);
    ui.gateError.hidden = false;
  } finally {
    ui.gateSubmit.disabled = false;
  }
}

async function signOut() {
  const ticket = state.token;
  state.token = null;
  state.staffName = null;
  state.role = null;
  closeAdminPanel();
  applyRole(null);
  globalThis.localStorage?.removeItem(STORE.token);
  globalThis.localStorage?.removeItem(STORE.staff);
  if (ui.agentName) ui.agentName.textContent = "坐席";
  showGate("已退出，请重新登录。");
  if (ticket === null) return;
  // 只在服务端吊销那张票据；本地状态已经清完了，吊销失败的最坏结果是它活到 TTL（12h）。
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { accept: "application/json", "x-staff-session": ticket },
      cache: "no-store",
    });
  } catch {
    // 离线登出也算登出：本地票据已删，页面不会再拿它发请求。
  }
}

/* ───────────────────────── 请求 ───────────────────────── */

/**
 * 唯一的请求出口：所有请求都带 `X-Staff-Session`（登录签发的会话票据）。
 * 票据**绝不**出现在 URL、`console.*` 与响应体里 —— 只在这一行进请求头。
 *
 * 也不再有 `X-Admin-Staff` 这个自称头（已退场）：认领时的"我"由服务端会话决定，客户端无法自称
 * （`09#03` / boundary-change-R2 §3 B5）。
 *
 * 两种失败分开处理（D31）：
 *   - 401 → 会话没了，回登录页并清票据（`onAuthLost`）；
 *   - 403 → 有身份但没这个权限（`src/errors.ts` 的 `FORBIDDEN`），只提示，**不清**登录态。
 */
async function api(path, options = {}) {
  const headers = { accept: "application/json", "x-trace-id": newTraceId() };
  if (options.anonymous !== true) headers["x-staff-session"] = state.token ?? "";
  const init = { method: options.method ?? "GET", headers, cache: "no-store" };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw failure("NETWORK", "网络不可用");
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (payload?.ok === true) return payload.data ?? {};
  const code = payload?.error?.code ?? (response.status === 404 ? "NOT_FOUND" : `HTTP_${response.status}`);
  if (response.status === 401 && options.anonymous !== true) onAuthLost();
  throw failure(code, payload?.error?.message ?? `请求失败（HTTP ${response.status}）`);
}

/* ───────────────────────── 管理面板（09#05） ───────────────────────── */

/**
 * 面板是否占着屏：查根节点上的 `is-open` 标记类（骨架打开面板时加、关闭时摘）。
 * 键盘处理器第一行就查它 —— 面板里是表单与列表，抢 `j`/`Enter` 会让打字变成跳行。
 */
const adminPanelOpen = () => ui.adminPanel?.classList.contains("is-open") === true;

/** 导航高亮：`is-active` 给样式，`aria-current` 给读屏（两个都要，别只改其中一个）。 */
function setActiveNav(key) {
  for (const node of ui.nav?.querySelectorAll("[data-nav]") ?? []) {
    const on = String(node.dataset.nav ?? "") === key;
    node.classList.toggle("is-active", on);
    if (on) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }
}

/**
 * 角色落到界面上：导航显隐 + 面板骨架的 ctx.role。
 *
 * 角色**只**来自 `GET /api/console/me`（`verifySession`）。未知 / 网络错一律按 `agent` 渲染：
 * 少给一个入口的代价是"管理员点一下工单再刷新"，多给一个入口的代价是"客服点开就 403"。
 * 反过来（把未知角色当 admin）才是危险的默认值。
 */
function applyRole(role) {
  const normalized = normalizeRole(role);
  state.role = normalized;
  // 降回 agent（会话过期 / 换账号 / 被降权）就把人员列表扔掉：
  // 浏览器只有一份 `localStorage`，下一个登录的可能是别人，别把上一份名单留在内存里当缓存。
  if (normalized === "agent") {
    state.staff = [];
    state.staffLoaded = false;
    state.staffError = "";
    state.dispatching = false;
  }
  applyRoleToNav(ui.nav, normalized);
  if (shell === null) return;
  shell.setRole(normalized);
  // 面板开着但新角色看不到它（会话过期 / 被降权）：收回面板，别留一个"导航上已经没有"的入口。
  if (shell.isOpen() && !visibleNavItems(normalized).includes(String(shell.name() ?? ""))) {
    shell.close();
    setActiveNav("tickets");
  }
}

/** 关掉当前管理面板（幂等）。返回"之前是不是开着"，调用方不必再自己判一次。 */
function closeAdminPanel() {
  if (shell === null || !shell.isOpen()) return false;
  shell.close();
  return true;
}

async function openAdminPanel(name) {
  if (state.token === null) {
    showGate("");
    return;
  }
  // 隐藏的项达不到这里（`hidden` 的按钮点不中，键盘也没有路径），这里再判一次只是为了
  // 让"点了看不见的入口"不会走进懒加载 —— 真权限仍在接口层，这一行不构成安全边界。
  if (!visibleNavItems(state.role).includes(name)) return;
  // 面板不用 5 秒轮询：队列接口在这一屏上没有任何人看，继续打就是白烧 Redis。
  stopPolling();
  setActiveNav(name);
  if (shell === null) {
    toast("管理面板不可用：页面缺少面板容器。");
    setActiveNav("tickets");
    return;
  }
  const opened = await shell.open(name);
  // 打开失败但占位已经画出来（模块还没落地）：留在面板上看"面板未就绪"，不要静默弹回工单。
  if (!opened && !shell.isPanelOpen()) {
    setActiveNav("tickets");
    toast("管理面板暂时打不开，请刷新页面重试。");
  }
}

/** 回到工单：面板先卸（含它自己的定时器），再走原有的"回队列"路径（`goQueue` 负责轮询与重拉）。 */
function showTickets() {
  closeAdminPanel();
  setActiveNav("tickets");
  goQueue();
}

/**
 * 面板侧的统一"退出"出口（`ctx.onSignOut`）。
 *
 * 401 时 `api()` 已经清过票据并弹回 gate，这里只是把界面收干净（不会二次弹提示）；
 * 面板自己主动调它则等价于真登出（票据还在才走 `signOut`）。
 */
function shellSignOut() {
  closeAdminPanel();
  applyRole(null);
  if (state.token !== null) void signOut();
}

/* ───────────────────────── 队列 ───────────────────────── */

function queueQuery() {
  const params = new URLSearchParams();
  params.set("status", state.filter.status);
  if (state.filter.reason !== "") params.set("reason", state.filter.reason);
  if (state.filter.q !== "") params.set("q", state.filter.q);
  params.set("page", String(state.page));
  params.set("size", String(state.size));
  return params.toString();
}

function setQueueStatus(text, cls) {
  const node = ui.work?.querySelector("#queue-status");
  if (!node) return;
  node.className = `queue-status${cls ? ` ${cls}` : ""}`;
  node.textContent = text;
}

function renderQueueShell(force = false) {
  if (!force && ui.work?.dataset.view === "queue") return;
  if (ui.work === undefined) return;
  ui.work.dataset.view = "queue";
  ui.work.dataset.ticket = "";
  ui.work.innerHTML = queueHtml({ ...state.filter, size: state.size, sizes: SIZE_CHOICES });
}

function assigneeOf(item) {
  const name = item?.assignee ?? state.assigneeById.get(String(item?.id ?? "")) ?? "";
  return typeof name === "string" && name.trim() !== "" ? name : "";
}

/**
 * 只重画表格主体 —— **不重画工具栏**。
 * 5 秒一次的轮询如果连 `<select>` / 搜索框一起换掉，坐席正在输的关键字会在第四个字符时消失。
 */
function renderRows(freshIds = []) {
  const body = ui.work?.querySelector("#queue-body");
  if (!body) return;
  const now = Date.now();
  const fresh = freshIds instanceof Set ? freshIds : new Set((freshIds ?? []).map(String));
  body.innerHTML = state.items
    .map((item) => {
      const snapshot = state.snapshots.get(String(item.id)) ?? {
        dueAt: item.due_at,
        secondsLeft: item.sla_seconds_left,
        at: now,
      };
      return rowHtml(item, {
        sla: formatSla(remainingSeconds(snapshot, now)),
        assignee: assigneeOf(item),
        fresh: fresh.has(String(item.id)),
      });
    })
    .join("");

  const emptyNode = ui.work.querySelector("#queue-empty");
  if (emptyNode) emptyNode.hidden = state.items.length > 0;

  const totalPages = Math.max(1, Math.ceil(state.total / state.size));
  const info = ui.work.querySelector("#page-info");
  if (info) info.textContent = `第 ${state.page} / ${totalPages} 页 · 共 ${state.total} 单`;
  const prev = ui.work.querySelector('[data-act="prev-page"]');
  const next = ui.work.querySelector('[data-act="next-page"]');
  if (prev) prev.disabled = state.page <= 1;
  if (next) next.disabled = state.page >= totalPages;

  // 选中态按行号重新落一次（J/K 之后会重画表格，DOM 是新的）
  const rows = [...body.querySelectorAll(".q-row")];
  if (state.selectedIndex >= rows.length) state.selectedIndex = rows.length - 1;
  rows.forEach((row, index) => {
    if (index === state.selectedIndex) {
      row.classList.add("is-selected");
      row.setAttribute("aria-selected", "true");
    }
  });

  // 高亮几秒后自己消退：留着会让"新单"这个信号在整班时间里失去意义
  for (const row of body.querySelectorAll(".q-row.is-new")) {
    window.setTimeout(() => row.classList.remove("is-new"), NEW_HIGHLIGHT_MS);
  }
}

async function loadQueue() {
  if (state.token === null) return;
  if (state.queueLoading) return;
  state.queueLoading = true;
  setQueueStatus("加载中…", "is-loading");
  try {
    const data = await api(`/api/console/tickets?${queueQuery()}`);
    const items = Array.isArray(data.items) ? data.items : [];
    const at = Date.now();
    // 首屏 / 换筛选 / 翻页之后的那一次不算"新单"：否则整页会一起闪，信号就废了。
    const fresh = state.polledOnce
      ? items.filter((item) => !state.known.has(String(item.id))).map((item) => String(item.id))
      : [];
    state.items = items;
    state.total = Number.isFinite(Number(data.total)) ? Number(data.total) : items.length;
    state.known = new Set(items.map((item) => String(item.id)));
    state.polledOnce = true;
    state.snapshots = new Map(
      items.map((item) => [String(item.id), { dueAt: item.due_at, secondsLeft: item.sla_seconds_left, at }]),
    );
    setQueueStatus("");
    renderRows(fresh);
    if (fresh.length > 0) toast(`${fresh.length} 个新工单`);
  } catch (err) {
    setQueueStatus(hintFor(err), "is-error");
  } finally {
    state.queueLoading = false;
  }
}

/** 换筛选 / 翻页：重置"新单"基线；换筛选时回到第 1 页（工单 07#02 第二条）。 */
function reloadQueue({ keepPage = false } = {}) {
  if (!keepPage) state.page = 1;
  state.known = new Set();
  state.polledOnce = false;
  void loadQueue();
}

function moveSelection(delta) {
  const rows = [...(ui.work?.querySelectorAll(".q-row") ?? [])];
  if (rows.length === 0) return;
  state.selectedIndex = Math.max(0, Math.min(rows.length - 1, state.selectedIndex + delta));
  rows.forEach((row, index) => {
    row.classList.toggle("is-selected", index === state.selectedIndex);
    row.setAttribute("aria-selected", String(index === state.selectedIndex));
  });
  rows[state.selectedIndex]?.scrollIntoView({ block: "nearest" });
}

function openSelected() {
  const rows = [...(ui.work?.querySelectorAll(".q-row") ?? [])];
  const row = rows[state.selectedIndex];
  if (row !== undefined) openRow(row.dataset.id);
}

function openRow(id) {
  const target = ticketHash(Number(id));
  if (target === "") return;
  if (location.hash === target) {
    void openDetail(Number(id));
    return;
  }
  location.hash = target; // 交给 hashchange 统一处理：刷新能回到同一单，链接也可分享
}

/* ───────────────────────── 详情：三栏 ───────────────────────── */

const ticketStatus = () => state.ticket?.status ?? "";
const isClosed = () => ticketStatus() === "closed";

function setDisabled(selector, disabled) {
  for (const node of ui.work?.querySelectorAll(selector) ?? []) node.disabled = disabled === true;
}

function updateReplyMeta() {
  const node = ui.work?.querySelector("#reply-meta");
  if (!node) return;
  const value = ui.work.querySelector("#reply")?.value ?? "";
  const saved = value === "" ? "草稿已清空" : "草稿自动保存";
  node.textContent = `${saved} · 已 ${countChars(value)} 字 · 发送只记本地（本期无外发接口）`;
}

function syncReplyState() {
  const reply = ui.work?.querySelector("#reply");
  const closed = isClosed();
  if (reply !== null && reply !== undefined) {
    reply.disabled = closed;
    reply.placeholder = closed ? "已关单，不能回复" : "输入回复…";
  }
  setDisabled('[data-act="send"]', closed || (reply?.value ?? "").trim() === "");
  setDisabled('[data-act="close"]', closed);
  setDisabled('[data-act="translate"]', closed);
  // 已升级的单不能再升（后端幂等回 changed:[]，这里禁用只是别让人白点）。
  setDisabled('[data-act="l2"]', closed || ticketStatus() === "escalated");
  updateReplyMeta();
}

function renderDetailParts() {
  const ticket = state.ticket;
  const assignee = ticket === null ? "" : assigneeOf(ticket);
  const meta = ui.work?.querySelector("#detail-meta");
  if (meta) {
    meta.innerHTML =
      ticket === null
        ? ""
        : metaHtml(ticket, {
            assignee,
            sla: slaFor(
              { dueAt: ticket.due_at, secondsLeft: ticket.sla_seconds_left, at: state.detailFetchedAt },
              Date.now(),
            ),
            closed: ticket.status === "closed",
          });
  }
  const actions = ui.work?.querySelector("#detail-actions");
  if (actions) {
    // `dispatch` 只对 lead / admin 生效（`canDispatch` 判角色，`dispatchHtml` 判能不能改）：
    // `agent` 拿到的 HTML 与从前一字不差，它只有"认领"。
    actions.innerHTML =
      ticket === null
        ? ""
        : actionsHtml(ticket, assignee, {
            role: state.role,
            staff: state.staff,
            currentId: typeof ticket.assignee_id === "string" ? ticket.assignee_id : "",
            busy: state.dispatching,
            loaded: state.staffLoaded,
            error: state.staffError,
          });
  }

  const stateNode = ui.work?.querySelector("#detail-state");
  if (stateNode) {
    if (state.detailError !== null) {
      stateNode.className = "detail-state is-error";
      stateNode.textContent = hintFor(state.detailError);
    } else if (state.detailLoading) {
      stateNode.className = "detail-state is-loading";
      stateNode.textContent = "加载中…";
    } else {
      stateNode.className = "detail-state";
      stateNode.textContent = "";
    }
  }

  const thread = ui.work?.querySelector("#thread");
  if (thread) {
    thread.innerHTML = threadHtml(state.messages);
    // 首次打开滚到底（最新一条在下面）；之后的局部重画保持原滚动位置，否则坐席刚翻上去的历史会跳掉
    if (state.threadSticky) {
      thread.scrollTop = thread.scrollHeight;
      state.threadSticky = false;
    }
  }

  const cites = ui.work?.querySelector("#side-cites");
  if (cites) cites.innerHTML = citesHtml(state.messages);
  syncReplyState();
}

function renderDetailShell(force = false) {
  const same = ui.work?.dataset.view === "detail" && ui.work?.dataset.ticket === String(state.ticketId);
  if (same && !force) return;
  if (ui.work === undefined) return;
  ui.work.dataset.view = "detail";
  ui.work.dataset.ticket = String(state.ticketId);
  ui.work.innerHTML = detailHtml();
  const reply = ui.work.querySelector("#reply");
  if (reply) reply.value = draft.read(state.ticketId);
  renderDetailParts(); // 先画骨架态（"加载中…" + 禁用按钮），别留一片空白
}

async function loadDetail(id) {
  state.detailLoading = true;
  state.detailError = null;
  renderDetailParts();
  try {
    const data = await api(`/api/console/tickets/${encodeURIComponent(String(id))}`);
    if (state.view !== "detail" || state.ticketId !== id) return; // 期间已经切走了，别用旧响应盖新视图
    state.ticket = data.ticket ?? null;
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    state.detailFetchedAt = Date.now();
    if (state.ticket === null) throw failure("NOT_FOUND", "工单不存在");
    state.threadSticky = true;
  } catch (err) {
    state.ticket = null;
    state.messages = [];
    state.detailError = err;
  } finally {
    state.detailLoading = false;
    if (state.view === "detail" && state.ticketId === id) renderDetailParts();
  }
}

async function openDetail(id) {
  const changed = state.view !== "detail" || state.ticketId !== id;
  state.view = "detail";
  state.ticketId = id;
  document.body.dataset.view = "detail";
  stopPolling(); // 详情是一单的固定快照，轮询列表只会白烧请求；返回队列时立刻重拉一次
  if (ui.resolve) ui.resolve.hidden = true;
  if (ui.faq) ui.faq.hidden = true;
  if (changed) {
    state.ticket = null;
    state.messages = [];
    state.detailError = null;
    state.threadSticky = true;
  }
  renderDetailShell(changed);
  await loadDetail(id);
  // 人员列表按需取一次（`lead` / `admin` 才有用；`agent` 直接返回，不发这个请求）。
  void ensureStaff();
}

/* ───────────────────────── 派发（lead / admin） ───────────────────────── */

/** 人员列表失败的提示：403 与 404 要分开说，否则"A 还没上线"会被当成"你没权限"。 */
function staffErrorHint(err) {
  const code = err?.code ?? "";
  if (code === "FORBIDDEN") return "人员列表需要更高角色，暂时无法派发";
  if (code === "NOT_FOUND") return "人员列表接口还没就绪（404），暂时无法派发";
  if (code === "NETWORK") return "连不上服务端，暂时无法派发";
  return `人员列表加载失败：${hintFor(err)}`;
}

/**
 * 取一次人员列表（详情页的派发下拉用）。
 *
 * 四条刻意的取舍：
 *   - **`agent` 不发这个请求**：它没有派发权，取了也画不出来；
 *   - **失败不清票据**（`api()` 只在 401 时清），下拉禁用并说明原因；
 *   - **403 不重试**：服务端给的是一条固定的角色结论，一个会话里不会变，每次打开工单再撞一次
 *     只是把同一句"没权限"打进网络日志。网络错 / 5xx / 404（接口还没上线）**会重试** ——
 *     那些是会自己好起来的；
 *   - 不设"重试"按钮：下次打开任意工单就是重试。
 */
async function ensureStaff() {
  if (state.staffLoaded || state.staffLoading) return;
  if (state.role !== "lead" && state.role !== "admin") return;
  state.staffLoading = true;
  try {
    const data = await api("/api/admin/staff");
    state.staff = Array.isArray(data?.items) ? data.items : [];
    state.staffLoaded = true;
    state.staffError = "";
  } catch (err) {
    state.staffError = staffErrorHint(err);
    if (err?.code === "FORBIDDEN") state.staffLoaded = true;
  } finally {
    state.staffLoading = false;
    if (state.view === "detail" && state.ticket !== null) renderDetailParts();
  }
}

/** 人员 id → 姓名（派发成功后用它更新本机缓存，免得还要等一次详情刷新才有名字）。 */
function staffNameById(id) {
  const found = state.staff.find((item) => String(item?.id ?? "") === String(id ?? ""));
  return typeof found?.name === "string" ? found.name : "";
}

/**
 * 改派一个人（`PATCH /api/console/tickets/:id` 带 `assignee_id`）。
 *
 * 三道前端门槛，都是为了"别让人白点"：角色（`canDispatch`）、已关单（终态）、
 * 以及"选中的就是当前指派人"——最后这一条**不发请求**，因为它只会在 `audit_log` 里
 * 留下一条没有意义的派发记录。真权限仍在 `core/ticket-queue.ts` 的 `updateTicket`。
 */
async function dispatchTicket(id, nextId) {
  if (id === null || state.dispatching) return;
  const ticket = state.ticket;
  if (ticket === null || String(ticket.id) !== String(id)) return;
  const permission = canDispatch(ticket, state.role);
  if (!permission.visible || !permission.enabled) {
    toast(permission.reason === "" ? "这张单现在不能改派。" : permission.reason);
    renderDetailParts();
    return;
  }
  const currentId = typeof ticket.assignee_id === "string" ? ticket.assignee_id : "";
  if (!shouldDispatch(currentId, nextId)) {
    renderDetailParts(); // 选回原值：把下拉的选中态复原，不发请求
    return;
  }
  const name = staffNameById(nextId);
  state.dispatching = true;
  renderDetailParts(); // 立刻禁用下拉，防连点重复派发
  try {
    await api(`/api/console/tickets/${encodeURIComponent(String(id))}`, {
      method: "PATCH",
      body: dispatchBody(nextId),
    });
    if (nextId === "") state.assigneeById.delete(String(id));
    else if (name !== "") state.assigneeById.set(String(id), name);
    // 队列里那一行也跟着改：返回队列时先看到新指派人，不用等下一轮轮询
    state.items = state.items.map((item) =>
      String(item.id) === String(id)
        ? { ...item, assignee_id: nextId === "" ? null : nextId, assignee: nextId === "" ? null : name }
        : item,
    );
    toast(nextId === "" ? "已取消指派" : `已派发给 ${name === "" ? "该坐席" : name}`);
    await loadDetail(id); // 指派人 / 状态 / 按钮禁用全以服务端为准
  } catch (err) {
    toast(hintFor(err));
    // 409 = 这单已被关（可能另一个坐席先关了）：刷新详情把"已关闭"如实显示出来
    if (err?.code === "TICKET_IMMUTABLE") await loadDetail(id);
  } finally {
    state.dispatching = false;
    renderDetailParts();
  }
}

/* ───────────────────────── 处置动作 ───────────────────────── */

/** PATCH 返回体的形状 `05-api.md` §4.3 没有写死，所以按几种已知形状取名字，全都没有就用本机记的。 */
function assigneeOfResponse(data) {
  const candidates = [
    data?.ticket?.assignee,
    data?.assignee,
    data?.staff?.name,
    data?.staff_name,
    data?.ticket?.assignee_name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

async function claimTicket(id, { quiet = false } = {}) {
  const data = await api(`/api/console/tickets/${encodeURIComponent(String(id))}`, {
    method: "PATCH",
    body: { status: "claimed" },
  });
  const name = assigneeOfResponse(data) ?? state.staffName;
  if (name !== null) {
    state.assigneeById.set(String(id), name);
    state.staffName = name;
    globalThis.localStorage?.setItem(STORE.staff, name);
    if (ui.agentName) ui.agentName.textContent = name;
  }
  if (state.ticket !== null && String(state.ticket.id) === String(id)) {
    state.ticket = { ...state.ticket, status: "claimed", assignee: name ?? state.ticket.assignee };
    renderDetailParts();
  }
  // 队列里那一行的"指派"列立刻显示当前坐席（不用等下一轮轮询）
  if (state.view === "queue") renderRows([]);
  if (!quiet) toast("已认领");
  return name;
}

async function sendReply() {
  const id = state.ticketId;
  const text = (ui.work?.querySelector("#reply")?.value ?? "").trim();
  if (id === null || text === "") return;
  if (isClosed()) {
    toast("已关单的工单不能回复");
    return;
  }
  // 发送前先置为已认领（11 §3.3）：否则两个坐席会各自"回复"同一单，最后谁也说不清是谁在处理。
  try {
    if (ticketStatus() !== "claimed") await claimTicket(id, { quiet: true });
  } catch (err) {
    toast(hintFor(err));
    return;
  }
  // 本期没有外发接口：这条消息只存在本页内存里，所以必须自带"本地记录，未外发"标签。
  state.messages.push({
    id: `local-${Date.now()}`,
    role: "staff",
    content: text,
    created_at: new Date().toISOString(),
    local: true,
  });
  draft.cancel(id);
  draft.write(id, "");
  const reply = ui.work?.querySelector("#reply");
  if (reply) reply.value = "";
  state.threadSticky = true;
  renderDetailParts();
  toast("已记录在本地（本期未外发）");
}

function openResolve() {
  if (isClosed() || state.ticketId === null || !ui.resolve) return;
  syncResolve();
  ui.resolve.hidden = false;
  ui.resolveText.focus();
}

function syncResolve() {
  if (!ui.resolveText) return;
  const value = ui.resolveText.value;
  ui.resolveCount.textContent = resolutionHint(value);
  ui.resolveConfirm.disabled = !isValidResolution(value);
}

async function confirmResolve() {
  const id = state.ticketId;
  const resolution = normalizeResolution(ui.resolveText?.value ?? "");
  if (id === null || !isValidResolution(resolution)) return;
  ui.resolveConfirm.disabled = true;
  try {
    await api(`/api/console/tickets/${encodeURIComponent(String(id))}`, {
      method: "PATCH",
      body: { status: "closed", resolution },
    });
    if (ui.resolve) ui.resolve.hidden = true;
    toast("已关单");
    await loadDetail(id); // 关单后状态、结论、按钮禁用全都要变，重新拉一次比手改本地副本可靠
  } catch (err) {
    // 409 → 已关单（可能另一个坐席先关了）。此时刷新详情，把"已关闭"如实显示出来。
    toast(hintFor(err));
    if (err?.code === "TICKET_IMMUTABLE") {
      if (ui.resolve) ui.resolve.hidden = true;
      await loadDetail(id);
    }
  } finally {
    if (ui.resolveConfirm) ui.resolveConfirm.disabled = !isValidResolution(ui.resolveText?.value ?? "");
  }
}

/* ───────────────────────── 转 L2 / 转 FAQ 草稿（09#06） ───────────────────────── */

/**
 * 转 L2：`POST /api/console/tickets/:id/escalate`。
 *
 * 为什么是独立端点而不是 PATCH `{status:"escalated"}`：那个补丁写不动 `tags`，
 * 而后端把"这单升级过"同时记在状态与标签上（见 `core/ticket-queue.ts` 的 `ESCALATE_TAG`）。
 *
 * 幂等由后端保证（已升级 → `changed: []`），所以这里不判"是不是已经升级过" ——
 * 前端多一道判断就会与后端分叉，而分叉的表现是"按钮亮着、点了没反应"。
 */
async function escalateTicket(id) {
  if (id === null) return;
  if (isClosed()) {
    toast("已关单的工单不能升级");
    return;
  }
  setDisabled('[data-act="l2"]', true);
  try {
    const data = await api(`/api/console/tickets/${encodeURIComponent(String(id))}/escalate`, {
      method: "POST",
    });
    const changed = Array.isArray(data?.changed) ? data.changed : [];
    toast(changed.length === 0 ? "这张单已经是已升级状态" : "已转 L2：队列置顶，等二线接手");
    // 状态徽章、按钮文案、队列置顶顺序都以服务端为准 —— 手改本地副本会让"看起来升级了"。
    await loadDetail(id);
  } catch (err) {
    toast(hintFor(err));
    if (err?.code === "TICKET_IMMUTABLE") await loadDetail(id);
    else setDisabled('[data-act="l2"]', false);
  }
}

/** 打开转草稿弹窗：问题预填本单问题、语言预填会话语言（拿不到就 `zh`，坐席端是中文内部工具）。 */
function openFaqDraft() {
  if (isClosed() || state.ticket === null || !ui.faq) return;
  const lang = typeof state.ticket.lang === "string" && state.ticket.lang !== "" ? state.ticket.lang : "zh";
  ui.faqQuestion.value = state.ticket.question ?? "";
  ui.faqLang.value = lang;
  ui.faqAnswer.value = "";
  syncFaq();
  ui.faq.hidden = false;
  ui.faqAnswer.focus();
}

/** 弹窗的即时校验：与后端同一份阈值（`faqDraftBody` 回 null 就不让点）。 */
function syncFaq() {
  const question = ui.faqQuestion?.value ?? "";
  const answer = ui.faqAnswer?.value ?? "";
  if (ui.faqCount) ui.faqCount.textContent = faqHint(question, answer);
  if (ui.faqSubmit) {
    ui.faqSubmit.disabled = faqDraftBody({ ticketId: state.ticketId, question, answer, lang: ui.faqLang?.value }) === null;
  }
}

async function submitFaqDraft() {
  const id = state.ticketId;
  if (id === null) return;
  const body = faqDraftBody({
    ticketId: id,
    question: ui.faqQuestion?.value ?? "",
    answer: ui.faqAnswer?.value ?? "",
    lang: ui.faqLang?.value ?? "",
  });
  if (body === null) {
    // 按钮禁用时走不到这里（键盘/脚本触发才可能）：说清缺什么，不打请求。
    toast(faqHint(ui.faqQuestion?.value ?? "", ui.faqAnswer?.value ?? ""));
    return;
  }
  if (ui.faqSubmit) ui.faqSubmit.disabled = true;
  try {
    await api("/api/console/draft", { method: "POST", body });
    if (ui.faq) ui.faq.hidden = true;
    toast("已生成 FAQ 草稿，待主管在「FAQ 草稿」面板审批");
  } catch (err) {
    // 409 = 这个问题已经有一份未驳回的草稿：草稿仍然留着，让人改完再点，不清空。
    toast(hintFor(err));
  } finally {
    syncFaq();
  }
}

async function copyText(text) {
  const value = String(text ?? "");
  if (value === "") return;
  try {
    await navigator.clipboard.writeText(value);
    toast(`已复制 ${value.length > 28 ? `${value.slice(0, 28)}…` : value}`);
  } catch {
    toast("复制失败，请手动选中");
  }
}

function findCitation(messageId, idx) {
  const message = state.messages.find((item) => String(item.id) === String(messageId));
  const list = Array.isArray(message?.citations) ? message.citations : [];
  return list.find((cite) => Number(cite?.idx) === Number(idx)) ?? null;
}

function openCite(messageId, idx) {
  const cite = findCitation(messageId, idx);
  if (cite === null || !ui.cite) return;
  ui.citeTitle.textContent = `引用 ${Number(idx)} · ${cite.doc_title ?? "未命名文档"}`;
  ui.citeBody.innerHTML = citeCardHtml(cite);
  ui.cite.hidden = false;
}

/* ───────────────────────── 路由与轮询 ───────────────────────── */

function applyQueueView() {
  const changed = state.view !== "queue";
  state.view = "queue";
  state.ticketId = null;
  state.selectedIndex = -1;
  document.body.dataset.view = "queue";
  renderQueueShell(changed);
  renderRows([]);
  startPolling();
  void loadQueue();
}

/** 回到队列：优先"改 URL 让 hashchange 统一处理"，避免出现两条切视图的路径。 */
function goQueue() {
  if (ui.resolve) ui.resolve.hidden = true;
  if (ui.cite) ui.cite.hidden = true;
  if (ui.faq) ui.faq.hidden = true;
  if (location.hash !== "" && location.hash !== "#") {
    location.hash = "";
    return;
  }
  applyQueueView();
}

function syncRoute() {
  const id = parseHash(location.hash);
  if (id === null) {
    applyQueueView();
    return;
  }
  void openDetail(id);
}

function startPolling() {
  stopPolling();
  // 管理面板占着屏时不轮询：队列在这一屏上没有任何人看，5 秒一次全是白打。
  if (document.hidden || state.token === null || adminPanelOpen()) return;
  state.pollTimer = window.setInterval(() => {
    if (state.view !== "queue" || document.hidden || state.token === null) return;
    void loadQueue();
  }, POLL_MS);
}

function stopPolling() {
  window.clearInterval(state.pollTimer);
  state.pollTimer = 0;
}

/**
 * 每 30 秒把 SLA 文本重算一次 —— **只改文本与 `data-sla`**，不发任何请求（工单 07#02 第一条）。
 * 顺带处理了"页面睡了 8 小时再回来"：`remainingSeconds` 用 `due_at - now`，醒来第一跳就是真值。
 */
function tickSla() {
  const now = Date.now();
  for (const row of ui.work?.querySelectorAll(".q-row") ?? []) {
    const snapshot = state.snapshots.get(String(row.dataset.id));
    if (snapshot === undefined) continue;
    const sla = formatSla(remainingSeconds(snapshot, now));
    row.dataset.sla = sla.level;
    const cell = row.querySelector(".sla-text");
    if (cell) cell.textContent = sla.text;
  }
  const detailSla = ui.work?.querySelector("#detail-sla");
  if (detailSla && state.ticket !== null) {
    const sla = slaFor(
      { dueAt: state.ticket.due_at, secondsLeft: state.ticket.sla_seconds_left, at: state.detailFetchedAt },
      now,
    );
    detailSla.textContent = sla.text;
    detailSla.dataset.sla = sla.level;
  }
}

/* ───────────────────────── 事件 ───────────────────────── */

function scheduleSearch(value) {
  state.filter.q = value;
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(() => reloadQueue(), SEARCH_DEBOUNCE_MS);
}

function handleAction(node, event) {
  const act = node.dataset.act;
  if (act === "back") {
    event.preventDefault();
    goQueue();
  } else if (act === "copy-no") {
    event.preventDefault();
    void copyText(node.dataset.no ?? state.ticket?.no ?? "");
  } else if (act === "copy-link") {
    event.preventDefault();
    void copyText(linkFor(location, state.ticketId));
  } else if (act === "claim") {
    if (state.ticketId !== null) void claimTicket(state.ticketId).catch((err) => toast(hintFor(err)));
  } else if (act === "send") {
    void sendReply();
  } else if (act === "close") {
    openResolve();
  } else if (act === "translate") {
    toast("翻译本期未开放（接口固定返回 501）");
  } else if (act === "cite") {
    openCite(node.dataset.msg, node.dataset.idx);
  } else if (act === "cite-close") {
    if (ui.cite) ui.cite.hidden = true;
  } else if (act === "resolve-cancel") {
    if (ui.resolve) ui.resolve.hidden = true;
  } else if (act === "resolve-confirm") {
    void confirmResolve();
  } else if (act === "l2") {
    void escalateTicket(state.ticketId);
  } else if (act === "faq") {
    openFaqDraft();
  } else if (act === "faq-cancel") {
    event.preventDefault();
    if (ui.faq) ui.faq.hidden = true;
  } else if (act === "faq-submit") {
    void submitFaqDraft();
  } else if (act === "prev-page") {
    if (state.page > 1) {
      state.page -= 1;
      reloadQueue({ keepPage: true });
    }
  } else if (act === "next-page") {
    state.page += 1;
    reloadQueue({ keepPage: true });
  } else if (act === "retry") {
    void loadQueue();
  }
}

function onClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  // 导航：工单 / 管理面板（四个，按角色渲染）都走真入口。
  // 兜底那一条分支留给将来加进 `console.html` 但还没接线的键：只给提示、不跳转 ——
  // 跳出去就是 404，坐席会以为系统坏了。
  const nav = target.closest("[data-nav]");
  if (nav !== null) {
    const key = String(nav.dataset.nav ?? "");
    event.preventDefault();
    if (key === "tickets") {
      showTickets();
      return;
    }
    if (isAdminNav(key)) {
      void openAdminPanel(key);
      return;
    }
    toast(`${nav.textContent.trim()}本期未开放`);
    return;
  }

  const tab = target.closest("[data-status]");
  if (tab !== null && tab.classList.contains("tab-btn")) {
    state.filter.status = tab.dataset.status ?? DEFAULT_STATUS;
    for (const node of ui.work?.querySelectorAll(".tab-btn") ?? []) {
      node.setAttribute("aria-selected", String(node === tab));
    }
    reloadQueue();
    return;
  }

  const action = target.closest("[data-act]");
  if (action !== null) {
    handleAction(action, event);
    return;
  }

  // 整行可点：只要没点中行内的按钮（单号 / 角标），就是"打开这一单"
  const row = target.closest(".q-row");
  if (row !== null) openRow(row.dataset.id);
}

function onChange(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  // 派发下拉（`lead` / `admin` 的详情页）。选中即发 PATCH —— 不加"确认"按钮：
  // 派发是可逆的（再选一次就改回来），门槛在角色与关单状态上，不在这里。
  if (target.dataset?.dispatch === "assignee") {
    void dispatchTicket(state.ticketId, target.value);
    return;
  }
  if (target.id === "filter-reason") {
    state.filter.reason = target.value;
    reloadQueue();
  } else if (target.id === "size") {
    const size = Number(target.value);
    if (SIZE_CHOICES.includes(size)) {
      state.size = size;
      globalThis.localStorage?.setItem(STORE.size, String(size));
      reloadQueue();
    }
  }
}

function onInput(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.id === "filter-q") {
    scheduleSearch(target.value);
  } else if (target.id === "reply") {
    if (state.ticketId !== null) draft.schedule(state.ticketId, target.value);
    updateReplyMeta();
    syncReplyState();
  } else if (target.id === "resolve-text") {
    syncResolve();
  }
}

function onKeydown(event) {
  // 管理面板占着屏时**整条快捷键链让位**（查根节点的 `is-open` 标记类）：
  // 面板里是表单与列表，按 `j` 跳行、按 `Enter` 打开工单都是事故。Esc 也不拦 ——
  // 面板可能自己开着弹层/下拉，抢了会把用户连人带没保存的编辑一起关掉；退出面板用导航（点"工单"）。
  if (adminPanelOpen()) return;

  // 模态优先吃键：Esc 只关自己，不能顺手把坐席弹回队列（关单弹窗里的 Esc 尤其危险）
  if (ui.resolve !== undefined && !ui.resolve.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      ui.resolve.hidden = true;
    } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void confirmResolve();
    }
    return;
  }
  if (ui.cite !== undefined && !ui.cite.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      ui.cite.hidden = true;
    }
    return;
  }
  // 转草稿弹窗：Esc 关、Ctrl/Cmd+Enter 提交（与关单弹窗同一套键；里面是 textarea，
  // 不拦的话 `j`/`k` 会把光标挪走、`Enter` 会当成"打开下一单"）。
  if (ui.faq !== undefined && !ui.faq.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      ui.faq.hidden = true;
    } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void submitFaqDraft();
    }
    return;
  }

  const action = mapKey(event, { view: state.view, editable: isEditableTarget(event.target) });
  if (action === ACTION.ignore) {
    // 纯映射把"输入框里的 Esc"判成忽略（`lib/console-keys.js` 的口径：输入框里的键一律让位）。
    // 但实测发现这一条会让 Esc 彻底失效：`Ctrl+Enter` 发送后焦点仍在回复框里，而"发送完就想回队列"
    // 正是最常按 Esc 的时刻。所以这里补一条**视图级**策略 —— Esc 不是打字，输入框里也要能返回；
    // 队列里则只把焦点从输入框放出来（不跳走，也不清掉已输入的关键字/草稿）。
    if (event.key === "Escape" && state.view === "detail") {
      event.preventDefault();
      goQueue();
      return;
    }
    if (event.key === "Escape" && isEditableTarget(event.target)) {
      event.preventDefault();
      event.target.blur();
    }
    return;
  }
  if (action === ACTION.next || action === ACTION.prev) {
    event.preventDefault();
    moveSelection(action === ACTION.next ? 1 : -1);
  } else if (action === ACTION.open) {
    event.preventDefault();
    openSelected();
  } else if (action === ACTION.back) {
    event.preventDefault();
    goQueue();
  } else if (action === ACTION.send) {
    event.preventDefault();
    void sendReply();
  } else if (action === ACTION.help) {
    event.preventDefault();
    toast("本期仅支持：J/K 上下移动、Enter 打开、Esc 返回、Ctrl/Cmd+Enter 发送");
  }
}

function bind() {
  ui.work = document.querySelector("#work") ?? undefined;
  ui.toast = document.querySelector("#toast") ?? undefined;
  ui.gate = document.querySelector("#gate") ?? undefined;
  ui.gateForm = document.querySelector("#gate-form") ?? undefined;
  ui.gateEmail = document.querySelector("#gate-email") ?? undefined;
  ui.gatePassword = document.querySelector("#gate-password") ?? undefined;
  ui.gateError = document.querySelector("#gate-error") ?? undefined;
  ui.gateSubmit = document.querySelector("#gate-submit") ?? undefined;
  ui.agentName = document.querySelector("#agent-name") ?? undefined;
  ui.signOut = document.querySelector("#btn-signout") ?? undefined;
  ui.cite = document.querySelector("#cite-modal") ?? undefined;
  ui.citeTitle = document.querySelector("#cite-title") ?? undefined;
  ui.citeBody = document.querySelector("#cite-body") ?? undefined;
  ui.resolve = document.querySelector("#resolve-modal") ?? undefined;
  ui.resolveText = document.querySelector("#resolve-text") ?? undefined;
  ui.resolveCount = document.querySelector("#resolve-count") ?? undefined;
  ui.resolveConfirm = document.querySelector("#resolve-confirm") ?? undefined;
  ui.faq = document.querySelector("#faq-modal") ?? undefined;
  ui.faqQuestion = document.querySelector("#faq-question") ?? undefined;
  ui.faqLang = document.querySelector("#faq-lang") ?? undefined;
  ui.faqAnswer = document.querySelector("#faq-answer") ?? undefined;
  ui.faqCount = document.querySelector("#faq-count") ?? undefined;
  ui.faqSubmit = document.querySelector("#faq-submit") ?? undefined;
  ui.nav = document.querySelector(".nav") ?? undefined;
  ui.adminPanel = document.querySelector("#admin-panel") ?? undefined;

  // 管理面板骨架（09#05）。`api` 传的是本文件那个**唯一**的请求出口：票据、401 清场、
  // 403 不清登录态的判定都在那里，面板不会各写一套（两套口径迟早会分叉）。
  shell = createAdminShell({
    root: ui.adminPanel ?? null,
    api: (path, options) => api(path, options ?? {}),
    toast,
    onSignOut: shellSignOut,
    role: state.role,
  });
  // 静态标记里两个管理项是 `hidden`；这里先按"未知角色 = agent"落一次，保证首屏干净。
  applyRole(state.role);

  document.addEventListener("click", onClick);
  document.addEventListener("keydown", onKeydown);
  // input/change 挂在 #work 上而不是各节点上：视图会被整块重画，委托才不用每次重新绑
  ui.work?.addEventListener("input", onInput);
  ui.work?.addEventListener("change", onChange);
  ui.gateForm?.addEventListener("submit", (event) => void submitGate(event));
  ui.signOut?.addEventListener("click", () => void signOut());
  // 关单结论的输入框在模态里（不在 #work 内），单独挂
  ui.resolveText?.addEventListener("input", syncResolve);
  // 转草稿弹窗同理：问题/答案/语言任何一个变了都要重算"生成草稿"能不能点
  for (const node of [ui.faqQuestion, ui.faqAnswer, ui.faqLang]) {
    node?.addEventListener("input", syncFaq);
    node?.addEventListener("change", syncFaq);
  }
  window.addEventListener("hashchange", syncRoute);

  // 标签页隐藏就停轮询（11 §2.4）：后台标签每 5 秒打一次库没有收益，回来时补拉一次
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
      return;
    }
    if (state.view === "queue" && state.token !== null && !adminPanelOpen()) {
      void loadQueue();
      startPolling();
    }
  });

  window.addEventListener("beforeunload", () => {
    // 关页面时把挂着的草稿落盘，否则最后 300ms 打的字会丢
    if (state.ticketId !== null) draft.flush(state.ticketId);
    // 面板自己的定时器由它的卸载函数收（不收就会在关页面前最后几秒乱跳）
    closeAdminPanel();
    stopPolling();
    window.clearInterval(state.slaTimer);
    window.clearTimeout(state.searchTimer);
  });
}

/**
 * 页面加载时验一次票据（D31）：`GET /api/console/me`。
 *
 * 三种结果的处理**刻意不同**：
 *   - 200 → 用服务端给的名字与角色渲染导航（`localStorage` 里那个只是上次的显示名，可能过时）；
 *   - 401 → 票据已失效，`api()` 那边已经清了票据并弹回登录闸门，这里只需不进页面；
 *   - 网络错 / 5xx → **只读降级 + toast，不清票据**。把一次网络抖动变成"重新登录"，
 *     等于让坐席在最需要看单的时候被踢出去（`boundary-change-R2.md` §5 第 6 条）。
 *
 * 角色只在这**一次**响应里拿（不新开请求）：`me` 是登录后的第一个请求，导航要在它之后才定型。
 * 拿不到角色一律按 `agent` 渲染（少给管理员一个入口，比多给客服一个入口安全）。
 */
async function verifySession() {
  try {
    const me = await api("/api/console/me");
    const name = typeof me?.name === "string" ? me.name : "";
    if (name !== "") {
      state.staffName = name;
      globalThis.localStorage?.setItem(STORE.staff, name);
      if (ui.agentName) ui.agentName.textContent = name;
    }
    applyRole(me?.role);
    return true;
  } catch (err) {
    const code = err?.code ?? "";
    applyRole(null);
    // 401 已经由 `api()` 的清场逻辑弹回 gate；403 不清票据，但也要停在 gate 上并说清楚原因 ——
    // 否则页面会停在"gate 隐藏 + 什么都没画"的空白态。
    if (code === "FORBIDDEN") {
      showGate("当前账号没有坐席端权限，请联系管理员。");
      return false;
    }
    if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID") return false;
    toast("暂时连不上服务端，界面为只读；登录状态已保留。");
    return true;
  }
}

function boot() {
  bind();
  const savedSize = Number(globalThis.localStorage?.getItem(STORE.size));
  if (SIZE_CHOICES.includes(savedSize)) state.size = savedSize;
  state.staffName = globalThis.localStorage?.getItem(STORE.staff) ?? null;
  if (ui.agentName) ui.agentName.textContent = state.staffName ?? "坐席";

  state.slaTimer = window.setInterval(tickSla, SLA_TICK_MS);

  const token = globalThis.localStorage?.getItem(STORE.token) ?? "";
  if (token === "") {
    showGate("");
    return;
  }
  state.token = token;
  hideGate();
  // 先验票据再进页面：锚点优先（#/ticket/31 刷新后直接回到那一单），但票据不对就不进去。
  void verifySession().then((verified) => {
    if (verified && state.token !== null) syncRoute();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
