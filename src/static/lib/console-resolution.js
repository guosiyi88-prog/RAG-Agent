/**
 * 关单结论的校验（`05-api.md` §4.3「status=closed 时 resolution 必填且 ≥10 字符」/ 工单 07#02）。
 *
 * 前端做这一遍**不是**为了替代后端（后端照样会回 `VALIDATION`），而是为了让按钮在输入不足时
 * 就是禁用的 —— 点一次、等一个 400、再回来看提示，坐席会以为系统坏了。
 *
 * 计数口径必须与后端一致：`trim` 后按**字符**数，不用 `String.length`。
 * 后者数的是 UTF-16 码元，一个 emoji 或部分生僻字会被算成 2，中文（BMP 内）恰好是 1 ——
 * 这种"某些字算两个"的偏差只会在特定客户的问题摘要里冒出来，事后极难解释。
 */

export const RESOLUTION_MIN_CHARS = 10;

/** `trim` 后按码点计数；`null`/非字符串按空串处理。 */
export function countChars(text) {
  const value = typeof text === "string" ? text : String(text ?? "");
  return Array.from(value.trim()).length;
}

/** 能否关单：≥10 字。 */
export function isValidResolution(text) {
  return countChars(text) >= RESOLUTION_MIN_CHARS;
}

/** 输入框旁边的实时提示：还差多少字 / 可以关单。 */
export function resolutionHint(text) {
  const count = countChars(text);
  if (count >= RESOLUTION_MIN_CHARS) return "可以关单";
  return `还差 ${RESOLUTION_MIN_CHARS - count} 字`;
}

/** 发送前的最后一道：去掉首尾空白后的正文（空串 = 不该发）。 */
export function normalizeResolution(text) {
  const value = typeof text === "string" ? text : String(text ?? "");
  return value.trim();
}
