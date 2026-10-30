/**
 * 用户端工单（`05-api.md` §3.4 / §3.5）：邮箱 + 会话归属 + 每令牌每小时 3 张 + 同会话 5 分钟幂等。
 *
 * 与 `core/ticket-store.ts` 的分工是**同一张表的两扇门**：
 *   - `ticket-store` 是内部入口（本进程的工具调它），调用方是可信的，所以不做限流、不收邮箱；
 *   - 本文件是对外入口（浏览器直接打），调用方不可信，所以每一层都要防：
 *     枚举（同一个 404）、灌单（配额）、重试（幂等）、越权（会话归属）。
 *
 * 写库**不**另写一条 insert：转人工的原因、SLA 读法（`settings.slas.hours` / `sla.hours`）、
 * `gen_ticket_no()` 的号段都只有一份实现，就在 `createInternalTicket` 里。这里多抄一份 SQL，
 * 就有两份"due_at 怎么算"的答案，改了一处另一处会静默走偏 —— 而这种偏差只会在坐席端
 * 看到"两张单的 SLA 不一样"时才被发现。
 */
import { one } from "../db.ts";
import { AppError } from "../errors.ts";
import { logger, maskEmail } from "../logger.ts";
import { rateLimit, redis } from "../redis.ts";
import { TICKET_QUESTION_MAX, TICKET_QUESTION_MIN, createInternalTicket, isUuid } from "./ticket-store.ts";

/* ────────────────────────── 常量（都带出处） ────────────────────────── */

/** 05 §3.4：每 token 每小时 3 张，第 4 张 429 `QUOTA_TICKET`。 */
const TICKET_QUOTA_LIMIT = 3;
const TICKET_QUOTA_WINDOW_SEC = 3_600;

/**
 * 05 §3.4：同一 `conv_id` 5 分钟内重复提交返回已有单号。
 * 300 秒是"用户连点两次按钮 / 网络重试 / 前端超时后自动重发"的合并窗口；
 * 再长就会把"用户过了一会儿真的想补一张单"也吞成同一张。
 */
const IDEM_TTL_SEC = 300;

/** 键名按 05 §3.4 的原文：幂等键用会话 id（同一会话只能有一张未过期的单），配额键用令牌。 */
const QUOTA_KEY_PREFIX = "quota:ticket:";
const IDEM_KEY_PREFIX = "ticket:idem:";

/**
 * 邮箱的"务实"校验（05 §3.4 的正则 + 长度上限）。
 *
 * 为什么不用 RFC 5322 的完整语法：那个语法允许 `"a b"@[1.2.3.4]` 这类形式，写出来的正则
 * 既读不懂也测不完，而它**唯一**的用途是挡住"明显不是邮箱的串"——真正的有效性只有发一封信
 * 才知道，本期也不发信。所以这里只要求：有本地部分、有 `@`、域名里有点、顶级域 ≥ 2 字符，
 * 且不含空白。254 是 SMTP 对整条地址的硬上限（RFC 5321 §4.5.3.1.3），超了必然投不出去。
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const EMAIL_MAX_CHARS = 254;

export function isValidEmail(value: string): boolean {
  return value.length <= EMAIL_MAX_CHARS && EMAIL_RE.test(value);
}

/* ────────────────────────── 会话归属 ────────────────────────── */

/**
 * 会话必须属于**这个令牌**（05 §3.4 的 `conv_id` 约束）。
 *
 * 归属查询就是 `conversations.token_id`：`/api/chat` 建会话时写的是 `token_id = 令牌`，
 * 所以一行是否属于本令牌，等价于 `token_id === token`（`token_id` 为 null 的会话属于
 * 没有令牌的渠道，匿名访客认不出来，也就不是他的）。
 *
 * **不存在**与**不属于你**必须回同一个 404（见 `chat.ts` 的同款处理）：403 等于告诉调用方
 * "这个 uuid 真的存在"，于是 `/api/ticket` 变成一台会话存在性预言机 —— 而 uuid 不可枚举，
 * 这个信息本来就不该被确认。所以两个分支共用一条错误。
 */
