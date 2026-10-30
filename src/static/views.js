/**
 * 「故障码 / 转人工 / 我的」三个次级页面的控制器（`06-user-web-ui` #03）。只做视图层：
 * `state` / `t()` / `el()` 由 `user.js` 传入，通知走 document 的 CustomEvent（`views:lang` / `views:toast`）。
 * 单开一个文件是因为 `user.js` 已装下对话页四态、收流与引用抽屉，再塞三页必然过 400 行。
 *
 * 与后端的三条约定（改后端前先读这里）：① `GET /api/fault/:code` 不要令牌（弱网首屏也能出卡）；
 * ② `POST /api/ticket` 与 `GET /api/ticket/:no` 都要 `x-user-session`，401 只提示不假装成功；
 * ③ 建单可不带 `conv_id`（冷启动转人工），带了就必须属于当前令牌。
 */
import { SUPPORTED_LANGS, matchFaultCode } from "./lib/lang.js";
import { FAULT_RECENT_MAX, loadRecent, pushRecent, saveRecent } from "./lib/fault-recent.js";
import { needsRefetch } from "./lib/fault-card.js";
/** 防抖 400ms（10 §5）：`E`、`E0` 这类中间态每敲一键就发一次请求，会在半秒里打出三条必然未命中的查询，
 *  把「1s 出结果」的预算全花在往返上；停手 400ms 才说明用户输完了。 */
const DEBOUNCE_MS = 400;
/** 05 §3.4 与 10 §6 的同一条正则（大小写不敏感）：后端要回 400，前端要就地提示，口径必须一致。 */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
/** 本页只服务阳台储能（05 §3.3 的缺省产品线）；常量放一处，将来加产品线只改这里。 */
const PRODUCT_LINE = "balcony";
const VIEWS = ["chat", "fault", "ticket", "me"];
const THEMES = ["system", "light", "dark"];
/** `tickets.status` 的 check 约束（sql/001_init.sql），只这四态；tone 是 app.css 的 `.badge[data-tone]` 取值。 */
const TICKET_STATUSES = ["open", "claimed", "escalated", "closed"];
const TICKET_TONE = { open: "warn", claimed: "accent", escalated: "fatal", closed: "info" };
/** 05 §6 错误码 → 文案 key。`VALIDATION` 故意不列：邮箱已在本地验过，服务端再回它多半是 question 长度或
 *  会话归属，拿「邮箱格式不正确」盖过去会把人指到错的方向。 */
const ERR_KEY = {
  QUOTA_TICKET: "ticket.quota", RATE_LIMITED: "ticket.quota",
  AUTH_REQUIRED: "chat.err.auth", AUTH_INVALID: "chat.err.auth", NOT_FOUND: "chat.err.notfound",
};
/** 我们的 id → 选择器。缺哪个就按 null 跳过：markup 由另一个 agent 写，一处缺失不该炸整页。逗号列表
 *  是兼容 markup 先落的 `#ticket-error` / `#clear-data`；`input`/`send` 供「问 AI」复用对话页发送链路。 */
const ID = {
  faultInput: "#fault-input", faultRecent: "#fault-recent", faultResult: "#fault-result",
  ticketForm: "#ticket-form", ticketEmail: "#ticket-email", ticketQuestion: "#ticket-question",
  ticketSubmit: "#ticket-submit", ticketErr: "#ticket-err, #ticket-error", ticketDone: "#ticket-done",
  ticketNo: "#ticket-no", ticketCopy: "#ticket-copy", ticketStatus: "#ticket-status",
  ticketState: "#ticket-state", clear: "#me-clear, #clear-data", appVersion: "#app-version",
  input: "#input", send: "#btn-send",
};
/** @param {{ ui: Record<string, any>, state: any, t: (key: string, vars?: Record<string, unknown>) => string,
 *  el: (tag: string, cls?: string|null, text?: string) => Element, elHtml?: unknown }} deps */
