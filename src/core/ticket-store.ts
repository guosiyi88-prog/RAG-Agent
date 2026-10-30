/**
 * 工单存取（`05-api.md` §3.4 / §3.5 / §5.3 / §5.4、`06-agent.md` §3.3–§3.4）。
 *
 * 只做两件事：内部建单、按单号查单。刻意不做的事：
 *   - 不做引用校验（引用落库在 `/internal/citations`，校验在收尾流程里）；
 *   - 不做限流与幂等（那是用户端 `POST /api/ticket` 的事 —— 那一层有令牌可数，
 *     内部接口的调用方是本进程的工具，重复计数只会把"模型多调一次工具"变成限流事故）。
 *
 * 写库只写 `tickets` 一张表。PRD 提到"建单同时写首条事件"，但 `sql/001_init.sql` 里
 * **没有** `ticket_events` 表（18 张表里没有它），所以没有事件行可写。事务已经就位，
 * 将来加表时在这里加一条 insert 即可，调用方与契约都不用改。
 */
import type { PoolClient } from "pg";
import { one, tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { logger } from "../logger.ts";

/**
 * 内部建单的唯一原因（工具的默认）：转人工。
 *
 * 为什么**模型与前端**都选不了 `reason`（05 §2、§3.4）：拒答（`no_citation` / `low_conf`）是
 * 系统判定"没有证据"，转人工（`user_request`）是用户主动点按钮 —— 两者都会建单、都会进
 * 坐席队列，但 SLA 优先级与统计口径不同。把 `reason` 做成模型可传的入参，它就有能力把一次
 * "用户要找人工"记成"系统没证据"，`v_no_hit`（未命中池）会被转人工单污染，知识库补写的
 * 优先级整个错位。所以 `/internal/ticket` 收到 `reason` 一律忽略（见 `api/internal-ticket.ts`），
 * 本常量就是那条口子的全部原因。
 *
 * `reason` 仍是 `createInternalTicket` 的**可选**入参，因为收尾流程的拒答路径（`api/chat.ts`
 * 的 `refuseTurn`）必须写入 `no_citation` / `low_conf`：那里没有模型、没有前端，原因是
 * `decideRefusal` 算出来的后端判定。留一个入参而不是两条建单 SQL，是为了让
 * "谁在建单"与"号怎么生成/SLA 怎么算"各只有一处。
 */
export const TICKET_REASON_USER_REQUEST = "user_request";

/** `tickets.reason` 的四个取值（`sql/001_init.sql` 的 check 约束）。 */
export type TicketReason = "no_citation" | "out_of_scope" | "low_conf" | "user_request";

/** 拒答能写的两个原因（06 §5.1 的 ①–④）。`out_of_scope` 本期没有判定产出它的入口。 */
export type RefusalTicketReason = Extract<TicketReason, "no_citation" | "low_conf">;

/** 05 §3.4：`question` 4–500 字符（trim 后）。建单的工具 schema 也是这两个数字。 */
export const TICKET_QUESTION_MIN = 4;
export const TICKET_QUESTION_MAX = 500;

/** 05 §3.4 的默认 SLA：`due_at = now() + sla.hours`，缺省 4 小时。 */
const DEFAULT_SLA_HOURS = 4;

/** SLA 的合理区间。`make_interval(hours => $n)` 只收整数，所以上下界之外一律回落默认值。 */
const SLA_HOURS_MIN = 1;
const SLA_HOURS_MAX = 168;

/**
 * uuid 形状（任意版本）。只做形状判断，不做版本判断：`conversations.id` 是
 * `gen_random_uuid()` 生成的 v4，但形状对了就足以避免把非 uuid 塞进 uuid 列变成 500。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * SLA 键的两种拼写。规格与种子数据前后不一致：接口约定（与 `ticket_create` 的契约）写
 * `slas.hours`，而 `05 §3.4` 与 `sql/002_seed.sql` 写的是 `sla.hours`。两个都认，
 * 按数组顺序取第一个存在的 —— 只认一个的话，改另一行的人会看到"截止时间没变"，
 * 而日志里什么都不会说。
 */
const SLA_HOUR_KEYS = ["slas.hours", "sla.hours"] as const;

/**
 * 读 SLA 小时数（坐席端可改的运行时参数，`sql/002_seed.sql` 默认 4）。
 *
 * 为什么要读库而不是钉常量：SLA 是运营旋钮，改它不该改代码发版。
 * 为什么脏值只回落不报错：转人工是用户此刻的下一步动作，配置层的问题不该让建单失败
 * （失败的建单等于用户被告知"稍后重试"，而他刚刚已经放弃了自助）。
 * 但必须留 `warn`：静默回落会让 SLA 悄悄退化成 4 小时，截止时间一直偏而没人发现。
 */
async function readSlaHours(client: PoolClient): Promise<number> {
  const result = await client.query<{ key: string; value: unknown }>(
    "select key, value from settings where key = any($1::text[])",
    [SLA_HOUR_KEYS],
  );
  const raw = SLA_HOUR_KEYS.map((key) => result.rows.find((row) => row.key === key)?.value).find(
    (value) => value !== undefined,
  );
  // `value` 是 jsonb：seed 写的是 `'4'`，pg 还原成 number；也曾有人写成字符串 "4"。
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (
    !Number.isInteger(parsed) ||
    parsed < SLA_HOURS_MIN ||
    parsed > SLA_HOURS_MAX
  ) {
    logger.warn(
      { slaHours: raw, keys: SLA_HOUR_KEYS, fallback: DEFAULT_SLA_HOURS },
      "settings 里的 SLA 小时数不可用，按默认值建单",
    );
    return DEFAULT_SLA_HOURS;
  }
  return parsed;
}

/**
 * 建一张内部工单。
 *
 * `reason` 默认 `user_request`（工具/内部接口的那条路），只有收尾流程的拒答路径会传
 * `no_citation` / `low_conf`：那是**后端按触发路径写入**的判定结果，不是调用方的选择。
 *
 * 入参 `question` 假定**已校验并 trim**（长度门槛在路由层，`05 §3.4`）：
 * 存这一层再截一次会造出"调用方以为存了 500 字、库里只有 400 字"的分歧。
 */
export async function createInternalTicket(input: {
  question: string;
  convId?: string | null;
  requester?: string | null;
  /** 只在进程内由后端判定填写；HTTP/工具调用方传什么都到不了这里（见 `TICKET_REASON_USER_REQUEST`）。 */
  reason?: RefusalTicketReason;
}): Promise<{ no: string; dueAt: string; status: string }> {
  const convId = input.convId ?? null;
  // 内部建单**不需要邮箱**（05 §5.3 "匿名单"）：`requester` 可空，坐席按 `question` 接手。
  const requester = input.requester ?? null;
  // 拒答与转人工的原因不同、统计口径不同（GLOSSARY）：拒答必须写"无引用/低置信"，
  // 否则 `v_no_hit`（未命中池）看不到这条知识缺口，坐席队列也分不出该由谁接手。
  const reason = input.reason ?? TICKET_REASON_USER_REQUEST;

  return tx(async (client) => {
    // `tickets.conv_id` 是 `references conversations(id)`：不存在的 uuid 会让 insert 抛
    // 23503，被统一错误处理器翻成 500"服务内部错误" —— 而这其实是调用方给错了一个 id。
    // 所以在写之前查一次，把"会话不存在"翻译成 400（调用方的错，不是服务的错）。
    // 不给 `conv_id` 则允许 null：用户在开聊前就点转人工时没有会话可挂，
    // 强行要求会话会让这件真实发生的事做不成；工单号 + 问题正文足以让坐席接手。
    if (convId !== null) {
      if (!isUuid(convId)) throw new AppError("VALIDATION", "conv_id 必须是 uuid");
      const conv = await client.query("select 1 from conversations where id = $1::uuid", [convId]);
      if (conv.rowCount === 0) throw new AppError("VALIDATION", "conv_id 不存在");
    }

    const hours = await readSlaHours(client);

    // 编号由列默认值 `gen_ticket_no()` 生成（序列 `ticket_seq`，并发不撞号），
    // **不**在这里算号：两处生成等于两套格式，`WT-YYYY-NNNN` 只会有一处是对的。
    // `priority` / `status` 走列默认（normal / open），不显式写 —— 默认值与规格一致，
    // 写死反而会在将来改默认值时出现两套口径。
    const inserted = await client.query<{ no: string; status: string; due_at: Date }>(
      `insert into tickets (conv_id, reason, question, requester, due_at)
       values ($1::uuid, $2, $3, $4, now() + make_interval(hours => $5::int))
       returning no, status, due_at`,
      [convId, reason, input.question, requester, hours],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new AppError("INTERNAL", "建单未返回行");

    return { no: row.no, dueAt: row.due_at.toISOString(), status: row.status };
  });
}

export type TicketLookup =
  | { found: false; no: string }
  | { found: true; no: string; status: string; reason: string; createdAt: string };

/**
 * 单号规范化：去空白、转大写。
 *
 * 为什么不做成"原样查"：单号只会经模型的手再传回来（"我的单怎么样了"），而模型复述
 * `wt-2026-0001` 或带一个尾空格是常态。把它当"不存在"回给用户，等于把一个找得到的单
 * 说成找不到 —— 这是这个工具唯一不能犯的错。大写安全，因为 `WT-YYYY-NNNN` 全大写生成。
 */
function normalizeTicketNo(no: string): string {
  return no.trim().toUpperCase();
}

/**
 * 按单号查状态（`06 §3.4` 的 `ticket_lookup`）。
 *
 * "不存在"不是错误：工具要能回答"未找到该工单"，所以返回 `found:false` 而不是抛 404。
 * 抛出去的 404 会让工具调用失败，模型只能对用户说"服务出错了"。
 */
export async function lookupTicket(no: string): Promise<TicketLookup> {
  const normalized = normalizeTicketNo(no);
  if (normalized === "") return { found: false, no };

  const row = await one<{ no: string; status: string; reason: string; created_at: Date }>(
    "select no, status, reason, created_at from tickets where no = $1",
    [normalized],
  );
  if (row === null) return { found: false, no };

  return {
    found: true,
    // 返回库里的原值而不是调用方拼写：前端要拿这个号去对照、坐席要按它搜单。
    no: row.no,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  };
}
