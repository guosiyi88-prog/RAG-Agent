/**
 * 引用抽屉的 DOM 控制器（`06-user-web-ui` #02）：点角标 → 底部滑出 → 聚焦关闭按钮 →
 * Esc / 下滑超阈值 / 点蒙层关闭 → 焦点回到原角标。抽成独立模块只为把 `user.js` 压在 400 行内；
 * 动画时长、手势阈值、索引环绕全部来自 `lib/sheet.js`（纯逻辑、有单测），这里只碰 DOM。
 */
import {
  SHEET_OPEN_MS, SHEET_CLOSE_MS, SHEET_SWIPE_CLOSE_PX,
  durationMs, stepIndex, shouldCloseBySwipe, nextFocusIndex, titleOf, clampPercent,
} from "./sheet.js";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * @param {{
 *   ui: Record<string, any>, state: any, turnMeta: WeakMap<Element, any>,
 *   el: (tag: string, cls?: string|null, text?: string) => Element,
 *   t: (key: string, vars?: Record<string, unknown>) => string,
 * }} deps
 */
export function createCiteSheet({ ui, state, turnMeta, el, t }) {
  const sheet = { open: false, opener: null, openerIdx: "", dy: 0, startY: 0, started: 0, pointerId: null, dragging: false, timer: 0, openTimer: 0, onEnd: null };
  const prefersReduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

/* ─────────────────────── 引用抽屉（06#02） ─────────────────────── */
/** `user:cite`：角标（以及别的渲染路径）都从这里进抽屉。`state.citations` 是唯一真源，关掉再开、
 *  上一条下一条都读它，不读 DOM。位置由引用编号反查 —— 编号不是数组下标。 */
function onCiteEvent(event) {
  const detail = event?.detail ?? {};
  state.citations = Array.isArray(detail.citations) && detail.citations.length > 0
    ? detail.citations : detail.citation ? [detail.citation] : [];
  openCitation(detail.idx);
}
/** 兜底的委派路径：不是 `citeButton` 造的 `.cite` 也能开抽屉，走同一个 `user:cite`。 */
function onCiteClick(event) {
  const node = event.target?.closest?.(".cite");
  if (node == null || node.dataset.citeWired === "1") return; // 自己造的角标已发过事件，别开两次
  const msg = node.closest(".msg"); const list = turnMeta.get(msg)?.citations ?? [];
  const citation = list.find((cite) => String(cite?.idx) === node.dataset.idx);
  sheet.opener = msg; sheet.openerIdx = node.dataset.idx;
  document.dispatchEvent(new CustomEvent("user:cite", {
    detail: { idx: Number(node.dataset.idx), citation, citations: list, index: Math.max(0, list.indexOf(citation)) },
  }));
}
function openCitation(idx) {
  if (!ui.citeOverlay || !ui.citeSheet || state.citations.length === 0) return; // markup 未就绪 / 没引用：不崩，也不假装打开
  const found = state.citations.findIndex((cite) => Number(cite?.idx) === Number(idx));
  state.citingIdx = found < 0 ? 0 : found; sheet.open = true;
  window.clearTimeout(sheet.timer); window.clearTimeout(sheet.openTimer);
  ui.citeOverlay.removeEventListener("transitionend", sheet.onEnd); sheet.onEnd = null;
  ui.citeOverlay.classList.remove("is-closing"); ui.citeOverlay.hidden = false;
  resetDrag(); renderCite(); document.body.dataset.sheet = "open";
  // 先 hidden=false 再**下一帧**加 class：同一帧改两次，浏览器会把过渡合并掉。
  requestAnimationFrame(() => {
    window.clearTimeout(sheet.openTimer); if (sheet.open) ui.citeOverlay.classList.add("is-open");
  });
  // rAF 在后台标签页不跑：用进入时长兜一层，别让抽屉停在屏幕外。
  sheet.openTimer = window.setTimeout(() => { if (sheet.open) ui.citeOverlay.classList.add("is-open"); }, SHEET_OPEN_MS + 40);
  ui.citeClose?.focus();
}
function closeCitation() {
  if (!sheet.open) return; // 幂等守卫：transitionend 与兜底 setTimeout 都走这里，焦点只还一次
  sheet.open = false; resetDrag(); window.clearTimeout(sheet.openTimer);
  const overlay = ui.citeOverlay; if (!overlay) return;
  // 关闭更快（160ms）；减少动态效果时 CSS 只淡不位移，用进入时长兜。时长一律问 lib，不在这儿写死。
  const ms = Number(prefersReduced() ? durationMs(true, true) : durationMs(false, prefersReduced()));
  const wait = Number.isFinite(ms) && ms > 0 ? ms : SHEET_CLOSE_MS;
  overlay.classList.remove("is-open"); overlay.classList.add("is-closing");
  let finished = false;
  const finish = () => {
    if (finished) return; finished = true;
    overlay.removeEventListener("transitionend", sheet.onEnd);
    window.clearTimeout(sheet.timer); sheet.timer = 0; sheet.onEnd = null;
    overlay.classList.remove("is-closing"); overlay.hidden = true; delete document.body.dataset.sheet;
    restoreCiteFocus(); // 焦点回角标：整条生命周期只做一次
  };
  sheet.onEnd = (event) => { if (event.target === overlay || event.target === ui.citeSheet) finish(); };
  overlay.addEventListener("transitionend", sheet.onEnd);
  sheet.timer = window.setTimeout(finish, wait + 60); // transitionend 被裁掉（或根本没过渡）时的兜底
}
/** 焦点回角标：同一个气泡里按 `data-idx` 找；角标被重渲染掉了就退回气泡本身（`tabindex=-1` 让它可聚焦）。*/
function restoreCiteFocus() {
  const msg = sheet.opener; const idx = sheet.openerIdx;
  sheet.opener = null; sheet.openerIdx = "";
  if (msg == null) return;
  const badge = idx === "" ? null : msg.querySelector(`.cite[data-idx="${idx}"]`);
  const target = badge ?? msg; if (badge === null) target.tabIndex = -1;
  target.focus?.();
}
function renderCite() {
  const list = state.citations;
  if (ui.citeBody) ui.citeBody.replaceChildren(citeCard(list[state.citingIdx] ?? {}));
  if (ui.citeTitle) ui.citeTitle.textContent = citeTitle(state.citingIdx, list.length);
  const single = list.length <= 1; // 单条：两个按钮没意义（10 §4「多引用时显示」）
  for (const node of [ui.citePrev, ui.citeNext]) if (node) { node.disabled = single; node.hidden = single; }
  // 整条底部栏一起收起：只剩 25px 内边距的空条会在抽屉底部留一道没有内容的灰边。
  const foot = ui.citeSheet?.querySelector(".sheet-foot");
  if (foot) foot.hidden = single;
}
/** 卡片内容**完全**照抄服务端下发的引用字段：没有页码就不画页码、没有文档名就不画文档、没有 section 就整段不出现。
 *  **绝不**按序号、按正文、按"看起来该有页码"补一个上去 —— 点开看到不存在的出处，信任直接崩（06 spec 原话）。*/
function citeCard(cite) {
  const card = el("div", "cite-card");
  const doc = typeof cite?.doc_title === "string" ? cite.doc_title.trim() : "";
  if (doc !== "") {
    const head = el("div", "cite-doc", doc);
    const lang = typeof cite?.doc_lang === "string" ? cite.doc_lang.trim().toUpperCase() : "";
    if (lang !== "") head.append(el("span", "badge", lang));
    card.append(head);
  }
  const page = Number.isFinite(cite?.page) ? t("cite.page", { page: cite.page }) : "";
  const section = typeof cite?.section === "string" ? cite.section.trim() : ""; // 服务端目前不下发：没有就整行不出现
  const meta = [page === "cite.page" ? "" : page, section].filter((part) => part !== "");
  if (meta.length > 0) card.append(el("div", "cite-meta", meta.join(" · ")));
  const snippet = typeof cite?.snippet === "string" ? cite.snippet.trim() : "";
  if (snippet === "") { card.append(el("p", "cite-text", t("cite.empty"))); return card; }
  card.append(citeText(snippet, turnMeta.get(sheet.opener)?.query ?? ""));
  return card;
}
/** 只把提问里**确实出现**在片段中的词包 `<mark>`（取最长的一个）：找不到就不标，不做任何猜词。*/
function citeText(snippet, query) {
  const node = el("p", "cite-text"); const hay = snippet.toLowerCase();
  const words = String(query ?? "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? [];
  const hit = words.filter((word) => hay.includes(word)).sort((a, b) => b.length - a.length)[0];
  const at = hit === undefined ? -1 : hay.indexOf(hit);
  if (at < 0) { node.textContent = snippet; return node; }
  node.append(snippet.slice(0, at), el("mark", null, snippet.slice(at, at + hit.length)), snippet.slice(at + hit.length));
  return node;
}
/** 标题「引用 1 / 3」：模板归 `titleOf`，`{i}` / `{n}` 用本地 `cite.title` 填（12 §4.4 的占位符）。*/
function citeTitle(index, total) {
  const base = String(titleOf(index, total) ?? ""); const copy = t("cite.title");
  const template = copy.includes("{i}") || copy.includes("{n}") ? copy : base;
  return template.replace(/\{i\}/g, String(index + 1)).replace(/\{n\}/g, String(total));
}
function stepCite(delta) {
  const total = state.citations.length; if (total <= 1) return;
  const next = Number(stepIndex(state.citingIdx, delta, total));
  if (!Number.isInteger(next) || next < 0 || next >= total) return; // 契约外的返回：不动，也不崩
  state.citingIdx = next; renderCite(); ui.citeBody?.scrollTo?.({ top: 0 });
}
function onSheetKeydown(event) {
  if (!sheet.open) return;
  if (event.key === "Escape") { event.preventDefault(); closeCitation(); return; }
  if (event.key !== "Tab" || !ui.citeSheet) return;
  const list = [...ui.citeSheet.querySelectorAll(FOCUSABLE)]
    .filter((node) => !node.disabled && node.tabIndex !== -1 && node.getClientRects().length > 0);
  if (list.length === 0) return;
  event.preventDefault(); // 焦点留在抽屉里，背景不可 Tab 进入（10 §9）
  const current = list.indexOf(document.activeElement);
  const next = Number(nextFocusIndex(current, event.shiftKey ? -1 : 1, list.length));
  const target = list[Number.isInteger(next) ? ((next % list.length) + list.length) % list.length : current < 0 ? 0 : current];
  target?.focus();
}
/** 下滑关闭：**只认把手与标题区**（`#cite-title` / `.sheet-handle`）；正文要能滚动，手势不抢。
 *  拖动只写 `--sheet-dy`（真的位移交给 CSS），越界提示用 `is-armed` 类，阈值判定交给 lib。 */
function onSheetPointerDown(event) {
  if (!sheet.open || sheet.dragging || event.button !== 0) return;
  if (event.target.closest("#cite-body, .sheet-foot") !== null) return;
  if (event.target.closest("#cite-title, .sheet-handle, .sheet-head") === null) return;
  sheet.dragging = true; sheet.pointerId = event.pointerId; sheet.dy = 0;
  sheet.startY = event.clientY; sheet.started = event.timeStamp;
  // 手指滑出纸片也要继续收 move。合成事件 / 已被系统释放的指针会让 setPointerCapture 抛
  // InvalidPointerId —— 捕获失败不该让整个手势死掉（下面的监听器照常挂）。
  try { ui.citeSheet.setPointerCapture?.(event.pointerId); } catch { /* 指针捕获不可用：退化为普通监听 */ }
  ui.citeSheet.classList.add("is-dragging");
  ui.citeSheet.addEventListener("pointermove", onSheetPointerMove);
  ui.citeSheet.addEventListener("pointerup", onSheetPointerUp);
  ui.citeSheet.addEventListener("pointercancel", resetDrag);
}
function onSheetPointerMove(event) {
  if (!sheet.dragging || event.pointerId !== sheet.pointerId) return;
  sheet.dy = Math.max(0, event.clientY - sheet.startY); // 只往下：往上拖不回弹出屏幕
  if (prefersReduced()) return; // 减少动态效果：阈值照算，但不让纸片真的动
  ui.citeSheet.style.setProperty("--sheet-dy", `${Math.round(sheet.dy)}px`);
  ui.citeSheet.classList.toggle("is-armed", clampPercent((sheet.dy / SHEET_SWIPE_CLOSE_PX) * 100) >= 100);
}
function onSheetPointerUp(event) {
  if (!sheet.dragging || event.pointerId !== sheet.pointerId) return;
  const elapsed = Math.max(1, event.timeStamp - sheet.started);
  const close = shouldCloseBySwipe(sheet.dy, sheet.dy / elapsed); // 第二参数是 px/ms 速度
  const moved = sheet.dy; resetDrag();
  if (close) { closeCitation(); return; }
  if (moved > 0) ui.citeSheet.style.setProperty("--sheet-dy", "0px"); // 没到阈值：弹回去
}
function resetDrag() {
  if (sheet.dragging) {
    sheet.dragging = false;
    try { ui.citeSheet?.releasePointerCapture?.(sheet.pointerId); } catch { /* 指针已自行释放 */ }
    sheet.pointerId = null;
    ui.citeSheet?.removeEventListener("pointermove", onSheetPointerMove);
    ui.citeSheet?.removeEventListener("pointerup", onSheetPointerUp);
    ui.citeSheet?.removeEventListener("pointercancel", resetDrag);
    ui.citeSheet?.classList.remove("is-dragging", "is-armed");
  }
  if (!sheet.open) ui.citeSheet?.style.removeProperty("--sheet-dy"); // 关掉就把偏移清干净，下次从 0 起
}
function bindSheet() {
  document.addEventListener("user:cite", onCiteEvent);
  ui.stream?.addEventListener("click", onCiteClick); // 委派兜底
  document.addEventListener("keydown", onSheetKeydown); // Esc / Tab：焦点在抽屉里，监听放 document 更稳
  ui.citeOverlay?.addEventListener("click", (event) => { if (event.target === ui.citeOverlay) closeCitation(); }); // 点蒙层空白关
  ui.citeClose?.addEventListener("click", () => closeCitation());
  ui.citePrev?.addEventListener("click", () => stepCite(-1));
  ui.citeNext?.addEventListener("click", () => stepCite(1));
  ui.citeSheet?.addEventListener("pointerdown", onSheetPointerDown);
}

  /** 角标点击前先记下 opener：关闭时焦点要回到它（找不到就退回气泡）。 */
  function prepare(msg, idx) { sheet.opener = msg; sheet.openerIdx = idx; }

  return { prepare, bind: bindSheet, close: closeCitation, handleClick: onCiteClick, state: sheet };
}
