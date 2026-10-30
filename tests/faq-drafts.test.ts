/**
 * 转 L2 与 FAQ 草稿链的黑盒验收（`09#06` / A5：未命中池 → 草稿 → 审批 → 入索引）。
 *
 * 断言的是**契约与可观察副作用**，不是实现：
 *   - 转 L2 写进了状态与 `tags`、审计里有一条 `ticket.escalate`、幂等（第二次 `changed: []`）、
 *     关单 409 / 他人工单 403；队列把已升级的单排在前面（`docs/prd/03-agent-console.md` "队列置顶"）。
 *   - 转 FAQ 草稿真的落了一行 `kb_drafts`（`source` 有两种）、同问题重复 409、答案太短 400、
 *     拿他人工单起稿 403。
 *   - 审批：`lead` 通过被拒（403）、`admin` 通过后**答案真的进了 `chunks`**（不只是改了个状态）、
 *     重复通过是空操作、被驳回的草稿不能再通过（409）。
 *   - 未命中池：`lead` 能读、`agent` 403（视图不带可见性过滤，放开就是同事问题原文泄漏）。
 *
 * 只注册 console + auth 路由（与 `tests/console-api.test.ts` 同一套写法）：本文件要能在别的
 * 路由半成品时独立变绿或变红。夹具一律带独有标记，清理只删自己造的行。
 *
 * 通过审批会**真的调用 embedding**（`core/kb-store.ts` 的 `buildIndex`）。缺 Key 时运行期会降级到
 * hash 兜底向量（仍然能入索引，只是召回质量差），所以这条用例在两种模式下都成立。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与其它测试同一套 .env 解析：`node --test` 不带 --env-file，得自己补。 */
async function loadDotEnv(): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, ".env"), "utf8");
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1] as string;
    const value = (match[2] as string).replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "") env[key] = value;
  }
  return env;
}

