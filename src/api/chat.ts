/**
 * `POST /api/chat`（`05-api.md` §3.2）：用户看得见的对话框。
 *
 * 本文件做传输层、记录层与收尾编排：鉴权 → 建/复用会话 → 落一条用户消息 → 把
 * `core/agent.ts` 的语义事件逐帧写出去 → 记账 → 收尾（引用校验 + 拒答判定 → 落助手消息
 * → 引用快照 `citations` 帧 / 拒答话术 + 建单 + `refusal` 帧）。
 * 判定本身是**纯函数**（`core/refusal.ts`、`core/citations.ts`）：本文件只按 06 §5.1 的顺序
 * 执行动作，不在这里重算"该不该拒答"。
 *
 * 两条出答案的路：
 *   - **故障码快路**（04#03）：`text` 整条匹配 `^[A-Za-z]\d{2,3}$` 时查表直答，
 *     不装配会话、不调模型、不嵌入（见 `registerChatRoutes` 里的分流位置）；
 *   - **模型路**：`runTurn` 驱动的正常对话。
 *
 * 五处易错，都写在对应位置：
 *   ① 池满必须在开流**之前**变成 503 —— 一旦 `reply.hijack()`，HTTP 状态码就写不动了，
 *      只能发 `error` 帧；而 05 §6 明确要求 `SESSION_BUSY` = 503。
 *   ② `done` 之前要先记账（06 §9 "每次 done 前"），但记账失败不得破坏流（run-log 内部已吞）。
 *      故障码快路与寒暄前置例外：它们没有模型调用，也就不记 `ai_runs`（`streamStaticAnswer`）。
 *   ③ `error` 之后只关流，不再发任何帧（05 §3.2"一次后关闭"）——包括 `done`。
 *   ④ 引用快照挂在**助手消息**上（收尾时才存在），`meta.message_id` 始终是用户消息 id；
 *      流程是「落助手消息 → 校验 buffer 与正文 → 落快照 → 发 `citations`」，顺序不可换。
 *   ⑤ 拒答的四个动作顺序固定（丢正文 → 话术 → 建单 → 单号，06 §5.1）：换一下就会出现
 *      "用户看到已建单却没有单号"（见 `refuseTurn`）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireUser } from "../auth.ts";
import { config } from "../config.ts";
import { acquireSession, retrievalVerdict, runTurn, sessionLang, type TurnBuffer } from "../core/agent.ts";
import type { Lang } from "../core/chunk.ts";
import { saveCitations } from "../core/citation-store.ts";
import { validateCitations, type Citation, type CitationVerdict } from "../core/citations.ts";
import { answerFaultCode, matchFaultCode } from "../core/fastpath.ts";
import { resolveTurnLang } from "../core/lang-detect.ts";
import { decideRefusal, refusalText, type RefusalReason } from "../core/refusal.ts";
import { recordRun } from "../core/run-log.ts";
import { greetingReply } from "../core/smalltalk.ts";
import { createInternalTicket } from "../core/ticket-store.ts";
import { one, tx } from "../db.ts";
import { ERROR_CODES, AppError, isAppError, type ErrorCode } from "../errors.ts";
import { logger } from "../logger.ts";

/** 05 §3.2：`text` 1–2000 字符（trim 后非空）。 */
const MAX_TEXT_CHARS = 2_000;

/** uuid 形状（v4）。用于 `conv_id` 入参与 `messages.trace_id`（uuid 列，塞非 uuid 会报类型错）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KNOWN_LANGS: readonly Lang[] = ["zh", "en", "de", "nl", "es"];

function isKnownLang(value: string): value is Lang {
  return (KNOWN_LANGS as readonly string[]).includes(value);
}

/* ────────────────────────── 纯函数（可单测） ────────────────────────── */

/**
 * SSE 帧序列化：`event: <name>\ndata: <json>\n\n`。
 * 导出是为了让测试能直接钉住 `error` 帧的字节形状 —— 真实 30s 超时在测试里不可制造。
 */
export function serializeFrame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 轮次级（`runTurn` / `acquireSession` 抛或发）错误码 → 对外错误码（05 §6）。
 *
 * `LLM_ERROR` 收窄成 `LLM_UNAVAILABLE`：前者是 `core/agent.ts` 内部对"prompt 抛了"的叫法，
 * 05 §6 对外没有这个码，对用户的语义就是"模型不可用"。
 */
function turnErrorCodeOf(code: string): ErrorCode {
  switch (code) {
    case "SESSION_BUSY":
      return "SESSION_BUSY";
    case "LLM_TIMEOUT":
      return "LLM_TIMEOUT";
    case "LLM_ERROR":
    case "LLM_UNAVAILABLE":
      return "LLM_UNAVAILABLE";
    case "EMBED_UNAVAILABLE":
      return "EMBED_UNAVAILABLE";
    default:
      return "INTERNAL";
  }
}

/**
 * 轮次级错误码 → HTTP 状态码（05 §6）。
 *
 * 只在**开流之前**用得上：开流后状态码已经发出去了，只剩 `error` 帧。
 * `SESSION_BUSY` 是这里唯一有实际流量的一条 —— 前端「前面还有几位」读的就是它。
 */
