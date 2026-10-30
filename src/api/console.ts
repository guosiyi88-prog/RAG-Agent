/**
 * 坐席端 HTTP 接口（`05-api.md` §4.1–§4.3 + §2 端点表第 8–15 行、`11-ui-console.md`）。
 *
 *   GET   /api/console/tickets        队列（筛选 / 分页 / 已升级置顶 + SLA 排序）
 *   GET   /api/console/tickets/:id    详情（工单 + 会话 + 消息 + 引用 + 无证据标记）
 *   PATCH /api/console/tickets/:id    认领 / 关单 / 回填结论
 *   POST  /api/console/tickets/:id/escalate  转 L2（状态 → escalated、tags += escalate）
 *   GET   /api/console/stats          真实聚合（工单数 / 拒答率 / 平均 SLA 剩余；口径 = `exclude_demo` + `window`）
 *                                     另带 `reports`（new / 24h 新增 / 合并率，`09#04` / R26 —— 固定全量，见该处理器注释）
 *   POST  /api/console/draft          转 FAQ 草稿（A5：写一条 `kb_drafts` 待审）
 *   GET   /api/console/drafts         草稿列表（按状态筛、分页）
 *   POST  /api/console/drafts/:id/approve   通过审批（`admin`；同步切块入索引）
 *   POST  /api/console/drafts/:id/reject    驳回（`lead`）
 *   GET   /api/console/no-hit         未命中池（`v_no_hit` 前 N 条，`lead` 起）
 *   POST  /api/console/translate|export     预留：固定 501
 *
 * 本文件只做**传输层**：鉴权 → 入参形状 → 调 `core/ticket-queue.ts` → 套统一信封。
 * 四条判定不在这里：状态机与不可变性（`guard_ticket_status` 触发器 + core 的 409 翻译）、
 * 认领时"我"是谁（`requireAdmin`）、可见性与派发权限（core 的 403，`09#03` 第三段 +
 * `09#04` 收口 —— 读路径与写路径同一口径）、聚合口径（SQL）。
 * 路由层再判一遍就会出现两份口径，而"已关单能不能改"这种判断分叉的后果是历史被改掉。
 *
 * 鉴权一律 `requireAdmin`（`src/auth.ts`，07#01 收敛、`09#03` 切成服务端会话）：
 * **不在这里写任何凭据比较**。它读 `x-staff-session` 并返回 `{ staffId, staffName, role, email }`，
 * 没票据 / 票据失效一律 401 `AUTH_REQUIRED`（旧的共享令牌已退场，见 boundary-change-R2 §3 B5）。
 * 拿到身份后，`role` 只**传给 core**：队列可见性与派发权限都由 `core/ticket-queue.ts` 判
 * （`09#03` 第三段）。本文件不写第二份角色判断 —— 两处各判一半，将来多一个入口就漏一处。
 * 三个业务端点 + stats + 三个预留端点全部在解析 body 之**前**先过会话 —— 未授权的请求
 * 不该有机会触发任何校验分支（每一个分支都是一次可以观察的信息泄露面）。
 *
 * 日志口径：本文件**不记**问题原文、`q` 的取值、结论内容与邮箱（`logger` 只在这一层之外
 * 被 core 用于"触发器拦下更新"这一类事实）。错误体由 `errors.ts` 统一产出，不带堆栈。
 */
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth.ts";
import { actorOf, guard } from "./admin-guard.ts";
import { readFaultLangHistogram, readFaultReportCounts } from "../core/admin-store.ts";
import { LANGUAGES, type Lang } from "../core/chunk.ts";
import {
  FAQ_ANSWER_MAX_CHARS,
  FAQ_ANSWER_MIN_CHARS,
  FAQ_NO_HIT_LIMIT_DEFAULT,
  FAQ_NO_HIT_LIMIT_MAX,
  FAQ_PAGE_SIZE_DEFAULT,
  FAQ_PAGE_SIZE_MAX,
  FAQ_QUESTION_MAX_CHARS,
  FAQ_STATUS_VALUES,
  approveDraft,
  createDraft,
  listDrafts,
  listNoHit,
  rejectDraft,
  type DraftListFilter,
  type FaqStatus,
  type FaqSource,
} from "../core/faq-store.ts";
import { isUuid, type TicketReason } from "../core/ticket-store.ts";
import {
  QUEUE_PAGE_SIZE_DEFAULT,
  QUEUE_PAGE_SIZE_MAX,
  QUEUE_Q_MAX_CHARS,
  RESOLUTION_MAX_CHARS,
  RESOLUTION_MIN_CHARS,
  SERIES_WINDOW_VALUES,
  STATS_WINDOW_VALUES,
  TICKET_REASON_VALUES,
  TICKET_STATUS_VALUES,
  type QueueFilter,
  type SeriesWindow,
  type StatsFilter,
  type StatsWindow,
  type TicketPatch,
  type TicketStatus,
  assertTicketVisible,
  escalateTicket,
  getTicketDetail,
  listTickets,
  readStats,
  readTicketAssignee,
  readTicketSeries,
  updateTicket,
} from "../core/ticket-queue.ts";
import { AppError } from "../errors.ts";
// 列表入参的统一解析（`09#04` 从本文件搬到 `api/params.ts`）：管理端要"复用 console 的 page 口径"，
// 两份实现迟早会漂。搬走的是逐字原样，行为零变化。
import { PAGE_MAX, firstString, parseEnumList, parseIntInRange } from "./params.ts";

