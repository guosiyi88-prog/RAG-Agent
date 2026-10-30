/**
 * SLA 倒计时的纯逻辑（`11-ui-console.md` §2.2 / 工单 07#02 第一条）。
 *
 * 为什么单独一个文件：后端只在列表里给**一次** `sla_seconds_left`，之后每 30 秒的重算全在前端，
 * 而"超时 / 紧急 / 正常"三档的判定一旦散进 DOM，就会变成三处各写一遍的数字比较 ——
 * 队列行、详情左栏、以后可能加的看板各有一份，改一次阈值要改三处。
 *
 * 两条硬约束（都来自工单）：
 *   1. 重算是**本地**的：不重新请求（5s 轮询拉的是列表，30s 跳动的是这一格文本）。
 *   2. 剩余 < 1 小时要醒目、负数要显示"超时"。
 */

/** 1 小时 = 紧急线的秒数。低于它红色加粗（`11-ui-console.md` §2.1 的 SLA 列规格）。 */
export const SLA_URGENT_SECONDS = 3600;

/** 三档 + "没有截止"。字符串值直接落到 DOM 的 `data-sla`，CSS 认它上色。 */
export const SLA_LEVEL = {
  none: "none",
  ok: "ok",
  urgent: "urgent",
  over: "over",
};

/**
 * 秒数 → 人话时长。负数按绝对值格式化，前缀由调用方加（"超时 2h 3m"）。
 *
 * 与 `11-ui-console.md` §2.2 的公式一致（`>=3600` 走 `h m`，否则走 `m`），只多一条 `<60s` 的分支：
 * 照着规格写，最后一分钟会显示 `0m` —— 坐席看到 `0m` 无法判断是"还有 40 秒"还是"已经归零"。
 */
export function humanizeSeconds(seconds) {
  const total = Math.max(0, Math.floor(Math.abs(Number(seconds) || 0)));
  if (total < 60) return `${total}s`;
  if (total < SLA_URGENT_SECONDS) return `${Math.floor(total / 60)}m`;
  const hours = Math.floor(total / SLA_URGENT_SECONDS);
  const minutes = Math.floor((total % SLA_URGENT_SECONDS) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * 剩余秒数 → `{ text, level, seconds }`。
 *
 * `null` / `undefined` / 非数字一律"无截止"：`tickets.due_at` 允许为空，列表里这类单排最后，
 * 界面上不能把它画成"0m"（那看着像刚超时，坐席会去追一个不存在的 SLA）。
 */
export function formatSla(seconds) {
  if (seconds === null || seconds === undefined) return { text: "无截止", level: SLA_LEVEL.none, seconds: null };
  const value = Number(seconds);
  if (!Number.isFinite(value)) return { text: "无截止", level: SLA_LEVEL.none, seconds: null };

  const floored = Math.floor(value);
  if (floored < 0) return { text: `超时 ${humanizeSeconds(floored)}`, level: SLA_LEVEL.over, seconds: floored };
  if (floored < SLA_URGENT_SECONDS) return { text: humanizeSeconds(floored), level: SLA_LEVEL.urgent, seconds: floored };
  return { text: humanizeSeconds(floored), level: SLA_LEVEL.ok, seconds: floored };
}

/** 剩余 < 1 小时（含已超时）算紧急；没有截止不算。 */
export function isUrgent(seconds) {
  if (seconds === null || seconds === undefined) return false;
  const value = Number(seconds);
  if (!Number.isFinite(value)) return false;
  return Math.floor(value) < SLA_URGENT_SECONDS;
}

/** 解析 `due_at`；认不出就返回 `null`（不抛：脏数据不该让整张表渲染失败）。 */
function parseTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 本地重算剩余秒数 —— 30 秒一跳，**不发请求**。
 *
 * 输入 `snapshot` 是"后端那一次回答"的快照：`{ dueAt, secondsLeft, at }`（`at` = 收到响应的本地时刻）。
 * 优先用 `dueAt - now`：它自愈时钟漂移（浏览器休眠、系统改时间、标签页被冻结后回来），
 * 也让"昨晚关掉的页面今早打开"直接显示真实的超时值，而不是从旧数字开始倒数。
 * 只有拿不到 `due_at` 时才退化成 `secondsLeft - elapsed`（后端排序把空截止排最后，但有的单确实没有截止）。
 *
 * 纯函数：同样的 `(snapshot, nowMs)` 一定得到同样的结果（工单要求"对同一输入幂等"），
 * 所以调用方可以每 30 秒重算任意多次，不需要自己去重。
 */
export function remainingSeconds(snapshot, nowMs) {
  if (snapshot === null || typeof snapshot !== "object") return null;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

  const due = parseTime(snapshot.dueAt ?? snapshot.due_at);
  if (due !== null) return Math.floor((due - now) / 1000);

  const base = Number(snapshot.secondsLeft ?? snapshot.sla_seconds_left);
  if (!Number.isFinite(base)) return null;
  const at = Number(snapshot.at ?? snapshot.fetched_at);
  const elapsed = Number.isFinite(at) ? (now - at) / 1000 : 0;
  return Math.floor(base - elapsed);
}

/** 详情左栏用的一步到位版：快照 → `{ text, level, seconds }`。 */
export function slaFor(snapshot, nowMs) {
  return formatSla(remainingSeconds(snapshot, nowMs));
}
