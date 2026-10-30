/**
 * 检索（07-retrieval.md §4–§7、ADR-0003）。分两层，**互不越界**：
 *
 * 第一层 · 召回（07 §4，本文件原有部分）：出候选、做语言过滤、给出该路原始分。
 *   召回层只回答"这一路命中了哪些片段、各自排第几"，
 *   不做融合、不做归一化、不判阈值、不按 doc 去重、不截断、不分配 `idx`。
 *
 * 第二层 · 融合与后处理（07 §5–§7，文件末尾 `retrieve()`）：
 *   RRF → 归一化 → 按 doc 去重（每文档 ≤3）→ 截断 600 字 → 取 topK → 分配 `idx`。
 *   判定"这个分够不够回答"仍然不在这里 —— 阈值比较是调用方的事（07 §8、05 §5.1 只透出
 *   `topScore` + `fallback`），本文件只保证 `topScore` 是**归一化后**的值。
 *
 * 入口分层（越靠下越纯，便于单独驱动）：
 *   retrieve()                  完整检索：query 构建 + 降级 + 两路召回 + 融合后处理
 *   fuseAndPostProcess()        **纯函数**：只看候选、不碰 DB/网络，单测直接打这里
 *   recall()                    两路并行召回，供内部调试接口使用
 *   recallVector()              embed(query) → recallVectorByEmbedding()
 *   recallVectorByEmbedding()   只要向量就能跑（降级向量走这里）
 *   recallFts()                 纯 SQL，不碰模型
 *
 * 不做：query 改写、query 翻译（ADR-0003）、同义词表、词干化。
 */
import { config } from "../config.ts";
import { query } from "../db.ts";
import { logger } from "../logger.ts";
import type { Lang } from "./chunk.ts";
import { EMBED_DIM, EmbedError, embed, toVectorLiteral } from "./embed.ts";
import { normalizeScore, rankOf, rrf } from "./fuse.ts";
import { hashEmbed } from "./hash-embed.ts";
import { buildQuery } from "./query.ts";

/**
 * 语言视野表 —— **唯一真源**。SQL 里的语言数组只能由它生成，不许在 SQL 里写 `array['de','en']`：
 * 写死之后"加一门语言"要改 N 条 SQL，漏改的那条不报错、只是悄悄少召回。
 *
 * 为什么必须过滤（07 §2）：同一段内容有 5 个语言副本，向量空间里挤在一起。
 * 不过滤时 top20 往往被同一段内容的不同语言版本占满，等于只召回 1 条独立信息。
 * 每种语言都带 `en`：英文语料是五语种的公共底稿，术语对得最齐。
 */
export const LANG_SCOPE: Record<Lang, readonly Lang[]> = {
  zh: ["zh", "en"],
  en: ["en"],
  de: ["de", "en"],
  nl: ["nl", "en"],
  es: ["es", "en"],
};

/** 两路各取 20 条（07 §4.1、§4.2 的 VECTOR_CANDIDATES / FTS_CANDIDATES）。 */
export const RECALL_TOP_N = 20;

/** 未知语言一律按英文视野处理：宁可少召回，也不要把五语副本全捞回来。 */
export function langScopeOf(lang: string): readonly Lang[] {
  return LANG_SCOPE[lang as Lang] ?? LANG_SCOPE.en;
}

/** 语言码是否在视野表里（HTTP 入参校验用，避免拼出空数组当成"不过滤"）。 */
export function isKnownLang(lang: string): lang is Lang {
  return Object.prototype.hasOwnProperty.call(LANG_SCOPE, lang);
}

