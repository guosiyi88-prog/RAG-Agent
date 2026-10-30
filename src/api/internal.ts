/**
 * 内部检索接口。
 *
 * 两个端点，共用同一套两道门（回环来源 + `X-Internal-Token`）：
 *   GET  /internal/retrieval/recall   分层调试：两路候选原样摊开（`03-hybrid-retrieval` #01）
 *   POST /internal/search             正式检索：RRF 融合 → 归一化 → 去重 → 截断 → topK（#02）
 *
 * 为什么保留第一个：融合是"两路都健康时才对自己成立"的算法。没有分层入口，
 * "召回为空"永远只能靠改 SQL + 重启服务来二分定位。所以那里把两路原样摊开：
 * 各自最多 20 条、各自的原始分、各自的语言视野，**不做**融合/归一化/去重/截断。
 *
 * 安全模型（两道门，任一不满足都回 404，不是 401）：
 *   1. 来源必须是回环地址（`127.0.0.0/8`、`::1`、IPv4-mapped `::ffff:127.x.x.x`）
 *   2. 请求头 `X-Internal-Token` 必须与 `config.internalToken` **全等**
 * 为什么要 404 而不是 401/403：401 等于告诉扫描器"这个端点存在，只是缺凭据"，
 * 会换来持续的爆破；404 与"路径根本不存在"不可区分，端点存在性不外泄。
 * **实现不在这里**：四个内部端点（含 `internal-fault/ticket/citations`）共用
 * `src/auth.ts` 的 `internalAuthorized` / `sendNotFound`，本文件只剩业务逻辑。
 * 判定散成三份的那天，就有一份会被改漏 —— 本卡（07#01）把三份并成了一份。
 *
 * 两个端点的错误码也刻意不同：调试端点把 `EMBED_UNAVAILABLE` 翻成 503 是为了让排查者
 * 一眼看出"嵌入没通"；`/internal/search` 走的是生产语义 —— 嵌入失败**降级**（`fallback=fts_only`），
 * 只有维度错误（契约破裂）才回 500 `INTERNAL`，其余异常交给统一错误处理器。
 */
import type { FastifyInstance } from "fastify";
import { internalAuthorized, sendNotFound } from "../auth.ts";
import { EMBED_DIM, EmbedError, embedBackend } from "../core/embed.ts";
import {
  RECALL_LANES,
  RECALL_TOP_N,
  isKnownLang,
  recall,
  retrieve,
  type RecallLane,
  type RecalledChunk,
  type RetrievalResult,
} from "../core/retrieval.ts";
import { AppError } from "../errors.ts";

/** 07 §9：query 上限 2000 字符。调试接口选择**明确报错**而不是静默截断。 */
const MAX_QUERY_CHARS = 2_000;

/** 05 §5.1 的 `top_k` 上限（与本卡"单次最多取 20 条"的召回上界一致）。 */
const MAX_TOP_K = 20;

type RecallQuery = {
  q?: string;
  lang?: string;
  lane?: string;
};

/** 片段在响应里的形状：序号 + 07 §1 的检索元数据 + 该路原始分。 */
type RecallRowBody = {
  rank: number;
  chunk_id: number;
  doc_id: string;
  doc_title: string;
  doc_lang: string;
  lang: string;
  page: number | null;
  section: string | null;
  content: string;
  score: number;
};

function toBody(rows: RecalledChunk[] | null): RecallRowBody[] | null {
  if (rows === null) return null;
  return rows.map((row, index) => ({
    rank: index + 1,
    chunk_id: row.chunk_id,
    doc_id: row.doc_id,
    doc_title: row.doc_title,
    doc_lang: row.doc_lang,
    lang: row.lang,
    page: row.page,
    section: row.section,
    content: row.content,
    score: row.score,
  }));
}

/** `/internal/search` 的 body（05 §5.1）。`unknown` 是故意的：入参没校验前不许假设类型。 */
type SearchBody = {
  query?: unknown;
  lang?: unknown;
  top_k?: unknown;
  prev_user?: unknown;
};

function bodyString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new AppError("VALIDATION", `${field} 必须是字符串`);
  return value;
}

/**
 * `top_k` 是可选的正整数，不收字符串数字：能收 `"5"` 就得逐个讨论 `"5abc"`、`"5 "`、`"0x5"`
 * 的边界，而这条链路是 agent 工具调用，没有"用户手输"这个借口。超出范围明确报错，
 * 不静默夹到 20 —— 调用方以为拿到了 50 条、实际只有 20 条，比报错更难查。
 */
function parseTopK(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AppError("VALIDATION", "top_k 必须是整数");
  }
  if (value < 1 || value > MAX_TOP_K) {
    throw new AppError("VALIDATION", `top_k 必须在 1..${MAX_TOP_K}，收到 ${value}`);
  }
  return value;
}