export function createViews({ ui, state, t, el }) {
  const root = ui?.el?.querySelector instanceof Function ? ui.el : document; // 页面根（#app），没有就从 document 查
  const qa = (selector) => [...root.querySelectorAll(selector)];
  // 三个次级页是 `<section data-view="…">`（markup 的选择），`#view-*` 只是兼容另一种写法；body 自己也有
  // data-view，所以这里必须限定到 section，否则 `querySelector("[data-view=fault]")` 会把 body 当成面板。
  const panelOf = (name) => root.querySelector(`section[data-view="${name}"], #view-${name}`);
  const storage = (() => { try { return window.localStorage; } catch { return null; } })(); // 隐私模式下访问就会抛
  /** app.css 的徽章只认 `data-tone`（info|accent|warn|fatal），不是 class。 */
  const badge = (tone, text) => { const node = el("span", "badge", text); node.setAttribute("data-tone", tone); return node; };
  /** 可重渲染的视图状态：`onLang` 靠它把动态文本换成新语言（静态节点由 user.js 的 applyLang 换）。*/
  const view = { fault: { kind: "idle" }, ticketErr: null, status: null, due: "", statusErr: null };
  const refs = {}, recent = { list: [] };
  let debounceTimer = 0, lookupSeq = 0, lastLookupCode = "", busy = false, version = "";
  /** 卡里那份数据是**哪一语**抓的。判据在 `lib/fault-card.js:needsRefetch`，这里只存事实：
   *  没有它就分不清"语言没变（第二次 onLang 别再发请求）"和"语言变了（必须重取）"。 */
  let lastFaultLang = "";
  let email = "", ticketNo = ""; // 邮箱与单号：查状态要原样带上（05 §3.5）
  const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
/* ─────────────────────────── 故障码页（10 §5） ─────────────────────────── */
/** 判形不过就**不请求、不报错**（占位提示已说明格式），顺手清掉上一条结果，否则用户删字时会盯着一张对不上
 *  的旧卡。`lastLookupCode` 一起清空，否则删回同一个码不会重新查。 */
function onFaultInput() {
  window.clearTimeout(debounceTimer);
  const code = matchFaultCode(refs.faultInput?.value ?? "");
  if (code === null) { lookupSeq += 1; lastLookupCode = ""; view.fault = { kind: "idle" }; renderFault(); return; }
  if (code === lastLookupCode && view.fault.kind !== "error") return; // 同一个码不重复打请求
  debounceTimer = window.setTimeout(() => { void lookup(code); }, DEBOUNCE_MS);
}
/** 一次主键查询。`lang` 从 `state.lang` 现取 —— 调用方（首次查 / 切语言重取）都不该自带语言，
 *  否则两条路径会有两个"当前语言"的来源。 */
async function getFault(code) {
  const query = `?lang=${encodeURIComponent(state.lang)}&product_line=${PRODUCT_LINE}`;
  const res = await fetch(`/api/fault/${encodeURIComponent(code)}${query}`, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => null);
  return { res, body };
}
/** 把响应体折成 `view.fault`。命中/未命中/形状不对三种结果只在这里判一次（首次查与重取共用）。 */
function faultOf(code, body) {
  const data = body?.data ?? {};
  if (data.found === true) return { kind: "hit", data };
  if (data.found === false) return { kind: "miss", code: String(data.code ?? code) };
  return { kind: "error" };
}
async function lookup(code) {
  const seq = (lookupSeq += 1);
  lastLookupCode = code; view.fault = { kind: "searching", code }; renderFault();
  let res = null, body = null;
  try {
    ({ res, body } = await getFault(code));
  } catch {
    if (seq === lookupSeq) { view.fault = { kind: "error" }; renderFault(); }
    return;
  }
  if (seq !== lookupSeq) return; // 慢响应不能盖掉后发的那次查询
  if (res.ok !== true || body?.ok !== true) { view.fault = { kind: "error" }; renderFault(); return; }
  remember(code); // 只有服务端答过的码才进「最近」：打错一个字母的码不该占坑
  lastFaultLang = state.lang; // 这份数据就是这一语抓的，记下来给 needsRefetch 用
  view.fault = faultOf(code, body);
  renderFault(); renderRecent();
}
/**
 * 切语言后**静默**重取当前卡（D1 / 录音里"切哪国描述都是中文"）。
 *
 * 三条刻意的克制：
 *   - 不进 `searching` 态：切个语言看到"搜索中…"闪一下，比看到半秒旧语言更糟；
 *   - 失败就保留旧卡、不弹 toast：旧语言的卡仍然有信息量，弹错只会打断切语言的节奏；
 *   - 不写「最近」（不调 `remember`）：这不是一次用户发起的查询，不该挤掉真实查询的位置。
 * `lookupSeq` 与 `lookup` 共用：重取还没回来用户又敲了别的码，慢响应必须让位（否则会盖掉新卡）。
 */
async function refetchFault() {
  const fault = view.fault;
  if (!needsRefetch({ kind: fault.kind, lang: state.lang, lastLang: lastFaultLang })) return;
  const code = fault.kind === "hit" ? String(fault.data?.code ?? lastLookupCode) : String(fault.code ?? "");
  if (code === "") return;
  const seq = (lookupSeq += 1);
  try {
    const { res, body } = await getFault(code);
    if (seq !== lookupSeq) return; // 期间用户查了别的码：这张卡已经不是"当前卡"了
    if (res.ok !== true || body?.ok !== true) return; // 静默失败：保留旧卡
    lastFaultLang = state.lang;
    view.fault = faultOf(code, body);
    renderFault();
  } catch { /* 离线/抖动：保留旧卡，不发第二遍错 */ }
}
/** 去重与截断由 `lib/fault-recent.js` 决定（同一个码不该占满三个坑）。*/
function remember(code) {
  recent.list = pushRecent(recent.list, code, FAULT_RECENT_MAX);
  saveRecent(storage, recent.list);
}
function renderFault() {
  const box = refs.faultResult, fault = view.fault;
  if (!box) return;
  if (fault.kind === "idle") { box.replaceChildren(); box.hidden = true; return; }
  box.hidden = false;
  if (fault.kind === "searching") { box.replaceChildren(el("p", "fault-h", t("fault.searching"))); return; }
  if (fault.kind === "error") {
    const key = navigator.onLine === false ? "chat.err.offline" : "chat.err.internal";
    box.replaceChildren(el("p", "fault-h", t(key))); return;
  }
  box.replaceChildren(fault.kind === "hit" ? hitCard(fault.data) : missCard(fault.code));
}
function hitCard(data) {
  const card = el("div", "card fault-card");
  const severity = ["warn", "fatal"].includes(data.severity) ? data.severity : "info"; // 未知严重度按「提示」画
  card.append(el("span", "fault-code", String(data.code ?? "")), badge(severity, t(`fault.severity.${severity}`)));
  const meaning = String(data.meaning ?? "").trim();
  if (meaning !== "") card.append(el("div", "fault-h", t("fault.meaning")), el("p", null, meaning));
  const actions = (Array.isArray(data.actions) ? data.actions : []).map((s) => String(s ?? "").trim()).filter((s) => s !== "");
  if (actions.length > 0) {
    // 语料里的步骤常自带 `1.` 前缀（05 §3.3 的示例就是）：`<ol>` 会自己编号，不剥掉就成了「1. 1. …」。
    const list = el("ol", "fault-actions");
    for (const step of actions) list.append(el("li", null, step.replace(/^\d+[.)]\s*/, "")));
    card.append(el("div", "fault-h", t("fault.actions")), list);
  }
  card.append(el("div", "fault-source", t("fault.source"))); // 固定文案：结论来自表，不是模型记忆
  return card;
}
function missCard(code) {
  const card = el("div", "card fault-miss"), ask = el("button", "btn btn-primary", t("fault.notfound.ask"));
  ask.type = "button"; ask.addEventListener("click", () => askAI(code));
  card.append(el("p", "fault-h", t("fault.notfound", { code })), ask);
  return card;
}
/** 「问 AI」= 切回对话页并把码发出去。复用 user.js 已有的发送链路（`#input` + `#btn-send`），不自己 POST
 *  `/api/chat`：收流、四态、令牌刷新、连发全在那边，另起一条只会长出第二套状态机。发的是**码本身**，
 *  不替用户编问句 —— 用户没说过的话不该出现在自己的气泡里。 */