/**
 * 工单 id 的形状（`bigserial` 的十进制表示）。
 *
 * 形状不对不进 SQL：`tickets.id` 是 bigint，拿 `"abc"` 去查会得到 22P02 的 500。
 * 但错误也不回 400 —— URL 里的 id 来自前端的锚点 `#/ticket/<id>`，一个贴错/失效的 id
 * 对坐席的意思就是"这单没了"，`NOT_FOUND` 是唯一对得上这个场景的回答（05 §4.2）。
 */
const TICKET_ID_RE = /^\d{1,18}$/;

/**
 * 本文件注册的路由（`guard()` 要按 `"METHOD /原始路径"` 去 `ROUTE_MIN_ROLE` 里查最低角色，
 * 键必须与注册时逐字一致）。写成常量而不是散落的字符串：`roles.ts` 那张表、这里的注册、
 * 前端三处引用同一个路径，改名字时只该改一处。
 */
const ROUTES = {
  tickets: "/api/console/tickets",
  ticket: "/api/console/tickets/:id",
  escalate: "/api/console/tickets/:id/escalate",
  stats: "/api/console/stats",
  draft: "/api/console/draft",
  drafts: "/api/console/drafts",
  draftApprove: "/api/console/drafts/:id/approve",
  draftReject: "/api/console/drafts/:id/reject",
  noHit: "/api/console/no-hit",
} as const;

function parseQueueQuery(raw: unknown): QueueFilter {
  const source = (raw ?? {}) as Record<string, unknown>;

  // 默认 `null`（= 除 closed 之外的全部），而不是显式三个状态的数组：默认视图的意义是
  // "待处理"，将来加一个中间状态时它应该自动出现在这里，不该被一个白名单藏起来。
  const statuses = parseEnumList(firstString(source.status), TICKET_STATUS_VALUES, "status");
  const reasons = parseEnumList<TicketReason>(firstString(source.reason), TICKET_REASON_VALUES, "reason");

  const rawQ = firstString(source.q);
  const trimmedQ = rawQ === null ? "" : rawQ.trim();
  if (trimmedQ.length > QUEUE_Q_MAX_CHARS) {
    throw new AppError("VALIDATION", `q 最多 ${QUEUE_Q_MAX_CHARS} 字符`);
  }

  return {
    statuses,
    reasons,
    // 空白 `q` 等价于没给：`%   %` 在 ilike 里能匹配一堆含空格的单，那不是坐席的意图。
    q: trimmedQ === "" ? null : trimmedQ,
    page: parseIntInRange(firstString(source.page), "page", 1, 1, PAGE_MAX),
    size: parseIntInRange(firstString(source.size), "size", QUEUE_PAGE_SIZE_DEFAULT, 1, QUEUE_PAGE_SIZE_MAX),
  };
}

