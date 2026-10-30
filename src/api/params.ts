/**
 * 列表查询的入参解析（`09#04` 从 `api/console.ts` 抽出来）。
 *
 * **为什么单独一个文件**：管理端的故障码列表要"复用 console 的 page 口径"（工单 04 的
 * 原话）。口径这种东西一旦有两份实现就会漂：一处把 `page=0` 夹到 1、另一处报 400，
 * 前端就要为两张列表写两套翻页逻辑。所以这里只有**一份**解析代码，两个 API 模块都 import 它。
 *
 * 移动是逐字搬迁（`console.ts` 里那三段注释一起搬过来），行为零变化 —— 坐席队列的既有用例
 * （`tests/console-api.test.ts`）就是在验"搬完还是原来那个行为"。
 *
 * 本文件零副作用：只做形状与取值判断，不碰库、不碰 Redis、不读请求对象。
 */
import { AppError } from "../errors.ts";

/**
 * `page` 的上限。这不是安全边界（参数化的 `offset` 再大也只是扫出一个空页），而是"别让一个
 * 手抖的 `?page=999999999` 变成一次离谱的深分页"的成本边界。超界夹住而不是 400：
 * 前端翻页逻辑算错时，看到的是"最后一页之后没有数据"，而不是一个把整页刷成红色错误的结果。
 */
export const PAGE_MAX = 10_000;

/**
 * 取一个查询参数。重复的同名查询参数（`?status=a&status=b`）在 Fastify 里是数组，
 * 这里只取第一个：本接口的契约是"逗号分隔多选"，数组形态不是任何正常前端发的，
 * 取第一个比 400 更稳（它表达的意思与前端想要的完全一致）。
 */
export function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

/**
 * 逗号分隔的枚举多选（05 §4.1 的 `status` / `reason`，`09#04` 的故障码 `status` / `severity`）。
 *
 * 返回 `null` 表示"没筛"（缺省或空串）。形状、取值都在这里挡：
 * 一个拼错的 `status=opne` 如果被静默忽略，坐席会以为自己在看"待处理"，实际看到的却是
 * 默认视图（除 closed 之外全部）—— 一次误判优先级的起因就这么小。所以回 400，并列出允许值。
 */
export function parseEnumList<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  field: string,
): T[] | null {
  if (raw === null) return null;
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return null;

  const values: T[] = [];
  for (const part of parts) {
    if (!(allowed as readonly string[]).includes(part)) {
      throw new AppError("VALIDATION", `${field} 取值必须是 ${allowed.join("|")}，收到 "${part}"`);
    }
    const value = part as T;
    // 去重：`status=open,open` 不该让 `= any(...)` 的参数看起来像两个筛选项。
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

/**
 * 分页参数。**只有"不是整数"是 400**，超出范围一律夹到区间内。
 *
 * 为什么超界不报错：`size=1000` 的前端意思通常是"我全都要"，回 400 等于把一次列表刷新
 * 打成错误提示，而坐席真正想知道的是"到底有多少单" —— 那个数在 `total` 里，本来就要给。
 * 夹住 + 给 `total` 既守住了"列表查询必须有上限"（G5），又不会把一次正常浏览变成错误。
 */
export function parseIntInRange(
  raw: string | null,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new AppError("VALIDATION", `${field} 必须是整数`);
  return Math.min(max, Math.max(min, parsed));
}