async function assertConversationOwned(convId: string, token: string): Promise<void> {
  const row = await one<{ token_id: string | null }>(
    "select token_id from conversations where id = $1::uuid",
    [convId],
  );
  if (row === null || row.token_id !== token) {
    throw new AppError("NOT_FOUND", "会话不存在");
  }
}

/* ────────────────────────── 问题正文 ────────────────────────── */

/**
 * 解析要落库的问题正文。
 *
 * 前端传了就用前端传的（长度门槛 4–500 与内部建单同一个常量：`tickets.question` 是坐席
 * 唯一能看到的上下文，一个字都没有的单等于把坐席和用户一起卡住）；没传（或只传了空白）就取
 * 会话里最后一条用户消息 —— 那是用户此刻真正在问的东西，比让他再抄一遍更接近真实意图。
 *
 * **从历史里取来的正文只截断、不设下限**：4 字下限是为了挡住往公开接口灌 `"a"` 这种垃圾，
 * 而会话里那条消息是用户自己打的（"E03" 就是 3 个字，正是他此刻最需要转人工的时刻）。
 * 用同一个下限去拒绝它，等于在用户最需要按钮的时候把按钮弄灰。所以这里截到 500 就存。
 */
async function resolveQuestion(convId: string, supplied: string | undefined): Promise<string> {
  // 空白串等价于"没填"：`question` 在这条路由上是可选字段，表单上空着提交比填一个
  // 3 个字的问题常见得多，把它当参数错误拒掉，用户只会看到"提交失败"而不知道该填什么。
  const trimmed = supplied?.trim() ?? "";
  if (trimmed !== "") {
    if (trimmed.length < TICKET_QUESTION_MIN || trimmed.length > TICKET_QUESTION_MAX) {
      throw new AppError(
        "VALIDATION",
        `question 必须是 ${TICKET_QUESTION_MIN}–${TICKET_QUESTION_MAX} 字符（trim 后 ${trimmed.length}）`,
      );
    }
    return trimmed;
  }

  const row = await one<{ content: string }>(
    `select content from messages
      where conv_id = $1::uuid and role = 'user'
      order by created_at desc, id desc
      limit 1`,
    [convId],
  );
  const text = (row?.content ?? "").trim();
  if (text === "") {
    throw new AppError("VALIDATION", "question 必填：会话里没有可引用的提问");
  }
  return text.length > TICKET_QUESTION_MAX ? text.slice(0, TICKET_QUESTION_MAX) : text;
}

/* ────────────────────────── 幂等 ────────────────────────── */

type IdempotentHit = { no: string; status: string; dueAt: string } | null;

/**
 * 幂等命中查询：Redis 存单号，状态与截止时间仍以库里那一行为准。
 *
 * 为什么只缓存**单号**：状态会变（open → claimed → closed），把状态写进 Redis 就等于
 * 在 5 分钟里给用户看一个过期的状态。单号是不变的，其余字段读一次库就对得上。
 *
 * 为什么库里查不到要当作未命中：工单被删（或号段被清）时缓存里还留着号，直接返回它
 * 就会让用户拿到一个**查不到的单号**——比多建一张单糟得多。
 */
async function findIdempotent(convId: string): Promise<IdempotentHit> {
  const cached = await redis.get(`${IDEM_KEY_PREFIX}${convId}`);
  if (cached === null || cached === "") return null;

  const row = await one<{ no: string; status: string; due_at: Date | null }>(
    "select no, status, due_at from tickets where no = $1",
    [cached],
  );
  if (row === null) {
    logger.warn({ conv: convId, no: cached }, "ticket-public: 幂等缓存里的单号在库里不存在，按新建处理");
    return null;
  }
  // `due_at` 可空（列上没有 not null），读不到就别编一个时间出来。
  return { no: row.no, status: row.status, dueAt: (row.due_at ?? new Date()).toISOString() };
}

/* ────────────────────────── 建单 ────────────────────────── */

