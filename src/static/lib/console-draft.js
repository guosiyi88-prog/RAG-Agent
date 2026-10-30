/**
 * 回复草稿的本地存取（`11-ui-console.md` §3.3 / 工单 07#02「草稿按工单 id 存 localStorage，输入即存（防抖 ~300ms）」）。
 *
 * 三条设计约束，每条都对应一种真会发生的故障：
 *   1. **按工单 id 隔离**（键名 `draft:<id>`）：坐席一次处理好几单，共用一个键的话，切单回来会看到
 *      上一单的回复被粘进这一单 —— 这类"串单"在客服场景里是事故，不是体验问题。
 *   2. **写入失败必须静默**：隐私模式、配额满、企业策略禁用 localStorage 都会让 `setItem` 抛异常。
 *      草稿是便利功能，不能因为它让整页停摆（`user.js` 对 sessionStorage 也是同一口径）。
 *   3. **空串 = 删键**：发出去之后清草稿，否则下次打开这一单会看到已经发过的话，容易重复发送。
 *
 * 防抖放在这里而不是 `console.js`：`console.js` 已经在管轮询、路由、三栏渲染，
 * 再把定时器塞进去，就要在"切工单"和"关页面"两处记得清它。
 */

/** PRD §3.3 写的是 500ms，工单 07#02 明确要求 ~300ms —— 以工单为准（防抖越短，切走时丢字越少）。 */
export const DRAFT_DEBOUNCE_MS = 300;

export const DRAFT_PREFIX = "draft:";

export function draftKey(ticketId) {
  return `${DRAFT_PREFIX}${String(ticketId)}`;
}

/**
 * 造一个草稿仓。`storage` 允许为 `null`（拿不到 localStorage 的浏览器），此时读永远空、写永远静默失败。
 *
 * `options.setTimeout` / `options.clearTimeout` 只为测试可注入：不注入就用全局定时器。
 */
export function createDraftStore(storage, options = {}) {
  const debounceMs = Number.isFinite(Number(options.debounceMs)) ? Number(options.debounceMs) : DRAFT_DEBOUNCE_MS;
  const setTimer = typeof options.setTimeout === "function" ? options.setTimeout : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof options.clearTimeout === "function" ? options.clearTimeout : (handle) => clearTimeout(handle);

  /** 定时器句柄与"最后一次输入"分两张表：只有最后一次输入值得落盘。 */
  const timers = new Map();
  const pending = new Map();

  /** 所有存储访问的唯一入口：任何异常都退化成兜底值，调用方看不到异常。 */
  function guard(action, fallback) {
    if (storage === null || storage === undefined) return fallback;
    try {
      return action(storage);
    } catch {
      return fallback;
    }
  }

  /** 读草稿。没有 → `""`（不是 `null`：调用方直接塞进 textarea.value）。 */
  function read(ticketId) {
    const raw = guard((store) => store.getItem(draftKey(ticketId)), null);
    return typeof raw === "string" ? raw : "";
  }

  /** 立即写。空串（含全是空白）删键。 */
  function write(ticketId, text) {
    const value = typeof text === "string" ? text : String(text ?? "");
    if (value.trim() === "") {
      guard((store) => store.removeItem(draftKey(ticketId)), undefined);
      return;
    }
    guard((store) => store.setItem(draftKey(ticketId), value), undefined);
  }

  /** 撤销某单上还没落盘的定时写入（切工单、发送成功、关页面时调）。 */
  function cancel(ticketId) {
    const key = String(ticketId);
    const handle = timers.get(key);
    if (handle !== undefined) {
      clearTimer(handle);
      timers.delete(key);
    }
    pending.delete(key);
  }

  /** 把挂着的输入立刻落盘（切工单前调一次，等于"用户以为已经存了"那一刻）。 */
  function flush(ticketId) {
    const key = String(ticketId);
    if (!pending.has(key)) return;
    const text = pending.get(key);
    pending.delete(key);
    cancel(key);
    write(key, text);
  }

  /** 输入即存：每次输入重置 300ms 定时器，到点写一次。 */
  function schedule(ticketId, text) {
    const key = String(ticketId);
    pending.set(key, typeof text === "string" ? text : String(text ?? ""));
    const handle = timers.get(key);
    if (handle !== undefined) clearTimer(handle);
    timers.set(
      key,
      setTimer(() => {
        timers.delete(key);
        const latest = pending.get(key);
        pending.delete(key);
        if (latest !== undefined) write(key, latest);
      }, debounceMs),
    );
  }

  return { read, write, schedule, flush, cancel, pending: () => [...pending.keys()], debounceMs };
}
