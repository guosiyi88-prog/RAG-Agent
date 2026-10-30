/**
 * 用户端页面控制器（`06-user-web-ui`）：令牌 → 发问 → 逐字收流 → 四态 → 键盘跟手 → 断网/限流，以及 `06#02` 的
 * 引用抽屉（点角标 → `user:cite` → 底部滑出 → 焦点陷阱 / 下滑 / Esc）。动画数学全在 `lib/sheet.js`，本文件只做 DOM；
 * 刻意原始：无框架、无构建、无 npm 依赖。
 */
import { createSseParser } from "./lib/stream.js";
import { renderCitations } from "./lib/cite.js";
import { normalizeLang, pickLang } from "./lib/lang.js";
import { createCiteSheet } from "./lib/cite-sheet.js";
import { DICT_DE } from "./lib/i18n-de.js";
import { chromeDict } from "./lib/i18n-chrome.js";
import { createViews } from "./views.js";
/** 长会话 DOM 越多越卡（每帧 delta 都要重排）。丢的只是 DOM —— 消息、引用、工单都在服务端。*/
const MAX_BUBBLES = 60;
const MAX_INPUT_H = 120; // 10 §3.5：输入框增高上限（app.css 的 .composer-input 同值）
const THROTTLE_FALLBACK_S = 60; // 429 没带 Retry-After 时的兜底
const PIN_SLACK = 48; // 距底多少像素内算「跟着看」；超过就当用户在上滑翻历史，别抢滚动
const STORE = { token: "wt:token", conv: "wt:conv", lang: "wt:lang" };
const ERROR_KEY = { RATE_LIMITED: "chat.err.rate", LLM_TIMEOUT: "chat.err.timeout", AUTH_INVALID: "chat.err.auth" };
/** 真表是 `src/static/i18n.json`（五语 127 条），由 `/api/i18n/:lang` 合并后下发（12 §1–§2）。
 *  `state.i18n` 就是那份合并结果；两张 JS 表（i18n-chrome / i18n-de）只在接口不可用时兜底。
 *  **注意区分两件事**：离线兜底表的深水区是德语（12 §6 步骤 5，德语是最先做全量抽检的市场），
 *  而界面默认语言由 `lib/lang.js:pickLang` 决定，回落终点是**英语**（12 §2）。
 *  这里的初值只是 `resolveLang()` 跑之前的占位，必须与回落终点一致，否则首帧会闪一下德语。*/
const state = { // token 也存 sessionStorage，刷新不重签
  token: null, convId: null, lang: "en", i18n: {}, streaming: false, phase: "idle", // idle | streaming | refused | error
  control: null, extras: new Set(), notice: null, // 主轮 controller / 连发 controller / 状态条临时文案（SESSION_BUSY）
  throttleUntil: 0, throttleTimer: 0, pinned: true, online: navigator.onLine,
  citations: [], citingIdx: 0, // 抽屉正在看的这一轮引用 / 第几条（10 §2 模块契约）
};
/** 助手气泡 → { citations, query }：角标不把整份引用列表塞进 DOM 属性 */
const turnMeta = new WeakMap();
let citeSheet = null;
let views = null; // 故障码 / 工单 / 我的三个视图的控制器（views.js） // 抽屉控制器在 bind() 里创建（要先拿到 ui）
const ui = {}; // DOM 引用。HTML 由另一个 agent 写：缺元素一律按 null 跳过，不让一处缺失炸掉整页
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls; if (text !== undefined) node.textContent = text;
  return node;
}
/**
 * 气泡外再包一层"行"，行里带一个头像（客户 / AI 各一个）。
 *
 * 为什么不把头像塞进气泡里：气泡是 `.msg`，引用抽屉靠 `node.closest(".msg")` 找上下文
 * （`openCite`），错误态/流式态也都在改 `.msg` 的 class。头像必须在这一层之外，
 * 才能既不动那套逻辑，又让"谁在说"一眼可辨。
 *
 * 头像是**装饰**（`aria-hidden`）：说话人身份由左右布局与文本本身表达，读屏不需要再念一遍
 * "头像"——念了反而多一条噪声。因此也不需要新增任何 i18n key。
 */
