/**
 * 未命中池 → FAQ 草稿 → 审批入索引（A5；`docs/prdv1.2/01-scope.md` 的「未命中池转 FAQ」）。
 *
 * 这条链路的三段分别落在这里：
 *
 *   1. **未命中池**（`v_no_hit` 视图，`sql/001_init.sql`）：哪些问题反复没答案、已经起过几份草稿。
 *      视图从第一版建表起就在，但一直没有消费者 —— 这正是 `core/admin-store.ts` 里 R26 警告的
 *      "有数据、没消费，一个月后就是第二个死池子"。本文件是它的第一个消费者。
 *   2. **草稿**（`kb_drafts` 表）：一线坐席在工单详情里把"AI 答不出、人工已答"的问题写成草稿。
 *   3. **审批入索引**：`lead` 驳回、`admin` 通过；通过时**同步**切块 + embedding + 写 `chunks`
 *      （复用 `kb-store.ts` 的 `buildIndex` / `insertIndexedDocument`，切块参数只有一份），
 *      于是"下次同类问题 AI 直接答得出"是这一条动作的结果，不是另一次 `make ingest`。
 *
 * 三条口径，改之前先读：
 *
 *   - **审批是全有或全无**：embedding 在事务外算（网络），写库在**同一张事务**里做
 *     （`documents` + 第一版快照 + `chunks` + `kb_drafts.status/reviewer/chunk_id`）。
 *     任何一步失败整体回滚，草稿仍是 `draft`，重试不会留下"正文在库里、草稿没通过"的孤儿。
 *   - **审计不存正文**：`audit_log` 保留两年，问题原文与答案都是用户内容，只记长度、语言与 id
 *     （与 `admin-store` / `ticket-queue` 的 PII 口径一致）。
 *   - **状态机只有一处**：`draft → approved | rejected`，两个终态互斥；重复通过是空操作
 *     （`changed: []`，不重复建文档），驳回后再通过是 409。
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { one, query, tx } from "../db.ts";
import { AppError } from "../errors.ts";
import type { AdminActor } from "./admin-store.ts";
import type { Lang } from "./chunk.ts";
import { IngestError } from "./ingest.ts";
import {
  KB_TITLE_MAX_CHARS,
  buildIndex,
  insertIndexedDocument,
  type IndexedPages,
} from "./kb-store.ts";

/* ────────────────────────── 枚举与上限 ────────────────────────── */

/** `kb_drafts.status` 的三个取值（`sql/001_init.sql` 的 check 是第二道闸）。 */
export const FAQ_STATUS_VALUES = ["draft", "approved", "rejected"] as const;
export type FaqStatus = (typeof FAQ_STATUS_VALUES)[number];

/** `kb_drafts.source` 的三个取值。本文件只写 `ticket`（工单转）与 `no_hit`（未命中池转）。 */
export const FAQ_SOURCE_VALUES = ["no_hit", "manual", "ticket"] as const;
export type FaqSource = (typeof FAQ_SOURCE_VALUES)[number];

/**
 * 长度上限。**不是安全边界，是成本边界**：答案会在审批时被切块并送进 embedding，
 * 4000 字已经覆盖一份完整答复；再长就该写成知识库文档（`/api/admin/documents`），
 * 那一条走的是异步重建，不必挂在一次"点通过"上。
 */
export const FAQ_QUESTION_MAX_CHARS = 500;
export const FAQ_ANSWER_MIN_CHARS = 10;
export const FAQ_ANSWER_MAX_CHARS = 4000;

/** 草稿列表与未命中池的分页口径（与 `QUEUE_PAGE_SIZE_*` 同值，前端算页数才对得上）。 */
export const FAQ_PAGE_SIZE_DEFAULT = 20;
export const FAQ_PAGE_SIZE_MAX = 100;
/** 未命中池默认只看前 20 条：它是"这周该补什么"的清单，不是一份全量报表。 */
export const FAQ_NO_HIT_LIMIT_DEFAULT = 20;
export const FAQ_NO_HIT_LIMIT_MAX = 100;

/* ────────────────────────── 类型 ────────────────────────── */

type DraftRow = {
  id: string;
  question: string;
  answer: string;
  lang: Lang;
  source: string;
  status: FaqStatus;
  reviewer: string | null;
  reviewer_name: string | null;
  chunk_id: string | null;
  created_at: Date;
};