export function statusForTurnError(code: string): number {
  return ERROR_CODES[turnErrorCodeOf(code)];
}

/**
 * 本轮错误码要不要变成 `error` 帧（05 §3.2"一次后关闭"）。
 *
 * `SESSION_BUSY` 有两个不同的语义，靠 `sameConv` 分开：
 *   - **不同会话**（`sameConv === false`）= 真的容量不足，它发生在开流**之前**（503），
 *     开流之后再遇到就是真事故，发 `error` 帧；
 *   - **同一会话**（`sameConv === true`）= 用户在流式过程中又发了一条。`core/agent.ts`
 *     用 `record.tail` 那条 promise 链把同会话的轮次串起来，第二轮的"忙"只是排队，
 *     不是这一轮的失败 —— 发 `error` 帧就是把"排队"渲染成"故障"（05 §3.2 的前端契约）。
 *
 * 导出是为了让测试能直接钉住这条分流：真实并发重叠在 `LLM_PROVIDER=mock` 下太短，
 * 靠掐时间断言必然抖。
 */
export function shouldEmitErrorFrame(code: string, sameConv: boolean): boolean {
  if (code === "SESSION_BUSY") return !sameConv;
  return true;
}

/** 池满 / 模型不可用时的统一信封（形状与 `server.ts` 的错误处理器逐字一致）。 */
function turnRejection(err: unknown, traceId: string): {
  status: number;
  body: { ok: false; error: { code: ErrorCode; message: string; trace_id: string } };
} {
  const raw = isAppError(err) ? err.code : "INTERNAL";
  const code = turnErrorCodeOf(raw);
  return {
    status: statusForTurnError(raw),
    body: { ok: false, error: { code, message: publicMessage(raw), trace_id: traceId } },
  };
}

/** 发出去的文案：只给用户能理解的一句，不带任何内部细节（模型名/并发数/堆栈）。 */
function publicMessage(code: string): string {
  if (code === "SESSION_BUSY") return "前面还有几位正在咨询，请稍后再试";
  return "服务暂时不可用，请稍后重试或转人工";
}

/**
 * `Accept-Language` 猜语言：按顺序取第一个已知语种的**主标签**（`de-DE` → `de`）。
 * 猜不到就 `en`（05 §3.2）。`q=` 权重不参与排序：浏览器已经把顺序排好了，
 * 再排一遍只会让"用户自己点过的语种"被权重抢走。
 */
export function langFromAcceptLanguage(header: string | undefined): Lang | undefined {
  if (header === undefined) return undefined;
  for (const item of header.split(",")) {
    const primary = item.split(";")[0]?.trim().toLowerCase().split("-")[0] ?? "";
    if (isKnownLang(primary)) return primary;
  }
  return undefined;
}

/**
 * token 拆分（06 §9）。
 *
 * `runTurn` 只回一个 `tokens` 总数，两种 provider 的原因不同但结论相同：
 *   - mock：它是 `estimateTokens(正文)`，本来就是纯输出 —— 输入侧记 0 是对的（真没花钱）；
 *   - 真实：它是 SDK `usage.input + usage.output` 的和，分侧数字只存在于 `core/agent.ts` 的
 *     `usageOf()` 里，本文件拿不到，所以整笔只能落到输出侧。
 *
 * TODO：让 `runTurn` 直接回 `{ inputTokens, outputTokens }`（`usageOf` 已经读到了这两个
 * 字段，只是合并后再返回），届时删除本函数。卡号 `04#02` 已收口，这条仍开着（属成本记账的
 * 已知限制，不影响功能）。在此之前宁可把输入也算成输出：单价 0.3 vs 1.2
 * 会让成本偏高，但"少记成本"会让成本报表静默失真 —— 选偏保守的一侧。
 */
export function splitTokens(tokens: number): { inputTokens: number; outputTokens: number } {
  return { inputTokens: 0, outputTokens: tokens };
}

/* ────────────────────────── 鉴权与入参 ────────────────────────── */

// 用户端令牌校验在 `src/auth.ts` 的 `requireUser`（07#01 收敛）：本文件此前有一份 12 行的
// 私有拷贝，`api/ticket.ts` 有第二份。两份的行为必须逐字一致才有意义 —— 而"必须一致"
// 靠拷贝是保不住的，所以它们合成了一份。

type ParsedChat = { text: string; lang: Lang; convId: string | undefined };