function askAI(code) {
  show("chat");
  const input = refs.input ?? ui.input; if (!input) return;
  input.value = code;
  input.dispatchEvent(new Event("input", { bubbles: true })); // 让 user.js 的 grow() 重算高度
  (refs.send ?? ui.send)?.click();
}
function renderRecent() {
  const box = refs.faultRecent; if (!box) return;
  box.replaceChildren(); box.hidden = recent.list.length === 0;
  for (const code of recent.list) {
    const chip = el("button", "btn btn-ghost fault-code", code); // 复用 .fault-code 的等宽字体：一眼是「码」不是「词」
    chip.type = "button";
    // 点最近查询**直接查**，不过 400ms 防抖：这不是输入中途，是明确的「就看这个」。
    chip.addEventListener("click", () => { if (refs.faultInput) refs.faultInput.value = code; void lookup(code); });
    box.append(chip);
  }
}

/* ─────────────────────────── 转人工页（10 §6） ─────────────────────────── */
/** 邮箱失焦：空着不算错（失焦常常只是还没填到那儿），只有「填了但格式不对」才提示。 */
function onEmailBlur() {
  const addr = (refs.ticketEmail?.value ?? "").trim();
  const bad = addr !== "" && EMAIL_RE.test(addr) !== true;
  if (!refs.ticketEmail) return;
  if (bad) refs.ticketEmail.setAttribute("aria-invalid", "true"); else refs.ticketEmail.removeAttribute("aria-invalid");
  if (bad) setTicketErr("ticket.email.invalid");
  else if (view.ticketErr === "ticket.email.invalid") setTicketErr(null);
}
function setTicketErr(key) {
  view.ticketErr = key ?? null;
  if (!refs.ticketErr) return;
  refs.ticketErr.textContent = view.ticketErr === null ? "" : t(view.ticketErr);
  refs.ticketErr.hidden = view.ticketErr === null;
}
/** 令牌过期/被清掉时重签一次再重试：让用户重填一遍表单是最糟的失败提示（401 在这里几乎只有这一种成因）。 */
async function authedFetch(url, init) {
  let res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), "x-user-session": state.token ?? "" } });
  if (res.status !== 401) return res;
  const minted = await fetch("/api/session", { method: "POST" }).then((r) => r.json()).catch(() => null);
  const token = minted?.data?.token;
  if (typeof token !== "string") return res;
  state.token = token; sessionStorage.setItem("wt:token", token);
  return fetch(url, { ...init, headers: { ...(init.headers ?? {}), "x-user-session": token } });
}
async function submitTicket() {
  if (busy) return;
  const addr = (refs.ticketEmail?.value ?? "").trim(), question = (refs.ticketQuestion?.value ?? "").trim();
  if (EMAIL_RE.test(addr) !== true) {
    refs.ticketEmail?.setAttribute("aria-invalid", "true"); refs.ticketEmail?.focus();
    setTicketErr("ticket.email.invalid"); return;
  }
  refs.ticketEmail?.removeAttribute("aria-invalid"); setTicketErr(null);
  // 从没聊过天就没有会话（`state.convId` 要等第一条消息的 meta 帧）。后端允许不带 conv_id 建单
  //（冷启动转人工是真实场景：打开就要找人），只是没有"5 分钟幂等"可言；有会话才带，别发空串。
  const hasConv = typeof state.convId === "string" && state.convId !== "";
  busy = true; if (refs.ticketSubmit) refs.ticketSubmit.disabled = true; // 禁用按钮：防双击（后端幂等只保 5 分钟）
  let res = null, body = null;
  try {
    res = await authedFetch("/api/ticket", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      // `reason` 不传：05 §3.4「原因由后端按触发路径写入」，这条路径恒为 `user_request`。
      body: JSON.stringify({ conv_id: hasConv ? state.convId : undefined, email: addr, question }),
    });
    body = await res.json().catch(() => null);
  } catch {
    setTicketErr(navigator.onLine === false ? "chat.err.offline" : "chat.err.internal");
  } finally {
    busy = false;
    if (refs.ticketSubmit) refs.ticketSubmit.disabled = false;
  }
  if (res === null) return;
  if (res.ok === true && body?.ok === true) { onTicketCreated(body.data ?? {}, addr); return; }
  // QUOTA_TICKET 是 429（每 token 每小时 3 张）：被限流时表单留着，用户过一会儿还能再交。
  setTicketErr(ERR_KEY[body?.error?.code] ?? (res.status === 429 ? "ticket.quota" : "chat.err.internal"));
}
function onTicketCreated(data, addr) {
  email = addr; ticketNo = typeof data.no === "string" ? data.no : "";
  if (refs.ticketNo) refs.ticketNo.textContent = ticketNo;
  if (refs.ticketForm) refs.ticketForm.hidden = true; // 建完就别再让人点「提交」（幂等只保 5 分钟）
  if (refs.ticketDone) refs.ticketDone.hidden = false;
  view.status = typeof data.status === "string" ? data.status : null;
  view.due = ""; view.statusErr = null; renderStatus();
  refs.ticketCopy?.focus(); // 单号是这一屏唯一要带走的东西，焦点直接落到「复制」
}
function renderStatus() {
  const box = refs.ticketState;
  if (!box) return;
  box.replaceChildren();
  if (view.statusErr !== null) { box.hidden = false; box.append(el("p", "fault-h", t(view.statusErr))); return; }
  if (typeof view.status !== "string" || view.status === "") { box.hidden = true; return; }
  box.hidden = false;
  // 服务端只有四态（DB check 约束）；万一将来多一态，按「待处理」画，不把枚举值当文案漏给用户。
  const status = TICKET_STATUSES.includes(view.status) ? view.status : "open";
  box.append(badge(TICKET_TONE[status], t(`ticket.status.${status}`)));
  if (view.due !== "") {
    const when = new Date(view.due), due = el("p", "ticket-hint", t("ticket.due"));
    if (!Number.isNaN(when.getTime())) due.append(" ", when.toLocaleString(state.lang));
    box.append(due);
  }
}
async function loadStatus() {
  if (ticketNo === "" || email === "") return;
  if (refs.ticketStatus) refs.ticketStatus.disabled = true;
  let res = null, body = null;
  try {
    // 这条要令牌（05 §3.5）：单号是序列号，公开查询等于把整张表的存在性交出去。
    res = await authedFetch(`/api/ticket/${encodeURIComponent(ticketNo)}?email=${encodeURIComponent(email)}`,
      { headers: { accept: "application/json" } });
    body = await res.json().catch(() => null);
  } catch {
    view.status = null; view.statusErr = navigator.onLine === false ? "chat.err.offline" : "chat.err.internal";
    renderStatus();
  } finally {
    if (refs.ticketStatus) refs.ticketStatus.disabled = false;
  }
  if (res === null) return;
  if (res.ok !== true || body?.ok !== true) { // 05 §3.5：号不存在与邮箱不匹配都回同一个 404，别去猜是哪种。
    view.status = null; view.due = ""; view.statusErr = ERR_KEY[body?.error?.code] ?? "chat.err.internal";
    renderStatus(); return;
  }
  const data = body.data ?? {};
  view.status = typeof data.status === "string" ? data.status : null;
  view.due = typeof data.due_at === "string" ? data.due_at : ""; // §3.5 的示例没有 due_at，有就显示
  view.statusErr = null; renderStatus();
}
/** 复制单号：clipboard 只在 https/localhost 可用，局域网 http 调试必失败，故备 select()+execCommand 的老路；
 *  两条都失败就选中单号让用户长按复制（复制不是主线，不该为它弹错）。 */
