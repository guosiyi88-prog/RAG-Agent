/**
 * 知识库数据通路（`09#05` · `.scratch/09-admin-console/issues/05-kb-crud.md` · `docs/prdv1.3/scope-delta.md` S5）。
 *
 * 一条真实通路：**新建/编辑正文 → 重建索引（切块 + embedding，异步）→ 失败可回滚 → 停用**。
 *
 * 三条口径，改之前先读：
 *
 *   1. **切块与嵌入不在这里重写**。`indexPages()`（`core/ingest.ts`）是唯一实现，目录入库与
 *      管理端重建走同一份 —— 两边各写一遍的那天，同一段正文会在两条路径上切出不同的块，
 *      而症状只是"检索质量莫名其妙差一点"（08-ingestion.md §5 的参数是常量，不是可调项）。
 *
 *   2. **重建要么整版生效，要么一个字节都不动**。"下一版"的片段先写进 `document_version_chunks`
 *      暂存，再在**同一个事务**里 `delete from chunks` + 装入新片段 + `version+1`。任何一步失败
 *      整体回滚，用户看到的还是旧索引（`status='failed'` + `err` 说明原因），不必"先删后建"
 *      承受中间态（08 §6 对目录入库允许失败留片段，是因为那些片段出自同一份文件；管理端这里
 *      改的是别人正在查的正文，半个库就是用户看到的错答案）。
 *
 *   3. **改正文不立刻换索引**：`PATCH` 只把 `status` 落回 `pending`，旧 chunks 原地不动，
 *      于是"改完还没重建"的那段时间里检索仍然命中旧正文（可解释），而不是命中半篇新半篇旧。
 *
 * 引用快照不受影响：`citations.chunk_id` 是 `on delete set null`，重建/回滚换了片段 id 之后
 * 快照字段（`doc_title` / `doc_lang` / `page` / `snippet`）仍在，历史回答里的角标照样点得开。
 * 这条链路的实现**不许**改成级联删（`sql/001_init.sql` 第 6 节）。
 */
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { one, query, tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { logger } from "../logger.ts";
import type { AdminActor } from "./admin-store.ts";
import type { Chunk, Lang } from "./chunk.ts";
import { toVectorLiteral } from "./embed.ts";
import { INSERT_BATCH_SIZE, IngestError, errorCodeOf, indexPages, splitPages } from "./ingest.ts";

/* ────────────────────────── 枚举与类型 ────────────────────────── */

/** 文档状态（`sql/001_init.sql` 第 1 节的 check 是第二道闸）。 */
export const KB_STATUS_VALUES = ["pending", "indexed", "failed", "archived"] as const;
export type KBDocumentStatus = (typeof KB_STATUS_VALUES)[number];

/** 重建任务的四个可见状态。`idle` 不是库里的取值：它表示"这篇文档从未重建过"。 */
export const KB_JOB_STATUS_VALUES = ["idle", "running", "succeeded", "failed"] as const;
export type KBJobStatus = (typeof KB_JOB_STATUS_VALUES)[number];

/**
 * 正文与标题的上限。**不是安全边界，是"别把 10MB 的 markdown 塞进一次 embedding"的成本边界**：
 * Fastify 的默认 bodyLimit 是 1MB，正文按 100k 字符封顶之后，最坏情况仍是一次几十批的
 * embedding 调用 —— 那已经是"异步任务"，不是"点一下保存"。
 */
export const KB_BODY_MAX_CHARS = 100_000;
export const KB_TITLE_MAX_CHARS = 200;

/**
 * 管理端录入的文档没有 MinIO 对象，`documents.object_key` 又不能为 NULL（既有 NOT NULL 约束，
 * 也是"同一 object_key 只有一个版本"那条入库口径的载体）。用 `kb:<uuid>` 前缀做占位：
 * 与语料相对路径（`warranty.zh.md`）不可能撞，看库时也一眼能认出"这篇不是从文件灌进来的"。
 */
export const KB_OBJECT_KEY_PREFIX = "kb:";

/** 列表行：不含正文（一篇 markdown 正文 × 一页 20 条是白搬的流量）。 */
export type KBDocumentSummary = {
  id: string;
  title: string;
  lang: Lang;
  productLine: string | null;
  status: KBDocumentStatus;
  chunkCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** 一次重建的句柄。字段名与 `api/admin-kb.ts` 出参一致（camelCase 在 core，下划线只在 HTTP）。 */
export type KBJob = {
  jobId: string | null;
  status: KBJobStatus;
  error: string | null;
  chunkCount: number | null;
  startedAt: string | null;
  finishedAt: string | null;
};

/** 详情 = 列表行 + 正文 + 最近一次重建的状态。 */
export type KBDocumentDetail = KBDocumentSummary & { body: string | null; rebuild: KBJob };

/**
 * 从未重建过的文档（语料目录灌进来的、或刚建还没点重建的）。
 * 每次返回一个新对象：这个结构会被塞进响应体，共用一个可变常量迟早被某处 `rebuild.xxx = ...` 污染。
 */
export function idleJob(): KBJob {
  return { jobId: null, status: "idle", error: null, chunkCount: null, startedAt: null, finishedAt: null };
}

type DocumentRow = {
  id: string;
  title: string;
  lang: Lang;
  product_line: string | null;
  body: string | null;
  status: KBDocumentStatus;
  chunk_count: number;
  version: number;
  pages: number | null;
  created_at: Date;
  updated_at: Date;
};

type JobRow = {
  id: string;
  status: "running" | "succeeded" | "failed";
  error: string | null;
  chunk_count: number | null;
  started_at: Date;
  finished_at: Date | null;
};

const DOCUMENT_COLUMNS = `id, title, lang, product_line, body, status, chunk_count, version, pages,
  created_at, updated_at`;

const JOB_COLUMNS = `id, status, error, chunk_count, started_at, finished_at`;

function toSummary(row: DocumentRow): KBDocumentSummary {
  return {
    id: row.id,
    title: row.title,
    lang: row.lang,
    productLine: row.product_line,
    status: row.status,
    chunkCount: row.chunk_count,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toJob(row: JobRow): KBJob {
  return {
    jobId: row.id,
    status: row.status,
    error: row.error,
    chunkCount: row.chunk_count,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at === null ? null : row.finished_at.toISOString(),
  };
}

/** 审计目标串：`document:<uuid>`。前缀让清理测试夹具与检索都不会撞别的表。 */
export function documentTarget(id: string): string {
  return `document:${id}`;
}

/* ────────────────────────── 小工具 ────────────────────────── */

/** 正文的内容 hash，落在 `documents.sha256`。与语料文件用的 sha256 是同一个列：它只是判重键。 */
function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 23505 = 唯一约束冲突。翻成 409 而不是让它变成 500（`sha256` 是 not null unique）。 */
function isUniqueViolation(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { code?: unknown }).code === "23505";
}

async function writeAudit(
  client: PoolClient,
  input: { action: string; target: string; actor: AdminActor; payload: Record<string, unknown> },
): Promise<void> {
  await client.query(`insert into audit_log (actor, action, target, payload) values ($1, $2, $3, $4::jsonb)`, [
    input.actor.staffName,
    input.action,
    input.target,
    // jsonb：`pg` 会把对象序列化成 Postgres 数组字面量，必须自己 JSON.stringify（同 admin-store）
    JSON.stringify(input.payload),
  ]);
}

/** 行锁读：判状态与写状态之间不留竞态（两个 admin 同时点重建/回滚时只有一个顺序）。 */
async function lockDocument(client: PoolClient, id: string): Promise<DocumentRow | null> {
  const result = await client.query<DocumentRow>(
    `select ${DOCUMENT_COLUMNS} from documents where id = $1 for update`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * 没有作业行、但索引是真的（`version > 0`）时，合成一条 `succeeded`。
 *
 * 什么时候会出现这种文档：**FAQ 审批**（`faq-store.ts` 的 `approveDraft`）走
 * `insertIndexedDocument`，在一个事务里直接写 `documents` + v1 快照 + 片段，**不落作业行** ——
 * 它没有"发起 → 轮询"这个过程，索引在请求里就算完了。
 *
 * 不合成的话，管理面板会对着一篇"已建索引 v1、1 个片段"的文档说"尚未重建：改动保存后要点重建"，
 * 而用户刚刚才看到它建好 —— 面板在撒谎，人只能怀疑索引没生效。
 *
 * `jobId: null` 是事实（确实没有作业行），不编一个 uuid 出来；时间戳取 `updated_at`
 * （写这篇文档的最后一次动作，对 FAQ 直通建索引来说就是索引落库的时刻）。
 */
function adoptedJob(doc: DocumentRow): KBJob {
  const stamp = doc.updated_at.toISOString();
  return {
    jobId: null,
    status: "succeeded",
    error: null,
    chunkCount: doc.chunk_count,
    startedAt: stamp,
    finishedAt: stamp,
  };
}

async function readLatestJob(client: PoolClient | undefined, doc: DocumentRow): Promise<KBJob> {
  const sql = `select ${JOB_COLUMNS} from document_rebuild_jobs
                where doc_id = $1
                order by started_at desc
                limit 1`;
  const row =
    client === undefined ? await one<JobRow>(sql, [doc.id]) : ((await client.query<JobRow>(sql, [doc.id])).rows[0] ?? null);
  if (row !== null) return toJob(row);
  return doc.version > 0 ? adoptedJob(doc) : idleJob();
}

function toDetail(row: DocumentRow, rebuild: KBJob): KBDocumentDetail {
  return { ...toSummary(row), body: row.body, rebuild };
}

/* ────────────────────────── 块写入（两条：线上 / 快照） ────────────────────────── */

/** 一版索引的直接产物：干净页数 + 块 + 每块的向量 + 该版的语言。 */
export type IndexedPages = {
  lang: Lang;
  pageCount: number;
  chunks: readonly Chunk[];
  vectors: readonly (readonly number[])[];
};

/**
 * 正文 → 一版索引（清洗 + 切块 + embedding）。**网络调用，必须在事务之外**：切块与嵌入失败时
 * 库里一个字节都不该动。
 *
 * 抽出来是为了让**第二条消费方**（FAQ 草稿审批，`core/faq-store.ts`）复用同一份口径：
 * 它要在一个事务里同时写 `documents` 与 `kb_drafts`，走不了 `createDocument` + 异步重建那条路。
 * 两条路径各写一遍切块参数，同一段答案会在两条入口上切成不同的块，症状只是"检索质量差一点"。
 */
export async function buildIndex(body: string, lang: Lang): Promise<IndexedPages> {
  const pages = splitPages(body);
  const result = await indexPages({ pages, lang });
  return { lang, pageCount: result.pageCount, chunks: result.chunks, vectors: result.vectors };
}

/**
 * 把**已经算好索引**的正文写成一篇可检索的文档：`documents` + 第一版快照 + 线上片段。
 *
 * 只给"新建即上线"的场景用（今天的唯一调用方是 FAQ 审批）。与 `writeVersion` 的区别是
 * 它不删旧片段、不碰版本号 —— 这篇文档在这一刻才诞生。
 *
 * 必须在调用方的事务里跑：FAQ 审批要保证"文档写进去了"与"草稿标成 approved"同生共死，
 * 否则失败重试会撞 `documents.sha256` 唯一约束，得到一个"草稿还没通过、正文已经在库里"的怪状态。
 */
export async function insertIndexedDocument(
  client: PoolClient,
  input: {
    id: string;
    title: string;
    lang: Lang;
    body: string;
    productLine: string | null;
    indexed: IndexedPages;
    actor: AdminActor;
    /** 审计 payload 里的来源标记（`faq` / `admin`…），只用于复盘"这篇从哪来"。 */
    source: string;
  },
): Promise<{ chunkCount: number; pages: number; firstChunkId: number | null }> {
  const { id, title, lang, body, productLine, indexed, actor, source } = input;
  const chunkCount = indexed.chunks.length;

  try {
    await client.query(
      `insert into documents
         (id, title, lang, product_line, object_key, sha256, body, status, version, chunk_count, pages)
       values ($1, $2, $3, $4, $5, $6, $7, 'indexed', 1, $8, $9)`,
      [id, title, lang, productLine, `${KB_OBJECT_KEY_PREFIX}${id}`, sha256Of(body), body, chunkCount, indexed.pageCount],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError("CONFLICT", "正文与已有文档完全相同（sha256 唯一）：这条答案已经进过索引了");
    }
    throw err;
  }

  // 第一版快照：留着它，将来"回滚到上一版"才有 409 而不是"回滚到不存在的版本"。
  await client.query(
    `insert into document_versions (doc_id, version, lang, title, pages, chunk_count)
     values ($1, 1, $2, $3, $4, $5)`,
    [id, lang, title, indexed.pageCount, chunkCount],
  );
  await insertSnapshotChunks(client, id, 1, indexed);
  await insertLiveChunks(client, id, indexed);

  const first = await client.query<{ id: string }>(
    `select id from chunks where doc_id = $1 order by seq asc limit 1`,
    [id],
  );
  const firstRow = first.rows[0];

  await writeAudit(client, {
    action: "document.create",
    target: documentTarget(id),
    actor,
    payload: {
      staff_id: actor.staffId,
      title,
      lang,
      product_line: productLine,
      status: "indexed",
      body_chars: body.length,
      chunk_count: chunkCount,
      source,
    },
  });

  return {
    chunkCount,
    pages: indexed.pageCount,
    firstChunkId: firstRow === undefined ? null : Number(firstRow.id),
  };
}

/**
 * 写 `chunks`：100 条一批 `insert ... select from unnest(...)`（与 `ingest.ts` 的批大小同源）。
 * `tsv` 是生成列，不许出现在 INSERT 列表里；`embedding` 必须走 `$n::vector`。
 *
 * 为什么不像回滚那样 `insert ... select from document_version_chunks` 直接搬：
 * 搬一份是"从快照恢复"（回滚），写一份是"用刚算出来的向量换上线"（重建）。
 * 两条路径共用一个函数，会让"重建其实是从快照搬的"这种误读有落脚点。
 */
async function insertLiveChunks(client: PoolClient, docId: string, indexed: IndexedPages): Promise<void> {
  const { chunks, vectors } = indexed;
  for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + INSERT_BATCH_SIZE);
    const batchVectors = vectors.slice(offset, offset + INSERT_BATCH_SIZE);
    await client.query(
      `insert into chunks (doc_id, seq, lang, section, content, page, token_len, embedding)
       select * from unnest($1::uuid[], $2::int[], $3::char(2)[], $4::text[],
                            $5::text[], $6::int[], $7::int[], $8::vector[])`,
      [
        batch.map(() => docId),
        batch.map((chunk) => chunk.seq),
        batch.map(() => indexed.lang),
        batch.map((chunk) => chunk.section),
        batch.map((chunk) => chunk.content),
        batch.map((chunk) => chunk.page),
        // 08 §4.4：token_len 用 length/3 估算，不做 tokenizer
        batch.map((chunk) => Math.ceil(chunk.content.length / 3)),
        batchVectors.map((vector) => toVectorLiteral(vector)),
      ],
    );
  }
}

async function insertSnapshotChunks(
  client: PoolClient,
  docId: string,
  version: number,
  indexed: IndexedPages,
): Promise<void> {
  const { chunks, vectors } = indexed;
  for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + INSERT_BATCH_SIZE);
    const batchVectors = vectors.slice(offset, offset + INSERT_BATCH_SIZE);
    await client.query(
      `insert into document_version_chunks
         (doc_id, version, seq, lang, section, content, page, token_len, embedding)
       select * from unnest($1::uuid[], $2::int[], $3::int[], $4::char(2)[], $5::text[],
                            $6::text[], $7::int[], $8::int[], $9::vector[])`,
      [
        batch.map(() => docId),
        batch.map(() => version),
        batch.map((chunk) => chunk.seq),
        batch.map(() => indexed.lang),
        batch.map((chunk) => chunk.section),
        batch.map((chunk) => chunk.content),
        batch.map((chunk) => chunk.page),
        batch.map((chunk) => Math.ceil(chunk.content.length / 3)),
        batchVectors.map((vector) => toVectorLiteral(vector)),
      ],
    );
  }
}

/* ────────────────────────── 读 ────────────────────────── */

export type KBDocumentListFilter = {
  /** `null` = 不筛（HTTP 层的 `status=all` 落在这里）。 */
  statuses: KBDocumentStatus[] | null;
  lang: Lang | null;
  productLine: string | null;
  page: number;
  size: number;
};

/**
 * 列表：**全部状态**（管理端要看见 pending / failed / archived 才能修）。
 *
 * `total` 与列表用**同一段 where**（两个口径分开算，翻到最后一页会发现总数比能翻到的行多），
 * 排序按 `updated_at desc` —— 管理端第一眼要看的是刚被改过的那几篇；同时间戳按 id 兜底，
 * 保证翻页时同一行不出现两次。
 */
export async function listDocuments(
  filter: KBDocumentListFilter,
): Promise<{ total: number; items: KBDocumentSummary[] }> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.statuses !== null) {
    params.push(filter.statuses);
    where.push(`status = any($${params.length}::text[])`);
  }
  if (filter.lang !== null) {
    params.push(filter.lang);
    where.push(`lang = $${params.length}::char(2)`);
  }
  if (filter.productLine !== null) {
    params.push(filter.productLine);
    where.push(`product_line = $${params.length}`);
  }
  const whereSql = where.length === 0 ? "" : `where ${where.join(" and ")}`;

  const totalRow = await one<{ n: string }>(`select count(*)::text as n from documents ${whereSql}`, params);
  const total = Number(totalRow?.n ?? "0");

  params.push(filter.size, (filter.page - 1) * filter.size);
  const rows = await query<DocumentRow>(
    `select ${DOCUMENT_COLUMNS}
       from documents
       ${whereSql}
      order by updated_at desc, id
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { total, items: rows.map(toSummary) };
}

/** 详情（含正文与最近一次重建状态）。不存在 → `null`（路由层翻 404）。 */
export async function getDocument(id: string): Promise<KBDocumentDetail | null> {
  const row = await one<DocumentRow>(`select ${DOCUMENT_COLUMNS} from documents where id = $1`, [id]);
  if (row === null) return null;
  return toDetail(row, await readLatestJob(undefined, row));
}

/**
 * 重建状态。文档不存在 → `null`（路由层翻 404，而不是给一个"idle"骗人：
 * 前端拿到 idle 会以为"这篇还没建过"，实际是"这篇不存在"）。
 */
export async function readRebuildStatus(id: string): Promise<KBJob | null> {
  const doc = await one<DocumentRow>(`select ${DOCUMENT_COLUMNS} from documents where id = $1`, [id]);
  if (doc === null) return null;
  return readLatestJob(undefined, doc);
}

/* ────────────────────────── 写 ────────────────────────── */

/**
 * 新建：落 `pending` + `version = 0`（**待重建**）。
 *
 * 不在这一步顺手建索引：一次 POST 里做完切块与 embedding 会把它变成"最长可能跑几十秒的
 * 写请求"，而前端要的是"存下来了，正在建"这两个明确的状态。所以新建之后必须点重建
 * （`POST .../rebuild`），或者等第一次重建由前端自动触发。
 *
 * `sha256`（正文 hash）冲突 → **409 `CONFLICT`**：请求本身没错，是同一份正文已经在库里了。
 * 不静默复用那一行 —— 那会让"我新建了一篇"与"我改的还是原来那篇"变成同一件事。
 */
export async function createDocument(input: {
  title: string;
  lang: Lang;
  body: string;
  productLine: string | null;
  actor: AdminActor;
}): Promise<KBDocumentDetail> {
  const { title, lang, body, productLine, actor } = input;
  const id = randomUUID();

  return tx(async (client) => {
    try {
      await client.query(
        `insert into documents (id, title, lang, product_line, object_key, sha256, body, status, version)
         values ($1, $2, $3, $4, $5, $6, $7, 'pending', 0)`,
        [id, title, lang, productLine, `${KB_OBJECT_KEY_PREFIX}${id}`, sha256Of(body), body],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError("CONFLICT", "正文与已有文档完全相同（sha256 唯一）：请去编辑那一篇，而不是再建一份");
      }
      throw err;
    }

    const row = await lockDocument(client, id);
    if (row === null) throw new AppError("INTERNAL", "文档新建后读不回来");

    await writeAudit(client, {
      action: "document.create",
      target: documentTarget(id),
      actor,
      // payload 只记状态与字段名/长度，不记正文 —— 审计表保留两年，往里塞整篇 markdown 就是
      // "另存一份用户内容"（与 admin-store 的 PII 口径一致）。
      payload: {
        staff_id: actor.staffId,
        title,
        lang,
        product_line: productLine,
        status: "pending",
        body_chars: body.length,
      },
    });

    return toDetail(row, idleJob());
  });
}

/**
 * 编辑（`admin` 起）。
 *
 * **改 `body` 或 `lang` 就把 `status` 落回 `pending`**，`version` 不动：
 *   - 旧 chunks 原地留着 → 重建之前检索仍然命中旧正文（可解释的中间态）；
 *   - `pending` 是前端"该点重建了"的信号（与新建同一种状态，前端只有一条提示逻辑）。
 * 只改标题/产品线不需要重建（标题是从 `documents` join 出来显示的，不进向量）。
 *
 * 已停用（`archived`）→ 409：停用态的定义是"这篇只做历史留档"。
 * 一个字都没改 → 不写库、不写审计（`changed: []`，双击保存不该留一条空流水）。
 */
export async function updateDocument(input: {
  id: string;
  title?: string;
  body?: string;
  lang?: Lang;
  productLine?: string | null;
  actor: AdminActor;
}): Promise<{ document: KBDocumentDetail; changed: string[] }> {
  const { id, title, body, lang, productLine, actor } = input;

  return tx(async (client) => {
    const before = await lockDocument(client, id);
    if (before === null) throw new AppError("NOT_FOUND", "文档不存在");
    if (before.status === "archived") {
      throw new AppError("CONFLICT", "已停用的文档不能再修改（停用只做历史留档）");
    }

    const changed: string[] = [];
    const sets: string[] = [];
    const params: unknown[] = [id];

    const push = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (title !== undefined && title !== before.title) {
      push("title", title);
      changed.push("title");
    }
    if (lang !== undefined && lang !== before.lang) {
      push("lang", lang);
      changed.push("lang");
    }
    if (productLine !== undefined && productLine !== before.product_line) {
      push("product_line", productLine);
      changed.push("product_line");
    }
    if (body !== undefined && body !== before.body) {
      push("body", body);
      // sha256 跟着正文走：它是判重键，不跟着改的话"两篇内容相同的文档"会带着不同的 hash 并存
      push("sha256", sha256Of(body));
      changed.push("body");
    }

    // 正文或语言变了 → 索引过期。旧片段不清（见函数头），只把状态落回 pending。
    if (changed.includes("body") || changed.includes("lang")) {
      // `err` 说的是**上一份**正文的失败原因，留着会让人以为新正文也坏了
      sets.push("err = null");
      if (before.status !== "pending") {
        sets.push(`status = 'pending'`);
        changed.push("status");
      }
    }

    if (changed.length === 0) {
      return { document: toDetail(before, await readLatestJob(client, before)), changed };
    }

    sets.push("updated_at = now()");
    try {
      await client.query(`update documents set ${sets.join(", ")} where id = $1`, params);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError("CONFLICT", "改后的正文与另一篇文档完全相同（sha256 唯一）");
      }
      throw err;
    }

    const after = await lockDocument(client, id);
    if (after === null) throw new AppError("INTERNAL", "文档更新后读不回来");

    await writeAudit(client, {
      action: "document.update",
      target: documentTarget(id),
      actor,
      payload: {
        staff_id: actor.staffId,
        changed,
        // 只记状态与长度，不记正文
        before: { status: before.status, version: before.version, body_chars: before.body?.length ?? 0 },
        after: { status: after.status, version: after.version, body_chars: after.body?.length ?? 0 },
      },
    });

    return { document: toDetail(after, await readLatestJob(client, after)), changed };
  });
}

/**
 * 发起重建：**落一行 `running` 的 job 就返回**（HTTP 202），真正的切块/嵌入在后台跑。
 *
 * 为什么不阻塞：一篇 100k 字的文档要几十批 embedding 调用（10 条一批、每批 15s 超时），
 * 把它挂在请求上等于让"点保存"变成一个可能超时的长请求，而前端本来就要显示进度。
 *
 * `job_id` 是这次重建的句柄：`GET .../rebuild` 读**最近一条** job（`started_at desc`），
 * 于是"这次"与"上一次"永远可区分 —— 失败之后重试时，前端要能看见失败的是哪一次、错在哪。
 *
 * 同一篇文档并发两次重建不会互相踩：事务里 `for update` 锁行，两次 `version+1` 各自串行，
 * 最终库里是后完成的那一版（中间那版也留在快照里，可回滚）。
 */
export async function startRebuild(input: { id: string; actor: AdminActor }): Promise<{ jobId: string; status: "running" }> {
  const { id, actor } = input;
  const jobId = randomUUID();

  await tx(async (client) => {
    const current = await lockDocument(client, id);
    if (current === null) throw new AppError("NOT_FOUND", "文档不存在");
    if (current.status === "archived") {
      throw new AppError("CONFLICT", "已停用的文档不能重建（停用只做历史留档，恢复不在本期范围）");
    }
    await client.query(`insert into document_rebuild_jobs (id, doc_id) values ($1, $2)`, [jobId, id]);
    await writeAudit(client, {
      action: "document.rebuild",
      target: documentTarget(id),
      actor,
      payload: {
        staff_id: actor.staffId,
        job_id: jobId,
        from_version: current.version,
        status: current.status,
      },
    });
  });

  // 不 await（契约：202 不阻塞）。异常只进日志：状态机已经把失败落进 job 行，
  // 日志是为了留住"为什么"（错误码之外还有 SQL/网络细节）。
  void runRebuild({ docId: id, jobId }).catch((err: unknown) => {
    logger.error({ err, docId: id, jobId }, "重建索引的后台任务异常退出");
  });

  return { jobId, status: "running" };
}

/** 重建的后台体（`startRebuild` 里 fire-and-forget）。两步：算向量（网络） → 一个事务换索引。 */
async function runRebuild(input: { docId: string; jobId: string }): Promise<void> {
  const { docId, jobId } = input;

  let indexed: IndexedPages;
  try {
    const doc = await one<{ lang: Lang; body: string | null }>(
      `select lang, body from documents where id = $1`,
      [docId],
    );
    if (doc === null) throw new IngestError("internal_error", "文档不存在");
    // 正文可以是 NULL（语料目录灌进来的），也可以是空串（历史数据）—— 两者都建不出索引。
    // 这里刻意**不**做"空正文就 400"的前置校验：失败要能被看见（status=failed + err），
    // 而不是让接口假装拒绝一次合法请求。
    if (doc.body === null || doc.body.trim() === "") {
      throw new IngestError("empty_after_clean", "正文为空，切不出任何片段");
    }
    // 切块 + 嵌入只有一份实现（`buildIndex`），FAQ 审批走的是同一个函数。
    indexed = await buildIndex(doc.body, doc.lang);
  } catch (err) {
    await finishFailed({ docId, jobId, code: errorCodeOf(err), message: err });
    return;
  }

  try {
    const version = await writeVersion(docId, indexed);
    await query(
      `update document_rebuild_jobs set status = 'succeeded', chunk_count = $2, finished_at = now()
        where id = $1`,
      [jobId, indexed.chunks.length],
    );
    logger.info({ docId, jobId, version, chunks: indexed.chunks.length }, "重建索引完成");
  } catch (err) {
    await finishFailed({ docId, jobId, code: "db_failed", message: err });
  }
}

/**
 * 换索引的**那一个事务**：先写"下一版"快照，再整体替换 `chunks`，最后 `version+1` + `indexed`。
 *
 * 顺序不能换：快照先落，事务里失败就一起回滚 —— 不会出现"线上换了索引、快照没写下来"
 * （那样下一次回滚会退到一版根本不存在的快照）。`delete from chunks` 在事务内做，
 * 一旦后续任何一步抛错，Postgres 会把删除一起回滚，`chunks` 一个字节都不动。
 *
 * `where ... and status <> 'archived'`：重建期间有人点了停用 → 更新命中 0 行 → 抛错回滚。
 * 停用是终态，不该被一个已经在跑的后台任务悄悄翻回 `indexed`。
 */
async function writeVersion(docId: string, indexed: IndexedPages): Promise<number> {
  return tx(async (client) => {
    const locked = await client.query<{ version: number; title: string }>(
      `select version, title from documents where id = $1 for update`,
      [docId],
    );
    const row = locked.rows[0];
    if (row === undefined) throw new AppError("NOT_FOUND", "文档不存在");
    const version = row.version + 1;

    // 回滚之后再重建会撞上同一个版本号（回滚走的是 version-1），先把同号快照清掉。
    // 快照的语义是"这一版的索引"，重建出来的当然是新的一份。
    await client.query(`delete from document_version_chunks where doc_id = $1 and version = $2`, [docId, version]);
    await client.query(`delete from document_versions where doc_id = $1 and version = $2`, [docId, version]);
    await client.query(
      `insert into document_versions (doc_id, version, lang, title, pages, chunk_count)
       values ($1, $2, $3, $4, $5, $6)`,
      [docId, version, indexed.lang, row.title, indexed.pageCount, indexed.chunks.length],
    );
    await insertSnapshotChunks(client, docId, version, indexed);

    await client.query(`delete from chunks where doc_id = $1`, [docId]);
    await insertLiveChunks(client, docId, indexed);

    const updated = await client.query(
      `update documents
          set version = $2, status = 'indexed', chunk_count = $3, pages = $4, err = null, updated_at = now()
        where id = $1 and status <> 'archived'`,
      [docId, version, indexed.chunks.length, indexed.pageCount],
    );
    if (updated.rowCount === 0) throw new AppError("CONFLICT", "重建期间文档被停用，本次结果已丢弃");

    return version;
  });
}

/**
 * 失败收尾（**事务之外**）：job 落 `failed` + error 码，文档落 `failed` + err。
 *
 * 为什么在事务外：`writeVersion` 的失败意味着那个事务整个回滚了 —— 连"记下失败"也要跟着回滚，
 * 那就没人知道刚才失败过。所以失败状态由事务外的两条 update 写，`chunks` / `version` /
 * `chunk_count` 保持失败前的值（契约：与失败前完全一致）。
 */
async function finishFailed(input: {
  docId: string;
  jobId: string;
  code: string;
  message: unknown;
}): Promise<void> {
  const { docId, jobId, code, message } = input;
  logger.error(
    { docId, jobId, code, message: message instanceof Error ? message.message : String(message) },
    "重建索引失败（旧索引保持不变）",
  );
  // 先写**文档**，再写**作业**：作业行是轮询句柄，客户端一看到 `failed` 就会去读文档状态 ——
  // 反过来写的话，那一瞬间文档还是 `pending`，测试（和人）会看到"作业失败但文档没失败"，
  // 只能靠再等一会儿才自洽。终态最后落，读的顺序就等于写的顺序。
  // `where status <> 'archived'`：停用是终态，失败只是"这次没建成"，不该把停用翻回来。
  await query(
    `update documents set status = 'failed', err = $2, updated_at = now()
      where id = $1 and status <> 'archived'`,
    [docId, code],
  );
  await query(
    `update document_rebuild_jobs set status = 'failed', error = $2, finished_at = now() where id = $1`,
    [jobId, code],
  );
}

/**
 * 回滚到上一版索引（`version - 1`）。
 *
 * 回滚**不是**"再切一次块"：把 `document_version_chunks` 里那一版原样装回 `chunks`
 * （向量逐位相同），于是回滚之后检索到的就是当时那一版。没有上一版 → 409 `CONFLICT`
 * （状态不允许这个动作，不是请求写错了）。
 *
 * 恢复的是**索引**（version / chunk_count / pages / status），不是文档的 title/body/lang：
 * 那三样是"这篇文档现在是什么"，不是"某一版索引有多长"。改了语言又回滚的话，片段语言仍是
 * 旧那版的 —— 这种情况本来就该重建（`PATCH` 已经把它置回 `pending`），不是回滚能解决的。
 */
export async function rollbackDocument(input: {
  id: string;
  actor: AdminActor;
}): Promise<{ document: KBDocumentDetail; changed: string[] }> {
  const { id, actor } = input;

  return tx(async (client) => {
    const current = await lockDocument(client, id);
    if (current === null) throw new AppError("NOT_FOUND", "文档不存在");
    if (current.status === "archived") {
      throw new AppError("CONFLICT", "已停用的文档不能回滚（停用只做历史留档）");
    }

    const target = current.version - 1;
    if (target < 1) {
      throw new AppError("CONFLICT", "没有可回滚的版本（这篇文档还没有成功重建过两版以上）");
    }
    const snapshot = await client.query<{ chunk_count: number; pages: number | null }>(
      `select chunk_count, pages from document_versions where doc_id = $1 and version = $2`,
      [id, target],
    );
    const snap = snapshot.rows[0];
    if (snap === undefined) {
      throw new AppError("CONFLICT", `没有可回滚的版本（v${target} 的索引快照不存在）`);
    }

    // 先删后插：`citations.chunk_id` 是 `on delete set null`，旧引用会变成"有快照、无锚点"，
    // 历史回答照常能打开（`sql/001_init.sql` 第 6 节，绝不许改成 cascade）
    await client.query(`delete from chunks where doc_id = $1`, [id]);
    await client.query(
      `insert into chunks (doc_id, seq, lang, section, content, page, token_len, embedding)
       select doc_id, seq, lang, section, content, page, token_len, embedding
         from document_version_chunks
        where doc_id = $1 and version = $2`,
      [id, target],
    );

    await client.query(
      `update documents
          set version = $2, status = 'indexed', chunk_count = $3, pages = $4, err = null, updated_at = now()
        where id = $1`,
      [id, target, snap.chunk_count, snap.pages],
    );

    const after = await lockDocument(client, id);
    if (after === null) throw new AppError("INTERNAL", "回滚后读不回来");

    await writeAudit(client, {
      action: "document.rollback",
      target: documentTarget(id),
      actor,
      payload: {
        staff_id: actor.staffId,
        from_version: current.version,
        to_version: target,
        chunk_count: snap.chunk_count,
      },
    });

    return { document: toDetail(after, await readLatestJob(client, after)), changed: ["version", "status", "chunkCount"] };
  });
}

/**
 * 停用（`admin` 起）：**只改 `status`，不删行、不删片段**。
 *
 * 为什么不删片段：`citations.chunk_id` 会因此全部悬空（可接受），但重建/回滚都还要读那一版，
 * 而且"删掉"之后想把这篇重新放回来就只剩重新录入一条路。检索侧靠
 * `d.status <> 'archived'`（`core/retrieval.ts` 的两条召回 SQL）排除停用文档 ——
 * 停用是一次可逆的状态迁移，不是一次数据删除。
 *
 * 已停用 → 200 且 `changed: []`（幂等：双击"停用"不该报错）。
 */
export async function archiveDocument(input: {
  id: string;
  actor: AdminActor;
}): Promise<{ document: KBDocumentDetail; changed: string[] }> {
  const { id, actor } = input;

  return tx(async (client) => {
    const current = await lockDocument(client, id);
    if (current === null) throw new AppError("NOT_FOUND", "文档不存在");
    if (current.status === "archived") {
      return { document: toDetail(current, await readLatestJob(client, current)), changed: [] };
    }

    await client.query(`update documents set status = 'archived', updated_at = now() where id = $1`, [id]);
    const after = await lockDocument(client, id);
    if (after === null) throw new AppError("INTERNAL", "停用后读不回来");

    await writeAudit(client, {
      action: "document.archive",
      target: documentTarget(id),
      actor,
      payload: {
        staff_id: actor.staffId,
        changed: ["status"],
        before: { status: current.status },
        after: { status: "archived" },
        kept_chunks: current.chunk_count,
      },
    });

    return { document: toDetail(after, await readLatestJob(client, after)), changed: ["status"] };
  });
}
