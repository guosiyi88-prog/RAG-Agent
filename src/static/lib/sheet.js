/**
 * 引用抽屉的纯逻辑（`06` spec「抽屉」/ `10-ui-user.md` §4）。
 *
 * 抽屉里有三件最容易写错、又最难靠人眼看出来的事：编号环绕（最后一条的"下一条"要回到第一条）、
 * 下滑判定的双条件（滑得够远 **或** 甩得够快）、以及"减少动态效果"下不许位移。
 * 这三件事全是输入 → 输出的算术，所以搬到这里用 node 一格一格断言；
 * 页面那份脚本只负责把触摸事件里的数字喂进来、把返回值写到 style 上。
 *
 * 本文件刻意零依赖、自包含：不引用其他模块、不碰宿主对象、不注册定时器。
 * 一旦这里出现宿主对象，这套断言就跑不起来了 —— 而它是这条关键路径上唯一能自动跑的部分。
 */

/** 打开 220ms（`10-ui-user.md` §4 的 `var(--dur-base)`）。 */
export const SHEET_OPEN_MS = 220;

/**
 * 关闭 160ms，比打开短约 30%。
 * 这不是随手取的小数：人按下"关闭"之后对"它已经没了"的预期非常短，
 * 关闭动画拖到和打开一样长时，手感会像"点了没反应"；反过来打开偏慢一点，反而让"滑出来"看得清。
 */
export const SHEET_CLOSE_MS = 160;

/** 下滑超过这个距离就关闭（页面的 touchmove 与本模块共用这一个数，避免两处阈值漂掉）。 */
export const SHEET_SWIPE_CLOSE_PX = 80;

/**
 * 减少动态效果（`prefers-reduced-motion`）时的时长：只淡入 / 淡出，不做位移。
 * 保留一个短时长而不是 0，是为了不硬切（0ms 的显隐会闪一下）；90/120 已短到读不出"动画"。
 */
const REDUCED_OPEN_MS = 120;
const REDUCED_CLOSE_MS = 90;

/** 甩动关闭的速度门限（px/ms）与最小位移：手快的人只滑一点点也该关掉。 */
const SWIPE_VELOCITY_CLOSE = 0.5;
const SWIPE_MIN_DISTANCE_PX = 20;

/** 所有入参都来自事件对象，可能是 undefined / NaN / 字符串；非有限数值一律当 0，绝不让 NaN 漏进 style。 */
function toNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 引用条数：非正数、非数值、NaN 一律视作"没有引用"（返回 0，调用方据此给出 -1 / 兜底文案）。 */
function toCount(count) {
  const value = toNumber(count);
  return value > 0 ? Math.trunc(value) : 0;
}

/** 环绕取模：JS 的 `%` 对负数给负值（`-1 % 3 === -1`），先补一轮再加模才是真正的"绕回去"。 */
function wrap(value, count) {
  return ((value % count) + count) % count;
}

/**
 * 抽屉动画时长。`reducedMotion` 为真时返回更短的时长（页面据此改成只改 opacity、不改 transform）。
 *
 * @param {boolean} opening 打开还是关闭
 * @param {boolean} reducedMotion 用户是否开了"减少动态效果"
 * @returns {number} 毫秒
 */
export function durationMs(opening, reducedMotion) {
  if (reducedMotion) return opening ? REDUCED_OPEN_MS : REDUCED_CLOSE_MS;
  return opening ? SHEET_OPEN_MS : SHEET_CLOSE_MS;
}

/**
 * 在 0..count-1 里走 `delta` 步并环绕。
 *
 * 环绕是刻意的：抽屉里"下一条"在最后一条必须回到第一条，否则用户滑到末尾会撞死在禁用按钮上，
 * 而 3 条引用的场景里"再点一下就看到第一条"比"按钮变灰"更省事。
 * `count <= 0` 时返回 -1 —— 没有引用就没有位置，页面据此不打开抽屉。
 *
 * @param {number} current 当前序号（0 基）
 * @param {number} delta 步数，负数向前
 * @param {number} count 总数
 * @returns {number} 0..count-1，或 -1
 */
export function stepIndex(current, delta, count) {
  const total = toCount(count);
  if (total <= 0) return -1;
  const from = Number.isInteger(current) ? current : 0;
  const step = Number.isInteger(delta) ? delta : 0;
  return wrap(from + step, total);
}