function row(role, node) {
  const line = el("div", `row row-${role}`);
  const avatar = el("span", `avatar avatar-${role}`);
  avatar.setAttribute("aria-hidden", "true");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "icon"); icon.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", role === "u" ? "#i-user" : "#i-bot");
  icon.append(use); avatar.append(icon);
  if (role === "u") line.append(node, avatar); else line.append(avatar, node);
  return line;
}
function t(key, vars) {
  // 查找顺序（12 §2 + §7，08#01 定稿）：① `/api/i18n/:lang` 的合并结果 —— 服务端已做过 lang → en → key；
  // ② 接口拿不到时的离线兜底（下面 offlineText）；③ key 原文（开发期可见，等于把缺翻译摆在脸上）。
  // 为什么不逐 key 用 `??` 往回兜：合并结果里**一定有**每个 key（服务端最后一格就是 key 本身），
  // 用 ?? 会把"服务器故意给的 key"盖成兜底表，缺翻译反而看不见。
  const remote = state.i18n[key];
  const raw = remote !== undefined ? remote : offlineText(key);
  return vars === undefined ? raw : raw.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined ? whole : String(vars[name])));
}
/** 离线兜底：五语骨架（`lib/i18n-chrome.js`）→ 德语表（`lib/i18n-de.js`）→ key 原文。
 *  真表是 `src/static/i18n.json`（经 `/api/i18n/:lang` 下发），这两张 JS 表只在接口不可用时顶一下；
 *  它们**不必**与真表逐条同步 —— 缺的 key 会显示 key 原文，那正是"离线"该有的样子。 */
function offlineText(key) {
  return chromeDict(state.lang)[key] ?? DICT_DE[key] ?? key;
}
const failure = (code, trace) => Object.assign(new Error(code), { code, trace_id: trace });
const newTraceId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
function toast(message) {
  if (!ui.toast) return;
  ui.toast.textContent = message; ui.toast.hidden = false;
  window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => { ui.toast.hidden = true; }, 3500);
}
function setPhase(phase) {
  state.phase = phase; state.streaming = phase === "streaming"; if (state.streaming) state.notice = null;
  document.body.dataset.state = phase; // CSS 的钩子
  if (ui.app) { ui.app.dataset.state = phase; ui.app.setAttribute("aria-busy", String(state.streaming)); } // 读屏靠 aria-busy 知道"正在写"
  renderStatus(); syncSend();
}
function renderStatus() {
  if (!ui.status) return;
  const text = state.notice ?? (!state.online ? t("chat.err.offline") : state.streaming ? t("chat.status.searching") : null);
  ui.status.textContent = text ?? ""; ui.status.hidden = text === null;
}
const throttleLeft = () => Math.max(0, Math.ceil((state.throttleUntil - Date.now()) / 1000));
/** 发送按钮的唯一写入口。只有「限流中」「断网」禁用：`streaming` 不禁用（连发走插入分支，10 §3.3），`error` / `refused` 也不禁用（两种状态都允许接着问下一句）。*/
function syncSend() {
  if (!ui.send) return;
  const left = throttleLeft(); ui.send.disabled = left > 0 || !state.online;
  // 只写内部 .send-label，绝不 textContent 整块覆盖：那会把内联 SVG 图标一起抹掉；倒计时用 is-counting 藏图标。
  const label = ui.send.querySelector(".send-label");
  if (label) { label.textContent = left > 0 ? `${left}s` : ""; label.hidden = left <= 0; }
  ui.send.classList.toggle("is-counting", left > 0);
  ui.send.setAttribute("aria-label", !state.online ? t("chat.err.offline")
    : left > 0 ? `${t("chat.err.rate")} ${left}s` : t("a11y.send"));
}
function applyThrottle(seconds) {
  const secs = Number.isFinite(seconds) && seconds > 0 ? seconds : THROTTLE_FALLBACK_S;
  state.throttleUntil = Date.now() + secs * 1000;
  window.clearInterval(state.throttleTimer);
  state.throttleTimer = window.setInterval(() => {
    if (throttleLeft() > 0) return syncSend();
    window.clearInterval(state.throttleTimer); state.throttleTimer = 0; state.throttleUntil = 0; syncSend();
  }, 1000);
  syncSend(); toast(t("chat.err.rate"));
}
async function mintToken() {
  const res = await fetch("/api/session", { method: "POST" });
  const token = res.ok ? (await res.json())?.data?.token : null; // 无 body：只换一个匿名令牌
  if (typeof token !== "string" || token === "") throw failure("INTERNAL");
  state.token = token; sessionStorage.setItem(STORE.token, token);
  // 会话归属令牌：新令牌拿不到旧会话（后端按"不属于你"回 404）。签新令牌时一起丢掉旧 conv，
  // 否则用户会卡在"每发一条就 404"的死循环里，而且自己没有任何办法修。
  state.convId = null; sessionStorage.removeItem(STORE.conv);
  return token;
}
function ensureToken() {
  if (state.token !== null) return Promise.resolve(state.token);
  const cached = sessionStorage.getItem(STORE.token);
  if (cached !== null) { state.token = cached; return Promise.resolve(cached); }
  return mintToken();
}
/** 拉一个语种的合并文案（12 §2：回落链在服务端做，这里只拿结果）。
 *  `state.i18n` 先清空：上一语的 key 残留会让"切到荷兰语却还有德语单词"这种问题查不出来 ——
 *  清空后 `t()` 立刻落到离线兜底表，语义明确。失败（离线 / 500 / 老服务端 404）**不弹错**：
 *  文案不该是能把页面卡死的东西，兜底表就是为这一小段时间存在的。 */