function parseChat(request: FastifyRequest): ParsedChat {
  const body = request.body;
  // content-type 不是 JSON 时 Fastify 会把 body 留成字符串/undefined，先挡形状。
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("VALIDATION", "body 必须是 JSON 对象");
  }
  const payload = body as { text?: unknown; lang?: unknown; conv_id?: unknown };

  if (typeof payload.text !== "string") throw new AppError("VALIDATION", "text 必填且必须是字符串");
  const text = payload.text.trim();
  if (text.length === 0) throw new AppError("VALIDATION", "text 不能为空");
  if (text.length > MAX_TEXT_CHARS) {
    throw new AppError("VALIDATION", `text 超过 ${MAX_TEXT_CHARS} 字符`);
  }

  let convId: string | undefined;
  if (payload.conv_id !== undefined && payload.conv_id !== null) {
    if (typeof payload.conv_id !== "string" || !UUID_RE.test(payload.conv_id)) {
      // 形状不合法是参数问题，不是"资源不存在"：400 让前端知道是自己传错了序号，而不是会话被删了。
      throw new AppError("VALIDATION", "conv_id 必须是 uuid");
    }
    convId = payload.conv_id;
  }

  // ── 本轮用哪门语言（D5/D18/D28）──────────────────────────────
  // 顺序在 `core/lang-detect.ts:resolveTurnLang` 里实现（顺序本身就是规格，所以它有单测）。
  // 这里只负责把三段输入凑齐：文本、客户端声明（= 界面语言）、会话记忆（池里上一轮的语言）。
  // 判不出来（平票/太短/非五语）就一路往下走 —— 检测器不做"最像哪个"的猜测。
  const lang = resolveTurnLang({
    text,
    declared: declaredLang(payload.lang),
    remembered: convId === undefined ? undefined : sessionLang(convId),
    acceptLanguage: langFromAcceptLanguage(request.headers["accept-language"]),
  });

  return { text, lang, convId };
}

/**
 * 客户端声明的语言（= 界面语言）。`undefined` 表示"这次没声明"，**不是**"声明了空"：
 * 空串 / 非字符串 / 未知语种都算调用方 bug，仍按老规则 400，别让它静默变成 en。
 */
function declaredLang(raw: unknown): Lang | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!isKnownLang(value)) throw new AppError("VALIDATION", "lang 必须是 zh|en|de|nl|es");
  return value;
}

/* ────────────────────────── 落库 ────────────────────────── */

/**
 * 建/复用会话 + 落用户消息，一个事务里做完。
 *
 * 为什么用户消息必须在开流**之前**落库：`meta` 帧是开流后第一帧，`message_id` 必须是真的。
 * 开流后才插，`meta` 里就只能先编一个 id —— 那就是一条永远对不上的记录。
 * 引用**不**挂这一行（见 `insertAssistantMessage`）：`meta.message_id` 是反馈与"这一问"
 * 的锚点，引用是"那一答用了哪几段原文"。
 */
async function openConversation(input: {
  token: string;
  convId: string | undefined;
  text: string;
  lang: Lang;
  traceId: string | undefined;
}): Promise<{ convId: string; messageId: number }> {
  return tx(async (client) => {
    let convId: string;

    if (input.convId !== undefined) {
      const found = await client.query<{ id: string; token_id: string | null }>(
        "select id, token_id from conversations where id = $1",
        [input.convId],
      );
      const row = found.rows[0];
      // 不存在与"属于另一个令牌"回**同一个** 404：403 等于确认这个会话存在，
      // 等于送出一个"这个 uuid 有人用过"的预言机；反正 uuid 不可枚举，也没理由多送这个信息。
      if (row === undefined || row.token_id !== input.token) {
        throw new AppError("NOT_FOUND", "会话不存在");
      }
      convId = row.id;
      // 用户中途换语言提问是正常事件（06 §6 的同一处理）：历史不变，`lang` 跟着最近一轮走。
      await client.query("update conversations set lang = $2, last_active_at = now() where id = $1", [
        convId,
        input.lang,
      ]);
    } else {
      const created = await client.query<{ id: string }>(
        `insert into conversations (token_id, lang)
         values ($1, $2)
         returning id`,
        [input.token, input.lang],
      );
      const row = created.rows[0];
      if (row === undefined) throw new AppError("INTERNAL", "会话创建失败");
      // `product_line` 留 null：05 §3.2 的请求体里没有这个字段，猜一个会把统计口径弄错。
      convId = row.id;
    }

    const message = await client.query<{ id: string }>(
      `insert into messages (conv_id, role, content, lang, trace_id)
       values ($1, 'user', $2, $3, $4)
       returning id`,
      [convId, input.text, input.lang, input.traceId ?? null],
    );
    const messageRow = message.rows[0];
    if (messageRow === undefined) throw new AppError("INTERNAL", "消息落库失败");

    // bigint 在 node-postgres 里是字符串：`meta.message_id` 必须是数字（05 §3.2 示例）。
    return { convId, messageId: Number(messageRow.id) };
  });
}

/**
 * 落助手消息，返回它的 id —— 引用快照挂在这一行上（`05#01`）。
 *
 * **为什么不挂 `meta.message_id`（用户消息）**：引用记的是"这段回答用了哪几段原文"，
 * 回答属于助手消息。挂到提问行上会有三处坏掉：`messages.citations_count` 出现在提问行，
 * 前端按 assistant 行渲染角标时永远是空的，同一会话第二轮还会覆盖第一轮的计数。
 * `meta.message_id` 保持是用户消息 id（05 §3.2 的反馈锚点），两者必须是不同的两行。
 *
 * `refused` 与 `citations_count` 都由调用方决定：拒答时 `content` 是**固定话术**
 * （模型已产出的正文一个字都不落库），`refused = true`、`citations_count` 保持 0。
 * 落库的正文必须与用户**最终看到**的那段一致 —— 存模型草稿而发话术，等于给自己留一份
 * 从没交付过的"回答"，事后复盘会把这个仓库的回答质量算高。
 */