/**
 * 这一次下滑该不该关闭抽屉。
 *
 * 两个条件取"或"：滑过阈值（默认 80px，够迟钝的手也算数），或者甩得够快（速度 > 0.5 px/ms 且已滑 > 20px）。
 * 只判距离的话，快手一甩 30px 会被弹回原位，像"手机不听话"；只判速度的话，慢慢拖到底反而关不掉。
 * 向上的手势（dy < 0）永不关闭：那是想把它推回去看内容。
 *
 * @param {number} dy 手指纵向位移，向下为正（px）
 * @param {number} velocity 纵向速度，向下为正（px/ms）
 * @param {number} [threshold] 关闭距离阈值
 * @returns {boolean}
 */
export function shouldCloseBySwipe(dy, velocity, threshold = SHEET_SWIPE_CLOSE_PX) {
  const distance = toNumber(dy);
  const speed = toNumber(velocity);
  const limit = toNumber(threshold) > 0 ? toNumber(threshold) : SHEET_SWIPE_CLOSE_PX;
  // 阈值本身也要能关门（`dy` 正好等于 80 算越线），否则手势的边界会有一像素的"死区"。
  if (distance >= limit) return true;
  return speed > SWIPE_VELOCITY_CLOSE && distance > SWIPE_MIN_DISTANCE_PX;
}

/**
 * Tab / Shift+Tab 在焦点环里环绕。
 *
 * 抽屉里只有"上一条 / 下一条 / 关闭"三个按钮，浏览器默认会在最后一个之后跳回地址栏 —— 视觉上等于
 * 焦点跑出了手机框。这里把环自己算出来，页面据此显式 `focus()` 下一个元素。
 * `count <= 0`（没有可聚焦元素）返回 -1，页面什么都不做，别把焦点丢到 body 上。
 *
 * @param {number} current 当前聚焦元素在环里的序号（0 基）
 * @param {number} count 环里可聚焦元素个数
 * @param {boolean} shift 是否 Shift+Tab（反向）
 * @returns {number} 0..count-1，或 -1
 */
export function nextFocusIndex(current, count, shift) {
  return stepIndex(current, shift ? -1 : 1, count);
}

/**
 * 抽屉标题："引用 1 / 3"；没有引用时退化成 "引用"。
 *
 * 序号是 **0 基**（与 `stepIndex` / 页面 `state.citingIdx` 一致），展示时才 +1，
 * 于是 `titleOf(0, 3)` 是"引用 1 / 3"，`titleOf(1, 3)` 是"引用 2 / 3"。
 * 越界或非整数一律先环绕回合法区间 —— 宁可在极端情况下显示"引用 1 / 3"，也不要显示"引用 4 / 3"。
 *
 * 这个字符串只是**兜底**：页面优先用文案 key（`cite.title`）里的 `{i}` / `{n}` 占位符，
 * 由页面的文案函数把两个数字替换进去（五语种因此都不用改代码）；只有 key 缺失时才落到这里的明文。
 *
 * @param {number} index 当前序号（0 基）
 * @param {number} count 总数
 * @returns {string}
 */
export function titleOf(index, count) {
  const total = toCount(count);
  if (total <= 0) return "引用";
  const position = wrap(Number.isInteger(index) ? index : 0, total) + 1;
  return `引用 ${position} / ${total}`;
}

/**
 * 下滑的视觉进度 0..1，页面直接拿它算 `translateY(percent * sheetHeight)`。
 *
 * 夹在 0..1 之间（不回负数、不超过 1）是因为它参与的是 opacity 与位移两个样式：
 * 手指向上推时进度必须是 0（不能反向把抽屉顶出屏幕），拖到底时必须正好 1（不能留一条缝再跳一下）。
 * `height <= 0`（抽屉还没布局出来）返回 0，即"看起来没动"，避免除零得到 Infinity。
 *
 * @param {number} dy 手指纵向位移，向下为正（px）
 * @param {number} height 抽屉高度（px）
 * @returns {number} 0..1
 */
export function clampPercent(dy, height) {
  const distance = toNumber(dy);
  const size = toNumber(height);
  if (size <= 0) return 0;
  if (distance <= 0) return 0;
  if (distance >= size) return 1;
  return distance / size;
}
