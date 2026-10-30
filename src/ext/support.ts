/**
 * 业务工具与 hook（06-agent.md §3–§4）。**唯一**允许模型使用的工具都在这里，
 * 白名单之外的调用一律被阻断 —— 这个 Agent 没有读文件 / 跑命令 / 编辑 / 写文件的能力。
 *
 * 恰好四个工具：`kb_search`（进程内检索）、`fault_code_lookup` / `ticket_create` /
 * `ticket_lookup`（经内部 HTTP 回主进程）。
 *
 * 三条不可违反（06 §1.2）在本文件里的落点：
 *   ① 工具只经 `pi.registerTool()` 注册（装配侧的 `tools:[]` 只做选择）；
 *   ② `tool_call` 白名单 fail-closed：不在名单里的请求返回 `{ block: true, reason }`；
 *   ③ hook 里**不发 HTTP**：检索走进程内 `retrieve()`，候选只进本轮内存 buffer。
 *
 * 为什么后三个工具走内部 HTTP 而不是 import 核心模块（04#02 的硬约束）：
 *   - **循环依赖**：`core/ticket-store.ts` / `core/fault-codes.ts` 与 Agent 装配同处一层，
 *     `ext/support.ts` 反过来 import 它们，装配链上就出现 `agent → ext → core → agent` 的环，
 *     ESM 下环的表现是"某个绑定在 init 期还是 undefined"，出错点离原因很远；
 *   - **执行边界解耦**：工具的执行边界是"一次工具调用"，它天然该走进程的公开接口 ——
 *     HTTP 回环让工具和主进程之间只剩一份契约（`src/api/internal-*.ts`），
 *     内部接口要改实现、要限流、要审计都在对面发生，工具这边一行不用动。
 *   代价是多一跳本机往返（P95 < 5ms 量级），换来的是装配面没有环、也没有跨层的共享状态。
 *
 * 本轮 buffer 怎么交给 hook：ExtensionAPI 的 hook 没有"请求"这个入参，只有一个按会话
 * 创建的闭包环境。所以每装配一个会话就造一个 `TurnSlot`，由 `runTurn()` 在开轮时写入、
 * 在 finally 里清空；hook 通过闭包拿到同一个 slot。**安全前提**：同一个会话同一时刻只跑
 * 一轮（`core/agent.ts` 的会话池用一条 promise 链把同会话的轮次串起来），
 * 因此 slot 里永远只有当前这一轮的 buffer，不存在两轮互串的可能。
 *
 * 同一个 buffer 还承载拒答判定 ① 的输入：`kbSearch()` 每次检索完都把
 * `{ topScore, fallback, chunkCount }` 并进 `buffer.retrieval`（见 `mergeRetrievalSignal`），
 * `runTurn()` 收尾时读它填进 `TurnResult` —— 这是"本轮检索是否为空/低分"唯一的对外通道。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { config } from "../config.ts";
import { logger } from "../logger.ts";
import { retrieve, type RetrievalFallback } from "../core/retrieval.ts";

/**
 * 允许模型调用的工具名 —— **唯一真源**。装配侧的 `tools:[]` 与 `tool_call` 白名单都读它：
 * 两处各写一份是"改一处漏一处"的经典死法（漏在白名单 = 静默放行，漏在 tools = 工具消失）。
 */
export const SUPPORT_TOOL_NAMES = ["kb_search", "fault_code_lookup", "ticket_create", "ticket_lookup"] as const;

const ALLOWED_TOOLS: ReadonlySet<string> = new Set<string>(SUPPORT_TOOL_NAMES);

/** 单条候选：给前端的角标数据。`idx` 就是正文里的 `[n]`（连续无空洞，由 retrieve 保证）。 */
export type TurnCitation = {
  idx: number;
  chunk_id: number;
  doc_id: string;
  doc_title: string;
  doc_lang: string;
  page: number | null;
  section: string | null;
  snippet: string;
  score: number;
};

