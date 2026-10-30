/**
 * 最近查询的故障码（`10-ui-user.md` §5：`localStorage.faultRecent`，最多 3 个）。
 *
 * 纯函数 + 调用方传 storage：存储是副作用，放进这里就没法在 node 里断言"去重与截断"这两条
 * 最容易写错的规则（重复点击同一个码不该占两个坑）。
 */

/** 最多留 3 条：再多就顶掉结果卡的空间，而且现场只关心刚查过的那几个码。 */
export const FAULT_RECENT_MAX = 3;

/**
 * 把一个码推到队首：已存在则先移除再插回（最近一次优先），去重后截断到 3。
 * 返回**新数组**，不改入参 —— 调用方要拿旧值做 diff 时不会被悄悄改掉。
 */
export function pushRecent(list, code, max = FAULT_RECENT_MAX) {
  const normalized = String(code ?? "").trim().toUpperCase();
  if (normalized === "") return Array.isArray(list) ? [...list] : [];
  const rest = (Array.isArray(list) ? list : []).filter((item) => item !== normalized);
  return [normalized, ...rest].slice(0, Math.max(1, max));
}

/** 读本地：JSON 坏掉、不是数组、含非字符串项都当没有——缓存坏了不该让页面白屏。 */
export function loadRecent(storage) {
  try {
    const raw = storage?.getItem("faultRecent");
    if (typeof raw !== "string" || raw === "") return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === "string" && /^[A-Za-z]\d{2,3}$/.test(item)).slice(0, FAULT_RECENT_MAX);
  } catch {
    return [];
  }
}

/** 写本地：写失败（隐私模式、配额满）静默跳过 —— 记不住历史不影响查询本身。 */
export function saveRecent(storage, list) {
  try {
    storage?.setItem("faultRecent", JSON.stringify(list.slice(0, FAULT_RECENT_MAX)));
  } catch {
    /* 存储不可用：功能降级为"没有最近查询" */
  }
}
