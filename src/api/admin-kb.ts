/**
 * 知识库管理接口（`09#05` · `.scratch/09-admin-console/issues/05-kb-crud.md` · `docs/prdv1.3/scope-delta.md` S5）。
 *
 *   GET    /api/admin/documents                    文档列表（全部状态 + 筛选 + 分页）        `lead`
 *   GET    /api/admin/documents/:id                详情（正文 + 最近一次重建状态）            `lead`
 *   POST   /api/admin/documents                    新建（落 pending，待重建）                 `admin`
 *   PATCH  /api/admin/documents/:id                编辑（改正文/语言 → 落回 pending）         `admin`
 *   POST   /api/admin/documents/:id/rebuild        发起重建（202 + job_id，后台跑）           `admin`
 *   GET    /api/admin/documents/:id/rebuild        重建状态（轮询句柄；从未重建 → idle）      `lead`
 *   POST   /api/admin/documents/:id/rollback       回滚到上一版索引                            `admin`
 *   POST   /api/admin/documents/:id/archive        停用（只改 status，不删行、不删片段）      `admin`
 *
 * **角色只从表里取**：`minRoleOf()` 现查 `src/api/roles.ts` 的 `ROUTE_MIN_ROLE`，
 * 路由里没有第二份 `"lead"` / `"admin"` 字面量（与 `api/admin.ts` 同一套做法）。
 * 这里那几个小函数是 `api/admin.ts` 里同名函数的**逐字副本**：本卡不允许改那个文件
 * （`09#04` 的卡片与本卡并行落地），所以先把口径复制一份，等两边都收口再抽到 `api/guard.ts`。
 * 副本的语义与原件完全一致：先认证（401）后授权（403），两件事都在解析 body 之前。
 *
 * 为什么 `POST .../rebuild` 返回 202 而不是 200：切块 + embedding 是**后台任务**，
 * 请求里能确定的只有"这次重建已经受理"（`running` + job_id），成功与否要轮询
 * `GET .../rebuild`。返回 200 会让前端把"受理"读成"建好了"。
 *
 * 本文件只做传输层：鉴权 → 入参形状 → 调 `core/kb-store.ts` → 统一信封。
 * 状态机（pending/indexed/failed/archived 的迁移）、重建/回滚的事务边界、审计留痕都在 core。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { actorOf, guard, minRoleOf, requireBodyRecord } from "./admin-guard.ts";
import { LANGUAGES, type Lang } from "../core/chunk.ts";
import {
  KB_BODY_MAX_CHARS,
  KB_STATUS_VALUES,
  KB_TITLE_MAX_CHARS,
  archiveDocument,
  createDocument,
  getDocument,
  listDocuments,
  readRebuildStatus,
  rollbackDocument,
  startRebuild,
  updateDocument,
  type KBDocumentDetail,
  type KBDocumentListFilter,
  type KBDocumentStatus,
  type KBDocumentSummary,
  type KBJob,
} from "../core/kb-store.ts";
import { QUEUE_PAGE_SIZE_DEFAULT, QUEUE_PAGE_SIZE_MAX } from "../core/ticket-queue.ts";
import { AppError } from "../errors.ts";
import { PAGE_MAX, firstString, parseEnumList, parseIntInRange } from "./params.ts";

/**
 * 路径常量：注册用的字面量与 `ROUTE_MIN_ROLE` 查表用的**是同一个变量** ——
 * 两处各写一遍字符串，改一个漏一个时查表会 miss。
 */
const ROUTES = {
  documents: "/api/admin/documents",
  document: "/api/admin/documents/:id",
  rebuild: "/api/admin/documents/:id/rebuild",
  rollback: "/api/admin/documents/:id/rollback",
  archive: "/api/admin/documents/:id/archive",
} as const;

/** `documents.id` 是 uuid。形状不对就不进 SQL（`'abc'` 进查询会变成 22P02 的 500）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 与 `api/admin.ts` / `api/fault.ts` 同一口径（表里最长是 `residential`，11 字符）。 */
const MAX_PRODUCT_LINE_CHARS = 32;

/* ────────────────────────── 入参 ────────────────────────── */

/** 路径里的 id：形状不对按 **404** 处理（前端列表里的 id 失效时该刷新，不是该重试）。 */
function parseDocumentId(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!UUID_RE.test(value)) throw new AppError("NOT_FOUND", "文档不存在");
  return value;
}