/**
 * 本轮检索的整体信号（拒答判定 ① 的输入，06 §5.1）。
 *
 * `topScore` / `fallback` 一律来自 `retrieve()` 的返回值，**不在这里重新算分**：
 * 阈值比较由拒答层做（07 §8），这一层只负责把"本轮到底搜到什么程度"原样带出去。
 * `chunkCount` 是本次检索返回的片段数，仅供排查/展示 —— 拒答判定不许拿它反推置信度。
 */
export type TurnRetrieval = {
  topScore: number;
  fallback: RetrievalFallback;
  chunkCount: number;
};

/** 本轮的内存缓冲：候选只进这里，不下发前端、不落库（落库统一在收尾流程，05#01）。 */
export type TurnBuffer = {
  citations: TurnCitation[];
  /** 本轮检索的整体信号：拒答判定 ①（空/低分）用它，不靠"候选是否为空"反推 */
  retrieval?: TurnRetrieval;
};

/**
 * 降级程度排序：`none` 最好、`empty` 最差。合并同一轮里的多次 `kb_search` 时取**最小**的那个。
 * 写成表而不是嵌套三元，是为了让"少降级优先"这条规则只有一处定义。
 */
const DEGRADATION_RANK: Record<RetrievalFallback, number> = { none: 0, fts_only: 1, empty: 2 };

/**
 * **纯函数**：把一次新的检索信号并进本轮已有的信号。
 *
 * 规则不是"后写覆盖先写"，因为**模型一轮里可能调两次 `kb_search`**（常见：先搜宽泛词、
 * 再补一条更精确的）。最终答案是被本轮**最好的那份证据**支撑的，不是被最后一次调用支撑的：
 *   - `topScore` 取**最大** —— 低分的那次不能把一次成功的高分检索"降级"掉；
 *   - `fallback` 取**降级最轻**的（none > fts_only > empty）—— 一次"两路都空"不该抹掉
 *     同一轮里另一次正常完成的检索；反之若全轮只有降级检索，这里就会如实留下降级标签；
 *   - `chunkCount` 跟着**分数最高的那次**走（同分时取片段更多的那次），
 *     否则会出现"分来自 A 次、片段数来自 B 次"的拼接数据。
 *
 * 注意：合并只影响"本轮有没有证据"的判断，**候选本身仍然全部累积**（`citations` 是并集），
 * 所以角标校验看到的永远是完整候选集合。
 */
export function mergeRetrievalSignal(
  prev: TurnRetrieval | undefined,
  next: TurnRetrieval,
): TurnRetrieval {
  if (prev === undefined) return next;

  const topScore = Math.max(prev.topScore, next.topScore);
  const winner =
    next.topScore > prev.topScore
      ? next
      : prev.topScore > next.topScore
        ? prev
        : next.chunkCount >= prev.chunkCount
          ? next
          : prev;

  return {
    topScore,
    fallback: DEGRADATION_RANK[next.fallback] < DEGRADATION_RANK[prev.fallback] ? next.fallback : prev.fallback,
    chunkCount: winner.chunkCount,
  };
}

/** 把信号写进本轮 buffer（没有 buffer 时静默丢弃：非 runTurn 发起的调用没有本轮可写）。 */
function recordRetrieval(buffer: TurnBuffer | undefined, signal: TurnRetrieval): void {
  if (buffer === undefined) return;
  buffer.retrieval = mergeRetrievalSignal(buffer.retrieval, signal);
}

/** 每会话一个的 buffer 挂载点，由 `core/agent.ts` 的会话池持有。 */
export type TurnSlot = {
  buffer: TurnBuffer | undefined;
  /** 本会话语言：工具执行时拿不到它（execute 的 ctx 里没有 lang），只能挂在 slot 上。 */
  lang: string;
  /**
   * 本会话 id：建单时作为 `conv_id` 回填，让工单能关联到那段对话。
   * 可选是因为装配侧（`core/agent.ts`）灌它的时机还不存在 —— 没灌时建单照常发，
   * 只是不带 `conv_id`（匿名单本来就不依赖它），**绝不编一个假 id 上去**。
   */
  convId?: string;
};