/**
 * 用户主动转人工建单（05 §3.4）。
 *
 * 顺序是这张卡最容易写错的地方，逐条说明：
 *   ① **归属 → ② 幂等 → ③ 正文 → ④ 配额 → ⑤ 落库 → ⑥ 写幂等键**
 *
 *   - 幂等必须在配额**之前**：用户点了两次按钮是同一件事，第一次已经扣过额度了。
 *     顺序反过来，每重试一次就烧掉一张额度，一小时 3 张的配额在 3 次网络抖动之后
 *     就没了 —— 限流本来是为了防灌单，结果惩罚的是最需要转人工的那批用户。
 *   - 幂等也必须在归属之后：先告诉"这个会话 ID 有没有被别家用过"，是白送一个预言机。
 *   - 配额在正文之后：正文不合法（400）的请求不该先扣一张额度，否则填错一次邮箱
 *     就少一张单的额度，用户越慌越填不对。
 *
 * 已知的边界（不修，因为修它要引入分布式锁）：**同一瞬间**的两条请求会各自读到
 * 幂等键为空、各自落一行 —— 真正并发（毫秒级同时）时本实现的保证只是"5 分钟内**先后**
 * 重复提交合并成一张"。用 `SET NX` 先占位能堵住这一秒，代价是"占位成功但落库失败"时
 * 要清一个可能属于别人的占位（锁的经典烂摊子），而收益仅仅是极端双击少一张单；配额
 * （3 张/小时）已经把最坏情况封住。
 *
 * `reason` 恒为 `user_request`，由 `createInternalTicket` 里的常量写入；本函数的入参里
 * 根本**没有** reason 这一项（05 §3.4「前端不得传原因」）—— 参数不存在，就没有"传了就生效"
 * 的可能。拒答（`no_citation` / `low_conf`）走的是对话收尾流程，不是这条公开入口。
 */
export async function createPublicTicket(input: {
  /** 冷启动（打开工单页但一次都没聊过）时没有会话：允许不带 conv_id，落库的 conv_id 为 null。 */
  convId?: string | null;
  token: string;
  email: string;
  /** 缺省时取会话里最后一条用户消息（见 `resolveQuestion`）；没有会话时必须显式给。 */
  question?: string;
}): Promise<{ no: string; dueAt: string; status: string; idempotent: boolean }> {
  const { token, email } = input;
  const convId = typeof input.convId === "string" && input.convId !== "" ? input.convId : null;

  if (convId !== null) {
    // `conversations.id` 是 uuid 列：形状不对的串进 SQL 会变成 500，而它其实是调用方传错了参数。
    if (!isUuid(convId)) throw new AppError("VALIDATION", "conv_id 必须是 uuid");
    await assertConversationOwned(convId, token);
  }

  // ② 幂等命中：不扣配额、不新建行，原样返回同一张单（`idempotent: true` 让前端知道
  // "这次没建新单"，可以据此改按钮文案，而不是再弹一次"已提交"）。
  // 没有会话就没有幂等键：去重以"同一处对话 5 分钟内重复提交"为前提，无会话时退化为每次新建。
  if (convId !== null) {
    const hit = await findIdempotent(convId);
    if (hit !== null) {
      return { no: hit.no, dueAt: hit.dueAt, status: hit.status, idempotent: true };
    }
  }

  const question = convId === null
    ? (typeof input.question === "string" ? input.question.trim() : "")
    : await resolveQuestion(convId, input.question);
  if (question === "") throw new AppError("VALIDATION", "没有会话时必须填写问题描述");

  // ④ 配额：复用 `redis.ts` 的 `rateLimit()` —— ZSET + `ZREMRANGEBYSCORE` 的**滑动窗口**
  // （不是 INCR+EXPIRE 的固定窗口：固定窗口在整点边界能放行 2×3 张）。
  // 计数按令牌而不是 IP：一个公司的安装商可能共用一个出口 IP，按 IP 限流会把同事的单
  // 算到同一个人头上；而令牌正是"一个浏览器会话"，它才是额度的天然维度。
  const allowed = await rateLimit(`${QUOTA_KEY_PREFIX}${token}`, TICKET_QUOTA_LIMIT, TICKET_QUOTA_WINDOW_SEC);
  if (!allowed) {
    // 429 的语言交给前端（`ticket.quota`）。日志里**不带令牌**（哪怕只是前 8 位：令牌等价于凭据，
    // 而日志会被贴进评审记录）；定位靠打码后的联系邮箱 —— 用户报"我提交不上"时，坐席只需要
    // 认出这个人，不需要任何凭据。键名用 `contact` 而不是 `email`：pino 的 redact 会把 `email`
    // 整个吞成 `[redacted]`（log grep 立刻变瞎），打码职责在 `maskEmail` 这一处。
    logger.warn({ contact: maskEmail(email), conv: convId }, "ticket-public: 建单配额命中");
    throw new AppError("QUOTA_TICKET", "工单提交过于频繁，请稍后再试");
  }

  // ⑤ 落库（原因 / 号段 / SLA 都与内部建单同一份实现）。
  // 刻意**不传** `reason`：`createInternalTicket` 的那个可选 reason 是留给后端自己判定的
  // 拒答路径（`no_citation` / `low_conf`）的，公开入口传它一次都不传，落库就恒为
  // `user_request`（05 §3.4「前端不得传原因」—— 参数不在链路上，就不存在被穿透的可能）。
  const created = await createInternalTicket({ question, convId, requester: email });
  // 建单是这套系统里唯一"用户付出了行动"的事件，值得一条 info：用户事后报"我提交过了"、
  // 坐席问"这张单从哪来的"都靠它。联系邮箱一律过 `maskEmail`（`logger.ts` 的职责是唯一出口，
  // 但如果哪天有人把这条日志改成 `{ email }`，redact 会兜住），**问题原文不进日志**。
  logger.info({ no: created.no, contact: maskEmail(email), conv: convId }, "ticket-public: 转人工建单");

  // ⑥ 写幂等键。失败**不能**把一次已经落库的建单变成 500：单已经存在，用户却收到
  // "服务出错"，接着重试就会（因为幂等键没写上而）真的建出第二张单 —— 一次 Redis
  // 抖动放大成两张单 + 一条差评。所以这里只记日志，响应照常返回单号。
  if (convId !== null) {
    try {
      await redis.set(`${IDEM_KEY_PREFIX}${convId}`, created.no, "EX", IDEM_TTL_SEC);
    } catch (err) {
      logger.error({ err, conv: convId, no: created.no }, "ticket-public: 幂等键写入失败（建单已成功）");
    }
  }

  return { no: created.no, dueAt: created.dueAt, status: created.status, idempotent: false };
}