/**
 * 向量路 SQL。
 *
 * `<=>` 是 **cosine distance**（索引 `chunks_emb_idx ... vector_cosine_ops` 建在余弦口径上），
 * 不是 L2/Euclidean。换算子会让分数与索引口径脱钩：分数看着还在 0..1，召回顺序已经不可比。
 * 所以 `score = 1 - distance`（余弦相似度），排序用距离原值（走索引）。
 *
 * `any($2::char(2)[])` 的 `char(2)` cast **不可省**（04-db §5）：省了 PG 会把参数当 `text[]`
 * 比较，`chunks_lang_idx` 上的 `character(2)` 等值条件用不上，退化成全表过滤。
 * 表只有 10 行时看不出差别（planner 一律 seq scan），等语料上量就是 P95 直接爆预算。
 *
 * `d.status <> 'archived'`（`09#05`）：管理端"停用"一篇文档只改状态、不删行也不删片段
 * （D25 的同一条理由：删了行，`make ingest` 会把同一份文件重新插回来）。所以"停用后不再命中"
 * 必须由检索侧保证，而不是靠一次删除。刻意**不**写成 `d.status = 'indexed'`：
 * 改完正文还没重建时状态是 `pending`，那时旧索引**仍然要可检索**（工单 05 的中间态），
 * 写成等值会让"改一个字就全篇搜不到"。
 *
 * `limit ${RECALL_TOP_N}` 是模块内数值常量拼接，不是用户输入：上界固定 20，
 * 不引入任何可注入的片段。
 */
export const VECTOR_RECALL_SQL = `
  select c.id              as id,
         c.doc_id          as doc_id,
         c.lang            as lang,
         c.section         as section,
         c.content         as content,
         c.page            as page,
         d.title           as doc_title,
         d.lang            as doc_lang,
         1 - (c.embedding <=> $1::vector) as score
  from chunks c
  join documents d on d.id = c.doc_id
  where c.lang = any($2::char(2)[])
    and c.embedding is not null
    and d.status <> 'archived'
  order by c.embedding <=> $1::vector
  limit ${RECALL_TOP_N}
`;

/**
 * 全文路 SQL。
 *
 * **职责边界（07 §4.2）**：只负责精确术语 —— 故障码（`E03`、`F21`）、型号与规格数字
 * （`600W`、`ESS-5000`）、短术语的逐字命中。`to_tsvector('simple', …)` 不做词干化：
 * 德语 `Wechselrichter` 与 `Wechselrichters` 被当成两个词，荷兰语复合词切不开。
 * 因此它**不承担语义召回**（那是向量路 + 多语 embedding 的事），也**不许**用同义词表、
 * 词干化扩展去"补命中"：那等于在检索层偷偷做 query 改写，命中率上去的同时可解释性没了，
 * 而且会与入库侧的分词口径漂移。
 *
 * 语言过滤同理必带 `$2::char(2)[]`。`d.status <> 'archived'` 的理由与向量路一致
 * （停用不删片段，所以"不再命中"只能在这里表达）。
 */
export const FTS_RECALL_SQL = `
  select c.id              as id,
         c.doc_id          as doc_id,
         c.lang            as lang,
         c.section         as section,
         c.content         as content,
         c.page            as page,
         d.title           as doc_title,
         d.lang            as doc_lang,
         ts_rank(c.tsv, plainto_tsquery('simple', $1)) as score
  from chunks c
  join documents d on d.id = c.doc_id
  where c.lang = any($2::char(2)[])
    and c.tsv @@ plainto_tsquery('simple', $1)
    and d.status <> 'archived'
  order by score desc
  limit ${RECALL_TOP_N}
`;

/**
 * SQL 行。用 type 而不是 interface：`db.query<T>` 要求 T 满足 `QueryResultRow`（字符串索引签名），
 * TS 只给对象类型别名隐式索引签名，interface 会报"Index signature is missing"。
 */
type RecallRow = {
  /** bigserial → pg 返回字符串，映射时转 number（chunk_id 的量级远在安全整数内）。 */
  id: string;
  doc_id: string;
  lang: Lang;
  section: string | null;
  content: string;
  page: number | null;
  doc_title: string;
  doc_lang: Lang;
  score: number;
};