async function insertAssistantMessage(input: {
  convId: string;
  text: string;
  lang: Lang;
  latencyMs: number;
  /** 与用户消息同一口径：非 uuid 形状就不落（`messages.trace_id` 是 uuid 列）。 */
  traceId: string | undefined;
  toolNames: string[];
  /** 本轮是否拒答（06 §5.1）：拒答行没有引用，计数恒为 0。 */
  refused: boolean;
}): Promise<number> {
  const row = await one<{ id: string }>(
    `insert into messages (conv_id, role, content, lang, refused, latency_ms, trace_id, tool_names)
     values ($1, 'assistant', $2, $3, $4, $5, $6, $7::text[])
     returning id`,
    [input.convId, input.text, input.lang, input.refused, input.latencyMs, input.traceId ?? null, input.toolNames],
  );
  if (row === null) throw new AppError("INTERNAL", "助手消息落库失败");
  return Number(row.id);
}

/** `citations` 帧条目（05 §3.2）：只带前端真要渲染的五个字段。 */
type CitationFrame = { idx: number; doc_title: string; page: number | null; snippet: string; doc_lang: string };

/**
 * 引用 → 帧条目。
 *
 * `chunk_id` 与 `score` **不下发**：前端拿它们什么也做不了，露出去只会让人以为可以拿
 * `chunk_id` 去调内部接口。它们仍随快照落库（排障要按块定位）。
 */
function citationFrameOf(citation: Citation): CitationFrame {
  return {
    idx: citation.idx,
    doc_title: citation.doc_title,
    page: citation.page,
    snippet: citation.snippet,
    doc_lang: citation.doc_lang,
  };
}

/* ────────────────────────── 路由 ────────────────────────── */

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/chat", async (request, reply) => {
    // 鉴权在第一行：未登录的请求不该有机会触发任何校验分支（那也是一次信息泄露面）。
    const token = await requireUser(request);
    const { text, lang, convId: requestedConvId } = parseChat(request);
    const traceId = String(request.id);

    const { convId, messageId } = await openConversation({
      token,
      convId: requestedConvId,
      text,
      lang,
      // `messages.trace_id` 是 uuid 列：前端传来的 `X-Trace-Id` 未必是 uuid（可能被中间层改写过），
      // 形状不对就不落，而不是让整条请求因为一个日志字段 500。
      traceId: UUID_RE.test(traceId) ? traceId : undefined,
    });

    // ── 故障码快路（05 §3.2、04-agent-chat #03）────────────────────────────
    // 位置是刻意的：在 `acquireSession` **之前**。这条路径不装配 Agent、不 acquire 池条目、
    // 不调模型、不调嵌入 —— 用户只敲了一个 `E03` 时，任何一次装配（ResourceLoader +
    // ModelRuntime + 模型解析）都是几百毫秒的浪费，而 05 §3.2 给它的是"1 秒内出结果卡"。
    // 用户消息在上面已经落库：快路跳过的只是"答案怎么产生"，不是"提问要留痕"。
    const faultCode = matchFaultCode(text);
    if (faultCode !== null) {
      const lookupStarted = performance.now();
      // 数据库异常**不**降级成"未命中"（见 `core/fastpath.ts`）：把一次查询失败伪装成
      // "表里没有这个码"，模型就会拿检索结果编一段听起来很像的处置步骤，那是最坏的一种回答。
      const answer = await answerFaultCode({ code: faultCode, lang });
      const lookupMs = Math.round(performance.now() - lookupStarted);

      if (answer !== null) {
        // 这条日志就是"1 秒内、没经模型"的可观测证据：毫秒数是唯一一次主键查询的耗时。
        logger.info({ code: faultCode, ms: lookupMs }, "chat: 故障码快路命中（未装配会话、未调模型、未嵌入）");
        streamStaticAnswer({ reply, convId, messageId, traceId, answer: answer.text, latencyMs: lookupMs });
        return reply;
      }
      // 未命中（表里没有这个码）→ 落回正常对话：用户敲的可能只是长得像故障码的型号。
      logger.debug({ code: faultCode, conv: convId }, "chat: 故障码未命中，落回模型路径");
    }

    // ── 寒暄前置（R1-1）────────────────────────────────────────────────
    // 位置在故障码快路之后：`E03` 不是招呼词，两条路径不会互相抢；但顺序仍要说清 ——
    // 码优先（用户敲了一个码就是想知道这个码），招呼其次。
    // 这条路径与快路同性质：不装配会话、不调模型、不嵌入、**不建单**，话术是常量表（五语）。
    // 为什么必须有它：检索阈值 0.30 打不中"你好"，于是走拒答四步 → 每句招呼 +1 张工单，
    // 队列与未命中池被噪声灌满（开工前实测过：tickets 138 张里 22 张是这类）。
    const greetStarted = performance.now();
    const greeting = greetingReply(text, lang);
    if (greeting !== null) {
      const greetingMs = Math.round(performance.now() - greetStarted);
      logger.info({ conv: convId, ms: greetingMs }, "chat: 寒暄命中（未装配会话、未调模型、未建单）");
      streamStaticAnswer({ reply, convId, messageId, traceId, answer: greeting, latencyMs: greetingMs });
      return reply;
    }

    // 池满在这里就要有结论（05 §6 的 503）。`runTurn` 内部还会再 acquire 一次，
    // 那次命中同一个池条目、只是复用 —— 不会重复装配。
    let sameConv = false;
    try {
      sameConv = (await acquireSession(convId, lang)).reused;
    } catch (err) {
      const rejection = turnRejection(err, traceId);
      // 用统一信封手写响应（而不是抛 AppError）：状态码必须由 `statusForTurnError` 决定，
      // 那是本仓唯一的"轮次错误 → HTTP 状态"映射表，两处各算一遍必然分叉。
      // 池满 / 模型不可用都是**预期内**的容量信号（前端各自有 503 文案），用 warn；
      // 只有 500 才是真事故。超时不走这条路（它发生在开流之后，只能是 error 帧）。
      if (rejection.status === ERROR_CODES.INTERNAL) {
        logger.error({ err, conv: convId, code: rejection.body.error.code }, "chat: 本轮无法开始");
      } else {
        logger.warn({ conv: convId, code: rejection.body.error.code }, "chat: 本轮无法开始");
      }
      return reply.code(rejection.status).send(rejection.body);
    }

    // `sameConv` = 这条请求落在了**已有**会话上（用户在我们出答案时又发了一条）。
    // 它只影响一件事：流里的"忙"信号要不要变成 `error` 帧（见 `shouldEmitErrorFrame`）。
    await streamTurn({ reply, convId, messageId, text, lang, traceId, sameConv });
    return reply;
  });
}