/** HTTP 侧的形状（`reviewer` 给姓名，`reviewer_id` 给 uuid —— 与工单列表的 assignee 同口径）。 */
export type FaqDraft = {
  id: number;
  question: string;
  answer: string;
  lang: Lang;
  source: FaqSource;
  status: FaqStatus;
  reviewer: string | null;
  reviewer_id: string | null;
  chunk_id: number | null;
  created_at: string;
};

/** `v_no_hit` 的一行：**问题 + 语言**就是它的键（视图按这两列分组）。 */
export type NoHitItem = {
  question: string;
  lang: string | null;
  hits: number;
  last_at: string;
  draft_count: number;
};

const DRAFT_COLUMNS = `d.id, d.question, d.answer, d.lang, d.source, d.status, d.reviewer,
  s.name as reviewer_name, d.chunk_id, d.created_at`;

function toDraft(row: DraftRow): FaqDraft {
  return {
    id: Number(row.id),
    question: row.question,
    answer: row.answer,
    lang: row.lang,
    source: row.source as FaqSource,
    status: row.status,
    reviewer: row.reviewer_name,
    reviewer_id: row.reviewer,
    chunk_id: row.chunk_id === null ? null : Number(row.chunk_id),
    created_at: row.created_at.toISOString(),
  };
}

/** 审计目标串：`faq_draft:<id>`。前缀让"清测试夹具"与工单的 `WT-…` 不会撞。 */
export function draftTarget(id: number | string): string {
  return `faq_draft:${id}`;
}

async function writeAudit(
  client: PoolClient,
  input: { action: string; target: string; actor: AdminActor; payload: Record<string, unknown> },
): Promise<void> {
  await client.query(`insert into audit_log (actor, action, target, payload) values ($1, $2, $3, $4::jsonb)`, [
    input.actor.staffName,
    input.action,
    input.target,
    // jsonb：`pg` 会把对象序列化成 Postgres 数组字面量，必须自己 JSON.stringify（同 kb-store）
    JSON.stringify(input.payload),
  ]);
}

async function readDraft(id: number, client?: PoolClient): Promise<DraftRow | null> {
  const sql = `select ${DRAFT_COLUMNS}
                 from kb_drafts d
                 left join staff s on s.id = d.reviewer
                where d.id = $1`;
  if (client === undefined) return one<DraftRow>(sql, [id]);
  const result = await client.query<DraftRow>(sql, [id]);
  return result.rows[0] ?? null;
}

/* ────────────────────────── 未命中池 ────────────────────────── */

/**
 * 未命中池前 N 条。`v_no_hit` 已经把"同一个问题在同一语言下被问过几次"聚合好了，
 * 这里只加一个上限（列表必须有上限，G5）与类型转换。
 *
 * `hits` / `draft_count` 在视图里是 `count(*)`（int8），`pg` 会当**字符串**交出来 ——
 * 不 `::int` 的话前端拿到 `"12"` 去做 `> 1` 比较是隐式的，`+` 会变成字符串拼接。
 */