/**
 * 看板口径的入参（`09#01`）：`exclude_demo` 默认 `true`、`window` 默认 `all`。
 *
 * 取值不对就 400，**不静默回落成默认值**。这条与 `parseQueueQuery` 里"超界夹住"的取舍不同，
 * 理由也不同：`size=1000` 夹住是因为"我全都要"这个意图明确，而 `window=month` / `exclude_demo=yes`
 * 表达的是一个**本接口不支持**的口径 —— 静默按默认值返回，坐席会以为自己在看"本月"的数字，
 * 而卡片上的数其实是全时段的。看板的每个数字都要能回答"这是哪段时间"，猜错一次就是一次误判。
 *
 * 空串（`?window=`、`?exclude_demo=`）当"没给"：前端清空筛选时发的是空值，它的意图确实是默认口径，
 * 这与"拼错的取值"是两件不同的事。重复的同名参数取第一个（与其它端点同口径）。
 */
function parseStatsQuery(raw: unknown): StatsFilter {
  const source = (raw ?? {}) as Record<string, unknown>;

  const trimmedWindow = (firstString(source.window) ?? "").trim();
  let window: StatsWindow = "all";
  if (trimmedWindow !== "") {
    if (!(STATS_WINDOW_VALUES as readonly string[]).includes(trimmedWindow)) {
      throw new AppError(
        "VALIDATION",
        `window 取值必须是 ${STATS_WINDOW_VALUES.join("|")}，收到 "${trimmedWindow}"`,
      );
    }
    window = trimmedWindow as StatsWindow;
  }

  const rawDemo = (firstString(source.exclude_demo) ?? "").trim();
  let excludeDemo = true;
  if (rawDemo !== "") {
    // 大小写不敏感（`TRUE` 与 `true` 意思一样，没必要为一个字母回 400），但 `1` / `yes` 一律不认：
    // 它们不是这个接口的取值，认了就等于又造一套隐性口径。
    const lowered = rawDemo.toLowerCase();
    if (lowered !== "true" && lowered !== "false") {
      throw new AppError("VALIDATION", `exclude_demo 取值必须是 true|false，收到 "${rawDemo}"`);
    }
    excludeDemo = lowered === "true";
  }

  return { excludeDemo, window };
}

/**
 * 字符数按**码点**数，不用 `String.length`。
 *
 * 前端 `src/static/lib/console-resolution.js` 的 `charCount()` 用的就是 `Array.from(...).length`，
 * 两处口径必须一致：`String.length` 数的是 UTF-16 码元，一个 emoji 算 2，于是"前端说还差 1 字、
 * 后端说够了"会出现在关单这条最关键的操作上。断言在 `tests/console-api.test.ts`。
 */
function charCount(value: string): number {
  return Array.from(value).length;
}

function parseTicketId(raw: unknown): number {
  const value = typeof raw === "string" ? raw : "";
  if (!TICKET_ID_RE.test(value)) throw new AppError("NOT_FOUND", "工单不存在");
  return Number(value);
}

/* ────────────────────────── FAQ 草稿的入参 ────────────────────────── */

/** `kb_drafts.id` 的形状（bigserial，与工单 id 同一套判法）。 */
const DRAFT_ID_RE = /^\d{1,18}$/;

/** 草稿 id 不合法 → 404（理由同 `parseTicketId`：路径里的 id 失效的意思是"这条没了"）。 */
function parseDraftId(raw: unknown): number {
  const value = typeof raw === "string" ? raw : "";
  if (!DRAFT_ID_RE.test(value)) throw new AppError("NOT_FOUND", "草稿不存在");
  return Number(value);
}