/* ────────────────────────── SSE 流 ────────────────────────── */

/**
 * 开一条 SSE 响应并把"写帧 / 关流 / 客户端断开"这三件事收成一个句柄。
 *
 * 快路与模型路唯一的共同点是**传输层**（响应头三件套、每帧一次 write、恰好 end 一次），
 * 所以这段只写一次：两条路各抄一遍，抄漏的那一份迟早是响应头缺 `x-accel-buffering`
 * 的那一份（现象是"线上只有快路被 nginx 攒着不发"）。
 */
type EventStream = {
  emit: (name: string, data: unknown) => void;
  finish: () => void;
  /** 客户端断开时 abort：把运行时那一轮真的停掉（继续跑等于白烧 token）。 */
  signal: AbortSignal;
  /** 收尾必须调：摘掉 `close` 监听。 */
  detach: () => void;
};

function openEventStream(reply: FastifyReply, convId: string): EventStream {
  const raw = reply.raw;

  reply.hijack();
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    // 05 §8 的三件套：少了任何一个，中间层（nginx）就会把流攒成一坨再发。
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  let settled = false;
  let clientGone = false;

  // 每帧一次 `write`：Node 对非压缩的 http 响应是立刻落 socket 的，
  // 这正是"首字可见"的实现方式（攒一坨等于把首字延迟变成总延迟）。
  const emit = (name: string, data: unknown): void => {
    if (settled || clientGone || raw.writableEnded) return;
    raw.write(serializeFrame(name, data));
  };

  const finish = (): void => {
    if (settled) return;
    settled = true;
    try {
      raw.end();
    } catch (err) {
      logger.warn({ err, conv: convId }, "chat: 关流失败");
    }
  };

  // 客户端断开：把运行时那一轮真的停掉（继续跑等于白烧 token），并且不再写任何帧。
  //
  // **必须在 `reply.raw` 上听，不能在 `request.raw` 上听**：Node ≥16 的 IncomingMessage
  // 的 `close` 语义是"请求已完成"—— 实测在开流后 1ms 就触发（此时响应还在写），
  // 拿它当断开信号会在第一帧之后就把每一轮真模型调用 abort 掉。`ServerResponse` 的
  // `close` 才是"连接没了"（正常 end 之后也会来一次，所以先看 settled）。
  const abort = new AbortController();
  const onClose = (): void => {
    if (settled) return; // 我们自己 end 的那次
    clientGone = true;
    abort.abort();
  };
  raw.once("close", onClose);

  return { emit, finish, signal: abort.signal, detach: () => raw.off("close", onClose) };
}

/**
 * **不经模型**的定稿回答：`meta` → **一帧** `delta` → `done`（05 §3.2）。
 *
 * 两个调用方：故障码快路（答案来自 `fault_codes` 主键查询）与寒暄前置（答案来自五语常量表）。
 * 共同点是"答案已经完整躺在内存里"，所以只发**一帧** delta —— 前端照样逐字出现，但没有任何
 * 流式等待，也没有模型的失败面。
 *
 * 刻意**不**发 `tool`（没有任何工具跑过）与 `citations`（故障码来自表、寒暄来自常量，
 * 都没有 chunk 可追溯 —— 发了前端就会画出一个点开是空的角标）。`tokens` / `cost_usd` 记 0：
 * 这两条路径没花钱，编一个非零数字会让成本报表从此对不上。
 *
 * 也**不**记 `ai_runs`：那张表记的是"模型花了多少"，这里一次模型调用都没有。
 */