/** 一个候选片段。字段名与 07-retrieval.md §1 的 RetrievedChunk 对齐（去掉只有 #02 才知道的 idx）。 */
export type RecalledChunk = {
  chunk_id: number;
  doc_id: string;
  doc_title: string;
  /** `documents.lang`：整篇文档的语言，断言"德语查询没串中文"看这个。 */
  doc_lang: Lang;
  /** `chunks.lang`：片段语言。正常情况下与 doc_lang 相同，留两份是为了能发现入库串档。 */
  lang: Lang;
  page: number | null;
  section: string | null;
  /** 原文，**不截断**：600 字截断是 #02 的后处理，调试接口要看全貌。 */
  content: string;
  /** 该路原始分（向量路=余弦相似度，全文路=ts_rank）。两路分数量纲不同，不可互相比较。 */
  score: number;
};

export type RecallLane = "vec" | "fts" | "both";

export const RECALL_LANES: readonly RecallLane[] = ["vec", "fts", "both"];

export type RecallTimings = {
  /** 查询向量化耗时（网络）；lane=fts 时不执行。 */
  embed_ms: number;
  vector_ms: number;
  fts_ms: number;
  total_ms: number;
};

export type RecallResult = {
  query: string;
  lang: string;
  /** 本次实际生效的语言数组，来自 LANG_SCOPE —— 出问题时第一眼看这个。 */
  lang_scope: readonly Lang[];
  lane: RecallLane;
  vector: RecalledChunk[] | null;
  fts: RecalledChunk[] | null;
  timings: RecallTimings;
};

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function mapRow(row: RecallRow): RecalledChunk {
  return {
    chunk_id: Number(row.id),
    doc_id: row.doc_id,
    doc_title: row.doc_title,
    doc_lang: row.doc_lang,
    lang: row.lang,
    page: row.page,
    section: row.section,
    content: row.content,
    // pg 的 float8 已经是 number，这里只防御 NaN 污染后续排序
    score: Number.isFinite(row.score) ? row.score : 0,
  };
}

/**
 * 维度防线（07 §9）：`chunks.embedding vector(1024)` 与 SQL 里的 `$1::vector` 都写死 1024。
 * 维度不对时**整体失败**：静默返回空会让故障表现成"召回率莫名为零"，
 * 排查要翻遍语料、分块、索引才能定位到这里。
 */
function assertVectorDim(vector: readonly number[]): void {
  if (vector.length !== EMBED_DIM) {
    throw new EmbedError(
      "EMBED_DIM_MISMATCH",
      `查询向量维度 ${vector.length}，契约要求 ${EMBED_DIM}（不截断、不补齐，整个请求失败）`,
    );
  }
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EmbedError("EMBED_DIM_MISMATCH", "查询向量含非有限数值，整个请求失败");
    }
  }
}

/**
 * 向量路：拿现成向量召回 top20。
 * 单独导出是给 #02 的降级钩子用的 —— embedding 失败时它会换成 hash 向量，
 * 走的仍是这条 SQL 与这份维度校验（降级策略本身不在这里决定）。
 */
export async function recallVectorByEmbedding(
  vector: readonly number[],
  lang: string,
): Promise<RecalledChunk[]> {
  assertVectorDim(vector);
  const rows = await query<RecallRow>(VECTOR_RECALL_SQL, [toVectorLiteral(vector), langScopeOf(lang)]);
  return rows.map(mapRow);
}

/** 向量路：embed(query) 后召回。embed 抛错一律向上抛（降级归 #02，本模块不吞）。 */
export async function recallVector(input: { query: string; lang: string }): Promise<RecalledChunk[]> {
  const vector = await embed(input.query);
  return recallVectorByEmbedding(vector, input.lang);
}

/** 全文路：不碰模型，纯 SQL。命中不到就是空数组（不是错误）。 */
export async function recallFts(input: { query: string; lang: string }): Promise<RecalledChunk[]> {
  const rows = await query<RecallRow>(FTS_RECALL_SQL, [input.query, langScopeOf(input.lang)]);
  return rows.map(mapRow);
}