async function loadI18n(lang) {
  state.i18n = {};
  try {
    const res = await fetch(`/api/i18n/${encodeURIComponent(lang)}`, { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const body = await res.json(); if (body?.ok === true && body.data?.messages) state.i18n = body.data.messages;
  } catch { /* 离线 / 网络抖动同样走离线兜底表 */ }
}
/** 界面语言：`pickLang` 自己就带回落终点（`en`，见 `lib/lang.js`），所以**不要在它后面再换终点**
 *  —— 以前这里写的是 `|| "de"`，等于把已经写好的回落链改成"中文/荷兰语/西班牙语浏览器的人都先看到德语"。
 *  现在末尾的 `|| "en"` 与 `pickLang` 的终点一致，只是形状兜底（两张表被人改歪时仍然给出合法语种）。 */
const resolveLang = () => normalizeLang(pickLang({ stored: localStorage.getItem(STORE.lang), browser: navigator.language })) || "en";
/** 整页换语言：`<html lang>` + 三类 data-i18n* 节点 + 浏览器标签页标题 + 各处的动态文本。
 *  不刷新页面（10 §8「切语言后全站文案变化，无需刷新」），所以每个可见节点都必须挂 key —— 漏一个就漏一个。 */
function applyLang(lang) {
  state.lang = lang; document.documentElement.lang = lang; localStorage.setItem(STORE.lang, lang);
  document.title = t("chat.title"); // <title> 是 10 §8 允许硬编码的例外，但跟着语言走更好：标签页也算界面
  document.querySelectorAll("[data-i18n]").forEach((n) => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach((n) => { n.placeholder = t(n.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-aria]").forEach((n) => { n.setAttribute("aria-label", t(n.dataset.i18nAria)); });
  const code = ui.lang?.querySelector(".lang-code"); if (code) code.textContent = lang.toUpperCase(); // 只改代码，别抹掉图标
  syncLangItems(); // 菜单里"当前语言"的高亮跟着走（母语名字自己不变，只有选中态变）
  renderStatus(); syncSend(); refreshCiteTitle(); // 抽屉开着时切语言：标题与页码跟着换
}
/** 抽屉开着时切语言：`cite.title` 带 `{i}` / `{n}`，上面那轮 data-i18n 会把标题写成未替换的模板，
 *  所以补一次带参数的渲染。重渲染入口是 `user:cite` 事件（`lib/cite-sheet.js` 没有导出 render），
 *  重新派发同一份 detail 等于"照原样再画一遍"，焦点仍落在关闭按钮上。
 *  另外这行原本写的是 `if (sheet.open) renderCite()` —— 这两个符号在 user.js 里都不存在，
 *  切语言时必抛 ReferenceError 把 boot() 之后的所有逻辑打断（页面看起来"没反应"）。 */
function refreshCiteTitle() {
  if (citeSheet?.state?.open !== true) return;
  const current = state.citations[state.citingIdx];
  document.dispatchEvent(new CustomEvent("user:cite", {
    detail: { idx: current?.idx, citation: current, citations: state.citations, index: state.citingIdx },
  }));
}
/**
 * 语言菜单（D7）：点顶部语言按钮展开，五项都用母语写，选了就整页换语言。
 *
 * 四个刻意的约束：
 *   - **不用模态、不自动弹**：首访不打断输入，菜单只是"按钮的展开"，不是引导；
 *   - `[hidden]` 与 `display:flex` 打架的问题在 CSS 里显式处理（`[hidden]{display:none}`）；
 *   - 关闭必须把焦点还给按钮（键盘用户失去了唯一的入口就等于迷路），
 *     Esc 关闭、方向键在五项间移动、Home/End 跳首尾；
 *   - 选中项的判定只认 `state.lang`，不认点击顺序 —— 两个真源迟早会不一致。
 */
const langItems = () => [...(ui.langMenu?.querySelectorAll(".lang-item") ?? [])];
function syncLangItems() {
  for (const item of langItems()) {
    const active = item.dataset.lang === state.lang;
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "true"); else item.removeAttribute("aria-current");
  }
}
function closeLangMenu({ restoreFocus = false } = {}) {
  if (ui.langMenu === undefined || ui.langMenu.hidden) return;
  ui.langMenu.hidden = true;
  // `ui.lang` 就是语言按钮（`bind()` 里的 `#btn-lang`）。别另起一个 `ui.langBtn` 名字 ——
  // 那个属性没人赋值，`?.setAttribute` 会静默什么都不做，展开态就永远停在 "false"。
  ui.lang?.setAttribute("aria-expanded", "false");
  if (restoreFocus) ui.lang?.focus();
}
function openLangMenu() {
  if (ui.langMenu === undefined) return;
  syncLangItems();
  ui.langMenu.hidden = false;
  ui.lang?.setAttribute("aria-expanded", "true");
  // 打开就把焦点放到"当前语言"那一项：键盘用户按一下 Enter 就是"我知道我在哪一语"。
  const current = ui.langMenu.querySelector('.lang-item[aria-current="true"]') ?? ui.langMenu.querySelector(".lang-item");
  current?.focus();
}
function toggleLangMenu() {
  if (ui.langMenu === undefined) return;
  if (ui.langMenu.hidden) openLangMenu(); else closeLangMenu({ restoreFocus: true });
}
/** 菜单内的键盘行为：Esc 关、上下移动、Home/End 跳首尾（`role="menu"` 的最低要求）。 */
function onLangMenuKeydown(event) {
  const items = langItems();
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement);
  if (event.key === "Escape") { event.preventDefault(); closeLangMenu({ restoreFocus: true }); return; }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : items.length - 1;
    items[(at + step) % items.length]?.focus();
    return;
  }
  if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); return; }
  if (event.key === "End") { event.preventDefault(); items[items.length - 1]?.focus(); }
}
/** 切语言的唯一入口：先取远程文案（拿不到就用本地德语表），再应用，最后让三个视图重渲染自己的动态文本。 */
async function applyLangAsync(lang) {
  await loadI18n(lang);
  applyLang(lang);
  views?.onLang(lang);
}
function grow() {
  if (!ui.input) return;
  ui.input.style.height = "auto"; // 先归零再量 scrollHeight，否则删字时高度不回缩
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, MAX_INPUT_H)}px`;
  ui.input.style.overflowY = ui.input.scrollHeight > MAX_INPUT_H ? "auto" : "hidden";
}
function onKeydown(event) {
  // 输入法组合中的 Enter 是"选词确认"，不是发送 —— 中日韩输入法下少这个守卫会误发。
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault(); send(ui.input?.value ?? ""); // Enter 发送；Shift+Enter 留给浏览器换行
}
function send(rawText) {
  const text = (rawText ?? "").trim();
  if (text === "") return; // 空白发送是 no-op，不是错误
  if (throttleLeft() > 0) return; // 按钮已禁用，这里是双击兜底
  if (!state.online) { toast(t("chat.err.offline")); return; } // 草稿留在输入框里
  if (ui.input) { ui.input.value = ""; grow(); }
  void turn(text, state.streaming ? "insert" : "primary");
}
/** 一轮对话。`primary` 接管四态与 `state.control`；`insert` 是连发（10 §3.3）——不 abort 主轮、不碰四态，自己一条流、
 *  自己一个气泡、前面插一行灰字，两条答案绝不交错进同一个气泡；`reuse` 是"重试"，复用出错的那条气泡。*/
async function turn(text, mode, reuse) {
  const primary = mode === "primary"; const control = new AbortController();
  if (primary) { state.control = control; setPhase("streaming"); } else state.extras.add(control);
  const view = reuse ?? newView(); view.question = text; resetView(view, primary);
  if (reuse === undefined) {
    push(row("u", el("div", "msg msg-u", text)));
    if (!primary) push(notice()); // 连发时的灰字提示：没有说话人，不挂头像
    push(row("a", view.msg));
  }
  try { await consume(await postChat(text, control), view); }
  catch (err) {
    if (err?.name === "AbortError" || (primary && state.control !== control)) return; // abort（重试 / 关页）或已被新轮接管
    onError(view, { code: err?.code ?? "INTERNAL", trace_id: err?.trace_id ?? "" });
  } finally {
    control.abort(); state.extras.delete(control); // 流读完时 abort 是空操作；异常路径顺手放连接
    if (state.control === control) state.control = null;
    if (!primary || state.control === null) settle(view, "idle"); // 幂等；被重试接管的那一轮不动新气泡
  }
}
async function postChat(text, control, retried = false) {
  await ensureToken();
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-session": state.token ?? "", "x-trace-id": newTraceId() },
    body: JSON.stringify({ conv_id: state.convId, text, lang: state.lang }),
    signal: control.signal,
  });
  if (res.status === 401 && !retried) { // 令牌过期（Redis TTL 到点 / 后端重置）：重签一次再重发，整轮只重试一次
    state.token = null; sessionStorage.removeItem(STORE.token);
    try { await mintToken(); } catch { throw failure("AUTH_INVALID"); }
    return postChat(text, control, true);
  }
  if (res.status === 429) {
    const raw = res.headers.get("Retry-After"); const seconds = raw === null ? NaN : Number(raw);
    applyThrottle(Number.isFinite(seconds) && seconds > 0 ? seconds : THROTTLE_FALLBACK_S);
    throw failure("RATE_LIMITED");
  }
  if (!res.ok || res.body === null) {
    const body = await res.json().catch(() => null);
    throw failure(body?.error?.code ?? "INTERNAL", body?.error?.trace_id ?? "");
  }
  return res;
}
/* 收流：fetch + ReadableStream（要带自定义头，也不能被内置浏览器缓冲到结束）。 */
async function consume(res, view) {
  const reader = res.body.getReader(); const decoder = new TextDecoder();
  const parser = createSseParser(); // 逐块喂：一帧被网络切碎由它兜住（spec「SSE 消费」铁律）
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
      applyFrame(frame, view);
      if (view.settled) { void reader.cancel().catch(() => {}); return; }
    }
  }
}
function applyFrame(raw, view) {
  // lib/stream.js 的约定是 `{ event, data: string }`；这里容忍 `name` 与已解析的 data。
  const name = raw?.event ?? raw?.name ?? ""; let data = raw?.data;
  if (typeof data === "string") { try { data = data === "" ? null : JSON.parse(data); } catch { data = null; } }
  if (name === "meta") {
    if (typeof data?.conv_id === "string" && data.conv_id !== "") { state.convId = data.conv_id; sessionStorage.setItem(STORE.conv, data.conv_id); }
    return;
  }
  if (name === "delta") return onDelta(view, data);
  if (name === "citations") return onCitations(view, data);
  if (name === "refusal") return onRefusal(view, data);
  if (name === "done") return settle(view, "idle");
  if (name === "error") return onError(view, data ?? {});
  // `tool` 帧：本卡不渲染工具过程
}
/** 一条助手气泡的可变上下文：正文是独立 `Text` 节点，光标块是它的下一个兄弟。*/
const newView = () => ({ msg: el("div", "msg msg-a"), body: null, node: null, cursor: null, chars: "", lastDelta: "", settled: false, primary: false, question: "" });
function resetView(view, primary) {
  Object.assign(view, { primary, settled: false, chars: "", lastDelta: "", node: document.createTextNode("") });
  view.body = el("span", "msg-text"); view.body.append(view.node);
  view.cursor = el("span", "cursor"); view.cursor.setAttribute("aria-hidden", "true");
  view.msg.className = "msg msg-a is-streaming"; view.msg.replaceChildren(view.body, view.cursor);
}
function settle(view, phase) {
  if (view.settled) return;
  view.settled = true; view.msg.classList.remove("is-streaming"); view.cursor.remove();
  if (view.primary) setPhase(phase);
}
function push(node) {
  if (!ui.stream) return;
  ui.stream.append(node); while (ui.stream.children.length > MAX_BUBBLES) ui.stream.firstElementChild.remove();
  scrollToBottom(true);
}
function onDelta(view, data) {
  const chunk = typeof data?.t === "string" ? data.t : typeof data === "string" ? data : "";
  if (chunk === "") return;
  view.chars += chunk; view.lastDelta = chunk; // 拒答时"最后一帧 delta 就是固定话术"（06 §5.1 (b)）
  view.node.appendData(chunk);
  if (state.pinned) scrollToBottom(true);
}
/** 连发分支的灰字（10 §3.3）。只有 `chat.inserted` 一个 key：上一卡为了兼容早期工单里的
 *  `chat.status.inserted` 留了双查 + 中文字面量兜底，`08#01` 把别名收进真表之后这段分支就成了
 *  "页面上唯一的中文硬编码"，一并删掉 —— 缺 key 就显示 key 原文，比藏一句中文好查。 */