async function copyTicketNo() {
  const no = ticketNo !== "" ? ticketNo : (refs.ticketNo?.textContent ?? "").trim();
  if (no === "") return;
  // 成功提示由 user.js 的 toast 负责：这里只广播 key，文案表不在本模块。
  if (await writeClipboard(no)) { document.dispatchEvent(new CustomEvent("views:toast", { detail: { key: "common.copied" } })); return; }
  selectNode(refs.ticketNo);
}
async function writeClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 没权限 / 非安全上下文：落到下面的回退 */ }
  try {
    const area = el("textarea");
    area.value = text; area.setAttribute("readonly", ""); // 只读：iOS 上可写区域会弹键盘
    area.style.position = "fixed"; area.style.top = "-1000px"; // 不能 display:none：不可见元素没法 select
    document.body.append(area); area.select();
    const ok = document.execCommand("copy");
    area.remove(); return ok === true;
  } catch { return false; }
}
function selectNode(node) {
  if (!node) return;
  const range = document.createRange(), selection = window.getSelection?.();
  range.selectNodeContents(node); selection?.removeAllRanges(); selection?.addRange(range);
}

/* ─────────────────────────── 我的页（10 §7） ─────────────────────────── */
function setLang(lang) {
  const value = SUPPORTED_LANGS.includes(lang) ? lang : state.lang;
  state.lang = value; // 先落到 state：紧接着要问的下一句就带新语言
  try { storage?.setItem("wt:lang", value); } catch { /* 存不住不影响这一屏 */ }
  document.documentElement.lang = value;
  document.dispatchEvent(new CustomEvent("views:lang", { detail: { lang: value } })); // user.js 重新 loadI18n + applyLang
  onLang(); // 先用旧字典刷一遍，等新字典到位 user.js 会再调一次
}
function applyTheme(theme) {
  const value = THEMES.includes(theme) ? theme : "system";
  // 「跟随系统」= body 上不留属性，由 html 承载解析后的明暗：index.html 写死的 `<html data-theme="light">` 是
  // 首屏兜底，不跟着改的话「跟随系统」会永远停在浅色。
  const resolved = value === "system" ? (darkQuery?.matches === true ? "dark" : "light") : value;
  if (value === "system") delete document.body.dataset.theme; else document.body.dataset.theme = value;
  document.documentElement.dataset.theme = resolved;
}
function setTheme(theme) {
  const value = THEMES.includes(theme) ? theme : "system";
  try { storage?.setItem("wt:theme", value); } catch { /* 同上 */ }
  applyTheme(value); syncMeControls();
}
function readTheme() {
  try {
    const stored = storage?.getItem("wt:theme") ?? "";
    return THEMES.includes(stored) ? stored : "system"; // 没选过 / 存储被禁用就跟随系统
  } catch { return "system"; }
}
function syncMeControls() {
  for (const radio of refs.langRadios ?? []) radio.checked = radio.value === state.lang;
  const theme = readTheme();
  for (const radio of refs.themeRadios ?? []) radio.checked = radio.value === theme;
}
/** 版本号只读一次：meta 优先，其次 markup 里 `#app-version` 的原样文本（两个 agent 各写一半时的兜底）。*/
function readVersion() {
  const meta = document.querySelector('meta[name="app-version"]');
  const fromMeta = (meta?.getAttribute("content") ?? "").trim();
  return fromMeta !== "" ? fromMeta : (refs.appVersion?.textContent ?? "").trim();
}
function renderVersion() {
  if (!refs.appVersion || version === "") return; // 没有任何版本来源就原样留着 markup 里的字，不编一个号
  refs.appVersion.textContent = t("me.version", { v: version });
}
function clearLocal() {
  if (window.confirm(t("me.data.clear.confirm")) !== true) return; // 破坏性操作先确认
  const lang = state.lang;
  try {
    storage?.clear();
    window.sessionStorage.clear(); // 令牌与会话 id 在这里：清完就是全新匿名访客
    storage?.setItem("wt:lang", lang); // 语言是这台机器的偏好，不属于被清掉的会话数据
  } catch { /* 存储被禁用：刷新后回到浏览器语言，不阻塞 */ }
  window.location.reload();
}