/**
 * 两路并行召回。`lane` 只影响**要不要跑**某一路（调试用），不影响 SQL 与过滤：
 * 关掉一路看到的就是同一批候选的子集，"哪一路坏了"因此可归因。
 *
 * 两路互不依赖（embedding 只服务向量路），所以 `Promise.all`；任一路抛错整体抛错，
 * 不返回"半路成功"——半路成功会被下游当成"这一路本身没命中"。
 */
export async function recall(input: {
  query: string;
  lang: string;
  lane?: RecallLane;
}): Promise<RecallResult> {
  const lane: RecallLane = input.lane ?? "both";
  const started = performance.now();
  const timings: RecallTimings = { embed_ms: 0, vector_ms: 0, fts_ms: 0, total_ms: 0 };

  let vector: RecalledChunk[] | null = null;
  let fts: RecalledChunk[] | null = null;
  const lanes: Promise<void>[] = [];

  if (lane !== "fts") {
    lanes.push(
      (async () => {
        const embedStarted = performance.now();
        const embedded = await embed(input.query);
        timings.embed_ms = roundMs(performance.now() - embedStarted);
        const vectorStarted = performance.now();
        vector = await recallVectorByEmbedding(embedded, input.lang);
        timings.vector_ms = roundMs(performance.now() - vectorStarted);
      })(),
    );
  }

  if (lane !== "vec") {
    lanes.push(
      (async () => {
        const ftsStarted = performance.now();
        fts = await recallFts({ query: input.query, lang: input.lang });
        timings.fts_ms = roundMs(performance.now() - ftsStarted);
      })(),
    );
  }

  await Promise.all(lanes);
  timings.total_ms = roundMs(performance.now() - started);

  return {
    query: input.query,
    lang: input.lang,
    lang_scope: langScopeOf(input.lang),
    lane,
    vector,
    fts,
    timings,
  };
}

/* ────────────────────── 第二层：融合与后处理（03-hybrid-retrieval #02） ────────────────────── */

/** 同一文档最多贡献几条（07 §6.1）：一份手册的连续小节不该占满 top5。 */
export const MAX_PER_DOC = 3;

/** 正文截断长度（07 §6.2）。入库、嵌入、打分都用全文，**只有下发时**才截断。 */
export const CONTENT_MAX_CHARS = 600;

/** 最终交给上层（以及前端角标）的一条片段：`idx` 就是正文里的 `[n]`。 */
export type RetrievedChunk = {
  /** 1..n，按 score 降序且**连续无空洞**：断号的角标在正文里就是坏引用。 */
  idx: number;
  chunk_id: number;
  doc_id: string;
  doc_title: string;
  doc_lang: Lang;
  page: number | null;
  section: string | null;
  /** 已截断到 CONTENT_MAX_CHARS。 */
  content: string;
  /** 归一化后的 0..1（07 §5.1）。**只有这个分能拿去和 RETRIEVAL_MIN_SCORE 比。** */
  score: number;
};

export type RetrievalFallback = "none" | "fts_only" | "empty";

export type RetrievalTimings = {
  /** "拿到查询向量"的耗时：含失败那次 embed 与兜底 hash 计算（降级时也照记，才看得出慢在哪）。 */
  embed_ms: number;
  vector_ms: number;
  fts_ms: number;
  /** 只测融合 + 后处理（07 §12 预算 ≤5ms），不含 DB 与网络。 */
  fuse_ms: number;
  total_ms: number;
};

export type RetrievalResult = {
  /** 真正送进检索的 query（可能已拼接上一轮，07 §3）。 */
  query: string;
  lang: string;
  /** 实际生效的语言视野，来自 LANG_SCOPE —— 排查"串语种"时第一眼看这个。 */
  lang_scope: readonly Lang[];
  chunks: RetrievedChunk[];
  /** 归一化后的最高分；`chunks` 为空时是 0。 */
  topScore: number;
  fallback: RetrievalFallback;
  timings: RetrievalTimings;
};