/** 空检索结果的固定文案：模型能识别，且不会因为抛错把整轮打成 500。 */
export const NO_RESULT = "NO_RESULT";

/** 单片段正文上限（06 §3.1）。retrieve() 已经截到 600，这里是第二道，防止上层换实现。 */
const SNIPPET_MAX_CHARS = 600;

/**
 * 检索并格式化成"给模型看的纯文本 + 给上层的结构化候选"。
 *
 * 工具与 mock 模式（`LLM_PROVIDER=mock`，PRD §8）都走这一个函数：mock 模式不能调模型，
 * 但**必须**真的检索一次，否则 citations 恒为空、每轮都判拒答。
 *
 * 第三个参数是本轮 buffer：检索一结束就把 `{ topScore, fallback, chunkCount }` 写进去
 * （见 `recordRetrieval`）。**拒答判定 ① 只能读这个信号**，不许用"候选是否为空"反推——
 * 低置信的一轮照样有 5 条候选，反推会让 ①b 永远不成立。
 *
 * 失败口径：检索不可用 → 与"空结果"同一条路（`NO_RESULT` + 空候选 + 信号 `0/empty`）。
 * 静默降级是禁止的（18 §1 第四类错误），所以这里必须 `logger.warn` 留痕 ——
 * 上层会因此拒答，日志是唯一能解释"为什么今天全在拒答"的地方。
 */
export async function kbSearch(
  params: { query: string; lang?: string },
  sessionLang: string,
  buffer?: TurnBuffer,
): Promise<{ text: string; citations: TurnCitation[]; retrieval: TurnRetrieval }> {
  const lang = params.lang ?? sessionLang;
  try {
    const result = await retrieve({ query: params.query, lang, topK: config.retrievalTopK });

    // 真实分数与真实降级标签，一个都不改：`topScore=0` 只在 retrieve 自己给出 0 时出现。
    const retrieval: TurnRetrieval = {
      topScore: result.topScore,
      fallback: result.fallback,
      chunkCount: result.chunks.length,
    };
    recordRetrieval(buffer, retrieval);

    if (result.chunks.length === 0) return { text: NO_RESULT, citations: [], retrieval };

    const citations: TurnCitation[] = result.chunks.map((chunk) => ({
      idx: chunk.idx,
      chunk_id: chunk.chunk_id,
      doc_id: chunk.doc_id,
      doc_title: chunk.doc_title,
      doc_lang: chunk.doc_lang,
      page: chunk.page,
      section: chunk.section,
      snippet: chunk.content.slice(0, SNIPPET_MAX_CHARS),
      score: chunk.score,
    }));

    // 给模型的只有"序号 + 标题 + 页码 + 正文"：结构化字段一律留在 details 里。
    // 页码可能是 null（同一文档跨页的块），此时只写标题，不写 "p.null"。
    const text = citations
      .map((c) => {
        const where = c.page === null ? c.doc_title : `${c.doc_title} p.${c.page}`;
        return `[${c.idx}] (${where})\n${c.snippet}`;
      })
      .join("\n\n");

    return { text, citations, retrieval };
  } catch (err) {
    // 检索直接失败（维度错、SQL 错、非 DB 类异常）：本来就没有分数可言，
    // 记 `0 / empty` 是"没有证据"的如实表达，不是编一个分数。上层据此拒答而不是 500。
    const retrieval: TurnRetrieval = { topScore: 0, fallback: "empty", chunkCount: 0 };
    recordRetrieval(buffer, retrieval);
    logger.warn({ err, lang, query_len: params.query.length }, "kb_search retrieval failed");
    return { text: NO_RESULT, citations: [], retrieval };
  }
}

/* ────────────────── 内部 HTTP：三个业务工具的唯一出口 ────────────────── */