/* ────────────────────────── 查单 ────────────────────────── */

/**
 * 用「单号 + 邮箱」查单（05 §3.5）。
 *
 * 单号不存在与邮箱不匹配**不区分**：两者都返回 `found: false`，路由层再翻成同一个 404。
 * 如果"号对但邮箱错"回 403、"号不存在"回 404，那么任何人都能拿一个邮箱去撞号：
 * 403 就等于确认"这张单真实存在"（工单号是 `WT-YYYY-NNNN` 序列号，从 0001 往上撞很快）。
 * 一个条件查询里同时比对两者，连"先查号再比邮箱"的时间差都不会有。
 *
 * 邮箱比对用 `lower()`：邮箱的域名部分大小写不敏感，本地部分在现实中也没人区分，
 * 用户换个大小写就被判"查不到"是纯粹的伤害（存进去的那个 original 大小写不动）。
 */
export async function lookupPublicTicket(input: { no: string; email: string }): Promise<
  { found: false } | { found: true; no: string; status: string; createdAt: string }
> {
  // 单号规范化与内部查单同口径（去空白、转大写）：用户会从邮件里复制出带空格的小写号。
  const no = input.no.trim().toUpperCase();
  const email = input.email.trim();
  // 任一为空就不必打扰数据库；空条件落到 SQL 里会变成 `= ''` 的全表扫。
  if (no === "" || email === "") return { found: false };

  const row = await one<{ no: string; status: string; created_at: Date }>(
    `select no, status, created_at from tickets
      where no = $1 and lower(requester) = lower($2)`,
    [no, email],
  );
  if (row === null) return { found: false };

  return { found: true, no: row.no, status: row.status, createdAt: row.created_at.toISOString() };
}
