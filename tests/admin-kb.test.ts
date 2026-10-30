/**
 * 知识库 CRUD 的黑盒验收（`09#05` · `.scratch/09-admin-console/issues/05-kb-crud.md`）。
 *
 * 断言的是**可观察契约**，不是实现：
 *   - 角色矩阵（`lead` 读、`admin` 写；agent 全 403；没票据 401）；
 *   - 新建只落 `pending`（`chunks` 一行都没有，检索不命中）→ 重建 → `indexed` 且内容可检索；
 *   - 改正文 → 落回 `pending` 但**旧索引仍然可检索**（中间态可解释）→ 再重建 → 新内容命中、`version+1`；
 *   - 重建失败 → `status='failed'` + `chunks` / `version` **与失败前完全一致**，随后能重建成功；
 *   - 回滚 → `chunks` 回到上一版内容，`citations.chunk_id` 置 null 但快照字段仍在；
 *   - 停用 → 行还在、`status='archived'`、检索不再命中、且不许再改/重建/回滚。
 *
 * 夹具自造自清：所有文档的标题都带本次运行的独有前缀（`FIXTURE`），清理只按
 * **本文件建出来的 id** 删 —— 绝不 `delete from documents`（那会删掉别人的语料与别人的夹具）。
 *
 * 检索断言走真的 `retrieve()`（含 embedding 调用），不走"直接查 chunks"：
 * 本卡最容易写错的地方就是"库里明明有块、检索却命中不到"（`documents.status` 过滤写错时
 * 就是这样），只查表证明不了这一点。
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

/** 演示账号（`sql/002_seed.sql`）：口令 `wt-demo-2026`，部署前必须改。 */
const AGENT_EMAIL = "zhang.wei@wotai.demo";
const LEAD_EMAIL = "li.na@wotai.demo";
const ADMIN_EMAIL = "admin@wotai.demo";
const DEMO_PASSWORD = "wt-demo-2026";

/** 本次运行的独有前缀：标题里带它，于是"这个库里的这些行是我造的"永远可判。 */
const FIXTURE = `kbt${randomUUID().replace(/-/g, "").slice(0, 8)}`;

/** 本文件造过的文档 id：清理时只按它们删（cascade 带走 chunks / versions / jobs）。 */
const createdDocs = new Set<string>();
/** 本文件造过的会话 id（引用快照夹具的表头，删它 cascade 带走 messages / citations）。 */
const createdConvs = new Set<string>();

type Staff = { staff_id: string; name: string; email: string; role: string };
type ErrorBody = { ok: false; error: { code: string; message: string; trace_id: string } };
type Reply = { status: number; body: unknown; raw: string };
type JobBody = {
  job_id: string | null;
  status: "idle" | "running" | "succeeded" | "failed";
  error: string | null;
  chunk_count: number | null;
  started_at: string | null;
  finished_at: string | null;
};
type DocBody = {
  id: string;
  title: string;
  lang: string;
  productLine: string | null;
  body: string | null;
  status: string;
  chunkCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  rebuild: JobBody;
};

let app: FastifyInstance;
let agentTicket = "";
let leadTicket = "";
let adminTicket = "";
let admin: Staff = { staff_id: "", name: "", email: "", role: "" };

before(async () => {
  if (!hasRuntimeEnv) return;
  const [{ default: Fastify }, { registerAdminKbRoutes }, { registerAuthRoutes }, { toErrorBody }] = await Promise.all([
    import("fastify"),
    import("../src/api/admin-kb.ts"),
    import("../src/api/auth.ts"),
    import("../src/errors.ts"),
  ]);

  // 与 `src/server.ts` 同一套错误信封：401/403/404/409 的形状必须是线上那一种。
  app = Fastify({ logger: false });
  app.setErrorHandler((err, request, reply) => {
    const { status, body } = toErrorBody(err, String(request.id));
    return reply.code(status).send(body);
  });
  await registerAdminKbRoutes(app);
  await registerAuthRoutes(app);
  await app.ready();

  const agentLogin = await loginAs(AGENT_EMAIL);
  agentTicket = agentLogin.ticket;
  const leadLogin = await loginAs(LEAD_EMAIL);
  leadTicket = leadLogin.ticket;
  const adminLogin = await loginAs(ADMIN_EMAIL);
  adminTicket = adminLogin.ticket;
  admin = adminLogin.staff;

  // 夹具前提先断言：三个身份必须真是三个角色，否则后面的断言只是在描述
  // "某三个账号碰巧能做什么"，而不是权限矩阵。
  assert.equal(leadLogin.staff.role, "lead", `夹具前提：${LEAD_EMAIL} 必须是 lead`);
  assert.equal(admin.role, "admin", `夹具前提：${ADMIN_EMAIL} 必须是 admin`);
});