/**
 * 失败 → 降级标签。**降级必须同时被日志、响应体和测试看见**：
 * 吞掉错误却不改 `fallback`，故障表现就是"今天召回率莫名偏低"，谁也归因不了。
 * 导出它是为了让单测能直接断言映射表，而不是只能靠断网/杀库去复现。
 *
 * | 失败                                    | 返回/行为    | 为什么                                                  |
 * |-----------------------------------------|--------------|---------------------------------------------------------|
 * | `EmbedError("EMBED_TIMEOUT"/"UNAVAILABLE")` | `"fts_only"` | 换 hash 兜底向量继续跑，但语义召回已不可信              |
 * | `EmbedError("EMBED_DIM_MISMATCH")`      | **原样抛出**  | 维度不是降级：1024 的契约破裂必须炸（07 §9）            |
 * | PG 超时/连接失败/查询取消                 | `"empty"`    | 检索不可用 → 上层走拒答，别让 500 直接面对客户           |
 * | 其它异常                                 | `"empty"`    | 同上（标签口径）；见下：`retrieve` 并不采纳这个口径      |
 *
 * 为什么维度错误不能返回 `"empty"`：返回空等于告诉上层"确实没搜到"，
 * 于是一次数据事故（列维度与契约不一致）会被说成"这个客户问题没有语料"，永远没人修。
 *
 * 注意 `"empty"` 的口径比 `retrieve()` 实际采纳的更宽：`retrieve` 只对**数据库类**失败
 * 降级成空结果，其余未分类异常（例如 SQL 写错）继续上抛成 500，免得把 bug 藏进拒答话术。
 */
export function fallbackOf(err: unknown): RetrievalFallback {
  // 先判"不是降级"的一类，顺序不能反：放到最后就被 EmbedError 分支先吞掉了。
  if (isEmbedDimMismatch(err)) throw err;
  if (err instanceof EmbedError) return "fts_only";
  return "empty";
}

function isEmbedDimMismatch(err: unknown): boolean {
  return err instanceof EmbedError && err.code === "EMBED_DIM_MISMATCH";
}

/**
 * 数据库"不可用/超时"的判定（07 §9）。
 * 只认三类：查询被取消（`statement_timeout` → SQLSTATE `57014`）、服务端关连接（`57P0x`）、
 * 连接层失败（SQLSTATE `08xxx` 与 socket 错误码）。`timeout exceeded when trying to connect`
 * 是 node-postgres 连接池超时的原文（没有 code），只能按文案认。
 *
 * **刻意不认** `42P01`（表不存在）这类 SQL 错误：那是代码或迁移的 bug，把它降级成"没搜到"
 * 等于把事故藏进一段礼貌的拒答里，必须让它 500 并留日志。
 */
const DB_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  // 查询取消 / 服务端不可用 / 连接数耗尽
  "57014",
  "57P01",
  "57P02",
  "57P03",
  "53300",
  // class 08：连接异常
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  // socket 层
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

const POOL_CONNECT_TIMEOUT_TEXT = "timeout exceeded when trying to connect";

export function isDbUnavailable(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && DB_UNAVAILABLE_CODES.has(code)) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && message.includes(POOL_CONNECT_TIMEOUT_TEXT);
}

/**
 * topK 兜底：`slice(0, NaN)` 返回空数组，会让"少配了一个参数"静默变成"检索没结果"，
 * 所以非有限值/非正数一律回落到配置值而不是相信入参。
 */
function resolveTopK(topK: number | undefined): number {
  const configured = config.retrievalTopK;
  const value = topK === undefined ? configured : topK;
  if (!Number.isFinite(value) || value < 1) return Math.max(1, Math.floor(configured));
  return Math.floor(value);
}

/**
 * 截断按 UTF-16 码元（`slice`），不按码点切：调用方看到的是 `content.length`，
 * 用码点切会让"600 字"在 emoji/CJK 扩展区上悄悄变成 1200 个码元，长度契约随之失效。
 */
function truncateContent(content: string): string {
  return content.length > CONTENT_MAX_CHARS ? content.slice(0, CONTENT_MAX_CHARS) : content;
}

