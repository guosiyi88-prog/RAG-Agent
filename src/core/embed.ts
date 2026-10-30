/**
 * Embedding 客户端 —— 全仓唯一出口（08-ingestion.md §5、07-retrieval.md §7）。
 *
 * 入库与检索**必须**共用这里的 `embedBatch()` / `embed()`：两套实现就会有两套超时、
 * 两套降级逻辑，最后表现为"入库的向量和查询的向量不在同一个空间里"，而这类故障
 * 从检索指标上看只是"命中率莫名偏低"，定位成本极高。
 *
 * 后端选择（`EMBED_BACKEND` + key 是否存在）只在这里判一次：
 *   - dashscope 有 key → 真调用（模型 `text-embedding-v3`，维度锁 1024）
 *   - 否则 → FNV-1a 兜底向量（`hash-embed.ts`），确定性、不需要外部服务
 */
import { config } from "../config.ts";
import { logger } from "../logger.ts";
import { HASH_DIM, hashEmbed } from "./hash-embed.ts";

/** `chunks.embedding vector(1024)` 与检索 SQL 都写死了 1024，任何偏差都是数据事故。 */
export const EMBED_DIM = 1024;
export const EMBED_MODEL = "text-embedding-v3";
export const EMBED_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding";

/**
 * 08 §5.1：串行、单批 15s、失败重试 2 次。这些是常量，不是可调参数。
 * 批大小 10 而不是规格原写的 16：`text-embedding-v3` 的硬上限是 10，送 11 条即
 * `400 InvalidParameter: batch size is invalid, it should not be larger than 10`。
 * 规格与勘误已同步（08 §5.1、16 §5 A7），不要凭记忆改回 16。
 */
export const EMBED_BATCH_SIZE = 10;
export const EMBED_BATCH_TIMEOUT_MS = 15_000;
export const EMBED_RETRY_DELAYS_MS: readonly number[] = [500, 1_500];

/** 入库用 `document`、检索用 `query`，混用会掉召回质量（08 §5.2 的硬约定）。 */
export type EmbedTextType = "document" | "query";

export type EmbedBackend = "dashscope" | "hash";

/** 错误码是契约：`EMBED_DIM_MISMATCH` 由 07 §9 点名，不许静默截断成别的形状。 */
export type EmbedErrorCode = "EMBED_UNAVAILABLE" | "EMBED_TIMEOUT" | "EMBED_DIM_MISMATCH";

export class EmbedError extends Error {
  readonly code: EmbedErrorCode;

  constructor(code: EmbedErrorCode, message?: string) {
    super(message ?? code);
    this.name = "EmbedError";
    this.code = code;
  }
}

let warnedMissingKey = false;

/**
 * 实际生效的后端。配了 dashscope 却没有 key 时降级到 hash —— 这是刻意设计：
 * 缺 key 不应该让入库或检索整条链路停摆（13-ops.md §4 的"Key 缺失只降级不退出"）。
 */
export function embedBackend(): EmbedBackend {
  if (config.embedBackend === "hash") return "hash";
  if (!config.dashscopeApiKey) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      logger.warn(
        { embedBackend: config.embedBackend },
        "DASHSCOPE_API_KEY 未设置，embedding 降级为本地 hash 兜底向量（检索质量下降，链路继续）",
      );
    }
    return "hash";
  }
  return "dashscope";
}