export async function listNoHit(limit: number): Promise<NoHitItem[]> {
  const rows = await query<{
    question: string;
    lang: string | null;
    hits: number;
    last_at: Date;
    draft_count: number;
  }>(
    `select question,
            lang,
            hits::int         as hits,
            last_at,
            draft_count::int  as draft_count
       from v_no_hit
      order by hits desc, last_at desc
      limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    question: row.question,
    lang: row.lang,
    hits: row.hits,
    last_at: row.last_at.toISOString(),
    draft_count: row.draft_count,
  }));
}

/* ────────────────────────── 草稿：读 ────────────────────────── */

export type DraftListFilter = {
  /** `null` = 不筛（HTTP 层不给 `status` 时）。 */
  statuses: FaqStatus[] | null;
  page: number;
  size: number;
};

/**
 * 草稿列表。`total` 与列表共用**同一段 where**（两个口径分开算，翻到最后一页会发现总数比能翻到的多）。
 * 排序 `created_at desc`：这是待办队列，最新的在最上面；同一秒建的两条按 id 兜底，翻页才不会重复。
 */
export async function listDrafts(filter: DraftListFilter): Promise<{ total: number; items: FaqDraft[] }> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter.statuses !== null) {
    params.push(filter.statuses);
    where.push(`d.status = any($${params.length}::text[])`);
  }
  const whereSql = where.length === 0 ? "" : `where ${where.join(" and ")}`;

  const totalRow = await one<{ n: string }>(`select count(*)::text as n from kb_drafts d ${whereSql}`, params);
  const total = Number(totalRow?.n ?? "0");

  params.push(filter.size, (filter.page - 1) * filter.size);
  const rows = await query<DraftRow>(
    `select ${DRAFT_COLUMNS}
       from kb_drafts d
       left join staff s on s.id = d.reviewer
       ${whereSql}
      order by d.created_at desc, d.id desc
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { total, items: rows.map(toDraft) };
}

/* ────────────────────────── 草稿：写 ────────────────────────── */

/**
 * 建一份草稿（`agent` 起）。
 *
 * 同一个问题 + 同一种语言只允许有一份**未驳回**的草稿：
 *   - 两份待审草稿会让审批的人分不清该看哪一份，而两份都通过就是 `chunks` 里两条近重复片段
 *     （检索时互相挤占 top-k）；
 *   - 唯一的例外是"上一份被驳回"：那是"再试一次"，必须允许。
 *
 * 冲突回 409 `CONFLICT`（请求形状没问题，是这条数据已经在库里），而不是静默复用那一行 ——
 * 静默复用会让"我新建了一份"与"我改的还是原来那份"变成同一件事。
 */
export async function createDraft(input: {
  question: string;
  answer: string;
  lang: Lang;
  source: FaqSource;
  actor: AdminActor;
}): Promise<FaqDraft> {
  const { question, answer, lang, source, actor } = input;

  return tx(async (client) => {
    const existing = await client.query<{ id: string; status: string }>(
      `select id, status from kb_drafts
        where question = $1 and lang = $2::char(2) and status <> 'rejected'
        limit 1`,
      [question, lang],
    );
    const clash = existing.rows[0];
    if (clash !== undefined) {
      throw new AppError(
        "CONFLICT",
        `这个问题已经有${clash.status === "approved" ? "通过" : "待审"}的草稿（id=${clash.id}），不必重复提交`,
      );
    }

    const inserted = await client.query<{ id: string }>(
      `insert into kb_drafts (question, answer, lang, source, status)
       values ($1, $2, $3::char(2), $4, 'draft')
       returning id`,
      [question, answer, lang, source],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new AppError("INTERNAL", "草稿新建后读不回来");

    await writeAudit(client, {
      action: "faq_draft.create",
      target: draftTarget(id),
      actor,
      // 只记形状与长度，不记正文（问题原文与答案都是用户内容）。
      payload: {
        staff_id: actor.staffId,
        lang,
        source,
        question_chars: question.length,
        answer_chars: answer.length,
      },
    });

    const row = await readDraft(Number(id), client);
    if (row === null) throw new AppError("INTERNAL", "草稿新建后读不回来");
    return toDraft(row);
  });
}

/** `IngestError` → HTTP 语义。空正文是调用方的错（400），嵌入挂了是外部依赖（503），其余算内部错误。 */
function indexErrorOf(err: unknown): unknown {
  if (!(err instanceof IngestError)) return err;
  if (err.code === "empty_after_clean") {
    return new AppError("VALIDATION", "答案太短（或全是页眉页脚），切不出任何片段");
  }
  if (err.code.startsWith("embed_")) {
    return new AppError("EMBED_UNAVAILABLE", `嵌入服务不可用（${err.code}），本次审批未生效，请稍后重试`);
  }
  return new AppError("INTERNAL", `入库失败（${err.code}）`);
}

/**
 * 审批通过（`admin` 起）：把答案切块 + embedding 写进 `chunks`，草稿转 `approved`。
 *
 * 顺序是刻意的：**先在事务外算索引**（网络失败时不碰库）→ 再进一个事务（锁草稿 → 复查状态 →
 * 写文档 → 改草稿 → 审计）。锁草稿是为了两个人同时点"通过"时只有一个真的建文档，
 * 另一个看到的是 `changed: []`（状态已经是 approved）。
 *
 * 幂等：已经通过 → 原样返回 + `changed: []`，**不重复建文档**（那会撞 sha256 唯一约束 409）。
 * 已驳回 → 409：驳回的语义是"这条不该出现在知识里"，想改主意就重新建一份（留痕清楚）。
 */
export async function approveDraft(input: {
  id: number;
  actor: AdminActor;
}): Promise<{ draft: FaqDraft; changed: string[] }> {
  const { id, actor } = input;

  const current = await readDraft(id);
  if (current === null) throw new AppError("NOT_FOUND", "草稿不存在");
  if (current.status === "approved") return { draft: toDraft(current), changed: [] };
  if (current.status === "rejected") {
    throw new AppError("CONFLICT", "已驳回的草稿不能通过；请重新提交一份新草稿");
  }

  // 问题**进正文首行**，不只是进标题：检索只搜 `chunks.content`，标题不参与召回 ——
  // 不把问句写进正文，用户原话里那些"答案没提到的词"（图示 / 并网点 / 三相四线）
  // 就只能靠语义向量兜，而 FTS 那一路永远命不中。
  const body = `${current.question}\n\n${current.answer}`;

  let indexed: IndexedPages;
  try {
    // 切块与嵌入必须基于**同一份正文**（含问题）：chunks 是 body 的派生物，
    // 两边不一致的那天，"重建"与"审批"会给出两个不同的索引。
    indexed = await buildIndex(body, current.lang);
  } catch (err) {
    throw indexErrorOf(err);
  }

  const docId = randomUUID();
  const title = `FAQ: ${current.question}`.slice(0, KB_TITLE_MAX_CHARS);

  return tx(async (client) => {
    const locked = await client.query<{ status: string }>(
      `select status from kb_drafts where id = $1 for update`,
      [id],
    );
    const status = locked.rows[0]?.status;
    if (status === undefined) throw new AppError("NOT_FOUND", "草稿不存在");
    if (status === "approved") {
      const row = await readDraft(id, client);
      if (row === null) throw new AppError("INTERNAL", "草稿读不回来");
      return { draft: toDraft(row), changed: [] };
    }
    if (status === "rejected") {
      throw new AppError("CONFLICT", "已驳回的草稿不能通过；请重新提交一份新草稿");
    }

    const inserted = await insertIndexedDocument(client, {
      id: docId,
      title,
      lang: current.lang,
      body,
      productLine: null,
      indexed,
      actor,
      source: "faq",
    });

    await client.query(
      `update kb_drafts
          set status = 'approved', reviewer = $2::uuid, chunk_id = $3
        where id = $1`,
      [id, actor.staffId, inserted.firstChunkId],
    );

    await writeAudit(client, {
      action: "faq_draft.approve",
      target: draftTarget(id),
      actor,
      payload: {
        staff_id: actor.staffId,
        lang: current.lang,
        document_id: docId,
        chunk_count: inserted.chunkCount,
      },
    });

    const row = await readDraft(id, client);
    if (row === null) throw new AppError("INTERNAL", "审批后读不回来");
    return { draft: toDraft(row), changed: ["status", "reviewer", "chunk_id"] };
  });
}

/**
 * 驳回（`lead` 起）：只改状态与审批人，**不删行、不碰索引**。
 *
 * 幂等：已经驳回 → `changed: []`。已通过 → 409：通过之后再驳回，索引里那条片段不会自己消失，
 * 想让答案下线该走「知识库」面板的停用（那才是"这篇不再参与检索"的动作）。
 */
export async function rejectDraft(input: {
  id: number;
  actor: AdminActor;
}): Promise<{ draft: FaqDraft; changed: string[] }> {
  const { id, actor } = input;

  return tx(async (client) => {
    const locked = await client.query<{ status: string }>(
      `select status from kb_drafts where id = $1 for update`,
      [id],
    );
    const status = locked.rows[0]?.status;
    if (status === undefined) throw new AppError("NOT_FOUND", "草稿不存在");
    if (status === "approved") {
      throw new AppError("CONFLICT", "已通过的草稿不能驳回；如需下线答案，请到「知识库」停用那一篇");
    }
    if (status === "rejected") {
      const row = await readDraft(id, client);
      if (row === null) throw new AppError("INTERNAL", "草稿读不回来");
      return { draft: toDraft(row), changed: [] };
    }

    await client.query(`update kb_drafts set status = 'rejected', reviewer = $2::uuid where id = $1`, [
      id,
      actor.staffId,
    ]);
    await writeAudit(client, {
      action: "faq_draft.reject",
      target: draftTarget(id),
      actor,
      payload: { staff_id: actor.staffId, from_status: status },
    });

    const row = await readDraft(id, client);
    if (row === null) throw new AppError("INTERNAL", "驳回后读不回来");
    return { draft: toDraft(row), changed: ["status", "reviewer"] };
  });
}