const dotenv = await loadDotEnv();
for (const [key, value] of Object.entries(dotenv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const hasRuntimeEnv = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

/** 三个演示账号（`sql/002_seed.sql`）：口令都是 `wt-demo-2026`，部署前必须改。 */
const DEMO_PASSWORD = "wt-demo-2026";
const AGENT_EMAIL = "zhang.wei@wotai.demo";
const LEAD_EMAIL = "li.na@wotai.demo";
const ADMIN_EMAIL = "admin@wotai.demo";

/** 本文件的唯一夹具前缀：问题摘要带它，清理只按它造出来的 id 删。 */
const FIXTURE = `f09-${randomUUID().slice(0, 8)}`;
const mark = (useCase: string): string => `${FIXTURE}-${useCase}`;

type ErrorBody = { ok: false; error: { code: string; message: string; trace_id: string } };
type Reply = { status: number; body: unknown; raw: string };

const conversationIds: string[] = [];
const ticketIds: number[] = [];
const ticketNos: string[] = [];
const draftIds: number[] = [];
const documentIds: string[] = [];

let app: FastifyInstance;
let agentTicket = "";
let leadTicket = "";
let adminTicket = "";
let leadStaffId = "";

before(async () => {
  if (!hasRuntimeEnv) return;
  const [{ default: Fastify }, { registerConsoleRoutes }, { registerAuthRoutes }, { toErrorBody }] = await Promise.all([
    import("fastify"),
    import("../src/api/console.ts"),
    import("../src/api/auth.ts"),
    import("../src/errors.ts"),
  ]);

  app = Fastify({ logger: false });
  app.setErrorHandler((err, request, reply) => {
    const { status, body } = toErrorBody(err, String(request.id));
    return reply.code(status).send(body);
  });
  await registerConsoleRoutes(app);
  await registerAuthRoutes(app);
  await app.ready();

  const agent = await loginAs(AGENT_EMAIL);
  agentTicket = agent.ticket;
  const lead = await loginAs(LEAD_EMAIL);
  leadTicket = lead.ticket;
  leadStaffId = lead.staff.staff_id;
  const admin = await loginAs(ADMIN_EMAIL);
  adminTicket = admin.ticket;
});

after(async () => {
  if (!hasRuntimeEnv) return;
  const [{ pool, query }, { redis }] = await Promise.all([import("../src/db.ts"), import("../src/redis.ts")]);
  if (app !== undefined) await app.close();

  // 顺序：审计 → 草稿 → 文档（chunks 级联）→ 工单 → 会话。
  // 审计的 target 有两类：工单号（`WT-…`）与 `faq_draft:<id>`。
  const targets = [...ticketNos, ...draftIds.map((id) => `faq_draft:${id}`)];
  if (targets.length > 0) await query("delete from audit_log where target = any($1::text[])", [targets]);
  if (draftIds.length > 0) await query("delete from kb_drafts where id = any($1::bigint[])", [draftIds]);
  if (documentIds.length > 0) await query("delete from documents where id = any($1::uuid[])", [documentIds]);
  if (ticketIds.length > 0) await query("delete from tickets where id = any($1::bigint[])", [ticketIds]);
  if (conversationIds.length > 0) await query("delete from conversations where id = any($1::uuid[])", [conversationIds]);

  for (const ticket of [agentTicket, leadTicket, adminTicket]) {
    if (ticket !== "") await redis.del(`staff_session:${ticket}`);
  }
  await redis.del("login:127.0.0.1");

  await redis.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

/* ─────────────────────────── 夹具 ─────────────────────────── */

function toReply(response: { statusCode: number; body: string }): Reply {
  return { status: response.statusCode, body: JSON.parse(response.body) as unknown, raw: response.body };
}

/** 登录拿票据。三个账号各登一次（整个文件只在这里登，避免撞 5 次/分钟限速）。 */
async function loginAs(
  email: string,
): Promise<{ ticket: string; staff: { staff_id: string; name: string; role: string } }> {
  const { redis } = await import("../src/redis.ts");
  await redis.del("login:127.0.0.1");
  const reply = toReply(
    await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: DEMO_PASSWORD } }),
  );
  assert.equal(reply.status, 200, `登录失败（${email}）：${reply.raw}`);
  return (reply.body as { data: { ticket: string; staff: { staff_id: string; name: string; role: string } } }).data;
}

async function call(options: {
  method: "GET" | "PATCH" | "POST";
  url: string;
  as?: "agent" | "lead" | "admin" | null;
  payload?: unknown;
}): Promise<Reply> {
  const headers: Record<string, string> = {};
  const who = options.as === undefined ? "agent" : options.as;
  const token = who === "agent" ? agentTicket : who === "lead" ? leadTicket : who === "admin" ? adminTicket : "";
  if (who !== null) headers["x-staff-session"] = token;
  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
  return toReply(response);
}

async function newTicket(input: {
  question: string;
  status?: string;
  assignee?: string | null;
  dueAt?: string;
  convId?: string | null;
  reason?: string;
}): Promise<{ id: number; no: string }> {
  const { one } = await import("../src/db.ts");
  const row = await one<{ id: string; no: string }>(
    `insert into tickets (no, conv_id, reason, question, status, assignee, due_at)
     values (gen_ticket_no(), $1::uuid, $2, $3, coalesce($4::text, 'open'), $5::uuid, $6::timestamptz)
     returning id, no`,
    [
      input.convId ?? null,
      input.reason ?? "no_citation",
      input.question,
      input.status ?? null,
      input.assignee ?? null,
      input.dueAt ?? null,
    ],
  );
  assert.ok(row !== null, "工单插入失败");
  ticketIds.push(Number(row.id));
  ticketNos.push(row.no);
  return { id: Number(row.id), no: row.no };
}

async function newConversation(lang: string): Promise<string> {
  const { one } = await import("../src/db.ts");
  const row = await one<{ id: string }>("insert into conversations (lang) values ($1) returning id", [lang]);
  assert.ok(row !== null, "会话插入失败");
  conversationIds.push(row.id);
  return row.id;
}

type DraftBody = {
  id: number;
  question: string;
  answer: string;
  lang: string;
  source: string;
  status: string;
  reviewer: string | null;
  reviewer_id: string | null;
  chunk_id: number | null;
  created_at: string;
};

/** 建一份草稿并记下 id（`after` 要清）。`expect` 允许调用方断言失败形状。 */
async function createDraft(input: {
  question: string;
  answer: string;
  lang?: string;
  ticketId?: number;
  as?: "agent" | "lead" | "admin";
}): Promise<{ reply: Reply; draft: DraftBody | null }> {
  const reply = await call({
    method: "POST",
    url: "/api/console/draft",
    as: input.as ?? "agent",
    payload: {
      question: input.question,
      answer: input.answer,
      lang: input.lang ?? "de",
      ...(input.ticketId === undefined ? {} : { ticket_id: input.ticketId }),
    },
  });
  const draft = (reply.body as { data?: { draft?: DraftBody } })?.data?.draft ?? null;
  if (draft !== null) draftIds.push(draft.id);
  return { reply, draft };
}

function errorCode(reply: Reply): string {
  return (reply.body as ErrorBody)?.error?.code ?? "";
}

/* ─────────────────────── ① 转 L2 ─────────────────────── */

test("转 L2：状态与 tags 都写、审计留痕，第二次是空操作（幂等）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const ticket = await newTicket({ question: `升级 ${mark("l2")}`, reason: "out_of_scope" });

  const first = await call({ method: "POST", url: `/api/console/tickets/${ticket.id}/escalate`, as: "agent" });
  assert.equal(first.status, 200, `转 L2 期望 200，实际 ${first.status}：${first.raw}`);
  const data = (first.body as { data: { ticket: { status: string }; changed: string[] } }).data;
  assert.equal(data.ticket.status, "escalated");
  assert.deepEqual(data.changed.sort(), ["status", "tags"]);

  const { one, query } = await import("../src/db.ts");
  const row = await one<{ status: string; tags: string[] }>(
    "select status, tags from tickets where id = $1::bigint",
    [ticket.id],
  );
  assert.equal(row?.status, "escalated");
  assert.ok(row?.tags.includes("escalate"), `tags 里要有 escalate，实际 ${JSON.stringify(row?.tags)}`);

  const audit = await one<{ action: string; payload: { staff_id?: string; before?: unknown; after?: unknown } }>(
    "select action, payload from audit_log where target = $1 order by id desc limit 1",
    [ticket.no],
  );
  assert.equal(audit?.action, "ticket.escalate", "审计动作要能分辨'升级'与普通状态变更");
  assert.equal(typeof audit?.payload?.staff_id, "string", "审计要记操作者 id");
  // PII 口径：审计不存问题原文（`audit_log` 保留两年）。
  assert.equal(JSON.stringify(audit?.payload ?? {}).includes(mark("l2")), false, "审计不该存问题原文");

  // 幂等：第二次不再改库、不写第二条审计。
  const auditCountBefore = await one<{ n: string }>("select count(*)::text as n from audit_log where target = $1", [
    ticket.no,
  ]);
  const second = await call({ method: "POST", url: `/api/console/tickets/${ticket.id}/escalate`, as: "agent" });
  assert.equal(second.status, 200);
  assert.deepEqual((second.body as { data: { changed: string[] } }).data.changed, []);
  const auditCountAfter = await one<{ n: string }>("select count(*)::text as n from audit_log where target = $1", [
    ticket.no,
  ]);
  assert.equal(auditCountAfter?.n, auditCountBefore?.n, "空操作不该多出一条审计");

  // 队列置顶：已升级的单排在前面（即便它的 due_at 更晚）。
  const early = await newTicket({
    question: `升级置顶对照 ${mark("l2")}`,
    dueAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const escalatedLater = await newTicket({
    question: `升级置顶本单 ${mark("l2")}`,
    status: "escalated",
    dueAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
  });
  const list = await call({
    method: "GET",
    url: `/api/console/tickets?q=${encodeURIComponent(mark("l2"))}&size=100`,
    as: "lead",
  });
  assert.equal(list.status, 200, list.raw);
  const items = (list.body as { data: { items: { id: number; status: string }[] } }).data.items;
  const ids = items.map((item) => item.id);
  assert.ok(
    ids.indexOf(escalatedLater.id) < ids.indexOf(early.id),
    `已升级的单必须排在未升级的单前面，实际顺序 ${ids.join(",")}`,
  );
});

test("转 L2：已关单 409、他人工单 403、lead 能升他人的单", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const closed = await newTicket({ question: `升级关单 ${mark("l2-guard")}` });
  const closeReply = await call({
    method: "PATCH",
    url: `/api/console/tickets/${closed.id}`,
    as: "agent",
    payload: { status: "closed", resolution: "已电话指导复位并观察十分钟" },
  });
  assert.equal(closeReply.status, 200, closeReply.raw);

  const onClosed = await call({ method: "POST", url: `/api/console/tickets/${closed.id}/escalate`, as: "agent" });
  assert.equal(onClosed.status, 409, onClosed.raw);
  assert.equal(errorCode(onClosed), "TICKET_IMMUTABLE");

  // 归 lead 的单：agent 升不动（403，不是 404 —— 与详情/补丁同一口径）。
  const others = await newTicket({ question: `升级他人单 ${mark("l2-guard")}`, assignee: leadStaffId });
  const asAgent = await call({ method: "POST", url: `/api/console/tickets/${others.id}/escalate`, as: "agent" });
  assert.equal(asAgent.status, 403, asAgent.raw);
  assert.equal(errorCode(asAgent), "FORBIDDEN");

  const asLead = await call({ method: "POST", url: `/api/console/tickets/${others.id}/escalate`, as: "lead" });
  assert.equal(asLead.status, 200, asLead.raw);
  assert.equal((asLead.body as { data: { ticket: { status: string } } }).data.ticket.status, "escalated");
});

test("转 L2：没有会话票据 → 401", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const ticket = await newTicket({ question: `升级无票据 ${mark("l2-auth")}` });
  const reply = await call({ method: "POST", url: `/api/console/tickets/${ticket.id}/escalate`, as: null });
  assert.equal(reply.status, 401, reply.raw);
});