/* ─────────────────────────── 视图切换（10 §1） ─────────────────────────── */
function show(name) {
  if (VIEWS.includes(name) !== true) return;
  document.body.dataset.view = name; // CSS 靠它切显隐：非 chat 视图藏 .stream/.status/.composer
  for (const tab of qa("[data-tab]")) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    if (active) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
  }
  for (const other of VIEWS) {
    const panel = panelOf(other);
    if (panel) panel.hidden = other !== name; // 对话页没有独立 section：显隐由 CSS + body[data-view] 决定
  }
  if (name === "fault") renderRecent();
  if (name === "me") syncMeControls();
  focusTitle(name);
  // 从对话页切走时**不动**正在流的这一轮：视图只是显隐，收流与四态都在 user.js 里继续跑到底。
}
/** 切页后把焦点移到该页标题（读屏用户才知道页面换了）。三视图没有 h1/h2，小标题是 `<legend>`，所以找不到
 *  标题时退到 section 本身；两者都临时补 tabindex=-1 —— 不可聚焦的元素 focus() 是空操作，而 markup 常忘。 */
function focusTitle(name) {
  const panel = panelOf(name);
  if (!panel) return; // chat：焦点留给输入框，别在标签间来回抢
  const target = panel.querySelector("[data-view-title]") ?? panel.querySelector("h1, h2, legend") ?? panel;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}