/**
 * 工具结果的固定形状（`AgentToolResult` 的子集）。details 必须是纯 JSON ——
 * 它会被写进运行轨迹与前端渲染，塞 Date/Error 进去只会在序列化时变成 `{}`。
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type ToolDetails = { [key: string]: Json };
type ToolResult = { content: { type: "text"; text: string }[]; details: ToolDetails };

/** 纯文本 + 结构化附加字段：给模型的永远只有一段字符串（06 §3.0）。 */
function textResult(text: string, details: ToolDetails): ToolResult {
  return { content: [{ type: "text", text }], details };
}

/**
 * 固定文案（给模型看，**不翻译**）：模型按字面识别"没查到"与"查不了"，
 * 前端与测试也按字面断言。混进自然语言就会各说各话。
 */
export const CODE_NOT_FOUND = "CODE_NOT_FOUND";
export const LOOKUP_FAILED = "LOOKUP_FAILED";
export const CREATE_FAILED = "CREATE_FAILED";
export const TICKET_NOT_FOUND = "未找到该工单";

/** 工单状态四态 → 中文（05 §4 / 10-ui）。未知状态原样透出，不猜。 */
const TICKET_STATUS_TEXT: Record<string, string> = {
  open: "待处理",
  claimed: "处理中",
  escalated: "已升级",
  closed: "已关闭",
};

/**
 * 故障码固定查 balcony 线：`fault_codes` 的主键是 `(code, product_line)`（04-db §），
 * 同一个码在不同产品线含义不同。**不让模型填产品线** —— 它没有判断依据，猜错就是查错含义。
 * 本期只有一条线在售，`balcony` 与 05 §3.3 的默认值一致。
 */
const FAULT_PRODUCT_LINE = "balcony";

/** 故障码形状（05 §3.3）：字母 + 2~3 位数字。与 `tool_call` hook 的校验同一份正则。 */
const FAULT_CODE_PATTERN = /^[A-Za-z]\d{2,3}$/;

/**
 * 内部接口单次调用的上限：工具在主链路上，内部接口 5 秒不回来，这轮对话已经废了；
 * 早失败、回固定文案、让模型走"转人工"，比让用户盯着转圈强。
 */
const INTERNAL_TIMEOUT_MS = 5_000;

/** 内部接口失败（网络 / 非 2xx / 非 JSON）统一成一种错误，由各工具自己降级。 */
class InternalHttpError extends Error {
  /** HTTP 状态码；网络层失败时为 undefined。 */
  readonly status: number | undefined;

  constructor(status: number | undefined, message: string) {
    super(message);
    this.name = "InternalHttpError";
    this.status = status;
  }
}

/**
 * 内部接口调用：回环地址 + `X-Internal-Token`（`src/api/internal.ts` 的两道门）。
 *
 * 为什么是 `127.0.0.1` 而不是 `localhost`：`localhost` 可能先解析到 `::1`，
 * 也可能被 hosts 文件改到别处；内部接口的门是"来源必须是回环"，写死 IPv4 回环最省事。
 */
async function internalJson(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const headers: Record<string, string> = { "X-Internal-Token": config.internalToken };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  // 超时与"本轮被取消"取交集：任一触发都停止等待，不会留下一个跑到天荒地老的连接。
  const timeout = AbortSignal.timeout(INTERNAL_TIMEOUT_MS);
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: merged,
    });
  } catch (err) {
    throw new InternalHttpError(undefined, `内部接口不可达：${err instanceof Error ? err.message : String(err)}`);
  }

  // 响应体里的原因不透给模型（它只会照抄给客户）；状态码留给调用方做语义判断 ——
  // 例如工单查询用 404 表示"没有这张单"，那不是故障。
  if (!response.ok) throw new InternalHttpError(response.status, `内部接口返回 ${response.status}`);

  try {
    return await response.json();
  } catch {
    throw new InternalHttpError(response.status, "内部接口的响应不是 JSON");
  }
}