export async function registerInternalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/internal/retrieval/recall", async (request, reply) => {
    if (!internalAuthorized(request)) return sendNotFound(request, reply);

    const params = request.query as RecallQuery;
    const text = (params.q ?? "").trim();
    if (text === "") throw new AppError("VALIDATION", "q 不能为空");
    if (text.length > MAX_QUERY_CHARS) {
      throw new AppError("VALIDATION", `q 超过 ${MAX_QUERY_CHARS} 字符（截断归上层，这里不静默改查询）`);
    }

    const lang = (params.lang ?? "en").trim();
    if (!isKnownLang(lang)) {
      throw new AppError("VALIDATION", `lang 必须是 zh|en|de|nl|es，收到 "${lang}"`);
    }

    const lane = (params.lane ?? "both").trim() as RecallLane;
    if (!RECALL_LANES.includes(lane)) {
      throw new AppError("VALIDATION", `lane 必须是 vec|fts|both，收到 "${lane}"`);
    }

    let result;
    try {
      result = await recall({ query: text, lang, lane });
    } catch (err) {
      // embedding 调用失败**不在这里降级**：降级（hash 向量 / fts_only）是 #02 的决定，
      // 这里只把它翻译成一个能看懂的状态码，免得排查时看到笼统的 500。
      if (err instanceof EmbedError) {
        throw new AppError(
          err.code === "EMBED_DIM_MISMATCH" ? "INTERNAL" : "EMBED_UNAVAILABLE",
          `${err.code}: ${err.message}`,
        );
      }
      throw err;
    }

    return reply.code(200).send({
      ok: true,
      query: result.query,
      lang: result.lang,
      lang_scope: result.lang_scope,
      lane: result.lane,
      recall_top_n: RECALL_TOP_N,
      embed_dim: EMBED_DIM,
      embed_backend: embedBackend(),
      timings_ms: result.timings,
      vector: toBody(result.vector),
      fts: toBody(result.fts),
    });
  });

  app.post("/internal/search", async (request, reply) => {
    if (!internalAuthorized(request)) return sendNotFound(request, reply);

    // content-type 不是 JSON 时 Fastify 会把 body 留成字符串/undefined，先挡住形状。
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError("VALIDATION", "body 必须是 JSON 对象");
    }
    const payload = body as SearchBody;

    const rawQuery = bodyString(payload.query, "query");
    if (rawQuery === undefined) throw new AppError("VALIDATION", "query 必填");
    const text = rawQuery.trim();
    if (text === "") throw new AppError("VALIDATION", "query 不能为空");
    if (text.length > MAX_QUERY_CHARS) {
      throw new AppError("VALIDATION", `query 超过 ${MAX_QUERY_CHARS} 字符（检索层不静默改查询）`);
    }

    // 刻意不给 lang 默认值：这是机器对机器接口，缺 lang 是调用方的 bug。
    // 悄悄按 en 处理会把英文片段返给德语用户，而这个错误在响应体里看不出来。
    const rawLang = bodyString(payload.lang, "lang");
    if (rawLang === undefined) throw new AppError("VALIDATION", "lang 必填（zh|en|de|nl|es）");
    const lang = rawLang.trim();
    if (!isKnownLang(lang)) {
      throw new AppError("VALIDATION", `lang 必须是 zh|en|de|nl|es，收到 "${lang}"`);
    }

    // 上一轮问题会被拼进检索语句，因此和 query 同一个长度上限（07 §9）。
    const prevUser = bodyString(payload.prev_user, "prev_user")?.trim();
    if (prevUser !== undefined && prevUser.length > MAX_QUERY_CHARS) {
      throw new AppError("VALIDATION", `prev_user 超过 ${MAX_QUERY_CHARS} 字符`);
    }

    const topK = parseTopK(payload.top_k);

    let result: RetrievalResult;
    try {
      result = await retrieve({ query: text, lang, topK, prevUser });
    } catch (err) {
      // 能走到这里的 EmbedError 只剩"维度契约破裂"（可降级的失败在 retrieve 内部已消化并记了日志）。
      // 必须回 500 而不是静默返回空：否则数据事故会伪装成"没搜到"。
      if (err instanceof EmbedError) {
        throw new AppError("INTERNAL", `${err.code}: ${err.message}`);
      }
      throw err;
    }

    return reply.code(200).send({
      ok: true,
      data: {
        lang: result.lang,
        // `topScore` 是**归一化后**的最高分（07 §5.1）；上层拿它和 0.30 比才成立。
        topScore: result.topScore,
        fallback: result.fallback,
        chunks: result.chunks,
        // 规格之外的附加字段（性能闸门与排查用）：规格要求的四个字段一个不少。
        timings_ms: result.timings,
      },
    });
  });
}