/** 切语言（或首屏点亮动态文本）时的唯一重渲染入口。
 *  `renderFault()` 用的是 `view.fault` 里的旧数据 —— 标题会立刻换成新文案，正文还是抓取时那一语；
 *  紧接着的 `refetchFault()` 才是把正文换掉的那一步（它自己判"要不要发"，同一语言连调两次只发一次）。 */
const onLang = () => {
  renderVersion(); renderFault(); renderRecent(); setTicketErr(view.ticketErr); renderStatus();
  void refetchFault();
};

/* ─────────────────────────── 绑定 ─────────────────────────── */
function binder() {
  for (const [key, selector] of Object.entries(ID)) refs[key] = root.querySelector(selector);
  refs.langRadios = qa('input[name="lang"]'); refs.themeRadios = qa('input[name="theme"]');
  recent.list = loadRecent(storage); version = readVersion();

  refs.faultInput?.addEventListener("input", onFaultInput);
  // 表单提交是建单的唯一入口：`#ticket-submit` 必须写成 form 内的 type=submit，否则这里收不到事件。
  refs.ticketForm?.addEventListener("submit", (event) => { event.preventDefault(); void submitTicket(); });
  refs.ticketEmail?.addEventListener("blur", onEmailBlur);
  refs.ticketCopy?.addEventListener("click", () => { void copyTicketNo(); });
  refs.ticketStatus?.addEventListener("click", () => { void loadStatus(); });
  refs.clear?.addEventListener("click", clearLocal);
  for (const radio of refs.langRadios) radio.addEventListener("change", () => { if (radio.checked) setLang(radio.value); });
  for (const radio of refs.themeRadios) radio.addEventListener("change", () => { if (radio.checked) setTheme(radio.value); });
  for (const tab of qa("[data-tab]")) tab.addEventListener("click", (event) => { event.preventDefault(); show(tab.dataset.tab); });
  // 系统主题变了：只有「跟随系统」要跟，用户显式选过明/暗就不打扰。
  darkQuery?.addEventListener?.("change", () => { if (readTheme() === "system") applyTheme("system"); });

  applyTheme(readTheme()); syncMeControls(); onLang(); // 一次性点亮动态文本（版本号 / 最近查询 / 空结果）
  // 首次进入不抢焦点：`show()` 留给 tab 点击与 user:handoff，页面按 markup 的 data-view="chat" 起。
  const current = document.body.dataset.view;
  for (const tab of qa("[data-tab]")) if (tab.dataset.tab === current) tab.setAttribute("aria-current", "page");
}
/** 从对话页「转人工」进来：问题已经问过了，预填进描述框，焦点落在邮箱（用户只需补联系方式）。*/
function handoff(question) {
  const text = typeof question === "string" ? question.trim() : "";
  if (refs.ticketQuestion && text !== "") refs.ticketQuestion.value = text;
  // 已经建过单又点了转人工：把表单放回来（同一会话 5 分钟内再提交拿回同一张单），但不擦掉已显示的单号。
  if (refs.ticketDone?.hidden === false && refs.ticketForm) refs.ticketForm.hidden = false;
  setTicketErr(null); show("ticket"); refs.ticketEmail?.focus();
}
return { binder, show, onLang, handoff };
}