function parseLangField(raw: unknown): Lang {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!(LANGUAGES as readonly string[]).includes(value)) {
    throw new AppError("VALIDATION", `lang 取值必须是 ${LANGUAGES.join("|")}`);
  }
  return value as Lang;
}

/** 一段"必填文本"：trim 之后按**码点**数上限（与 `charCount` 同口径）。 */
function parseText(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION", `${field} 必填且必须是字符串`);
  const trimmed = raw.trim();
  const length = charCount(trimmed);
  if (length < min) throw new AppError("VALIDATION", `${field} 至少 ${min} 字`);
  if (length > max) throw new AppError("VALIDATION", `${field} 最多 ${max} 字`);
  return trimmed;
}

/**
 * 转 FAQ 草稿的入参。
 *
 * `ticket_id` 可选，但它的作用是**来源留痕**：给了就写 `source='ticket'`，不给就是 `no_hit`
 * （从未命中池直接起稿）。给了就必须是一张真实存在的工单 —— 一个不存在的 id 被静默写进
 * `source='ticket'` 会让"这条答案是从哪来的"在复盘时变成一句假话。
 */
function parseDraftBody(body: unknown): {
  question: string;
  answer: string;
  lang: Lang;
  source: FaqSource;
  ticketId: number | null;
} {
  const payload = (() => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError("VALIDATION", "body 必须是 JSON 对象");
    }
    return body as Record<string, unknown>;
  })();
  const question = parseText(payload.question, "question", 1, FAQ_QUESTION_MAX_CHARS);
  const answer = parseText(payload.answer, "answer", FAQ_ANSWER_MIN_CHARS, FAQ_ANSWER_MAX_CHARS);
  const lang = parseLangField(payload.lang);

  const rawTicket = payload.ticket_id;
  if (rawTicket === undefined || rawTicket === null) {
    return { question, answer, lang, source: "no_hit", ticketId: null };
  }
  const asText = typeof rawTicket === "number" ? String(rawTicket) : rawTicket;
  if (typeof asText !== "string" || !TICKET_ID_RE.test(asText)) {
    throw new AppError("VALIDATION", "ticket_id 必须是工单号（数字）");
  }
  return { question, answer, lang, source: "ticket", ticketId: Number(asText) };
}

/** 草稿列表的查询串。`status` 缺省 = 不筛（面板自己发 `status=draft`）。 */
function parseDraftQuery(raw: unknown): DraftListFilter {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    statuses: parseEnumList<FaqStatus>(firstString(source.status), FAQ_STATUS_VALUES, "status"),
    page: parseIntInRange(firstString(source.page), "page", 1, 1, PAGE_MAX),
    size: parseIntInRange(firstString(source.size), "size", FAQ_PAGE_SIZE_DEFAULT, 1, FAQ_PAGE_SIZE_MAX),
  };
}

/**
 * 补丁入参（05 §4.3）。字段全可选，但至少一个；未识别的字段**忽略而不报错**
 * （前端可能顺手带上 `id` / `trace_id`），不过"一个可识别字段都没有"必须是 400，
 * 否则一次拼错字段名的认领会被当作成功——坐席看到的是"点了没反应"。
 */
