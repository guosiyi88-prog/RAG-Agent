/**
 * 详情 URL 锚点解析（`11-ui-console.md` §4「路由」/ 工单 07#02「URL 用锚点 `#/ticket/<id>`」）。
 *
 * 为什么单独一个文件：刷新能回到同一单、把链接发给同事，这两件事都只依赖这一个格式，
 * 而解析与生成必须**互为逆运算** —— 写歪任何一侧的症状都不是"报错"，是"刷新回到队列"，
 * 人只会觉得"这破页面又丢了我的单"，很难定位。
 *
 * 格式固定 `#/ticket/<正整数>`，其余一律"没有选中"（`null`）：
 *   空 hash、`#`、`#/ticket/`、`#/ticket/abc`、`#/ticket/0`、`#/board` 都回 `null`。
 * 用 `null` 而不是 `undefined`：调用方会把它和 `state.ticketId` 比较，少一种"空值形态"就少一类 bug。
 */

const TICKET_PREFIX = "#/ticket/";

/** 解析 `location.hash` → 工单 id（正整数）或 `null`。 */
export function parseHash(hash) {
  if (typeof hash !== "string") return null;
  let raw = hash.trim();
  if (raw === "") return null;
  if (raw.startsWith("#")) raw = raw.slice(1);
  // 大小写不敏感：手打/复制时 `#/Ticket/31` 很常见，但语义完全一致，没有理由让人卡住。
  if (!raw.toLowerCase().startsWith("/ticket/")) return null;

  const tail = raw.slice("/ticket/".length);
  // 只认纯十进制数字：`/^\d+$/` 会放过 `+31`、`3e1`、` 31`、`31abc`，这些都不是工单 id。
  if (!/^\d+$/.test(tail)) return null;
  const id = Number(tail);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

/** 工单 id → 锚点。与 `parseHash` 互逆：`parseHash(ticketHash(id)) === id`。 */
export function ticketHash(id) {
  const value = Number(id);
  if (!Number.isSafeInteger(value) || value <= 0) return "";
  return `${TICKET_PREFIX}${value}`;
}

/**
 * 复制链接用：把当前地址里的 hash 换掉，其余（协议/主机/路径、可能的反代前缀）原样保留。
 * 传 `null` 表示"回队列"，会去掉 hash 而不是留一个尾随 `#`。
 */
export function linkFor(location, id) {
  const href = typeof location?.href === "string" ? location.href : "";
  if (href === "") return "";
  const base = href.split("#")[0];
  const hash = id === null || id === undefined ? "" : ticketHash(id);
  return `${base}${hash}`;
}