/**
 * 最终分 = 归一化 RRF × 余弦相似度²（07 §5.1 的勘误）。
 *
 * 为什么不能只用归一化 RRF：它是**纯排名**信号。向量路只要返回了行，第 1 名就存在，
 * 归一化必然给出 0.8（单路）或 1.0（两路都第一）—— 和问题相不相关完全无关。
 * 实测（同一份五语语料，见 07 §5.1 表）：`Wechselrichter Wirkungsgrad` 余弦 0.65、
 * `今天天气怎么样` 余弦 0.42，两条的归一化 RRF 都是 0.8，阈值 0.30 等于没有阈值。
 *
 * 为什么平方：多语嵌入的余弦有 ~0.4 的噪声地板（无关文本也能到 0.42–0.46），不压缩的话
 * "0.42 的无关" 与 "0.65 的相关" 只差 0.23；平方后变成 0.18 与 0.42，0.30 落在两者之间。
 * 这是**唯一一处分值整形**，理由写在 07 §5.1，改它必须同时改 14 §3 的断言。
 *
 * 余弦缺失（全文路独有片段）按 1 处理：字面命中精确术语本身就是相关，
 * 不能因为"没有向量"把它判成无关；这一条也让 `fallback="fts_only"` 时全文路仍然可用。
 */
function blendedScore(rawRrf: number, cosine: number | undefined, maxPossible?: number): number {
  const normalized = normalizeScore(rawRrf, maxPossible);
  if (cosine === undefined) return normalized;
  const similarity = Math.min(1, Math.max(0, cosine));
  return normalized * similarity * similarity;
}

/**
 * **纯函数**：融合 + 后处理（07 §5–§6）。不碰 DB、不碰网络，单测直接打这里。
 * 顺序不可调换，每一步都想清楚"换序会怎样"：
 *
 *   ① `rrf()`        带权 RRF（k=60、0.8/0.2）；常量在 fuse.ts，不在这里散落
 *   ② 归一化 + 相关性 归一化只表达"两路排名一致性"，**它没有绝对相关性含义**：
 *                     任何有向量命中的查询都排第一 → 归一化必得 0.8/1.0，
 *                     于是无关问题也是 0.8，"< 0.30 判无关"永远不成立（实测见 07 §5.1 的勘误）。
 *                     所以最终分 = 归一化 RRF × 余弦相似度²：RRF 决定两路证据是否一致，
 *                     相似度决定"到底像不像"。平方是因为多语嵌入有 ~0.4 的噪声地板
 *                     （实测无关问题 0.42–0.46、正例 0.65–0.77），平方把中低段压下去，
 *                     0.30 阈值才重新具备区分力。全文路独有的片段没有余弦，按 1 处理（字面命中即相关）。
 *   ③ 按分降序        并列时按 chunk_id 升序 —— 同一输入永远同一输出，否则测试会抖
 *   ④ 按 doc 去重     在**分数序**上数，所以留下的是这份文档最好的 3 条，不是前 3 条
 *   ⑤ 截断 600 字     放在去重之后：截断只影响下发，不影响排序
 *   ⑥ 取 topK         不足就按现有数量返回，**不补空**（补一条空片段等于伪造引用）
 *   ⑦ 分配 idx        1..n 连续，与正文 `[n]` 一一对应
 *
 * 阈值比较**不在这里**（07 §8、05 §5.1）：这里只产出最终分，比较是调用方的事。
 * 将来若有人想在这里加阈值，必须用这里算出的 `score`；用原始 RRF 分是必错——
 * 那是本卡最容易写反的一条规则。
 *
 * 与 07 §7 伪代码第 8 步的差异（有意为之）：伪代码先截"前 max(topK*3, 15) 条"再去重。
 * 两路合计最多 40 条候选，截前 15 条只会在"前 15 条全来自同一份文档"时反而丢掉
 * 本该去重后补位的其它文档片段。去重本身就是 O(n)，没必要先砍。
 */