function parsePatchBody(body: unknown): TicketPatch {
  // content-type 不是 JSON 时 Fastify 会把 body 留成字符串/undefined，先挡形状。
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("VALIDATION", "body 必须是 JSON 对象");
  }
  const payload = body as Record<string, unknown>;
  const patch: TicketPatch = {};
  let given = 0;

  if (payload.status !== undefined && payload.status !== null) {
    if (
      typeof payload.status !== "string" ||
      !(TICKET_STATUS_VALUES as readonly string[]).includes(payload.status)
    ) {
      throw new AppError("VALIDATION", `status 取值必须是 ${TICKET_STATUS_VALUES.join("|")}`);
    }
    patch.status = payload.status as TicketStatus;
    given += 1;
  }

  if (payload.assignee_id !== undefined) {
    if (payload.assignee_id === null) {
      // 显式 `null` = 清空指派（转回未认领）。与"没给这个字段"是两件事，所以用三态而不是 `??`。
      patch.assignee = { set: null };
      given += 1;
    } else if (typeof payload.assignee_id === "string" && isUuid(payload.assignee_id)) {
      // 只判形状；"这个坐席存不存在"在 core 的事务里查（那里才有权威的行）。
      patch.assignee = { set: payload.assignee_id };
      given += 1;
    } else {
      // 非 uuid 塞进 uuid 列会变成 22P02 的 500 —— 那是调用方最看不懂的一种错误。
      throw new AppError("VALIDATION", "assignee_id 必须是 uuid 或 null");
    }
  }

  if (payload.resolution !== undefined && payload.resolution !== null) {
    if (typeof payload.resolution !== "string") throw new AppError("VALIDATION", "resolution 必须是字符串");
    const trimmed = payload.resolution.trim();
    if (charCount(trimmed) === 0) throw new AppError("VALIDATION", "resolution 不能为空");
    if (charCount(trimmed) > RESOLUTION_MAX_CHARS) {
      throw new AppError("VALIDATION", `resolution 最多 ${RESOLUTION_MAX_CHARS} 字符`);
    }
    patch.resolution = trimmed;
    given += 1;
  }

  if (given === 0) {
    throw new AppError("VALIDATION", "至少提供 status / assignee_id / resolution 之一");
  }

  // 关单必须在这**一次**补丁里给出 ≥10 字结论（05 §4.3）。
  //
  // 不复用库里已有的 `resolution`：审计上要记的是"关单时坐席写了什么"。允许复用会出现
  // "上一单的结论被当成本单的结论"，而复盘时这两句话读起来一模一样，没人能分辨。
  if (patch.status === "closed") {
    if (patch.resolution === undefined) {
      throw new AppError("VALIDATION", `关单必须填写 resolution（至少 ${RESOLUTION_MIN_CHARS} 字符）`);
    }
    if (charCount(patch.resolution) < RESOLUTION_MIN_CHARS) {
      throw new AppError("VALIDATION", `关单结论至少 ${RESOLUTION_MIN_CHARS} 字符`);
    }
  }

  return patch;
}

/**
 * 预留的两个端点（`05-api.md` §2 第 12–14 行）：路径与鉴权都真实存在，行为固定 501。
 *
 * `draft` 已从这份清单里**移除**：它是 A5 的「转 FAQ 草稿」，现在是真接口
 * （`POST /api/console/draft` 写一条 `kb_drafts` 待审，见下面的路由与 `core/faq-store.ts`）。
 * `translate` / `export` 仍然只是占位 —— 前者要外发译文，后者要 MinIO 落文件，都不在本卡范围。
 */
const RESERVED_ENDPOINTS = ["translate", "export"] as const;