/**
 * 内部接口的响应可能是 `{ ok: true, data: {...} }`（05 §5 的统一外壳），
 * 也可能直接是数据本体。两种都认：外壳是传输层的事，工具只关心数据。
 */
function unwrapPayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  const data = record.data;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  return record;
}

/** 错误 → 一行可读文本（进 details，不进给模型的正文）。 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 故障码查询（06 §3.2）：命中 → 含义 + 有序处理步骤（纯文本）；严重度 / 来源语种 /
 * 步骤原文留在 details。**未命中与查不了必须分开**：`CODE_NOT_FOUND` 是"表里没这个码"
 * （模型可以据此转人工），`LOOKUP_FAILED` 是"内部接口挂了"（模型不该因此断言码不存在）。
 *
 * `signal` 由 SDK 传入（用户断开 / 本轮超时），原样透给 fetch。
 */
export async function faultCodeLookup(
  params: { code: string },
  slot: TurnSlot,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const code = params.code.trim();
  // 语言取会话语言：工具执行时拿不到 lang（execute 的 ctx 里没有），slot 是唯一来源。
  const search = new URLSearchParams({ code, lang: slot.lang, product_line: FAULT_PRODUCT_LINE });

  try {
    const data = unwrapPayload(await internalJson("GET", `/internal/fault?${search.toString()}`, undefined, signal));
    if (data.found !== true) return textResult(CODE_NOT_FOUND, { found: false, code });

    const meaning = typeof data.meaning === "string" ? data.meaning : "";
    const actions = Array.isArray(data.actions)
      ? data.actions.filter((action): action is string => typeof action === "string")
      : [];

    // 步骤文案来自词条正文，有的自带 "1." 前缀。先剥掉再统一编号，
    // 否则模型看到的会是 "1. 1. 测量电压" 这种双编号。
    const steps = actions.map((action, index) => `${index + 1}. ${action.replace(/^\s*\d+\s*[.)、]\s*/, "")}`);
    const text = [meaning, ...steps].filter((line) => line !== "").join("\n");

    return textResult(text, {
      found: true,
      code,
      severity: typeof data.severity === "string" ? data.severity : null,
      doc_lang: typeof data.doc_lang === "string" ? data.doc_lang : null,
      actions,
    });
  } catch (err) {
    logger.warn({ err, code, lang: slot.lang }, "fault_code_lookup failed");
    return textResult(LOOKUP_FAILED, { found: false, code, error: errorText(err) });
  }
}

/**
 * 建单（06 §3.3）：走内部建单接口，返回 `WT-YYYY-NNNN`。
 *
 * **`params.reason` 不发给内部接口**：`reason` 在 schema 里存在只是为了让模型说清
 * "为什么想转人工"，但工单原因必须由后端按触发路径写死 —— 模型可以把一次闲聊说成
 * `no_citation`，那会污染拒答统计与 SLA 优先级（05 §3.4 的"两个词"）。内部建单
 * 固定写 `user_request`（转人工），模型选择的余地是零。
 */
export async function ticketCreate(
  params: { reason: string; question: string; requester?: string },
  slot: TurnSlot,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    const payload = await internalJson(
      "POST",
      "/internal/ticket",
      {
        question: params.question,
        // 匿名单不需要邮箱（05 §5.3）；缺省 / 全空白都显式发 null，让对面看到"没有"而不是"没传"，
        // 也免得模型吐一个空串把内部接口的邮箱正则撞成 VALIDATION。
        conv_id: slot.convId,
        requester: (params.requester ?? "").trim() === "" ? null : (params.requester ?? "").trim(),
      },
      signal,
    );

    const data = unwrapPayload(payload) as { no?: unknown; due_at?: unknown };
    const no = data.no;
    if (typeof no !== "string" || no === "") {
      // 建单成功却没有单号 = 契约破裂。照实报失败，不要让模型对一个空号道谢。
      throw new InternalHttpError(undefined, "内部建单没有返回工单号");
    }
    // 截止时间一并透出（工单卡 checklist："返回 WT-YYYY-NNNN 与截止时间"）：
    // 模型据此才能回答"最迟什么时候联系我"，而不用自己编一个时间。
    const dueAt = typeof data.due_at === "string" && data.due_at !== "" ? data.due_at : null;
    return textResult(`已创建工单 ${no}`, { no, due_at: dueAt });
  } catch (err) {
    logger.error({ err }, "ticket_create failed");
    return textResult(CREATE_FAILED, { no: null, error: errorText(err) });
  }
}