function parseTitle(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION", "title 必须是字符串");
  const title = raw.trim();
  if (title === "") throw new AppError("VALIDATION", "title 不能为空");
  if (title.length > KB_TITLE_MAX_CHARS) {
    throw new AppError("VALIDATION", `title 最多 ${KB_TITLE_MAX_CHARS} 字符`);
  }
  return title;
}

/** 正文。**允许空白但要拦下来**：空正文建不出索引，让它进库只会在重建时变成一条 failed。 */
function parseBody(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION", "body 必须是字符串（markdown 正文）");
  if (raw.trim() === "") throw new AppError("VALIDATION", "body 不能为空");
  if (raw.length > KB_BODY_MAX_CHARS) {
    throw new AppError("VALIDATION", `body 最多 ${KB_BODY_MAX_CHARS} 字符`);
  }
  return raw;
}

/** 语言：只认五语（`chunks.lang` 的 check 是第二道闸，但 400 比 500 有用）。 */
function parseLang(raw: unknown): Lang {
  if (typeof raw !== "string" || !(LANGUAGES as readonly string[]).includes(raw)) {
    throw new AppError("VALIDATION", `lang 取值必须是 ${LANGUAGES.join("|")}`);
  }
  return raw as Lang;
}

/** 产品线：`undefined` = 没给（不筛/不改），`null` = 显式清空。 */
function parseProductLine(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new AppError("VALIDATION", "product_line 必须是字符串或 null");
  const value = raw.trim();
  if (value === "") return null;
  if (value.length > MAX_PRODUCT_LINE_CHARS) {
    throw new AppError("VALIDATION", `product_line 超过 ${MAX_PRODUCT_LINE_CHARS} 字符`);
  }
  return value;
}

/**
 * 列表筛选。`status` 默认 `all`（管理端的默认视图是"全部状态"，因为待办往往是
 * pending / failed 那几篇 —— 与坐席队列"默认只看待处理"的取值不同，这里是修语料的面板）。
 *
 * 枚举一律 400（`status=indxed` 静默忽略会让管理员以为筛过了，实际看到的是全部）。
 * 允许逗号多选：`status=pending,failed` 是"待办的两类"，比连查两次少一次往返。
 */
function parseDocumentQuery(raw: unknown): KBDocumentListFilter {
  const source = (raw ?? {}) as Record<string, unknown>;

  const statuses = parseEnumList(
    firstString(source.status),
    [...KB_STATUS_VALUES, "all"] as const,
    "status",
  );
  const statusFilter: KBDocumentStatus[] | null =
    statuses === null || statuses.includes("all") ? null : (statuses.filter((s) => s !== "all") as KBDocumentStatus[]);

  const rawLang = (firstString(source.lang) ?? "").trim();
  const lang = rawLang === "" ? null : parseLang(rawLang);

  const rawProductLine = (firstString(source.product_line) ?? "").trim();
  if (rawProductLine.length > MAX_PRODUCT_LINE_CHARS) {
    throw new AppError("VALIDATION", `product_line 超过 ${MAX_PRODUCT_LINE_CHARS} 字符`);
  }

  return {
    statuses: statusFilter,
    lang,
    productLine: rawProductLine === "" ? null : rawProductLine,
    page: parseIntInRange(firstString(source.page), "page", 1, 1, PAGE_MAX),
    size: parseIntInRange(firstString(source.size), "size", QUEUE_PAGE_SIZE_DEFAULT, 1, QUEUE_PAGE_SIZE_MAX),
  };
}

/* ────────────────────────── 出参 ────────────────────────── */

/**
 * 文档行一律 camelCase（与 `admin-store.ts` 的出参风格一致）。
 *
 * **重建任务那一块用 snake_case**：`job_id` / `chunk_count` / `started_at` / `finished_at` 是
 * 工单 05 里冻结的字段名（前端 B 正在按它写轮询），而它不是"文档行"，是另一个资源
 * （`document_rebuild_jobs` 一行）。两套命名并存看着不整齐，但改哪个都会打断已经写好的半边。
 */
function jobBody(job: KBJob): Record<string, unknown> {
  return {
    job_id: job.jobId,
    status: job.status,
    error: job.error,
    chunk_count: job.chunkCount,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
  };
}