export async function registerConsoleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/console/tickets", async (request, reply) => {
    // 身份即观察者（`09#03` 第三段）：会话给出的 `{ staffId, role }` 原样交给 core，
    // 可见性判定在 `listTickets` 里（`agent` 只看自己的 + 未分配池）。路由层不写第二份判断。
    const principal = await requireAdmin(request);
    const { total, items } = await listTickets({ ...parseQueueQuery(request.query), viewer: principal });
    return reply.code(200).send({ ok: true, data: { total, items } });
  });

  app.get("/api/console/tickets/:id", async (request, reply) => {
    const principal = await requireAdmin(request);
    // `agent` 查他人的单：core 抛 `FORBIDDEN` → 403（不是 404，理由见 `getTicketDetail` 的注释）。
    const detail = await getTicketDetail(parseTicketId((request.params as { id?: unknown }).id), principal);
    if (detail === null) throw new AppError("NOT_FOUND", "工单不存在");
    // `data` 的形状逐字照 05 §4.2：`{ ticket, conversation, messages }`。
    return reply.code(200).send({ ok: true, data: detail });
  });

  app.patch("/api/console/tickets/:id", async (request, reply) => {
    // 会话先过，再由 `requireAdmin` 给出"我"是谁 —— 认领的默认指派人来自会话里的 staffId，
    // 不来自 body、也不来自任何请求头（`X-Admin-Staff` 已退场）。`role` 一并带出。
    // 整个 `principal` 原样交给 core：可见性（`09#04` 收口）与派发权（`09#03` 第三段）都在
    // `updateTicket` 里判，本文件没有第二份角色判断 —— 404→409→403(可见)→403(派发)→400 的顺序
    // 只有一处实现，加一个入口（批量改状态）时才不会漏掉其中一条。
    const principal = await requireAdmin(request);
    const id = parseTicketId((request.params as { id?: unknown }).id);
    const patch = parsePatchBody(request.body);

    const { ticket, changed } = await updateTicket({ id, patch, principal });
    // 响应给 `{ ticket, changed }`：`ticket` 是补丁后的完整列表项形状（前端可直接替换那一行），
    // `changed` 让"点了一下但什么都没变"可以被区分出来（空数组 = 空操作，没有写审计）。
    return reply.code(200).send({ ok: true, data: { ticket, changed } });
  });

  /* ─────────────────── 转 L2（升级到二线） ─────────────────── */

  app.post(ROUTES.escalate, async (request, reply) => {
    // `guard` = `requireAdmin`（会话票据 → 401）+ `requireRole`（角色从 `ROUTE_MIN_ROLE` 现查 → 403）。
    // 转 L2 是 `agent` 的日常动作，表里写的就是 `agent`；本文件仍然没有角色字面量。
    const principal = await guard(request, "POST", ROUTES.escalate);
    const id = parseTicketId((request.params as { id?: unknown }).id);
    // 判定顺序（404 → 409 → 403 可见性）全在 core 的 `escalateTicket` 里，与 `updateTicket` 同一份。
    const { ticket, changed } = await escalateTicket({ id, principal });
    return reply.code(200).send({ ok: true, data: { ticket, changed } });
  });

  /* ─────────────────── FAQ 草稿（A5） ─────────────────── */

  app.post(ROUTES.draft, async (request, reply) => {
    const principal = await guard(request, "POST", ROUTES.draft);
    const input = parseDraftBody(request.body);

    // 从工单起稿时判两张门：存在性（400）与可见性（403，与详情/补丁同一口径）。
    // 不判的话，`agent` 能拿别人工单的问题去建草稿 —— "看不见标题"就白挡了，
    // 因为正文会原样存进 `kb_drafts.question` 并出现在主管的审批列表里。
    if (input.ticketId !== null) {
      const target = await readTicketAssignee(input.ticketId);
      if (target === null) throw new AppError("VALIDATION", "ticket_id 不存在");
      assertTicketVisible(target.assignee, principal);
    }

    const draft = await createDraft({
      question: input.question,
      answer: input.answer,
      lang: input.lang,
      source: input.source,
      actor: actorOf(principal),
    });
    return reply.code(200).send({ ok: true, data: { draft } });
  });

  app.get(ROUTES.drafts, async (request, reply) => {
    // 读归 `agent`：起稿的人要能看见自己那份现在是什么状态（待审 / 通过 / 驳回）。
    await guard(request, "GET", ROUTES.drafts);
    const { total, items } = await listDrafts(parseDraftQuery(request.query));
    return reply.code(200).send({ ok: true, data: { total, items } });
  });

  app.post(ROUTES.draftApprove, async (request, reply) => {
    // 通过 = 把答案写进用户能检索到的索引，与「发布故障卡」「改知识库正文」同一档签字动作 → `admin`。
    const principal = await guard(request, "POST", ROUTES.draftApprove);
    const id = parseDraftId((request.params as { id?: unknown }).id);
    const { draft, changed } = await approveDraft({ id, actor: actorOf(principal) });
    return reply.code(200).send({ ok: true, data: { draft, changed } });
  });

  app.post(ROUTES.draftReject, async (request, reply) => {
    // 驳回不改索引、不删行，只是"这条不进知识库"的判断 → `lead` 起（与查看/编辑草稿同档）。
    const principal = await guard(request, "POST", ROUTES.draftReject);
    const id = parseDraftId((request.params as { id?: unknown }).id);
    const { draft, changed } = await rejectDraft({ id, actor: actorOf(principal) });
    return reply.code(200).send({ ok: true, data: { draft, changed } });
  });

  app.get(ROUTES.noHit, async (request, reply) => {
    // 未命中池是**质量视图**（哪些问题反复没答案），给主管看 → `lead` 起。
    // 若放开给 `agent`，`v_no_hit` 会把同事工单的问题原文一并端出来（视图不带可见性过滤）。
    await guard(request, "GET", ROUTES.noHit);
    const limit = parseIntInRange(
      firstString((request.query as Record<string, unknown> | undefined)?.limit),
      "limit",
      FAQ_NO_HIT_LIMIT_DEFAULT,
      1,
      FAQ_NO_HIT_LIMIT_MAX,
    );
    const items = await listNoHit(limit);
    return reply.code(200).send({ ok: true, data: { items } });
  });

  app.get("/api/console/stats", async (request, reply) => {
    await requireAdmin(request);
    // 会话先过再解析 query：未授权的请求不该有机会触发任何一个校验分支（文件头第 19 行的口径）。
    //
    // `reports` 是反馈回路的三个计数（`09#04` / R26）：**口径固定全量，不跟 `window` /
    // `exclude_demo` 走**。它们回答的是"待审积压多少、回路还在不在动、处置倾向如何"，
    // 是队列健康度而不是看板筛选结果 —— 让 `window=today` 同时表示"今天的工单"与"今天的反馈"
    // 会把卡片标题写成假话，而 `merge_rate` 按时间窗切分后分母会小到没有统计意义。
    // 于是响应里 `window` / `exclude_demo` 只描述 `tickets_*` / `runs_*` 的口径，
    // `reports.*` 恒为全量（前端不要把这三个数标成"今日"）。
    // 读法只有一处：`core/admin-store.ts` 的 `readFaultReportCounts`（与待审列表共用同一张表）。
    const stats = await readStats(parseStatsQuery(request.query));

    // 图表（`09#04` 看板 A 方案）：`?series=7d|30d` 才返回时间序列与语言直方图。
    // 为什么不做成独立端点：多一条路由就多一行 `ROUTE_MIN_ROLE`，而启动断言会因为它漏登记
    // 让进程起不来 —— 一个纯粹的展示开关不值得换这道门。缺省不返回，老前端不受影响。
    const seriesParam = firstString((request.query as Record<string, unknown> | undefined)?.series);
    const series =
      seriesParam !== null && SERIES_WINDOW_VALUES.includes(seriesParam as SeriesWindow)
        ? await readTicketSeries(seriesParam as SeriesWindow)
        : null;
    if (seriesParam !== null && series === null) {
      throw new AppError("VALIDATION", `series 取值必须是 ${SERIES_WINDOW_VALUES.join("|")}`);
    }

    const reports = await readFaultReportCounts();
    const faultLangs = series === null ? null : await readFaultLangHistogram();
    return reply.code(200).send({
      ok: true,
      data: { ...stats, reports, ...(series === null ? {} : { series, fault_langs: faultLangs }) },
    });
  });

  // 三个预留端点用同一个处理器：鉴权与 501 的形状必须是同一份，逐个抄三遍迟早会漂。
  for (const name of RESERVED_ENDPOINTS) {
    app.post(`/api/console/${name}`, async (request) => {
      // 照样要会话：501 是"功能没做"，不是"可以匿名探测"。
      await requireAdmin(request);
      throw new AppError("NOT_IMPLEMENTED", "本期未开放");
    });
  }
}