/* ─────────────────────── ② 转 FAQ 草稿 ─────────────────────── */

test("转 FAQ 草稿：落一行 kb_drafts（source=ticket），同问题重复 409，答案太短 400", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const convId = await newConversation("de");
  const ticket = await newTicket({ question: `草稿来源 ${mark("draft")}`, convId });
  const question = `草稿问题 ${mark("draft")}`;
  const answer = `先断开直流侧，再按复位键 5 秒；若仍报 E07，请联系安装商检查组串电压。${mark("draft")}`;

  const { reply, draft } = await createDraft({ question, answer, lang: "de", ticketId: ticket.id });
  assert.equal(reply.status, 200, reply.raw);
  assert.ok(draft !== null);
  assert.equal(draft.status, "draft");
  assert.equal(draft.source, "ticket", "从工单起稿要记 source=ticket（来源留痕）");
  assert.equal(draft.lang, "de");
  assert.equal(draft.reviewer, null);

  // 同一个问题再提交一次 → 409（两份待审会让审批的人分不清该看哪份）。
  const again = await createDraft({ question, answer, lang: "de" });
  assert.equal(again.reply.status, 409, again.reply.raw);
  assert.equal(errorCode(again.reply), "CONFLICT");

  // 答案 5 字 → 400（前端 10 字门槛的第二道门）。
  const tooShort = await createDraft({ question: `太短 ${mark("draft")}`, answer: "五个字答案" });
  assert.equal(tooShort.reply.status, 400, tooShort.reply.raw);
  assert.equal(errorCode(tooShort.reply), "VALIDATION");

  // 语言必须是五语之一。
  const badLang = await createDraft({ question: `语言 ${mark("draft")}`, answer, lang: "fr" });
  assert.equal(badLang.reply.status, 400, badLang.reply.raw);
});