/** Postgres `vector` 的字面量入参形式；参数化查询里必须走 `$n::vector`，不能拼 SQL。 */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function assertDim(vector: unknown, where: string): number[] {
  if (!Array.isArray(vector) || vector.length !== EMBED_DIM) {
    const actual = Array.isArray(vector) ? vector.length : "非数组";
    throw new EmbedError(
      "EMBED_DIM_MISMATCH",
      `${where} 返回维度 ${String(actual)}，契约要求 ${EMBED_DIM}（不截断、不补齐）`,
    );
  }
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EmbedError("EMBED_DIM_MISMATCH", `${where} 返回了非有限数值，整批失败`);
    }
  }
  return vector as number[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callDashscope(
  texts: string[],
  textType: EmbedTextType,
): Promise<number[][]> {
  let response: Response;
  try {
    response = await fetch(EMBED_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.dashscopeApiKey ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: { texts },
        parameters: { dimension: EMBED_DIM, text_type: textType },
      }),
      signal: AbortSignal.timeout(EMBED_BATCH_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout 的 CancellationError / 旧版 AbortError 都归到超时
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new EmbedError("EMBED_TIMEOUT", `embedding 单批超过 ${EMBED_BATCH_TIMEOUT_MS}ms`);
    }
    throw new EmbedError("EMBED_UNAVAILABLE", `embedding 请求失败：${String(err)}`);
  }

  if (!response.ok) {
    throw new EmbedError("EMBED_UNAVAILABLE", `embedding HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    output?: { embeddings?: { text_index?: number; embedding?: number[] }[] };
  };
  const rows = payload.output?.embeddings;
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw new EmbedError(
      "EMBED_UNAVAILABLE",
      `embedding 返回条数 ${rows?.length ?? "?"} ≠ 请求条数 ${texts.length}`,
    );
  }

  // text_index 不保证按请求顺序返回，必须按它重排，否则片段会配错向量
  const ordered = new Array<number[]>(texts.length);
  rows.forEach((row, fallbackIndex) => {
    const index = row.text_index ?? fallbackIndex;
    ordered[index] = assertDim(row.embedding, `第 ${index} 条`);
  });
  // 用下标循环而不是 forEach：稀疏位（重复 text_index 造成的空洞）forEach 会直接跳过
  for (let index = 0; index < texts.length; index += 1) {
    if (ordered[index] === undefined) {
      throw new EmbedError("EMBED_UNAVAILABLE", `第 ${index} 条 embedding 缺失，整批失败`);
    }
  }
  return ordered;
}

/** 单批：重试 2 次（退避 500ms / 1500ms）。维度错误不重试 —— 重试改变不了维度。 */
async function embedChunkOfBatch(texts: string[], textType: EmbedTextType): Promise<number[][]> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= EMBED_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await callDashscope(texts, textType);
    } catch (err) {
      lastError = err;
      if (err instanceof EmbedError && err.code === "EMBED_DIM_MISMATCH") throw err;
      const delay = EMBED_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      logger.warn(
        { attempt: attempt + 1, delay, err: err instanceof Error ? err.message : err },
        "embedding 单批失败，退避后重试",
      );
      await sleep(delay);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new EmbedError("EMBED_UNAVAILABLE", String(lastError));
}

/**
 * 批量嵌入：批 10（DashScope 上限）、严格串行（并发 1，避免限流）、每批 15s 超时。
 * 返回顺序与入参一一对应；任一批最终失败 → 整体抛错（不做部分成功的"尽力而为"）。
 */
export async function embedBatch(
  texts: readonly string[],
  textType: EmbedTextType = "document",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (HASH_DIM !== EMBED_DIM) {
    // 兜底维度与列维度不一致时立刻失败：写进库之后再发现，只能全表重建
    throw new EmbedError("EMBED_DIM_MISMATCH", `兜底维度 ${HASH_DIM} ≠ 列维度 ${EMBED_DIM}`);
  }
  const backend = embedBackend();
  if (backend === "hash") {
    return texts.map((text) => assertDim(hashEmbed(text), "hash 兜底"));
  }

  const out: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
    const batch = texts.slice(offset, offset + EMBED_BATCH_SIZE);
    out.push(...(await embedChunkOfBatch(batch, textType)));
  }
  return out;
}

/**
 * 单条嵌入（检索侧入口）：内部复用 `embedBatch`，保证超时/重试/降级只有一份实现。
 * 默认 `text_type=query`：这个导出是给查询用的，入库侧请显式传 `document`。
 */
export async function embed(text: string, textType: EmbedTextType = "query"): Promise<number[]> {
  const [vector] = await embedBatch([text], textType);
  if (!vector) throw new EmbedError("EMBED_UNAVAILABLE", "embedding 返回空结果");
  return vector;
}