/**
 * 工单查询（06 §3.4、05 §5.4）：按单号取状态，让模型能回答"我的单怎么样了"。
 * 404 等于"没这张单"（不是一个故障）：内部接口对**未授权**也回 404，
 * 这里区分不了，所以只在日志里留痕，给模型的口径统一是"未找到"。
 */
export async function ticketLookup(
  params: { no: string },
  _slot: TurnSlot,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const no = params.no.trim();
  try {
    const data = unwrapPayload(
      await internalJson("GET", `/internal/ticket/${encodeURIComponent(no)}`, undefined, signal),
    );
    const status = typeof data.status === "string" ? data.status : undefined;
    if (data.found !== true || status === undefined) return textResult(TICKET_NOT_FOUND, { found: false, no });

    return textResult(`状态：${TICKET_STATUS_TEXT[status] ?? status}`, { found: true, no, status });
  } catch (err) {
    if (err instanceof InternalHttpError && err.status === 404) {
      logger.warn({ no }, "ticket_lookup 404（工单不存在，或内部令牌/回环来源不满足）");
      return textResult(TICKET_NOT_FOUND, { found: false, no });
    }
    logger.warn({ err, no }, "ticket_lookup failed");
    return textResult(LOOKUP_FAILED, { found: false, no, error: errorText(err) });
  }
}

/**
 * 三个执行函数的具名出口：注册用的 `execute` 只是把它们接到 SDK 的五个位置参数上，
 * 单测可以直接驱动这一层（不需要真的 `pi` 对象，也不用起服务）。
 */
export const toolExecutors = {
  fault_code_lookup: faultCodeLookup,
  ticket_create: ticketCreate,
  ticket_lookup: ticketLookup,
};

/**
 * 业务扩展：注册四个工具 + 两个 hook。`slot` 见文件头的说明（每会话一份）。
 *
 * 注册项与 `SUPPORT_TOOL_NAMES` 必须逐字对应：`tools:[]` 只做**选择**（06 §1.1 C1），
 * 注册是"能不能调"，选择是"让不让模型看见"，两边缺一个都会变成"模型说我没有这个能力"。
 * 少注册一个不会报错，只会静默消失 —— 所以 `tests/tool-registry.test.ts` 有静态断言盯着。
 */