function streamStaticAnswer(ctx: {
  reply: FastifyReply;
  convId: string;
  messageId: number;
  traceId: string;
  answer: string;
  latencyMs: number;
}): void {
  const { reply, convId, messageId, traceId, answer, latencyMs } = ctx;
  const stream = openEventStream(reply, convId);
  try {
    stream.emit("meta", { conv_id: convId, message_id: messageId, trace_id: traceId });
    stream.emit("delta", { t: answer });
    stream.emit("done", { latency_ms: latencyMs, tokens: 0, cost_usd: 0 });
  } finally {
    stream.detach();
    stream.finish();
  }
}

/**
 * 拒答的四步（06 §5.1、`18-human-gates.md` §6）—— **顺序是红线**，不许换：
 *
 *   (a) **丢弃已产出的文本**：模型草稿一个字都不落库、不发 `citations` 帧，
 *       助手消息行的 `content` 已经是固定话术（`refused = true`、`citations_count = 0`）。
 *   (b) `delta` + 固定话术：常量直发，**不经模型**（ADR-0004），额外延迟 ≈ 0。
 *   (c) 建单：在本轮会话下建一张"无引用/低置信"的工单。
 *   (d) `refusal` + 单号：前端只渲染固定话术 + 工单小卡。
 *
 * **"已产出文本收不回来"的取舍（选的是 (ii)）**：`delta` 是边生成边发的，正文已经到浏览器
 * 里了，后端无法物理撤回。所以（i）不在收尾时缓存全文再统一发（那会毁掉 06 的"逐字出现"），
 * 而是把"丢弃"做成**消息级**语义：
 *   - 落库的那条助手消息 = 固定话术（草稿从不进库，事后的回答质量统计里没有这段）；
 *   - 客户端契约（`06#01`）：收到 `refusal` 帧时**用固定话术替换整条气泡**，把之前流出来的
 *     草稿连同角标一起丢掉。没有 `refusal` 帧的那一轮（建单失败）保留草稿 —— 此时用户至少
 *     还看得见模型说了什么，且没有任何"已建单"的承诺。
 * 于是"客户看到的是话术"由前端最终态保证，"库里没有草稿"由后端保证，两边各有唯一的证据。
 *
 * 建单失败时**不发** `refusal` 帧：话术已经下发（用户知道需要工程师确认），但一个查不到的
 * 单号比没有单号更坏 —— 用户会拿着它去追问、坐席按它搜不到任何东西。失败只留 `logger.error`，
 * 流以 `done` 收尾（`05 §3.2` 的帧序不因一次建单失败而破）。
 */
async function refuseTurn(ctx: {
  emit: (name: string, data: unknown) => void;
  convId: string;
  /** 用户原问题（工单的 `question` 就是它，不做摘要 —— 摘要会改变客户的原话）。 */
  question: string;
  lang: Lang;
  reason: RefusalReason;
  citationVerdict: CitationVerdict;
}): Promise<void> {
  const startedAt = performance.now();
  const copy = refusalText(ctx.lang);

  // (b) 话术：后端常量，不经模型、不查库。哪怕建单接着失败，这一段也已经交付了。
  ctx.emit("delta", { t: copy });

  // (c) 建单。原因由**触发路径**决定（本函数的入参来自 `decideRefusal`），
  // 前端与模型都选不了：`/api/ticket` 与 `ticket_create` 走的是另一条固定 `user_request` 的口子。
  let ticketNo: string | null = null;
  try {
    const created = await createInternalTicket({ question: ctx.question, convId: ctx.convId, reason: ctx.reason });
    ticketNo = created.no;
  } catch (err) {
    logger.error(
      { err, conv: ctx.convId, reason: ctx.reason },
      "chat: 拒答建单失败（话术已下发，本轮不发 refusal 帧）",
    );
  }

  // (d) 单号。`refusal` 帧是前端"替换气泡"与"渲染工单小卡"的唯一触发器（见上面的客户端契约）。
  if (ticketNo !== null) ctx.emit("refusal", { ticket_no: ticketNo });

  // 这条日志就是"额外延迟 < 1 秒"的可观测证据：`ms` 只含一次 insert（话术是常量、零 I/O）。
  // `marks` / `illegal` 是判定的证据（角标数量与非法编号），拒答原因本身由 `reason` 单独记。
  const evidence = ctx.citationVerdict.ok ? { marks: [], illegal: [] } : ctx.citationVerdict;
  logger.info(
    {
      reason: ctx.reason,
      marks: evidence.marks,
      illegal: evidence.illegal,
      conv: ctx.convId,
      ticketNo,
      ms: Math.round(performance.now() - startedAt),
    },
    "chat: 拒答（丢弃模型正文、下发固定话术、建单）",
  );
}

/**
 * 把一轮对话写成 SSE 流。
 *
 * `reply.hijack()` 之后这个响应的生命周期完全由我们负责：**必须**恰好 end 一次，
 * 且任何异常都只能以 `error` 帧表达（状态码已经发出去了）。
 */