function notice() { return el("div", "msg msg-sys", t("chat.inserted")); }
/** 角标：只在收到 `citations` 帧后替换，且编号必须在列表里（10 §3.2 铁律 / G4 红线②）。`renderCitations` 是纯函数（不碰 DOM），造节点是这里的事。*/
function onCitations(view, list) {
  const items = Array.isArray(list) ? list : [];
  if (items.length === 0) return;
  const byIdx = new Map(items.map((citation) => [Number(citation.idx), citation]));
  view.body.replaceChildren();
  for (const segment of segmentsOf(renderCitations(view.chars, items), view.chars)) {
    const citation = segment.idx === null ? undefined : byIdx.get(segment.idx);
    // 不在列表里的 `[n]` 保持纯文本（后端本应拦掉，这里是兜底）。
    view.body.append(citation === undefined ? segment.text : citeButton(segment.idx, citation, items));
  }
  turnMeta.set(view.msg, { citations: items, query: view.question }); // 抽屉要看整轮引用
  if (state.pinned) scrollToBottom(true);
}
function segmentsOf(raw, fallbackText) {
  if (!Array.isArray(raw)) return [{ idx: null, text: fallbackText }];
  return raw.map((segment) => {
    if (typeof segment === "string") return { idx: null, text: segment };
    const idx = Number.isInteger(segment?.idx) ? segment.idx : Number.isInteger(segment?.n) ? segment.n : null;
    const text = typeof segment?.value === "string" ? segment.value : typeof segment?.text === "string" ? segment.text : typeof segment?.t === "string" ? segment.t : "";
    return { idx, text };
  });
}
function citeButton(idx, citation, list) {
  const index = Math.max(0, list.indexOf(citation));
  // 文字只放编号：`.cite` 自己已经画成 18px 的方框徽章，再写 `[1]` 会变成「[1]」双边括号。
  const node = el("button", "cite", `${idx}`);
  node.type = "button"; node.dataset.idx = String(idx); node.dataset.citeWired = "1";
  node.setAttribute("aria-label", t("cite.aria", { i: idx }));
  node.addEventListener("click", () => {
    citeSheet?.prepare(node.closest(".msg"), node.dataset.idx);
    // 角标不只"打开抽屉"：把**整轮**引用一起广播，抽屉才能上一条 / 下一条。
    // `citations` / `index` 是 06#02 契约；`citation` 是旧的单片字段，留着不删，免得别处断掉。
    document.dispatchEvent(new CustomEvent("user:cite", { detail: { idx, citation, citations: list, index } }));
  });
  return node;
}
/** 拒答：话术由后端常量以**一帧** delta 直发，模型草稿在它之前（`chat.ts` refuseTurn），所以"替换整条气泡"= 用最后一个 delta 覆盖正文，草稿连同角标一起丢掉。建单失败时后端不发 `refusal` 帧 —— 那一轮保留草稿。*/
function onRefusal(view, data) {
  view.body.replaceChildren(view.lastDelta !== "" ? view.lastDelta : view.chars);
  const no = typeof data?.ticket_no === "string" ? data.ticket_no : "";
  if (no !== "") {
    const card = el("div", "ticket-card");
    card.append(el("div", "ticket-no", no), el("div", "ticket-hint", t("chat.ticket.created", { no })));
    view.msg.append(card);
  }
  settle(view, "refused");
}
function onError(view, data) {
  if (view.settled) return;
  const code = typeof data.code === "string" ? data.code : "INTERNAL";
  // 同会话的忙只是排队（05 §3.4 / chat.ts shouldEmitErrorFrame）：不是故障，不报错。
  if (code === "SESSION_BUSY") { state.notice = t("chat.err.busy"); settle(view, "idle"); return; }
  if (code === "AUTH_INVALID") { state.token = null; sessionStorage.removeItem(STORE.token); }
  view.body.replaceChildren(t(ERROR_KEY[code] ?? "chat.err.internal"));
  view.msg.className = "msg msg-a msg-err"; // 半截正文不值得留：`error` 之后没有 `done`（05 §3.2）
  const actions = el("div", "msg-actions");
  // 被限流时"重试"只会再吃一个 429，所以那时只留转人工。
  if (code !== "RATE_LIMITED") actions.append(button(t("chat.retry.send"), () => retry(view)));
  actions.append(button(t("chat.to.human"), () => handoff(view.question)));
  view.msg.append(actions); settle(view, "error");
  if (code !== "RATE_LIMITED" && code !== "AUTH_INVALID" && data.trace_id) {
    toast(`${t("chat.err.internal")} · ${String(data.trace_id).slice(-6)}`); // 后 6 位给坐席查日志
  }
}
function button(label, onClick) {
  const node = el("button", "btn btn-ghost", label); node.type = "button"; node.addEventListener("click", onClick); return node;
}
function retry(view) { abortTurns(); void turn(view.question, "primary", view); }
function handoff(question) {
  document.dispatchEvent(new CustomEvent("user:handoff", { detail: { question, convId: state.convId } }));
}
function abortTurns() {
  state.control?.abort(); state.control = null;
  for (const control of state.extras) control.abort();
  state.extras.clear();
}
function scrollToBottom(force = false) {
  if (!ui.stream) return; if (force || state.pinned) ui.stream.scrollTop = ui.stream.scrollHeight;
}
function onScroll() {
  if (!ui.stream) return; state.pinned = ui.stream.scrollHeight - ui.stream.scrollTop - ui.stream.clientHeight < PIN_SLACK;
}
let viewportRaf = 0;
/** 键盘跟手：`innerHeight - visualViewport.height` = 键盘挡住的高度，写进自定义属性交给 CSS 让位，
 *  **不用** `position: fixed` 硬顶（10 §3.5）。rAF 去抖：iOS 在键盘动画里会连发几十次 resize。
 *  `--kb` 是本卡契约名，`--kb-h` 是 09-ui-tokens 的既有名字（同值），`--vvh` 是可视高度。 */