test("转 FAQ 草稿：拿他人工单起稿 → 403（否则'看不见标题'就白挡了）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const others = await newTicket({
    question: `草稿他人单 ${mark("draft-guard")}`,
    assignee: leadStaffId,
  });
  const { reply } = await createDraft({
    question: `草稿他人问题 ${mark("draft-guard")}`,
    answer: `这段答案足够十个字以上，用于验证可见性。${mark("draft-guard")}`,
    ticketId: others.id,
  });
  assert.equal(reply.status, 403, reply.raw);
  assert.equal(errorCode(reply), "FORBIDDEN");

  // 不存在的 ticket_id → 400（不是静默写成 source=ticket）。
  const missing = await createDraft({
    question: `草稿不存在单 ${mark("draft-guard")}`,
    answer: `这段答案同样足够十个字以上，用于验证存在性。${mark("draft-guard")}`,
    ticketId: 999999999,
  });
  assert.equal(missing.reply.status, 400, missing.reply.raw);
});

/* ─────────────────────── ③ 审批入索引 ─────────────────────── */

test("审批：lead 通过被 403（要 admin）；admin 通过后答案真的进了 chunks；重复通过是空操作", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const question = `审批问题 ${mark("approve")}`;
  const answer = `审批答案 ${mark("approve")}：断开交流侧断路器，等待 5 分钟后再合闸；若故障码仍存在，请记录机型与序列号并联系安装商。`;
  const { reply, draft } = await createDraft({ question, answer, lang: "de" });
  assert.equal(reply.status, 200, reply.raw);
  assert.ok(draft !== null);

  const byLead = await call({ method: "POST", url: `/api/console/drafts/${draft.id}/approve`, as: "lead" });
  assert.equal(byLead.status, 403, `通过需要 admin，实际 ${byLead.status}：${byLead.raw}`);
  assert.equal(errorCode(byLead), "FORBIDDEN");

  const byAdmin = await call({ method: "POST", url: `/api/console/drafts/${draft.id}/approve`, as: "admin" });
  assert.equal(byAdmin.status, 200, `审批失败：${byAdmin.raw}`);
  const approved = (byAdmin.body as { data: { draft: DraftBody; changed: string[] } }).data;
  assert.equal(approved.draft.status, "approved");
  assert.equal(typeof approved.draft.reviewer, "string", "审批人要落成姓名");
  assert.ok(approved.draft.chunk_id !== null, "通过之后要指到索引里的那一条片段");
  assert.deepEqual(approved.changed.sort(), ["chunk_id", "reviewer", "status"]);

  // 副作用：`documents` 一篇 indexed + `chunks` 至少一条，且语言与草稿一致（检索按 `c.lang` 过滤）。
  const { one, query } = await import("../src/db.ts");
  const doc = await one<{ id: string; status: string; lang: string; chunk_count: number; version: number }>(
    "select id, status, lang, chunk_count, version from documents where title = $1",
    [`FAQ: ${question}`.slice(0, 200)],
  );
  assert.ok(doc !== null, "审批要真的写一篇文档（不能只改状态）");
  documentIds.push(doc.id);
  assert.equal(doc.status, "indexed");
  assert.equal(doc.lang, "de");
  assert.equal(doc.version, 1, "第一版就是上线版");
  assert.ok(doc.chunk_count > 0, `chunk_count 应大于 0，实际 ${doc.chunk_count}`);

  const chunks = await query<{ id: string; lang: string; content: string }>(
    "select id, lang, content from chunks where doc_id = $1::uuid",
    [doc.id],
  );
  assert.equal(chunks.length, doc.chunk_count, "chunk_count 与实际行数必须一致（质量检查靠它）");
  assert.ok(chunks.every((chunk) => chunk.lang === "de"), "片段语言跟着草稿（错了会落进另一路召回）");
  assert.equal(Number(chunks[0]?.id), approved.draft.chunk_id, "草稿指到的那条片段要真实存在");

  // 问题必须进正文与片段：检索只搜 `chunks.content`（标题不参与召回），
  // 不把问句写进去，用户原话里"答案没提到的词"就只能靠语义向量兜，FTS 永远命不中。
  const bodyRow = await one<{ body: string | null }>("select body from documents where id = $1", [doc.id]);
  assert.ok(String(bodyRow?.body ?? "").startsWith(question), "正文首行是问题");
  assert.match(String(bodyRow?.body ?? ""), /审批答案/, "问题之后是答案");
  assert.ok(
    chunks.some((chunk) => chunk.content.includes(question)),
    "至少一条片段里要含问题原文（否则这条 FAQ 的提问词进不了 FTS）",
  );

  // FAQ 直通建索引没有作业行：`rebuild` 要合成一条 `succeeded`，不能报"尚未重建"。
  const detail = await call({ method: "GET", url: `/api/admin/documents/${doc.id}`, as: "admin" });
  assert.equal(detail.status, 200, detail.raw);
  const rebuild = (detail.body as { data: { rebuild: { status: string; job_id: string | null; chunk_count: number | null } } })
    .data.rebuild;
  assert.equal(rebuild.status, "succeeded", "审批已经建好索引，状态不能是 idle");
  assert.equal(rebuild.job_id, null, "没有作业行就是 null，不编一个 id 出来");
  assert.equal(rebuild.chunk_count, doc.chunk_count, "块数取文档上的真实值");

  // 重复通过：不重复建文档，`changed: []`。
  const docsBefore = await one<{ n: string }>("select count(*)::text as n from documents where title = $1", [
    `FAQ: ${question}`.slice(0, 200),
  ]);
  const again = await call({ method: "POST", url: `/api/console/drafts/${draft.id}/approve`, as: "admin" });
  assert.equal(again.status, 200, again.raw);
  assert.deepEqual((again.body as { data: { changed: string[] } }).data.changed, []);
  const docsAfter = await one<{ n: string }>("select count(*)::text as n from documents where title = $1", [
    `FAQ: ${question}`.slice(0, 200),
  ]);
  assert.equal(docsAfter?.n, docsBefore?.n, "重复通过不该再建一篇文档");

  // 审计：通过要留痕，且不存答案正文。
  const audit = await one<{ action: string; payload: Record<string, unknown> }>(
    "select action, payload from audit_log where target = $1 order by id desc limit 1",
    [`faq_draft:${draft.id}`],
  );
  assert.equal(audit?.action, "faq_draft.approve");
  assert.equal(JSON.stringify(audit?.payload ?? {}).includes(mark("approve")), false, "审计不存答案正文");
});