after(async () => {
  if (!hasRuntimeEnv) return;
  const [{ pool, query }, { redis }] = await Promise.all([import("../src/db.ts"), import("../src/redis.ts")]);
  if (app !== undefined) await app.close();

  // 顺序：审计 → 会话（cascade 带走 messages/citations）→ 文档（cascade 带走 chunks/versions/jobs）。
  const ids = [...createdDocs];
  if (ids.length > 0) {
    await query(`delete from audit_log where target = any($1::text[])`, [ids.map((id) => `document:${id}`)]);
    await query(`delete from conversations where id = any($1::uuid[])`, [[...createdConvs]]);
    await query(`delete from documents where id = any($1::uuid[])`, [ids]);
  }
  // 兜底：硬杀进程时 `after` 不跑，下次靠这条把它扫干净（只碰本文件的 `kb:` 前缀 + 独有标题）
  await query(`delete from documents where object_key like 'kb:%' and title like $1`, [`%${FIXTURE}%`]);

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

/** 先清限速键再登录（跨文件累计很容易在第 6 次撞 429，那是限速的正确行为）。 */
async function loginAs(email: string): Promise<{ ticket: string; staff: Staff }> {
  const { redis } = await import("../src/redis.ts");
  await redis.del("login:127.0.0.1");
  const reply = toReply(
    await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: DEMO_PASSWORD } }),
  );
  assert.equal(reply.status, 200, `登录失败（${email}）：${reply.raw}`);
  return (reply.body as { data: { ticket: string; staff: Staff } }).data;
}

/** 带会话票据的 inject。默认用 admin；权限用例显式传 `token`（`null` = 不带票据）。 */
async function call(options: {
  method: "GET" | "POST" | "PATCH";
  url: string;
  token?: string | null;
  payload?: unknown;
}): Promise<Reply> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? adminTicket : options.token;
  if (token !== null) headers["x-staff-session"] = token;
  return toReply(
    await app.inject({
      method: options.method,
      url: options.url,
      headers,
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
    }),
  );
}

/**
 * 正文夹具：一段长得足以切出一个块（`MIN_CHUNK_CHARS` 60）的英文说明，里面埋一个
 * **只由字母数字组成**的检索标记（`to_tsvector('simple', ...)` 会按标点切词，
 * 带连字符的标记会让 FTS 命中变成两段词，断言就不可靠）。
 */
function bodyOf(marker: string, extra = ""): string {
  return [
    `## Index rebuild ${marker}`,
    "",
    `Marker ${marker} appears here on purpose: it is the only token that can match this document.`,
    "Torque the DC terminals to 12 Nm, verify the isolation resistance and confirm the firmware version",
    "before energising the cabinet. Keep the service log for the next maintenance interval.",
    extra,
  ].join("\n");
}