export function fuseAndPostProcess(input: {
  vector: readonly RecalledChunk[];
  fts: readonly RecalledChunk[];
  topK?: number;
  /** 归一化分母；省略时由 fuse.ts 按上界公式算（`maxPossibleScore()`），不写魔数。 */
  maxPossible?: number;
}): { chunks: RetrievedChunk[]; topScore: number } {
  // 同一 chunk 可能两路都命中：元数据来自同一行 join 同一份 documents，取值必然一致，
  // 这里向量路优先、全文路只补缺，避免"后写覆盖前写"这种顺序敏感的隐蔽差异。
  const metaOf = new Map<number, RecalledChunk>();
  for (const row of input.vector) if (!metaOf.has(row.chunk_id)) metaOf.set(row.chunk_id, row);
  for (const row of input.fts) if (!metaOf.has(row.chunk_id)) metaOf.set(row.chunk_id, row);

  const fused = rrf({ vecRank: rankOf(input.vector), ftsRank: rankOf(input.fts) });

  // 余弦相似度只对"被向量路召回"的片段存在；全文路独有的片段没有相似度可言，
  // 按 1 处理（字面命中即相关，不能因为缺余弦就把精确术语命中判成无关）。
  const cosOf = new Map<number, number>();
  for (const row of input.vector) {
    if (!cosOf.has(row.chunk_id) && Number.isFinite(row.score)) cosOf.set(row.chunk_id, row.score);
  }

  const scored: { row: RecalledChunk; score: number }[] = [];
  for (const candidate of fused) {
    const row = metaOf.get(candidate.chunk_id);
    // 不可达：rrf 的 id 只来自两张 rank 表，而两张表都由上面两个数组生成。
    // 真出现了说明 fuse.ts 与本层的 id 口径已经不一致 —— 跳过，而不是编一条假片段。
    if (row === undefined) continue;
    scored.push({ row, score: blendedScore(candidate.score, cosOf.get(candidate.chunk_id), input.maxPossible) });
  }

  scored.sort((a, b) => b.score - a.score || a.row.chunk_id - b.row.chunk_id);

  const topK = resolveTopK(input.topK);
  const perDoc = new Map<string, number>();
  const chunks: RetrievedChunk[] = [];

  for (const item of scored) {
    if (chunks.length >= topK) break;
    const used = perDoc.get(item.row.doc_id) ?? 0;
    if (used >= MAX_PER_DOC) continue;
    perDoc.set(item.row.doc_id, used + 1);
    chunks.push({
      idx: chunks.length + 1,
      chunk_id: item.row.chunk_id,
      doc_id: item.row.doc_id,
      doc_title: item.row.doc_title,
      doc_lang: item.row.doc_lang,
      page: item.row.page,
      section: item.row.section,
      content: truncateContent(item.row.content),
      score: item.score,
    });
  }

  return { chunks, topScore: chunks[0]?.score ?? 0 };
}

/**
 * 完整检索（07 §7 的伪代码，顺序照抄）。
 *
 * 降级语义（本卡红线，07 §9）：
 *   - embed 失败（超时/不可用）→ 换 `hashEmbed` 继续跑，标 `fallback="fts_only"` 并 `logger.warn`
 *   - 数据库超时/不可用        → 返回空 + `fallback="empty"`（**不抛**：慢库不该变成用户看到的 500）
 *   - 两路都空                → `fallback="empty"`
 *   - 向量维度 ≠1024          → 抛出（不是降级，见 `fallbackOf` 的说明）
 *
 * 关于 `fts_only` 这个名字：降级时向量路**仍然会跑**（用 hash 兜底向量），
 * 标签描述的是"语义召回已经不可信、实际靠全文路兜住"，不是"把向量路关掉"。
 */
