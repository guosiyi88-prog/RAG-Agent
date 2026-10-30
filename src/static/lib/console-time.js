/**
 * 时间格式化（`11-ui-console.md` §2.1「创建列 `MM-DD HH:mm`」/ §3.2「每条消息右下角 `HH:mm`」）。
 *
 * 全部按**浏览器本地时区**渲染，不用 UTC：坐席看的是"我什么时候接的这单"，
 * 和后端日志里的 UTC 是两件事；`datetime` 属性保留原始 ISO，读屏与调试仍拿到真值。
 *
 * 认不出的时间给 `—`，不抛异常：脏数据不该让整张表或整条对话渲染失败。
 */

const pad2 = (value) => String(value).padStart(2, "0");

function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `MM-DD HH:mm`（本地时区）。列表的"创建"、详情的"创建/截止"用它。 */
export function formatDayMinute(value) {
  const date = toDate(value);
  if (date === null) return "—";
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** `HH:mm`（本地时区）。对话流每条消息的角标时间用它。 */
export function formatClock(value) {
  const date = toDate(value);
  if (date === null) return "—";
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