/** 每篇文档一个独立的检索标记（小写字母数字）。 */
function markerOf(useCase: string): string {
  return `${FIXTURE}${useCase.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
}

async function createDocument(useCase: string, body: string, token?: string): Promise<DocBody> {
  const reply = await call({
    method: "POST",
    url: "/api/admin/documents",
    token,
    payload: { title: `${FIXTURE} ${useCase}`, lang: "en", body },
  });
  assert.equal(reply.status, 201, `新建文档期望 201（${useCase}），实际 ${reply.status}：${reply.raw}`);
  const doc = (reply.body as { data: DocBody }).data;
  createdDocs.add(doc.id);
  return doc;
}

/** 轮询重建句柄直到它离开 `running`。超时即失败（异步任务卡住是必须被看见的故障）。 */
async function waitForJob(id: string): Promise<JobBody> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const reply = await call({ method: "GET", url: `/api/admin/documents/${id}/rebuild` });
    assert.equal(reply.status, 200, `重建状态期望 200，实际 ${reply.status}：${reply.raw}`);
    const job = (reply.body as { data: JobBody }).data;
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`重建在 60s 内没有结束（doc ${id}）`);
}

/** 发起重建并等它结束。返回这次重建的终态。 */
async function rebuildNow(id: string): Promise<JobBody> {
  const reply = await call({ method: "POST", url: `/api/admin/documents/${id}/rebuild` });
  assert.equal(reply.status, 202, `发起重建期望 202，实际 ${reply.status}：${reply.raw}`);
  const accepted = (reply.body as { data: { job_id: string; status: string } }).data;
  assert.equal(accepted.status, "running", "202 的语义是受理，状态必须是 running");
  assert.equal(typeof accepted.job_id, "string", "202 必须给一个可轮询的 job_id");
  const job = await waitForJob(id);
  assert.equal(job.job_id, accepted.job_id, "轮询读到的必须就是刚发起的那一次重建");
  return job;
}

async function getDetail(id: string): Promise<DocBody> {
  const reply = await call({ method: "GET", url: `/api/admin/documents/${id}` });
  assert.equal(reply.status, 200, `详情期望 200，实际 ${reply.status}：${reply.raw}`);
  return (reply.body as { data: DocBody }).data;
}

/** 库里这篇文档的片段（id + 正文），用来断言"失败时一个字节都没动"。 */
async function chunksOf(docId: string): Promise<{ id: string; content: string }[]> {
  const { query } = await import("../src/db.ts");
  return query<{ id: string; content: string }>(
    `select id::text as id, content from chunks where doc_id = $1 order by seq`,
    [docId],
  );
}

/**
 * 这段正文能不能被检索命中。走真 `retrieve()`（含 `documents.status` 过滤）。
 *
 * 断言落在**片段正文是否含这枚标记**上，而不是"结果里有没有这篇文档的 doc_id"：
 * 向量路本来就会返回 20 条"最近"的片段（与查询是否相关无关，相关度由分数表达），
 * 所以"结果里出现这篇文档"几乎恒真 —— 那种断言证明不了任何事，只会把红变绿。
 */
async function retrievesContent(token: string): Promise<boolean> {
  const { retrieve } = await import("../src/core/retrieval.ts");
  // topK 给到 50（> 两路候选上限 40）：融合后不截断，于是"命不命中"是确定性的，
  // 不需要去猜阈值 —— 阈值比较本来就是调用方的事，不是这张卡关心的东西。
  const result = await retrieve({ query: token, lang: "en", topK: 50 });
  return result.chunks.some((chunk) => chunk.content.includes(token));
}

/* ─────────────────── ① 角色矩阵 ─────────────────── */

test("角色矩阵：无票据 401、agent 全 403、lead 只读、admin 全通", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  // admin 建一篇（全程不重建，零 embedding 开销），下面拿它的 id 试各种越权动作。
  const doc = await createDocument("roles", bodyOf(markerOf("roles")));
  assert.equal(doc.status, "pending", "新建必须落 pending（待重建）");
  assert.equal(doc.version, 0, "新建的 version 必须是 0（从未重建）");
  assert.equal(doc.chunkCount, 0, "新建不该有片段");
  assert.equal(doc.rebuild.status, "idle", "从未重建过的文档，rebuild.status 必须是 idle");
  assert.equal(doc.rebuild.job_id, null, "idle 时不该有 job_id");
  assert.equal(doc.body?.includes(markerOf("roles")), true, "详情必须回正文（库里是真源）");

  const id = doc.id;
  const writes = [
    { method: "POST" as const, url: "/api/admin/documents", payload: { title: "x", lang: "en", body: "y" } },
    { method: "PATCH" as const, url: `/api/admin/documents/${id}`, payload: { title: "x" } },
    { method: "POST" as const, url: `/api/admin/documents/${id}/rebuild` },
    { method: "POST" as const, url: `/api/admin/documents/${id}/rollback` },
    { method: "POST" as const, url: `/api/admin/documents/${id}/archive` },
  ];
  const reads = [
    { method: "GET" as const, url: "/api/admin/documents" },
    { method: "GET" as const, url: `/api/admin/documents/${id}` },
    { method: "GET" as const, url: `/api/admin/documents/${id}/rebuild` },
  ];

  // 没票据 → 401（前端据此回登录页，而不是"权限不足"）
  for (const callSpec of [...reads, ...writes]) {
    const reply = await call({ ...callSpec, token: null });
    assert.equal(reply.status, 401, `无票据 ${callSpec.method} ${callSpec.url} 期望 401，实际 ${reply.status}`);
    assert.equal((reply.body as ErrorBody).error.code, "AUTH_REQUIRED");
  }

  // agent：连 lead 那一档都进不去（读和写都是 403）
  for (const callSpec of [...reads, ...writes]) {
    const reply = await call({ ...callSpec, token: agentTicket });
    assert.equal(reply.status, 403, `agent ${callSpec.method} ${callSpec.url} 期望 403，实际 ${reply.status}`);
    assert.equal((reply.body as ErrorBody).error.code, "FORBIDDEN");
  }

  // lead：三个读都通，五个写全 403（知识库的写是 admin 的签字动作）
  for (const callSpec of reads) {
    const reply = await call({ ...callSpec, token: leadTicket });
    assert.equal(reply.status, 200, `lead ${callSpec.method} ${callSpec.url} 期望 200，实际 ${reply.status}：${reply.raw}`);
  }
  for (const callSpec of writes) {
    const reply = await call({ ...callSpec, token: leadTicket });
    assert.equal(reply.status, 403, `lead ${callSpec.method} ${callSpec.url} 期望 403，实际 ${reply.status}`);
    assert.equal((reply.body as ErrorBody).error.code, "FORBIDDEN");
  }

  // 被 403 拒掉的写操作不得改状态（状态与 chunks 都没动）
  const after = await getDetail(id);
  assert.equal(after.status, "pending", "被拒的写操作不得改状态");
  assert.equal((await chunksOf(id)).length, 0, "被拒的写操作不得写片段");

  // 不存在的文档 → 404（形状不对的 id 也是 404：那串东西不可能对应一篇文档）
  const missing = await call({ method: "GET", url: `/api/admin/documents/${randomUUID()}` });
  assert.equal(missing.status, 404, `不存在的文档期望 404，实际 ${missing.status}：${missing.raw}`);
  const malformed = await call({ method: "GET", url: "/api/admin/documents/not-a-uuid" });
  assert.equal(malformed.status, 404, `畸形 id 期望 404，实际 ${malformed.status}：${malformed.raw}`);
});

/* ─────────────────── ② 新建 → 重建 → 可检索 ─────────────────── */

test("新建只有正文：pending + 零片段（检索不命中）→ 重建 → indexed + 内容可检索", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const marker = markerOf("rebuild");
  const doc = await createDocument("rebuild", bodyOf(marker));

  // 建完还没重建：库里一个片段都没有，于是检索命不中（这正是"待重建"的意思）
  assert.equal((await chunksOf(doc.id)).length, 0, "pending 的文档不该有任何片段");
  assert.equal(await retrievesContent(marker), false, "没有片段时检索不该命中这篇");

  // 列表筛选：pending 筛得到，indexed 筛不到，all/不写 都包含它
  const pendingOnly = await call({ method: "GET", url: "/api/admin/documents?status=pending&size=100" });
  assert.equal(pendingOnly.status, 200, `列表期望 200，实际 ${pendingOnly.status}：${pendingOnly.raw}`);
  const pendingList = (pendingOnly.body as { data: { items: DocBody[]; page: number; size: number; total: number } }).data;
  assert.equal(pendingList.page, 1);
  assert.equal(pendingList.size, 100);
  assert.equal(pendingList.items.some((item) => item.id === doc.id), true, "status=pending 应筛到刚建的那篇");
  assert.equal(Object.hasOwn(pendingList.items[0] ?? {}, "body"), false, "列表行不该带正文");

  const indexedOnly = await call({ method: "GET", url: "/api/admin/documents?status=indexed&size=100" });
  const indexedList = (indexedOnly.body as { data: { items: DocBody[] } }).data;
  assert.equal(indexedList.items.some((item) => item.id === doc.id), false, "status=indexed 不该筛到 pending");

  const bad = await call({ method: "GET", url: "/api/admin/documents?status=indxed" });
  assert.equal(bad.status, 400, `拼错的状态期望 400，实际 ${bad.status}：${bad.raw}`);

  // 正文与已有文档完全相同 → 409（sha256 唯一，不能翻成 500）
  const duplicate = await call({
    method: "POST",
    url: "/api/admin/documents",
    payload: { title: `${FIXTURE} dup`, lang: "en", body: bodyOf(marker) },
  });
  assert.equal(duplicate.status, 409, `同正文再建一次期望 409，实际 ${duplicate.status}：${duplicate.raw}`);
  assert.equal((duplicate.body as ErrorBody).error.code, "CONFLICT");

  // 重建 → indexed
  const job = await rebuildNow(doc.id);
  assert.equal(job.status, "succeeded", `重建应成功，实际 ${job.status}（error=${String(job.error)}）`);
  assert.equal(job.error, null);
  assert.equal((job.chunk_count ?? 0) > 0, true, "成功的重建必须报出块数");

  const after = await getDetail(doc.id);
  assert.equal(after.status, "indexed", `重建后状态应为 indexed，实际 ${after.status}`);
  assert.equal(after.version, 1, "第一次重建把 version 推到 1");
  assert.equal(after.chunkCount, job.chunk_count, "详情里的 chunkCount 必须与重建结果一致");
  assert.equal(after.rebuild.status, "succeeded");
  assert.equal(after.rebuild.job_id, job.job_id);
  assert.equal((await chunksOf(doc.id)).length, after.chunkCount, "chunks 行数必须等于 chunkCount");

  // 内容可检索（走真 retrieve：库里有时索引对不上，只有检索能证明）
  assert.equal(await retrievesContent(marker), true, "重建之后这篇的内容必须能被检索命中");

  // 审计留痕：建 + 重建各一条，actor 是真实登录人
  const { query } = await import("../src/db.ts");
  const audits = await query<{ action: string; actor: string | null }>(
    `select action, actor from audit_log where target = $1 order by id`,
    [`document:${doc.id}`],
  );
  assert.deepEqual(
    audits.map((row) => row.action),
    ["document.create", "document.rebuild"],
    "新建与重建各写一条审计",
  );
  assert.equal(audits[0]?.actor, admin.name, `审计 actor 必须是真实登录人，实际 "${String(audits[0]?.actor)}"`);
});

/* ─────────────────── ③ 改正文 → pending（旧索引仍可检索）→ 再重建 ─────────────────── */

test("改正文：status 回 pending、旧片段仍在（旧内容仍可检索）→ 再重建 → 新内容命中、version+1", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const v1 = markerOf("editv1");
  const v2 = markerOf("editv2");
  const doc = await createDocument("edit", bodyOf(v1));
  await rebuildNow(doc.id);
  const first = await getDetail(doc.id);
  assert.equal(first.version, 1);
  const chunksV1 = await chunksOf(doc.id);
  assert.equal(chunksV1.length > 0, true);

  const patched = await call({
    method: "PATCH",
    url: `/api/admin/documents/${doc.id}`,
    payload: { body: bodyOf(v2) },
  });
  assert.equal(patched.status, 200, `编辑期望 200，实际 ${patched.status}：${patched.raw}`);
  const patchedData = (patched.body as { data: { document: DocBody; changed: string[] } }).data;
  assert.equal(patchedData.document.status, "pending", "改了正文必须落回 pending（该重建了）");
  assert.deepEqual(patchedData.changed.sort(), ["body", "status"], "changed 只报真改了的字段");
  assert.equal(patchedData.document.version, 1, "编辑不动 version（重建才 +1）");
  assert.equal(patchedData.document.body, bodyOf(v2), "详情回显新正文");

  // 中间态：旧索引原地不动，旧内容仍然可检索；新内容检索不到（还没建）
  assert.deepEqual(await chunksOf(doc.id), chunksV1, "pending 期间旧片段必须原样留着");
  assert.equal(await retrievesContent(v1), true, "重建之前旧内容仍应可检索（可解释的中间态）");
  assert.equal(await retrievesContent(v2), false, "还没重建，新内容不该被检索到（也不能命中半篇）");

  const job = await rebuildNow(doc.id);
  assert.equal(job.status, "succeeded", `第二次重建应成功：error=${String(job.error)}`);
  const second = await getDetail(doc.id);
  assert.equal(second.version, 2, "第二次重建把 version 推到 2");
  assert.equal(second.status, "indexed");

  assert.equal(await retrievesContent(v2), true, "重建之后新内容必须可检索");
  assert.equal(await retrievesContent(v1), false, "旧内容的片段必须已被换掉（否则同一篇会答两次不同答案）");

  // 两版快照都在（回滚的依据）
  const { query } = await import("../src/db.ts");
  const versions = await query<{ version: number }>(
    `select version from document_versions where doc_id = $1 order by version`,
    [doc.id],
  );
  assert.deepEqual(versions.map((row) => row.version), [1, 2], "每重建一次留一版快照");

  // 只改标题不需要重建（标题是从 documents join 出来显示的，不进向量）
  const retitled = await call({
    method: "PATCH",
    url: `/api/admin/documents/${doc.id}`,
    payload: { title: `${FIXTURE} edit renamed` },
  });
  assert.equal(retitled.status, 200, `改标题期望 200，实际 ${retitled.status}：${retitled.raw}`);
  const retitledData = (retitled.body as { data: { document: DocBody; changed: string[] } }).data;
  assert.equal(retitledData.document.status, "indexed", "只改标题不该把状态打回 pending");
  assert.deepEqual(retitledData.changed, ["title"]);

  // 空补丁 → 400（一次拼错字段名的保存若被当成成功，管理员会以为已经改完了）
  const empty = await call({ method: "PATCH", url: `/api/admin/documents/${doc.id}`, payload: { nothing: 1 } });
  assert.equal(empty.status, 400, `空补丁期望 400，实际 ${empty.status}：${empty.raw}`);
});

/* ─────────────────── ④ 重建失败：旧索引一个字节都不动 ─────────────────── */

test("重建失败：status=failed + err 记原因，chunks/version 与失败前完全一致，随后能重建成功", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const marker = markerOf("fail");
  const doc = await createDocument("fail", bodyOf(marker));
  await rebuildNow(doc.id);
  const before = await getDetail(doc.id);
  assert.equal(before.version, 1);
  const chunksBefore = await chunksOf(doc.id);
  assert.equal(chunksBefore.length > 0, true);

  // 注入一次必然失败的重建：正文置空。接口层不许写空正文（那是 400），
  // 所以这里直接改库 —— 它模拟的是"数据被别的路径弄坏了"，而重建必须**诚实失败**而不是
  // 建出一个空索引（那样用户会得到"这篇文档突然什么都不知道"）。
  const { query } = await import("../src/db.ts");
  await query(`update documents set body = '', status = 'pending', updated_at = now() where id = $1`, [doc.id]);

  const failedJob = await rebuildNow(doc.id);
  assert.equal(failedJob.status, "failed", "空正文的重建必须失败");
  assert.equal(failedJob.error, "empty_after_clean", `失败原因应是 empty_after_clean，实际 "${String(failedJob.error)}"`);
  assert.equal(failedJob.chunk_count, null, "失败的重建不报块数");

  const afterFail = await getDetail(doc.id);
  assert.equal(afterFail.status, "failed", "失败后文档状态必须是 failed（可再次发起重建）");
  assert.equal(afterFail.version, before.version, "失败不得改 version");
  assert.equal(afterFail.chunkCount, before.chunkCount, "失败不得改 chunkCount");
  assert.equal(afterFail.rebuild.status, "failed");
  assert.equal(afterFail.rebuild.error, "empty_after_clean");

  // 旧索引一个字节都没动：片段 id 与正文逐个相同（id 相同说明是同一批行，不是重建后又恢复的）
  assert.deepEqual(await chunksOf(doc.id), chunksBefore, "失败的重建不许动 chunks（半个库就是错答案）");
  assert.equal(await retrievesContent(marker), true, "失败之后旧索引仍然可用");

  // 修回正文 → 再发起一次就能成功（失败不是终态）
  await query(`update documents set body = $2, status = 'pending' where id = $1`, [doc.id, bodyOf(marker)]);
  const retry = await rebuildNow(doc.id);
  assert.equal(retry.status, "succeeded", `修好正文后应能重建成功：error=${String(retry.error)}`);
  const afterRetry = await getDetail(doc.id);
  assert.equal(afterRetry.version, before.version + 1, "成功的那次才 +1");
  assert.equal(afterRetry.status, "indexed");
  assert.equal(await retrievesContent(marker), true);
});

/* ─────────────────── ⑤ 回滚：索引回到上一版，引用快照仍在 ─────────────────── */

test("回滚：chunks 回到上一版内容；citations.chunk_id 置 null 但快照字段仍在；没有上一版 → 409", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const v1 = markerOf("rollbackv1");
  const v2 = markerOf("rollbackv2");
  const doc = await createDocument("rollback", bodyOf(v1));
  await rebuildNow(doc.id);
  assert.equal(await retrievesContent(v1), true);

  // 引用快照夹具：一条真实形状的 citations 行，指着这一版的片段
  const { query } = await import("../src/db.ts");
  const convId = randomUUID();
  createdConvs.add(convId);
  await query(`insert into conversations (id, lang) values ($1, 'en')`, [convId]);
  const message = await query<{ id: string }>(
    `insert into messages (conv_id, role, content) values ($1, 'assistant', 'fixture') returning id::text as id`,
    [convId],
  );
  const chunkId = (await chunksOf(doc.id))[0]!.id;
  await query(
    `insert into citations (message_id, chunk_id, doc_title, doc_lang, page, snippet, score, idx)
     values ($1, $2, $3, 'en', 1, $4, 0.5, 1)`,
    [message[0]!.id, chunkId, `${FIXTURE} rollback`, "snapshot snippet"],
  );

  // v2：换正文再重建（这一版会把 v1 的片段删掉 → 引用的 chunk_id 置 null）
  await call({ method: "PATCH", url: `/api/admin/documents/${doc.id}`, payload: { body: bodyOf(v2) } });
  await rebuildNow(doc.id);
  assert.equal((await getDetail(doc.id)).version, 2);
  assert.equal(await retrievesContent(v2), true);

  const citation = async (): Promise<{ chunk_id: string | null; doc_title: string | null; snippet: string | null }> => {
    const rows = await query<{ chunk_id: string | null; doc_title: string | null; snippet: string | null }>(
      `select chunk_id::text as chunk_id, doc_title, snippet from citations where message_id = $1`,
      [message[0]!.id],
    );
    return rows[0]!;
  };
  const afterV2 = await citation();
  assert.equal(afterV2.chunk_id, null, "重建换掉片段后 citations.chunk_id 必须置 null（on delete set null）");
  assert.equal(afterV2.snippet, "snapshot snippet", "快照字段必须还在（历史回答要还能打开）");

  // 回滚 → v1 的片段原样装回来
  const rolled = await call({ method: "POST", url: `/api/admin/documents/${doc.id}/rollback` });
  assert.equal(rolled.status, 200, `回滚期望 200，实际 ${rolled.status}：${rolled.raw}`);
  const rolledDoc = (rolled.body as { data: DocBody }).data;
  assert.equal(rolledDoc.version, 1, "回滚把 version 退回 1");
  assert.equal(rolledDoc.status, "indexed", "回滚之后索引是好的（indexed）");

  const restored = await chunksOf(doc.id);
  assert.equal(restored.length, rolledDoc.chunkCount, "chunks 行数必须等于那一版的块数");
  assert.equal(restored[0]!.content.includes(v1), true, "回滚后片段内容必须是 v1 的");
  assert.equal(restored[0]!.content.includes(v2), false, "回滚后不该残留 v2 的内容");
  assert.equal(await retrievesContent(v1), true, "回滚之后 v1 的内容必须可检索");
  assert.equal(await retrievesContent(v2), false, "回滚之后 v2 的内容不该再命中");

  // 引用仍然开得（锚点丢一个，快照还在 —— 这是刻意接受的代价）
  const afterRollback = await citation();
  assert.equal(afterRollback.chunk_id, null, "回滚换了片段 id，锚点仍然是 null");
  assert.equal(afterRollback.doc_title, `${FIXTURE} rollback`, "快照里的标题还在");
  assert.equal(afterRollback.snippet, "snapshot snippet", "快照里的摘录还在");

  // 已经到 v1，再回滚 → 409（状态不允许，不是请求写错了）
  const noMore = await call({ method: "POST", url: `/api/admin/documents/${doc.id}/rollback` });
  assert.equal(noMore.status, 409, `没有上一版时回滚期望 409，实际 ${noMore.status}：${noMore.raw}`);
  assert.equal((noMore.body as ErrorBody).error.code, "CONFLICT");
  assert.equal((noMore.body as ErrorBody).error.message.includes("没有可回滚"), true, "报错要说清没有可回滚的版本");

  // 审计：编辑 / 两次重建 / 回滚都留痕
  const audits = await query<{ action: string }>(`select action from audit_log where target = $1 order by id`, [
    `document:${doc.id}`,
  ]);
  assert.deepEqual(
    audits.map((row) => row.action),
    ["document.create", "document.rebuild", "document.update", "document.rebuild", "document.rollback"],
    "新建 / 重建 / 编辑 / 重建 / 回滚各一条审计",
  );
});

/* ─────────────────── ⑥ 停用：行还在、检索不再命中、不许再改 ─────────────────── */

test("停用：status=archived、行与片段都在、检索不再命中，且不许再编辑/重建/回滚（409）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const marker = markerOf("archive");
  const doc = await createDocument("archive", bodyOf(marker));
  await rebuildNow(doc.id);
  assert.equal(await retrievesContent(marker), true, "停用前应当检索得到");
  const chunkCount = (await chunksOf(doc.id)).length;

  const archived = await call({ method: "POST", url: `/api/admin/documents/${doc.id}/archive` });
  assert.equal(archived.status, 200, `停用期望 200，实际 ${archived.status}：${archived.raw}`);
  const archivedDoc = (archived.body as { data: DocBody }).data;
  assert.equal(archivedDoc.status, "archived");
  assert.equal(archivedDoc.body?.includes(marker), true, "停用不得清正文");

  const { one } = await import("../src/db.ts");
  const still = await one<{ n: string }>(`select count(*)::text as n from documents where id = $1`, [doc.id]);
  assert.equal(still?.n, "1", "停用不许删行：行必须还在");
  assert.equal((await chunksOf(doc.id)).length, chunkCount, "停用不删片段（重建/回滚还要用）");

  // 检索不再命中（靠检索侧的 `d.status <> 'archived'`，不是靠删数据）
  assert.equal(await retrievesContent(marker), false, "停用之后检索不该再命中这篇");

  // 停用是终态：编辑 / 重建 / 回滚都是 409（状态不允许，不是 404）
  for (const callSpec of [
    { method: "PATCH" as const, url: `/api/admin/documents/${doc.id}`, payload: { title: "x" } },
    { method: "POST" as const, url: `/api/admin/documents/${doc.id}/rebuild` },
    { method: "POST" as const, url: `/api/admin/documents/${doc.id}/rollback` },
  ]) {
    const reply = await call(callSpec);
    assert.equal(reply.status, 409, `对已停用文档的 ${callSpec.method} ${callSpec.url} 期望 409，实际 ${reply.status}：${reply.raw}`);
    assert.equal((reply.body as ErrorBody).error.code, "CONFLICT");
  }

  // 重复停用是幂等的（双击按钮不该报错）
  const again = await call({ method: "POST", url: `/api/admin/documents/${doc.id}/archive` });
  assert.equal(again.status, 200, `重复停用期望 200，实际 ${again.status}：${again.raw}`);
});

/* ─────────────────── ⑦ 入参形状 ─────────────────── */

test("入参：缺 title/lang/body 与非法 lang 一律 400（不静默落库）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const cases: { label: string; payload: Record<string, unknown> }[] = [
    { label: "缺 title", payload: { lang: "en", body: "hello world, this is long enough to be a chunk" } },
    { label: "缺 lang", payload: { title: `${FIXTURE} x`, body: "hello world, this is long enough to be a chunk" } },
    { label: "缺 body", payload: { title: `${FIXTURE} x`, lang: "en" } },
    { label: "空正文", payload: { title: `${FIXTURE} x`, lang: "en", body: "   " } },
    { label: "非法 lang", payload: { title: `${FIXTURE} x`, lang: "fr", body: "hello world, long enough" } },
  ];
  for (const item of cases) {
    const reply = await call({ method: "POST", url: "/api/admin/documents", payload: item.payload });
    assert.equal(reply.status, 400, `${item.label} 期望 400，实际 ${reply.status}：${reply.raw}`);
    assert.equal((reply.body as ErrorBody).error.code, "VALIDATION");
  }
});
