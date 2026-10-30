/**
 * 键盘映射（`11-ui-console.md` §5 / 工单 07#02「J/K 上下移动、回车打开、Esc 返回、Ctrl/Cmd+Enter 发送」）。
 *
 * 为什么是纯函数：键盘是"看起来能用就没人测"的典型。把 `event → 动作` 的判定抽出来，
 * 就能不碰 DOM 地钉住最容易出错的两条 —— 输入框聚焦时不能抢打字（`J`/`K`/`Enter` 全部让位），
 * 以及 `Ctrl/Cmd + Enter` 在两种视图下都只表示"发送"。
 *
 * 动作字符串由 `console.js` 解释；本文件不生成 DOM、不读 `window`。
 */

export const ACTION = {
  next: "next",
  prev: "prev",
  open: "open",
  back: "back",
  send: "send",
  help: "help",
  ignore: "ignore",
};

/**
 * 焦点是否在可输入控件里。`SELECT` 也算：在筛选下拉里按 `j` 应该是"跳到 j 开头的选项"，
 * 不是"选中下一行工单"（后者会让坐席以为自己在下拉里选了东西，实际切走了工单）。
 */
export function isEditableTarget(target) {
  if (target === null || typeof target !== "object") return false;
  const tag = String(target.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable === true;
}

/**
 * `event` + 视图上下文 → 动作。
 *
 * `ctx.view` 取 `"queue"` / `"detail"`；`ctx.editable` 一般来自 `isEditableTarget(event.target)`。
 * 优先级刻意写成这个顺序：
 *   1. `Ctrl/Cmd + Enter` 先判（它在输入框里也要生效，是唯一的"发送"手势）；
 *   2. 输入框聚焦 → 其余全部忽略（不劫持打字）；
 *   3. 带修饰键的字母键忽略（`Ctrl+J`、`Cmd+K` 属于浏览器/系统，不该被抢）；
 *   4. 再按视图分派。
 */
export function mapKey(event, ctx = {}) {
  if (event === null || typeof event !== "object") return ACTION.ignore;
  const key = typeof event.key === "string" ? event.key : "";
  const modifier = event.ctrlKey === true || event.metaKey === true;
  const view = ctx.view === "detail" ? "detail" : "queue";
  const editable = ctx.editable === true;

  if (modifier && key === "Enter") return view === "detail" ? ACTION.send : ACTION.ignore;
  if (editable) return ACTION.ignore;
  if (modifier || event.altKey === true) return ACTION.ignore;

  if (key === "j" || key === "J") return view === "queue" ? ACTION.next : ACTION.ignore;
  if (key === "k" || key === "K") return view === "queue" ? ACTION.prev : ACTION.ignore;
  if (key === "Enter") return view === "queue" ? ACTION.open : ACTION.ignore;
  if (key === "Escape") return view === "detail" ? ACTION.back : ACTION.ignore;
  if (key === "?") return ACTION.help;
  return ACTION.ignore;
}