test("审批：lead 能驳回；被驳回的草稿不能再通过（409）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const question = `驳回问题 ${mark("reject")}`;
  const { reply, draft } = await createDraft({
    question,
    answer: `这条答案会被驳回，因为它是测试数据。${mark("reject")}`,
  });
  assert.equal(reply.status, 200, reply.raw);
  assert.ok(draft !== null);

  const byLead = await call({ method: "POST", url: `/api/console/drafts/${draft.id}/reject`, as: "lead" });
  assert.equal(byLead.status, 200, byLead.raw);
  const rejected = (byLead.body as { data: { draft: DraftBody; changed: string[] } }).data;
  assert.equal(rejected.draft.status, "rejected");
  assert.deepEqual(rejected.changed.sort(), ["reviewer", "status"]);

  const approve = await call({ method: "POST", url: `/api/console/drafts/${draft.id}/approve`, as: "admin" });
  assert.equal(approve.status, 409, approve.raw);
  assert.equal(errorCode(approve), "CONFLICT");

  // 驳回是幂等的（双击不留第二条审计）。
  const twice = await call({ method: "POST", url: `/api/console/drafts/${draft.id}/reject`, as: "lead" });
  assert.equal(twice.status, 200, twice.raw);
  assert.deepEqual((twice.body as { data: { changed: string[] } }).data.changed, []);

  // 驳回之后同一个问题可以重新起稿（409 只挡未驳回的）。
  const retry = await createDraft({
    question,
    answer: `这次换一条不同的答案，允许重新提交。${mark("reject")}`,
  });
  assert.equal(retry.reply.status, 200, retry.reply.raw);
});