function syncViewport() {
  if (viewportRaf !== 0) return;
  viewportRaf = window.requestAnimationFrame(() => {
    viewportRaf = 0;
    const visible = window.visualViewport === null ? window.innerHeight : window.visualViewport.height;
    const keyboard = Math.max(0, Math.round(window.innerHeight - visible));
    const style = document.documentElement.style;
    style.setProperty("--kb", `${keyboard}px`); style.setProperty("--kb-h", `${keyboard}px`);
    style.setProperty("--vvh", `${Math.round(visible)}px`);
    if (keyboard > 0) scrollToBottom(true); // 键盘弹起后把最新一条留在可视区
  });
}
function syncOnline() {
  const online = navigator.onLine; const changed = online !== state.online; state.online = online;
  if (ui.offline) ui.offline.hidden = online; // 断网条；恢复后自动消失，草稿不动
  renderStatus(); syncSend(); // 断网文案落在状态条上
  if (!changed) return; // 首屏只摆横幅，不额外弹 toast
  toast(online ? t("toast.online") : t("toast.offline"));
}
function bind() {
  // 8 个主界面 id + 抽屉的 6 个 id：另一个 agent 的 index.html 必须都有，缺哪个都按 null 跳过。
  ui.stream = document.querySelector("#stream"); ui.input = document.querySelector("#input");
  ui.send = document.querySelector("#btn-send"); ui.status = document.querySelector("#status");
  ui.lang = document.querySelector("#btn-lang"); ui.offline = document.querySelector("#offline");
  ui.langMenu = document.querySelector("#lang-menu");
  ui.toast = document.querySelector("#toast"); ui.app = document.querySelector("#app");
  ui.citeOverlay = document.querySelector("#cite-overlay"); ui.citeSheet = document.querySelector("#cite-sheet");
  ui.citeTitle = document.querySelector("#cite-title"); ui.citeBody = document.querySelector("#cite-body");
  ui.citePrev = document.querySelector("#cite-prev"); ui.citeNext = document.querySelector("#cite-next");
  ui.citeClose = document.querySelector("#cite-close");
  ui.input?.addEventListener("keydown", onKeydown); ui.input?.addEventListener("input", grow);
  ui.send?.addEventListener("click", () => send(ui.input?.value ?? ""));
  ui.lang?.addEventListener("click", toggleLangMenu);
  // 点了某一项：先换语言（远程文案拿到才应用），再关菜单把焦点还给按钮。
  // 顺序不能反：先关菜单会让 applyLang 期间的 `syncLangItems` 落在隐藏节点上，用户看不到选中态变化。
  ui.langMenu?.addEventListener("click", (event) => {
    const item = event.target instanceof Element ? event.target.closest(".lang-item") : null;
    const lang = item?.dataset.lang;
    if (lang === undefined) return;
    void applyLangAsync(lang).finally(() => closeLangMenu({ restoreFocus: true }));
  });
  ui.langMenu?.addEventListener("keydown", onLangMenuKeydown);
  // 点菜单外面就关：`pointerdown` 而不是 `click`，否则菜单项自己的 click 会先冒到 document 把菜单关掉。
  document.addEventListener("pointerdown", (event) => {
    if (ui.langMenu === undefined || ui.langMenu.hidden) return;
    const target = event.target;
    if (target instanceof Node && (ui.langMenu.contains(target) || ui.lang?.contains(target) === true)) return;
    closeLangMenu();
  });
  ui.stream?.addEventListener("scroll", onScroll, { passive: true });
  citeSheet = createCiteSheet({ ui, state, turnMeta, el, t }); citeSheet.bind();
  views = createViews({ ui, state, t, el }); views.binder();
  document.addEventListener("user:handoff", (event) => { views?.handoff(event.detail?.question ?? ""); });
  document.addEventListener("views:toast", (event) => { const key = event.detail?.key; if (key) toast(t(key)); });
  document.addEventListener("views:lang", (event) => { const lang = event.detail?.lang; if (typeof lang === "string") void applyLangAsync(lang); });
  window.addEventListener("online", syncOnline); window.addEventListener("offline", syncOnline);
  window.addEventListener("beforeunload", () => { // 单页只有这一处"卸载"：定时器在这里清
    abortTurns(); window.clearInterval(state.throttleTimer);
  });
  if (window.visualViewport !== null) {
    window.visualViewport.addEventListener("resize", syncViewport);
    window.visualViewport.addEventListener("scroll", syncViewport, { passive: true }); // 键盘滚动也要跟
  }
  window.addEventListener("orientationchange", syncViewport);
}
function boot() {
  bind();
  state.convId = sessionStorage.getItem(STORE.conv); state.lang = resolveLang();
  applyLang(state.lang); // 先点亮页面（本地字典），不等网络：弱网 3G 首屏也要可用
  void loadI18n(state.lang).then(() => { applyLang(state.lang); views?.onLang(state.lang); });
  void ensureToken().catch(() => toast(t("chat.err.internal"))); // 失败不阻塞：首次发送会再签
  setPhase("idle"); syncOnline(); syncViewport(); grow();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