export async function retrieve(input: {
  query: string;
  lang: string;
  topK?: number;
  prevUser?: string;
}): Promise<RetrievalResult> {
  const started = performance.now();
  const timings: RetrievalTimings = { embed_ms: 0, vector_ms: 0, fts_ms: 0, fuse_ms: 0, total_ms: 0 };
  const scope = langScopeOf(input.lang);

  // 空结果只有一种构造方式：保证 `chunks/topScore/fallback` 永远配对，不会出现
  // "有 topScore 没 chunks"这种让上层阈值判断走岔的组合。
  const emptyResult = (q: string, fallback: RetrievalFallback, withTotal: boolean): RetrievalResult => {
    if (withTotal) timings.total_ms = roundMs(performance.now() - started);
    return { query: q, lang: input.lang, lang_scope: scope, chunks: [], topScore: 0, fallback, timings };
  };

  // ① 查询构建（07 §3）：只在当前问句过短/无实词时拼上一轮。不改写、不翻译。
  const q = buildQuery(input.query, input.prevUser);
  if (q.trim() === "") {
    // 空白查询连 embedding 都不值得发（07 §9）：前端就该拦住，这里是最后一道。
    // timings 保持全 0：什么都没跑，记 0 才看得懂"这是一次空转"。
    return emptyResult(q, "empty", false);
  }

  let fallback: RetrievalFallback = "none";
  let vector: RecalledChunk[] = [];
  let fts: RecalledChunk[] = [];

  try {
    await Promise.all([
      (async () => {
        const embedStarted = performance.now();
        let queryVector: number[];
        try {
          queryVector = await embed(q, "query");
        } catch (err) {
          // 只有 EmbedError 才可降级：`fallbackOf` 对维度错误原样抛出，
          // 对其它的非 EmbedError 返回 "empty" —— 那种情况不是"仅全文路"，上抛（→ 500）。
          if (fallbackOf(err) !== "fts_only") throw err;
          queryVector = hashEmbed(q);
          fallback = "fts_only";
          logger.warn(
            {
              err,
              code: err instanceof EmbedError ? err.code : "unknown",
              lang: input.lang,
              fallback: "fts_only",
            },
            "查询嵌入失败，降级为 hash 兜底向量并标记 fallback=fts_only（语义召回不可信，靠全文路兜住）",
          );
        }
        timings.embed_ms = roundMs(performance.now() - embedStarted);
        const vectorStarted = performance.now();
        vector = await recallVectorByEmbedding(queryVector, input.lang);
        timings.vector_ms = roundMs(performance.now() - vectorStarted);
      })(),
      (async () => {
        // 全文路不依赖 embedding，与向量路并行（07 §12 的预算按并行后的墙钟算）。
        const ftsStarted = performance.now();
        fts = await recallFts({ query: q, lang: input.lang });
        timings.fts_ms = roundMs(performance.now() - ftsStarted);
      })(),
    ]);
  } catch (err) {
    // 维度错误必须炸：静默返回空会把数据事故伪装成"没搜到"（07 §9）。
    if (isEmbedDimMismatch(err)) throw err;
    // 只降级"数据库不可用/超时"这一类；其它异常（SQL 写错等）继续上抛，交给统一错误处理器。
    if (!isDbUnavailable(err)) throw err;
    logger.warn(
      { err, lang: input.lang, fallback: "empty" },
      "检索数据库不可用或超时，返回空结果并标记 fallback=empty（上层据此拒答，不回 500）",
    );
    return emptyResult(q, "empty", true);
  }

  // ② 两路都空 == 没搜到：标签是 empty，不是 none（07 §9）。
  //    此前若降级过，"fts_only" 也让位给 "empty"：上层只需要知道"这条问题没法答"。
  if (vector.length === 0 && fts.length === 0) {
    return emptyResult(q, "empty", true);
  }

  // ③ 融合 + 后处理（预算 ≤5ms，只测这一段）。
  const fuseStarted = performance.now();
  const { chunks, topScore } = fuseAndPostProcess({ vector, fts, topK: input.topK });
  timings.fuse_ms = roundMs(performance.now() - fuseStarted);
  timings.total_ms = roundMs(performance.now() - started);

  return { query: q, lang: input.lang, lang_scope: scope, chunks, topScore, fallback, timings };
}