/* ─────────────────────── ④ 草稿列表与未命中池 ─────────────────────── */

test("草稿列表：agent 能看到自己那份；状态筛选生效；非法状态 400", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const question = `列表问题 ${mark("list")}`;
  const { draft } = await createDraft({ question, answer: `列表答案足够十个字以上。${mark("list")}` });
  assert.ok(draft !== null);

  const all = await call({ method: "GET", url: "/api/console/drafts?status=draft&size=100", as: "agent" });
  assert.equal(all.status, 200, all.raw);
  const items = (all.body as { data: { items: DraftBody[] } }).data.items;
  assert.ok(items.some((item) => item.id === draft.id), "刚建的草稿要出现在待审列表里");

  const rejected = await call({ method: "GET", url: "/api/console/drafts?status=rejected&size=100", as: "agent" });
  assert.equal(rejected.status, 200, rejected.raw);
  assert.equal(
    (rejected.body as { data: { items: DraftBody[] } }).data.items.some((item) => item.id === draft.id),
    false,
    "status 筛选要真的生效",
  );

  const bad = await call({ method: "GET", url: "/api/console/drafts?status=nope", as: "agent" });
  assert.equal(bad.status, 400, bad.raw);
});

test("未命中池：lead 能读且包含反复没答案的问题；agent 403", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const question = `未命中问题 ${mark("nohit")}`;
  const convId = await newConversation("es");
  // 两单同问题同语言 → 视图里聚合成 hits=2（`v_no_hit` 的键就是问题+语言）。
  await newTicket({ question, convId, reason: "no_citation" });
  await newTicket({ question, convId, reason: "out_of_scope" });

  const asAgent = await call({ method: "GET", url: "/api/console/no-hit?limit=100", as: "agent" });
  assert.equal(asAgent.status, 403, `未命中池要 lead 起，实际 ${asAgent.status}：${asAgent.raw}`);

  const asLead = await call({ method: "GET", url: "/api/console/no-hit?limit=100", as: "lead" });
  assert.equal(asLead.status, 200, asLead.raw);
  const items = (asLead.body as { data: { items: { question: string; lang: string | null; hits: number }[] } }).data.items;
  const row = items.find((item) => item.question === question);
  assert.ok(row !== undefined, "刚造的两张未命中单要出现在未命中池里");
  assert.equal(row.lang, "es", "语言来自会话连接（tickets 表没有 lang 列）");
  assert.equal(typeof row.hits, "number", "hits 必须是数字（int8 不转换会变成字符串）");
  assert.ok(row.hits >= 2, `同一个问题问两次，hits 至少 2，实际 ${row.hits}`);

  const badLimit = await call({ method: "GET", url: "/api/console/no-hit?limit=abc", as: "lead" });
  assert.equal(badLimit.status, 400, badLimit.raw);
});