async function streamTurn(ctx: {
  reply: FastifyReply;
  convId: string;
  messageId: number;
  text: string;
  lang: Lang;
  traceId: string;
  /** 这条请求落在已有会话上（流式过程中用户又发了一条）。见 `shouldEmitErrorFrame`。 */
  sameConv: boolean;
}): Promise<void> {
  const { reply, convId, messageId, text, lang, traceId, sameConv } = ctx;
  const stream = openEventStream(reply, convId);
  const { emit, finish, signal } = stream;

  emit("meta", { conv_id: convId, message_id: messageId, trace_id: traceId });

  const toolCalls: { name: string; ms: number }[] = [];
  const buffer: TurnBuffer = { citations: [] };
  let failed = false;

  // ── 放行门（R1-2）──────────────────────────────────────────────────────
  // 问题：拒答判定要等生成结束才知道（引用校验依赖完整正文），而 delta 是边生成边发的 ——
  // 于是"答不了"的一轮会先把模型草稿送到浏览器，再补一条拒答话术，用户看到自相矛盾的两段
  // （实测：打招呼 / 超纲题都这样）。
  //
  // 解法：**只放行"检索结果够用之后"产生的文字**。判据不猜：`retrievalVerdict(buffer)` 与
  // 收尾时的 `decideRefusal` 读的是同一个信号（`kb_search` 写进 buffer 的分数与 fallback），
  // 所以这里拦下的，收尾一定会拒答；这里放行的，收尾一定不是"检索不足"。
  //
  // 为什么不是"全流缓冲"（那会毁掉逐字出现）也不是"前端替换"（帧契约变更 + 用户仍看到闪一下）：
  // 这条门只在**检索还没回来/不值得答**的那段时间里攒文本，正常一轮的首字延迟 ≈ 一次检索，
  // 而首字本来就不该早于资料。
  let gateOpen = false;
  let held = "";
  /** 检索是否"够用"：空结果或低于阈值 → 这一轮注定拒答，模型写什么都别发。 */
  const retrievalUsable = (): boolean => {
    const verdict = retrievalVerdict(buffer);
    return verdict.fallback !== "empty" && verdict.topScore >= config.retrievalMinScore;
  };

  // 整段收尾在 finally 里：无论哪条路径（正常 / error 帧 / 意外抛错）都**只** end 一次。
  try {
    let result: Awaited<ReturnType<typeof runTurn>>;
    try {
      result = await runTurn({
        convId,
        text,
        lang,
        signal,
        buffer,
        onEvent: (event) => {
          switch (event.type) {
            case "delta":
              // 门没开就先攒着（不落库、不下发）。门一开立刻把攒的一起放出去，顺序不乱。
              if (gateOpen) emit("delta", { t: event.t });
              else held += event.t;
              return;
            case "tool": {
              toolCalls.push({ name: event.name, ms: event.ms });
              emit("tool", { name: event.name, ms: event.ms });
              // `kb_search` 是唯一的检索入口；它一回来，本轮"有没有资料"就定了。
              if (!gateOpen && event.name === "kb_search" && retrievalUsable()) {
                gateOpen = true;
                if (held !== "") { emit("delta", { t: held }); held = ""; }
              }
              return;
            }
            case "error":
              // runTurn 把 LLM_TIMEOUT / LLM_ERROR / SESSION_BUSY 都做成事件而不是抛错
              // （抛出去会变成"连接被重置"，前端拿不到任何可展示的话）。
              // 但"同会话的忙"只是排队（用户连发），不是故障 —— 见 `shouldEmitErrorFrame`。
              if (!shouldEmitErrorFrame(event.code, sameConv)) {
                logger.info({ conv: convId, code: event.code }, "chat: 同会话的忙信号只是排队，不发 error 帧");
                return;
              }
              failed = true;
              emit("error", { code: event.code, message: event.message, trace_id: traceId });
              return;
            default:
              return;
          }
        },
      });
    } catch (err) {
      // runTurn 契约上不抛；真抛了说明流已经没法继续 —— 只能补一个 error 帧再关。
      logger.error({ err, conv: convId }, "chat: 一轮对话异常终止");
      emit("error", { code: "INTERNAL", message: publicMessage("INTERNAL"), trace_id: traceId });
      return;
    }

    // ── 05#02 收尾判定：引用校验 + 拒答判定（两个纯函数，无 I/O、微秒级）───────────
    // 放在 `recordRun` **之前**：`ai_runs.refused` 与下一条消息的 `refused` 都由它决定，
    // 而记账的位置不能动（06 §9"每次 done 前"，且 `citations`/`refusal` 帧都在它之后）。
    // 顺序也照 06 §5.1：① 已经在 `decideRefusal` 里读 `fallback`/`topScore`，
    // ②③④ 读同一份 `citationVerdict`（`no_candidates`/`no_marks` → no_citation，`illegal_mark` → low_conf）。
    const citationVerdict = validateCitations(result.text, buffer.citations);
    const decision = decideRefusal({
      fallback: result.fallback,
      topScore: result.topScore,
      minScore: config.retrievalMinScore,
      citationVerdict,
      text: result.text,
    });
    const refused = decision.refuse;
    // 拒答时落库、下发的正文是**固定话术**，模型草稿一个字都不留（06 §5.1 动作 (a)）。

    // 兜底放行：正常一轮但门始终没开（例如模型先写正文、最后一个工具才成功）。这时正文还压在
    // `held` 里，必须在 `citations` 帧之前补发，否则用户看到"有角标的答案但正文缺失"。
    // 拒答的一轮不补发：那些字正是要被丢掉的东西。
    if (!failed && !refused && held !== "") {
      emit("delta", { t: held });
      held = "";
      gateOpen = true;
    }

    const answerText = refused ? refusalText(lang) : result.text;

    // 06 §9：记账在 `done` 之前。`recordRun` 自己吞异常（只记日志），所以这里不需要 try。
    const { inputTokens, outputTokens } = splitTokens(result.tokens);
    await recordRun({
      convId,
      model: config.modelId,
      inputTokens,
      outputTokens,
      // 核心里已经算过成本（`usageOf`：SDK 报的总价优先，否则 06 §9 的单价公式；mock 记 0，
      // 因为那条路真的没花钱）。这里直接透传，**不**在 0 上做"补算"——那会把 mock 的账编出来。
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      // 拒答的一轮照样花钱（模型已经跑过，①b 之后才发现分数不够），所以账要记、只标 refused：
      // 拒答率与"拒答烧了多少钱"是本仓库最重要的两个指标，缺一个都看不出知识缺口的成本。
      refused,
      toolCalls,
    });

    // ── 收尾：落助手消息 → (拒答四步) 或 (引用快照 + `citations` 帧) ────────────────
    // 顺序不可交换：① 引用表的外键是**助手消息** id（`meta.message_id` 是用户消息，不能顶替），
    // 所以消息先落；② `citations` 帧只发校验通过的**被引用**片段 —— 候选全集绝不下发
    // （05 §3.2 规则 1–4：前端会把没用到的角标也画出来，客户点开发现"这段不支持那句话"）；
    // ③ 拒答的四个动作（丢正文 → 话术 → 建单 → 单号）在助手消息之后，见 `refuseTurn`。
    // 校验本身在 `recordRun` 之前就算完了（纯函数，见上）：消息要用它的结论决定 content/refused。
    // `failed` 时不进这段：`error` 之后不再发任何帧（05 §3.2），半截正文也不值得留档。
    if (!failed) {
      let assistantId: number | null = null;
      try {
        assistantId = await insertAssistantMessage({
          convId,
          // 拒答行的 content 是话术（动作 (a)：草稿不落库），正常行的才是模型正文。
          text: answerText,
          lang,
          latencyMs: result.latencyMs,
          traceId: UUID_RE.test(traceId) ? traceId : undefined,
          toolNames: toolCalls.map((call) => call.name),
          refused,
        });
      } catch (err) {
        // 与 `recordRun` 同一个取舍：用户已经看到正文了，用一次落库失败把流打成 `error` 帧
        // 等于否掉一条已经交付的回答。代价只有一处：没有消息 id 就没有可挂的引用 → 不发
        // `citations`（拒答路径不依赖它，话术与建单照常）。
        logger.error({ err, conv: convId }, "chat: 助手消息落库失败（回答照常收尾，跳过 citations）");
      }

      if (refused) {
        // 拒答不依赖助手消息 id（不落引用快照、不发 `citations`），所以落库失败也不影响这条路径。
        await refuseTurn({
          emit,
          convId,
          question: text,
          lang,
          reason: decision.reason,
          citationVerdict,
        });
      } else if (assistantId !== null) {
        if (citationVerdict.ok) {
          // 规则 4：按 `idx` 升序，与正文首次出现顺序无关。
          const cited = [...citationVerdict.citations].sort((a, b) => a.idx - b.idx);
          try {
            // 先落快照再发帧：前端拿到的角标必须立刻能点开。
            const { inserted } = await saveCitations({ messageId: assistantId, citations: cited });
            logger.debug({ conv: convId, messageId: assistantId, inserted }, "chat: 引用快照落库");
            emit("citations", cited.map(citationFrameOf));
          } catch (err) {
            // 引用写失败**不得**把一条已交付的回答变成断流：delta 已经发出去了，收不回来；
            // 少一帧 `citations` 只是这一轮没有角标，流本身仍是一次完整的回答。
            logger.error({ err, conv: convId, messageId: assistantId }, "chat: 引用落库失败（本轮不发 citations）");
          }
        } else {
          // 不可达的兜底：`decideRefusal` 只要看到 `ok: false` 就会拒答，上面那条 `if (refused)`
          // 已经接管。留一条日志是为了"判定与动作分叉"这件事**永远有个声音**，
          // 而不是让它在类型收窄之外静默吞掉（05 §3.2 规则 2：校验不过不许发 citations）。
          logger.error(
            { conv: convId, reason: citationVerdict.reason, marks: citationVerdict.marks, illegal: citationVerdict.illegal },
            "chat: 判定未拒答但引用校验不通过（不发 citations，检查 decideRefusal 的顺序）",
          );
        }
      }
    }

    // 05 §3.2：`error` 之后不再发任何帧（含 `done`），直接关流。
    if (!failed) emit("done", { latency_ms: result.latencyMs, tokens: result.tokens, cost_usd: result.costUsd });
  } finally {
    stream.detach();
    finish();
  }
}