function summaryBody(document: KBDocumentSummary): Record<string, unknown> {
  return {
    id: document.id,
    title: document.title,
    lang: document.lang,
    productLine: document.productLine,
    status: document.status,
    chunkCount: document.chunkCount,
    version: document.version,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

/** 详情带正文与重建状态；列表不带（一篇 markdown × 一页 20 条是白搬的流量）。 */
function detailBody(document: KBDocumentDetail): Record<string, unknown> {
  return { ...summaryBody(document), body: document.body, rebuild: jobBody(document.rebuild) };
}

/* ────────────────────────── 路由 ────────────────────────── */

export async function registerAdminKbRoutes(app: FastifyInstance): Promise<void> {
  app.get(ROUTES.documents, async (request, reply) => {
    await guard(request, "GET", ROUTES.documents);
    const filter = parseDocumentQuery(request.query);
    const { total, items } = await listDocuments(filter);
    return reply.code(200).send({
      ok: true,
      data: { items: items.map(summaryBody), page: filter.page, size: filter.size, total },
    });
  });

  app.get<{ Params: { id?: unknown } }>(ROUTES.document, async (request, reply) => {
    await guard(request, "GET", ROUTES.document);
    const id = parseDocumentId(request.params.id);
    const document = await getDocument(id);
    if (document === null) throw new AppError("NOT_FOUND", "文档不存在");
    return reply.code(200).send({ ok: true, data: detailBody(document) });
  });

  // 新建 → **201**（这条请求真的产生了一个新资源，与"发布/归档"那类状态迁移不同）。
  app.post(ROUTES.documents, async (request, reply) => {
    const principal = await guard(request, "POST", ROUTES.documents);
    const body = requireBodyRecord(request);
    const document = await createDocument({
      title: parseTitle(body.title),
      lang: parseLang(body.lang),
      body: parseBody(body.body),
      productLine: body.product_line === undefined ? null : parseProductLine(body.product_line),
      actor: actorOf(principal),
    });
    return reply.code(201).send({ ok: true, data: detailBody(document) });
  });

  app.patch<{ Params: { id?: unknown } }>(ROUTES.document, async (request, reply) => {
    const principal = await guard(request, "PATCH", ROUTES.document);
    const id = parseDocumentId(request.params.id);
    const body = requireBodyRecord(request);

    const title = body.title === undefined ? undefined : parseTitle(body.title);
    const content = body.body === undefined ? undefined : parseBody(body.body);
    const lang = body.lang === undefined ? undefined : parseLang(body.lang);
    const productLine = body.product_line === undefined ? undefined : parseProductLine(body.product_line);

    // 一个可识别字段都没有就 400（与 `api/admin.ts` 的补丁同口径）：一次拼错字段名的保存
    // 如果被当成成功，管理员看到的是"点了没反应"，而他以为已经改完了。
    if (title === undefined && content === undefined && lang === undefined && productLine === undefined) {
      throw new AppError("VALIDATION", "至少提供 title / body / lang / product_line 之一（重建与停用各有一个端点）");
    }

    const { document, changed } = await updateDocument({ id, title, body: content, lang, productLine, actor: actorOf(principal) });
    return reply.code(200).send({ ok: true, data: { document: detailBody(document), changed } });
  });

  // 202：受理即返回，成功与否看 `GET .../rebuild`。不读 body（没有任何参数能影响结果）。
  app.post<{ Params: { id?: unknown } }>(ROUTES.rebuild, async (request, reply) => {
    const principal = await guard(request, "POST", ROUTES.rebuild);
    const id = parseDocumentId(request.params.id);
    const { jobId, status } = await startRebuild({ id, actor: actorOf(principal) });
    return reply.code(202).send({ ok: true, data: { job_id: jobId, status } });
  });

  // 轮询句柄。`lead` 也能读：主管要看得见"这篇为什么还是 failed"，而修不修是 admin 的事。
  app.get<{ Params: { id?: unknown } }>(ROUTES.rebuild, async (request, reply) => {
    await guard(request, "GET", ROUTES.rebuild);
    const id = parseDocumentId(request.params.id);
    const job = await readRebuildStatus(id);
    if (job === null) throw new AppError("NOT_FOUND", "文档不存在");
    return reply.code(200).send({ ok: true, data: jobBody(job) });
  });

  app.post<{ Params: { id?: unknown } }>(ROUTES.rollback, async (request, reply) => {
    const principal = await guard(request, "POST", ROUTES.rollback);
    const id = parseDocumentId(request.params.id);
    const { document } = await rollbackDocument({ id, actor: actorOf(principal) });
    return reply.code(200).send({ ok: true, data: detailBody(document) });
  });

  app.post<{ Params: { id?: unknown } }>(ROUTES.archive, async (request, reply) => {
    const principal = await guard(request, "POST", ROUTES.archive);
    const id = parseDocumentId(request.params.id);
    const { document } = await archiveDocument({ id, actor: actorOf(principal) });
    return reply.code(200).send({ ok: true, data: detailBody(document) });
  });
}