export function supportExtension(pi: ExtensionAPI, slot: TurnSlot): void {
  pi.registerTool({
    name: "kb_search",
    label: "知识库检索",
    description: "检索产品知识库（参数/安装/保修/故障）。回答任何技术问题前必须先调用。",
    parameters: Type.Object({
      query: Type.String({ description: "用户的原始问题，任意语言，可含上一轮上下文" }),
      lang: Type.Optional(Type.String({ description: "zh|en|de|nl|es，缺省跟随会话" })),
    }),
    // execute 是 5 个位置参数（06 §3.0），不是 (input, ctx)：
    // 少写一个，signal/onUpdate 会顶到错误位置，params 拿到的是 toolCallId。
    // 第 5 个参数 ctx 由 SDK 上下文类型推断（ExtensionToolContext），这里不用显式标注。
    async execute(_toolCallId, params, _signal, _onUpdate) {
      // lang 可以不填：缺省跟随会话（06 §3.1），填了则以模型给的为准（它可能故意换语种检索）。
      // slot.buffer 是拒答判定 ① 的信号通道：kbSearch 一返回就把 topScore/fallback 写进去，
      // 这里不再二次加工（一个分数只能有一处来源）。
      const { text, citations } = await kbSearch(params, slot.lang, slot.buffer);
      return { content: [{ type: "text", text }], details: { citations } };
    },
  });

  pi.registerTool({
    name: "fault_code_lookup",
    label: "故障码查询",
    description: "按故障码查含义与处理步骤（如 E03）。用户报故障码时先查它，再答。",
    parameters: Type.Object({
      code: Type.String({ description: "故障码，字母 + 2~3 位数字，例如 E03" }),
    }),
    // signal 第 3 个位置：透给 fetch，用户断开 / 本轮超时时真的停掉内部请求。
    async execute(_toolCallId, params, signal) {
      return await faultCodeLookup(params, slot, signal);
    },
  });

  pi.registerTool({
    name: "ticket_create",
    label: "创建工单",
    description: "转人工：资料不足以回答或用户要求人工时创建工单。需要邮箱以外的信息都不必问，匿名也能建。",
    parameters: Type.Object({
      // reason 只用来让模型说清意图，**不发给内部接口**（原因由后端固定写 user_request）。
      reason: Type.String({ description: "no_citation|out_of_scope|low_conf|user_request" }),
      question: Type.String({ minLength: 4, maxLength: 500, description: "用户的问题原文" }),
      requester: Type.Optional(Type.String({ description: "联系邮箱（可选，匿名单可不填）" })),
    }),
    async execute(_toolCallId, params, signal) {
      return await ticketCreate(params, slot, signal);
    },
  });

  pi.registerTool({
    name: "ticket_lookup",
    label: "工单查询",
    description: "按工单号查状态，用于回答“我的单怎么样了”。工单号形如 WT-2026-0031。",
    parameters: Type.Object({
      no: Type.String({ description: "工单号，形如 WT-2026-0031" }),
    }),
    async execute(_toolCallId, params, signal) {
      return await ticketLookup(params, slot, signal);
    },
  });

  /**
   * ① 白名单，fail-closed（06 §4.1）。
   * 注意**不要** try/catch 吞异常：handler 抛错时框架按 block 处理，这正是我们要的
   * "宁可拒绝也不放行"。吞掉异常等于把 fail-closed 改成 fail-open。
   *
   * 白名单之后还有两道参数校验（06 §4.1）：schema 已经校验过类型与长度，
   * 但 schema 管不住"全是空格"（`"    "` 满足 minLength 4）与"看起来像码但不是码"。
   * 这类输入进到工具里只会白烧一次内部调用，所以在门口就挡掉。
   */
  pi.on("tool_call", async (event) => {
    if (!ALLOWED_TOOLS.has(event.toolName)) {
      logger.warn({ tool: event.toolName }, "blocked tool call: not in whitelist");
      return { block: true, reason: "tool_not_allowed" };
    }

    if (event.toolName === "ticket_create") {
      const question = String((event.input as { question?: unknown } | undefined)?.question ?? "").trim();
      if (question.length < 4) return { block: true, reason: "question_too_short" };
    }

    if (event.toolName === "fault_code_lookup") {
      const code = String((event.input as { code?: unknown } | undefined)?.code ?? "");
      if (!FAULT_CODE_PATTERN.test(code)) return { block: true, reason: "bad_code" };
    }

    return;
  });

  /**
   * ② 候选落进本轮内存 buffer（06 §4.2）。
   * **不发 HTTP**：hook 在主链路上，多一次往返就是工具延迟多一跳；
   * 落库由 chat.ts 在 `done` 前统一做（05#01）。
   */
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "kb_search") return;
    const citations = (event.details as { citations?: TurnCitation[] } | undefined)?.citations;
    if (citations === undefined || citations.length === 0) return;
    // slot.buffer 为空只可能是"这一轮不是 runTurn 发起的"（例如直连 SDK 的单测）。
    // 那种情况丢掉候选比抛错好：上层没有 buffer 可用，本来就会走拒答。
    slot.buffer?.citations.push(...citations);
  });
}
