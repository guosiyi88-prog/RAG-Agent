/**
 * 坐席端接口的黑盒验收（`07-console-and-security` #02 · 05 §4.1–§4.3、11 §2–§3）。
 *
 * 断言的是**契约与可观察副作用**，不是实现：列表条目的字段与排序、语言字段来自会话连接、
 * 筛选与分页上限、"AI 那一轮没有检索证据"的标记、认领落到谁头上、关单的 10 字门槛、
 * 已关单再改的 409、审计行是否真的多了一条、预留端点的 501、统计是真数字。
 *
 * 只注册 console 路由（不 `import ../src/routes.ts`）：本文件要能在别的路由半成品时独立
 * 变绿或变红；注册顺序的影响由 `tests/auth-boundaries.test.ts` 那层（走真实 `buildApp()`）覆盖。
 *
 * 并发提示：其它 agent 的测试共用同一个库。所有夹具的问题摘要带独有标记（`c07-<uuid8>-<用途>`），
 * 列表断言一律带 `q=<该标记>`，因此别的 agent 造的工单不会混进来；清理只删自己建的行
 * （按 id / 单号），**不按 reason 或 tags 批量删**。
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

const hasRuntimeEnv = Boolean(
  process.env.DATABASE_URL && process.env.REDIS_URL,
);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

/** 演示账号（`sql/002_seed.sql`）：`wt-demo-2026`，部署前必须改。 */
const DEMO_EMAIL = "zhang.wei@wotai.demo";
const DEMO_PASSWORD = "wt-demo-2026";
/**
 * `lead` 账号（李娜）。`09#03` 第三段起"派发给他人 / 清空指派"是 `lead` 的权力：
 * 一条要验派发路径的用例必须用它登录，而不是拿 agent 票据硬试（那现在会 403）。
 */
const LEAD_EMAIL = "li.na@wotai.demo";

/** 本文件的唯一夹具前缀：问题摘要与邮箱都带它，清理只按它造出来的 id 删。 */
const FIXTURE = `c07-${randomUUID().slice(0, 8)}`;

/** 每个用例一个标记：列表断言靠 `q=<标记>` 把自己造的行圈出来，互不干扰。 */
function mark(useCase: string): string {
  return `${FIXTURE}-${useCase}`;
}

type ErrorBody = { ok: false; error: { code: string; message: string; trace_id: string } };
type Reply = { status: number; body: unknown; raw: string };

/** 造出来的行，`after` 只清这些。 */
const conversationIds: string[] = [];
const ticketIds: string[] = [];
const ticketNos: string[] = [];
const staffIds: string[] = [];

let app: FastifyInstance;
/** 本文件全程用的一张会话票据（`before` 里登录一次，`after` 里删掉）。 */
let sessionTicket = "";
/** 登录账号自己的身份：认领的默认指派人必须等于它（不再有客户端自称的 `X-Admin-Staff`）。 */
let sessionStaff: { staff_id: string; name: string; role: string } = { staff_id: "", name: "", role: "" };
/** `lead` 票据：派发给他人 / 清空指派这两条路径只有它能走（`09#03` 第三段）。 */
let leadTicket = "";
let leadStaff: { staff_id: string; name: string; role: string } = { staff_id: "", name: "", role: "" };

before(async () => {
  if (!hasRuntimeEnv) return;
  const [{ default: Fastify }, { registerConsoleRoutes }, { registerAuthRoutes }, { toErrorBody }] = await Promise.all([
    import("fastify"),
    import("../src/api/console.ts"),
    import("../src/api/auth.ts"),
    import("../src/errors.ts"),
  ]);

  // 与 `src/server.ts` 同一个错误处理器：401/404/409 的信封形状必须是线上那一种。
  // 登录路由也挂在这里：`09#03` 起坐席接口只认会话票据，而票据只能从 `/api/auth/login` 拿到。
  app = Fastify({ logger: false });
  app.setErrorHandler((err, request, reply) => {
    const { status, body } = toErrorBody(err, String(request.id));
    return reply.code(status).send(body);
  });
  await registerConsoleRoutes(app);
  await registerAuthRoutes(app);
  await app.ready();

  const login = await loginAs(DEMO_EMAIL, DEMO_PASSWORD);
  sessionTicket = login.ticket;
  sessionStaff = login.staff;

  // 第二个身份：派发要 lead（`09#03` 第三段）。整个文件只在此处登录，避免撞 5 次/分钟限速。
  const leadLogin = await loginAs(LEAD_EMAIL, DEMO_PASSWORD);
  leadTicket = leadLogin.ticket;
  leadStaff = leadLogin.staff;
});

after(async () => {
  if (!hasRuntimeEnv) return;
  // `src/auth.ts` 会 import `src/redis.ts`：ioredis 的连接会一直挂住事件循环，
  // 不主动 quit 的话 `node --test` 跑完所有断言也不退出（表现是"卡住"而不是"失败"）。
  const [{ pool, query }, { redis }] = await Promise.all([import("../src/db.ts"), import("../src/redis.ts")]);
  if (app !== undefined) await app.close();

  // 顺序：审计（按单号）→ 工单（closed 行不可 UPDATE 但可以 DELETE）→ 会话（消息与引用级联）
  // → 坐席（工单已删，assignee 外键不会再挡住）。
  if (ticketNos.length > 0) await query("delete from audit_log where target = any($1::text[])", [ticketNos]);
  if (ticketIds.length > 0) await query("delete from tickets where id = any($1::bigint[])", [ticketIds]);
  if (conversationIds.length > 0) {
    await query("delete from conversations where id = any($1::uuid[])", [conversationIds]);
  }
  if (staffIds.length > 0) await query("delete from staff where id = any($1::uuid[])", [staffIds]);

  // 会话票据与限速计数都是本文件造出来的 Redis 状态，别留给下一个文件。
  if (sessionTicket !== "") await redis.del(`staff_session:${sessionTicket}`);
  if (leadTicket !== "") await redis.del(`staff_session:${leadTicket}`);
  await redis.del("login:127.0.0.1");

  await redis.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

/* ─────────────────────────── 夹具 ─────────────────────────── */

function toReply(response: { statusCode: number; body: string }): Reply {
  return { status: response.statusCode, body: JSON.parse(response.body) as unknown, raw: response.body };
}

/**
 * 登录拿一张会话票据（`09#03`：坐席接口只认 `x-staff-session`）。
 *
 * 先清掉 `login:127.0.0.1` 的限速计数：限速键是"每 IP 每分钟 5 次"，而 `app.inject` 的来源永远
 * 是 127.0.0.1，跨测试文件累计很容易在第 6 次撞上 429 —— 那是限速的**正确**行为，不该让
 * 一条无关的断言因此变红。只清 `login:` 这一个命名空间，不碰用户端配额（`quota:*`）。
 */
async function loginAs(
  email: string,
  password: string,
): Promise<{ ticket: string; staff: { staff_id: string; name: string; role: string } }> {
  const { redis } = await import("../src/redis.ts");
  await redis.del("login:127.0.0.1");
  const reply = toReply(
    await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } }),
  );
  assert.equal(reply.status, 200, `登录失败（${email}）：${reply.raw}`);
  return (reply.body as { data: { ticket: string; staff: { staff_id: string; name: string; role: string } } }).data;
}

/** 带会话票据的 inject。`token: null` 用于"没有票据"的用例。 */
async function call(options: {
  method: "GET" | "PATCH" | "POST";
  url: string;
  token?: string | null;
  /** 覆盖请求头里的票据（用旧 `x-admin-token` 之类的哨兵用例）。 */
  headers?: Record<string, string>;
  payload?: unknown;
}): Promise<Reply> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== null && options.headers === undefined) headers["x-staff-session"] = options.token ?? sessionTicket;
  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
  return toReply(response);
}

async function newConversation(lang: string | null): Promise<string> {
  const { one } = await import("../src/db.ts");
  const row = await one<{ id: string }>("insert into conversations (lang) values ($1) returning id", [lang]);
  assert.ok(row !== null, "会话插入失败");
  conversationIds.push(row.id);
  return row.id;
}

/** 造一张工单。`no` 不传就由序列生成（`WT-YYYY-NNNN`）。 */
async function newTicket(input: {
  convId?: string | null;
  reason?: string;
  question: string;
  status?: string;
  assignee?: string | null;
  /** ISO 字符串或 `null`（= 无截止时间）。 */
  dueAt?: string | null;
  createdAt?: string;
  tags?: string[];
  no?: string;
}): Promise<{ id: number; no: string }> {
  const { one } = await import("../src/db.ts");
  const row = await one<{ id: string; no: string }>(
    `insert into tickets (no, conv_id, reason, question, status, assignee, due_at, created_at, tags)
     values (coalesce($1::text, gen_ticket_no()), $2::uuid, $3, $4,
             coalesce($5::text, 'open'), $6::uuid, $7::timestamptz,
             coalesce($8::timestamptz, now()), coalesce($9::text[], '{}'::text[]))
     returning id, no`,
    [
      input.no ?? null,
      input.convId ?? null,
      input.reason ?? "no_citation",
      input.question,
      input.status ?? null,
      input.assignee ?? null,
      input.dueAt ?? null,
      input.createdAt ?? null,
      input.tags ?? null,
    ],
  );
  assert.ok(row !== null, "工单插入失败");
  ticketIds.push(row.id);
  ticketNos.push(row.no);
  return { id: Number(row.id), no: row.no };
}

async function newMessage(input: {
  convId: string;
  role: "user" | "assistant";
  content: string;
  refused?: boolean;
  toolNames?: string[];
  createdAt?: string;
}): Promise<number> {
  const { one } = await import("../src/db.ts");
  const row = await one<{ id: string }>(
    `insert into messages (conv_id, role, content, refused, tool_names, created_at)
     values ($1::uuid, $2, $3, coalesce($4::boolean, false), coalesce($5::text[], '{}'::text[]),
             coalesce($6::timestamptz, now()))
     returning id`,
    [
      input.convId,
      input.role,
      input.content,
      input.refused ?? null,
      input.toolNames ?? null,
      input.createdAt ?? null,
    ],
  );
  assert.ok(row !== null, "消息插入失败");
  return Number(row.id);
}

async function newCitation(input: { messageId: number; idx: number; title: string; page: number; snippet: string }): Promise<void> {
  const { query } = await import("../src/db.ts");
  await query(
    `insert into citations (message_id, chunk_id, doc_title, doc_lang, page, snippet, score, idx)
     values ($1::bigint, null, $2, 'de', $3, $4, 0.83, $5)`,
    [input.messageId, input.title, input.page, input.snippet, input.idx],
  );
}

type ListItem = {
  id: number;
  no: string;
  reason: string;
  status: string;
  question: string;
  lang: string | null;
  assignee: string | null;
  assignee_id: string | null;
  due_at: string | null;
  sla_seconds_left: number | null;
  demo: boolean;
  created_at: string;
};

async function list(query: Record<string, string>): Promise<{ total: number; items: ListItem[] }> {
  const search = new URLSearchParams(query).toString();
  const reply = await call({ method: "GET", url: `/api/console/tickets?${search}` });
  assert.equal(reply.status, 200, `列表期望 200，实际 ${reply.status}：${reply.raw}`);
  return (reply.body as { data: { total: number; items: ListItem[] } }).data;
}

async function detail(id: number): Promise<{
  ticket: ListItem & { resolution: string | null; closed_at: string | null };
  conversation: { id: string; lang: string | null } | null;
  messages: {
    id: number;
    role: string;
    content: string;
    created_at: string;
    refused?: boolean;
    citations_count?: number;
    tool_names?: string[];
    no_evidence?: boolean;
    citations?: { idx: number; doc_title: string | null; page: number | null; doc_lang: string | null; snippet: string | null }[];
  }[];
}> {
  const reply = await call({ method: "GET", url: `/api/console/tickets/${id}` });
  assert.equal(reply.status, 200, `详情期望 200，实际 ${reply.status}：${reply.raw}`);
  return (reply.body as { data: never }).data;
}

/* ─────────────────────── ① 鉴权：三个业务端点 ─────────────────────── */

test("坐席接口：三个业务端点 × 无票据/伪造票据 → 401（都是 AUTH_REQUIRED），旧令牌头 401", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const calls = [
    { label: "GET /api/console/tickets", method: "GET" as const, url: "/api/console/tickets" },
    { label: "GET /api/console/tickets/:id", method: "GET" as const, url: "/api/console/tickets/1" },
    {
      label: "PATCH /api/console/tickets/:id",
      method: "PATCH" as const,
      url: "/api/console/tickets/1",
      payload: { status: "claimed" },
    },
  ];

  for (const item of calls) {
    const missing = await call({ method: item.method, url: item.url, token: null, payload: item.payload });
    assert.equal(missing.status, 401, `${item.label} 无票据期望 401，实际 ${missing.status}：${missing.raw}`);
    assert.equal((missing.body as ErrorBody).error.code, "AUTH_REQUIRED");

    // 伪造票据与"没登录"回同一个码：对调用方的行动完全一致（重新登录），
    // 而区分开只等于告诉对方"这个票据存在过"（会话存在性预言机）。
    const wrong = await call({
      method: item.method,
      url: item.url,
      token: `${sessionTicket}-wrong`,
      payload: item.payload,
    });
    assert.equal(wrong.status, 401, `${item.label} 伪造票据期望 401，实际 ${wrong.status}：${wrong.raw}`);
    assert.equal((wrong.body as ErrorBody).error.code, "AUTH_REQUIRED");
    // 错误体不得带堆栈或连接串（G5）。
    assert.equal(wrong.raw.includes("at "), false, `错误体出现堆栈：${wrong.raw}`);
    assert.equal(wrong.raw.includes("://"), false, `错误体出现连接串：${wrong.raw}`);
  }

  // 旧的共享令牌头已退场（boundary-change-R2 §3 B5，§6 不做双轨）：现在它只是一段没人读的
  // 请求头，结果与"没登录"完全一样 —— 401。
  const legacy = await call({
    method: "GET",
    url: "/api/console/tickets",
    headers: { "x-admin-token": "change-me-admin-token" },
  });
  assert.equal(legacy.status, 401, `旧 x-admin-token 必须 401，实际 ${legacy.status}：${legacy.raw}`);
  assert.equal((legacy.body as ErrorBody).error.code, "AUTH_REQUIRED");
});

/* ─────────────────────── ② 列表：字段与排序 ─────────────────────── */

test("队列：条目字段齐全，排序 = due_at 升序（空值最后）→ created_at 降序", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("sort");
  const convId = await newConversation("de");
  // 两条工单用**同一个** due_at 字面值：分别调用 now() + interval 会差出微秒，
  // 那样测的就不是 created_at 这个次序键了。
  const sameDue = new Date(Date.now() + 2 * 3600_000).toISOString();

  // 先建"更早创建"的那条，再建"更晚创建"的那条，断言顺序确实由 created_at 决定而非插入顺序。
  const older = await newTicket({
    convId,
    question: `排序较旧 ${tag}`,
    dueAt: sameDue,
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    tags: ["demo"],
  });
  const newer = await newTicket({
    convId,
    question: `排序较新 ${tag}`,
    dueAt: sameDue,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const noDue = await newTicket({ convId, question: `无截止 ${tag}`, dueAt: null });

  const { total, items } = await list({ q: tag });
  assert.equal(total, 3, `total 只该数到本用例的 3 张，实际 ${total}`);
  assert.deepEqual(
    items.map((item) => item.id),
    [newer.id, older.id, noDue.id],
    "同一 due_at 时按 created_at 降序；无截止时间（null）排最后",
  );

  const first = items[0] as ListItem;
  // 字段齐全：单号 / 原因 / 状态 / 问题 / 语言 / 指派 / 截止 / 剩余秒数 / 创建时间 + demo。
  assert.equal(typeof first.id, "number");
  assert.match(first.no, /^WT-\d{4}-\d{4}$/);
  assert.equal(first.reason, "no_citation");
  assert.equal(first.status, "open");
  assert.equal(first.lang, "de", "语言必须来自会话连接（tickets 表没有 lang 列）");
  assert.equal(first.assignee, null);
  assert.equal(first.assignee_id, null);
  assert.equal(first.due_at, new Date(sameDue).toISOString());
  assert.equal(typeof first.sla_seconds_left, "number");
  assert.ok(
    (first.sla_seconds_left as number) > 7000 && (first.sla_seconds_left as number) <= 7200,
    `剩余秒数应约 7200，实际 ${String(first.sla_seconds_left)}`,
  );
  assert.equal(typeof first.created_at, "string");
  assert.equal(typeof first.demo, "boolean");

  // demo 由 tags 派生（08#03 的演示数据要靠它）：只有标了 demo 的那张是 true。
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.equal(byId.get(older.id)?.demo, true);
  assert.equal(byId.get(newer.id)?.demo, false);
  // 无截止时间 → 剩余秒数为 null（不是 0）。
  assert.equal(byId.get(noDue.id)?.sla_seconds_left, null);
});

test("队列：超时工单的 remaining 是负数（不夹到 0，前端要显示「超时 xx 分钟」）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("overdue");
  const overdue = await newTicket({
    question: `已超时 ${tag}`,
    dueAt: new Date(Date.now() - 45 * 60_000).toISOString(),
  });

  const { items } = await list({ q: tag });
  const item = items.find((entry) => entry.id === overdue.id);
  assert.ok(item !== undefined);
  assert.ok((item.sla_seconds_left as number) < -2400, `超时应为明显负数，实际 ${String(item.sla_seconds_left)}`);
});

/* ─────────────────────── ③ 列表：筛选与上限 ─────────────────────── */

test("队列：默认不含 closed；status 多选、reason、q（单号与问题）都生效", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("filter");
  const open = await newTicket({ question: `筛选开放 ${tag}`, reason: "no_citation" });
  const claimed = await newTicket({ question: `筛选已认领 ${tag}`, reason: "low_conf", status: "claimed" });
  // 升级单只用来把"默认视图 = 除 closed 之外全部"的总数撑到 3，不单独筛它。
  await newTicket({ question: `筛选升级 ${tag}`, reason: "out_of_scope", status: "escalated" });
  const toClose = await newTicket({ question: `筛选将关闭 ${tag}`, reason: "no_citation" });

  // 关单走一次真实补丁：这样"默认不含 closed"测的是线上那条路径产出的行，不是手工造的状态。
  const closed = await call({
    method: "PATCH",
    url: `/api/console/tickets/${toClose.id}`,
    payload: { status: "closed", resolution: "电话指导复位后恢复正常运行" },
  });
  assert.equal(closed.status, 200, `关单失败：${closed.raw}`);

  // 默认：除 closed 之外全部（这里是 3 张：open / claimed / escalated）。
  const all = await list({ q: tag, size: "100" });
  assert.equal(all.total, 3, `默认视图不该含 closed，实际 total=${all.total}`);
  assert.equal(
    all.items.some((item) => item.status === "closed"),
    false,
    "默认视图出现了已关闭工单",
  );

  // 多选 status：逗号分隔必须真的生效（不是"第一个生效"）。
  const multi = await list({ q: tag, status: "open,claimed" });
  assert.deepEqual(
    multi.items.map((item) => item.id).sort((a, b) => a - b),
    [open.id, claimed.id].sort((a, b) => a - b),
    "status=open,claimed 应只回这两张",
  );

  // 显式要 closed 时必须能拿到（"已关闭"标签页就靠它）。
  const onlyClosed = await list({ q: tag, status: "closed" });
  assert.deepEqual(onlyClosed.items.map((item) => item.id), [toClose.id]);

  // reason 筛选。
  const byReason = await list({ q: tag, reason: "low_conf" });
  assert.deepEqual(byReason.items.map((item) => item.id), [claimed.id]);

  // q 命中单号：这张单的问题摘要里**没有**这个标记，只能靠 no 命中。
  const noMark = `WTQ-${FIXTURE}`;
  const byNo = await newTicket({ question: "单号命中的工单", no: noMark });
  const qNo = await list({ q: noMark });
  assert.deepEqual(qNo.items.map((item) => item.id), [byNo.id], "q 必须能命中单号");

  // q 命中问题摘要：单号是序列生成的，不含标记。
  const questionMark = `qq-${FIXTURE}`;
  const byQuestion = await newTicket({ question: `问题摘要 ${questionMark} 命中` });
  const qQuestion = await list({ q: questionMark });
  assert.deepEqual(qQuestion.items.map((item) => item.id), [byQuestion.id], "q 必须能命中问题摘要");

  // 拼错的枚举值回 400（静默忽略会让坐席以为自己在看待处理，其实看的是默认视图）。
  const bad = await call({ method: "GET", url: `/api/console/tickets?status=opne&q=${encodeURIComponent(tag)}` });
  assert.equal(bad.status, 400);
  assert.equal((bad.body as ErrorBody).error.code, "VALIDATION");
});

test("队列：size=1000 被夹到上限 100（不是静默失败，也不是 400）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const reply = await call({ method: "GET", url: "/api/console/tickets?size=1000" });
  assert.equal(reply.status, 200, `size 超上限应该是 200 + 夹住，实际 ${reply.status}：${reply.raw}`);
  const data = (reply.body as { data: { total: number; items: ListItem[] } }).data;
  assert.ok(data.items.length <= 100, `单页不得超过 100 条，实际 ${data.items.length}`);
  // 上限生效而不是"库里只有这么几条"：total 可以大于一页，items 仍被夹住。
  assert.equal(typeof data.total, "number");

  // 非整数 size 是调用方的 bug（400），与"超界"要区分开。
  const malformed = await call({ method: "GET", url: "/api/console/tickets?size=abc" });
  assert.equal(malformed.status, 400);
  assert.equal((malformed.body as ErrorBody).error.code, "VALIDATION");
});

/* ─────────────────────── ④ 语言：跨表取值 ─────────────────────── */

test("队列：lang 来自 conversations 连接；没有会话时为 null", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("lang");
  const convId = await newConversation("de");
  const withConv = await newTicket({ convId, question: `有会话 ${tag}` });
  const withoutConv = await newTicket({ convId: null, question: `无会话 ${tag}` });

  const { items } = await list({ q: tag, size: "100" });
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.equal(byId.get(withConv.id)?.lang, "de", "有会话时必须取会话的语言");
  assert.equal(byId.get(withoutConv.id)?.lang, null, "没有会话时 lang 必须是 null（不给默认语言）");
});

/* ─────────────────────── ⑤ 详情 ─────────────────────── */

test("详情：对话、引用（idx 升序）、无证据标记、404", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("detail");
  const convId = await newConversation("de");
  const ticket = await newTicket({ convId, question: `详情用例 ${tag}` });

  /** 消息按插入顺序即 created_at 顺序（同一毫秒时 order by 里有 id 兜底）。 */
  const userId = await newMessage({ convId, role: "user", content: "Wechselrichter zeigt E03" });
  const citedId = await newMessage({
    convId,
    role: "assistant",
    content: "E03 bedeutet … [1][2]",
    toolNames: ["kb_search"],
  });
  // 故意先插 idx=2 再插 idx=1：返回顺序必须是 idx 升序，而不是插入顺序。
  await newCitation({ messageId: citedId, idx: 2, title: "Installationshandbuch 600W", page: 12, snippet: "Die Netzspannung muss …" });
  await newCitation({ messageId: citedId, idx: 1, title: "Sicherheitshinweise", page: 3, snippet: "Vor Arbeiten freischalten." });

  const noEvidenceId = await newMessage({ convId, role: "assistant", content: "Bitte kontaktieren Sie uns.", toolNames: [] });
  const refusedId = await newMessage({ convId, role: "assistant", content: "Dazu kann ich nichts sagen.", refused: true });

  const data = await detail(ticket.id);
  assert.equal(data.ticket.id, ticket.id);
  assert.equal(data.ticket.resolution, null);
  assert.equal(data.ticket.closed_at, null);
  assert.deepEqual(data.conversation, { id: convId, lang: "de" });
  assert.deepEqual(
    data.messages.map((message) => message.id),
    [userId, citedId, noEvidenceId, refusedId],
    "消息必须按时间升序（同一毫秒由 id 兜底）",
  );

  const [userMsg, cited, noEvidence, refused] = data.messages;
  assert.ok(userMsg !== undefined && cited !== undefined && noEvidence !== undefined && refused !== undefined);

  // 用户消息没有那五个 assistant 专属字段（有的话前端会多出"用户消息也能标拒答"的分支）。
  assert.equal("citations" in userMsg, false);
  assert.equal("no_evidence" in userMsg, false);
  assert.equal("refused" in userMsg, false);

  // 有引用的 AI 消息：idx 升序，doc_title / page / snippet 都有值。
  assert.equal(cited.refused, false);
  assert.equal(cited.citations_count, 2);
  assert.deepEqual(cited.tool_names, ["kb_search"]);
  assert.equal(cited.no_evidence, false);
  assert.deepEqual(cited.citations?.map((cite) => cite.idx), [1, 2], "引用必须按 idx 升序");
  for (const cite of cited.citations ?? []) {
    assert.equal(typeof cite.doc_title, "string");
    assert.equal(typeof cite.page, "number");
    assert.equal(typeof cite.snippet, "string");
    assert.equal(cite.doc_lang, "de");
  }

  // 无引用且未拒答 → 明确标记"本轮无检索证据"（坐席据此决定能不能直接采纳）。
  assert.equal(noEvidence.refused, false);
  assert.equal(noEvidence.citations_count, 0);
  assert.deepEqual(noEvidence.citations, []);
  assert.equal(noEvidence.no_evidence, true, "无引用且未拒答的 AI 消息必须带 no_evidence: true");

  // 拒答本身已经是"没有证据"的显式表达，不再叠一层面包屑式的 no_evidence。
  assert.equal(refused.refused, true);
  assert.equal(refused.no_evidence, false);

  // 不存在 / 形状不对的 id 都是 404（锚点里贴错一个 id 对坐席就是"这单没了"）。
  const missing = await call({ method: "GET", url: "/api/console/tickets/999999999" });
  assert.equal(missing.status, 404);
  assert.equal((missing.body as ErrorBody).error.code, "NOT_FOUND");
  const malformed = await call({ method: "GET", url: "/api/console/tickets/not-an-id" });
  assert.equal(malformed.status, 404);
  assert.equal((malformed.body as ErrorBody).error.code, "NOT_FOUND");
});

test("详情：没有会话的工单返回空消息列表（而不是 404/500）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("noconv");
  const ticket = await newTicket({ convId: null, question: `无会话详情 ${tag}` });
  const data = await detail(ticket.id);
  assert.equal(data.conversation, null);
  assert.deepEqual(data.messages, []);
});

/* ─────────────────────── ⑥ 认领 ─────────────────────── */

test("认领：指派给会话里的坐席；显式 assignee_id 走派发；清空后重新认领回到自己", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("claim");

  // 自建一个坐席夹具，用来验"显式派发给别人"这条路径（与"我"无关）。
  const { one } = await import("../src/db.ts");
  const fixtureStaff = await one<{ id: string; name: string }>(
    "insert into staff (name, email) values ($1, $2) returning id, name",
    [`测试坐席 ${FIXTURE}`, `${FIXTURE}-staff@example.com`],
  );
  assert.ok(fixtureStaff !== null);
  staffIds.push(fixtureStaff.id);

  // 显式 assignee_id = 派发给指定坐席（`09#03` 第三段起这是 `lead`/`admin` 的权力，
  // 所以这里用 lead 票据；agent 拿同一份 payload 会 403 —— 那一格由
  // `tests/queue-visibility.test.ts` 断言，本文件只验"派发这条路走得通"）。
  const dispatched = await newTicket({ question: `认领指定 ${tag}` });
  const claimed = await call({
    method: "PATCH",
    url: `/api/console/tickets/${dispatched.id}`,
    token: leadTicket,
    payload: { status: "claimed", assignee_id: fixtureStaff.id },
  });
  assert.equal(claimed.status, 200, `认领期望 200，实际 ${claimed.status}：${claimed.raw}`);
  const claimedTicket = (claimed.body as { data: { ticket: ListItem } }).data.ticket;
  assert.equal(claimedTicket.status, "claimed");
  assert.equal(claimedTicket.assignee_id, fixtureStaff.id, "显式 assignee_id 必须指派给该坐席");
  assert.equal(claimedTicket.assignee, fixtureStaff.name);
  assert.deepEqual((claimed.body as { data: { changed: string[] } }).data.changed, ["status", "assignee"]);
  assert.equal(leadStaff.role, "lead", `夹具前提：派发用例的票据必须是 lead，实际 "${leadStaff.role}"`);

  // 不带 assignee_id → 落到**会话里的那个坐席**（`X-Admin-Staff` 已退场，客户端不再能自称）。
  assert.notEqual(sessionStaff.staff_id, "", "登录响应必须带上 staff_id");
  const mine = await newTicket({ question: `认领默认 ${tag}` });
  const fallback = await call({
    method: "PATCH",
    url: `/api/console/tickets/${mine.id}`,
    payload: { status: "claimed" },
  });
  assert.equal(fallback.status, 200, `认领期望 200，实际 ${fallback.status}：${fallback.raw}`);
  const fallbackTicket = (fallback.body as { data: { ticket: ListItem } }).data.ticket;
  assert.equal(fallbackTicket.assignee_id, sessionStaff.staff_id, "缺失指派时必须落到当前登录的坐席");
  assert.equal(fallbackTicket.assignee, sessionStaff.name);

  // 指派不存在的坐席 → 400（不能变成外键 23503 的 500）。
  // 用 lead 票据：派发权检查在"指派对象是否存在"之前（先 403 再 400，agent 拿 uuid 试探时
  // 拿不到"这个 id 存不存在"的答案），所以 agent 发这条只会得到 403 —— 那由
  // `tests/queue-visibility.test.ts` 断言，这里要验的是"uuid 查不到 → 400 而不是 500"。
  const ghost = await call({
    method: "PATCH",
    url: `/api/console/tickets/${mine.id}`,
    token: leadTicket,
    payload: { assignee_id: randomUUID() },
  });
  assert.equal(ghost.status, 400, `不存在的 assignee_id 期望 400，实际 ${ghost.status}：${ghost.raw}`);
  assert.equal((ghost.body as ErrorBody).error.code, "VALIDATION");

  // 空 body / 无可识别字段 → 400（拼错字段名不该被当成"改成功了"）。
  const empty = await call({ method: "PATCH", url: `/api/console/tickets/${mine.id}`, payload: {} });
  assert.equal(empty.status, 400);
  assert.equal((empty.body as ErrorBody).error.code, "VALIDATION");

  // 显式 assignee_id=null 是"清空指派"（转回未认领）—— 同样是派发权，用 lead 票据。
  // 注意**必须同时把状态退回 open**：
  // `claimed` 且没有指派对象时会按 05 §4.3 自动指派给请求方（否则会出现"已认领但没人负责"的单）。
  const cleared = await call({
    method: "PATCH",
    url: `/api/console/tickets/${mine.id}`,
    token: leadTicket,
    payload: { status: "open", assignee_id: null },
  });
  assert.equal(cleared.status, 200, `清空指派期望 200，实际 ${cleared.status}：${cleared.raw}`);
  const clearedTicket = (cleared.body as { data: { ticket: ListItem } }).data.ticket;
  assert.equal(clearedTicket.assignee_id, null);
  assert.equal(clearedTicket.status, "open");

  // 不存在的工单 id：补丁回 404（锚点失效就是这个场景），不是 500。
  const ghostTicket = await call({
    method: "PATCH",
    url: "/api/console/tickets/999999999",
    payload: { status: "claimed" },
  });
  assert.equal(ghostTicket.status, 404);
  assert.equal((ghostTicket.body as ErrorBody).error.code, "NOT_FOUND");
});

/* ─────────────────────── ⑦ 关单与不可变 ─────────────────────── */

test("关单：9 字结论 400；正常关单写 closed_at + 审计；再 PATCH 任何字段 409", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("close");
  const ticket = await newTicket({ question: `关单用例 ${tag}` });
  const { one, query } = await import("../src/db.ts");

  const auditCount = async (): Promise<number> => {
    const row = await one<{ n: string }>("select count(*)::text as n from audit_log where target = $1", [ticket.no]);
    return Number(row?.n ?? 0);
  };
  assert.equal(await auditCount(), 0, "新造的工单不该已有审计行");

  // 9 个字符（按 code point 数）：门槛是 ≥10，差一个也不行。
  const tooShort = await call({
    method: "PATCH",
    url: `/api/console/tickets/${ticket.id}`,
    payload: { status: "closed", resolution: "一二三四五六七八九" },
  });
  assert.equal(tooShort.status, 400, `9 字结论期望 400，实际 ${tooShort.status}：${tooShort.raw}`);
  assert.equal((tooShort.body as ErrorBody).error.code, "VALIDATION");

  // 关单必须在本条补丁里给出结论（不复用库里已有的值）——没有 resolution 也是 400。
  const noResolution = await call({
    method: "PATCH",
    url: `/api/console/tickets/${ticket.id}`,
    payload: { status: "closed" },
  });
  assert.equal(noResolution.status, 400);
  assert.equal((noResolution.body as ErrorBody).error.code, "VALIDATION");
  assert.equal(await auditCount(), 0, "被拒的补丁不得留下审计行");

  const resolution = "电话指导复位后恢复正常运行";
  const closed = await call({
    method: "PATCH",
    url: `/api/console/tickets/${ticket.id}`,
    payload: { status: "closed", resolution },
  });
  assert.equal(closed.status, 200, `关单期望 200，实际 ${closed.status}：${closed.raw}`);
  const closedTicket = (closed.body as { data: { ticket: ListItem & { resolution: string | null; closed_at: string | null } } }).data
    .ticket;
  assert.equal(closedTicket.status, "closed");
  assert.equal(closedTicket.resolution, resolution);
  assert.ok(closedTicket.closed_at !== null, "关单后响应里 closed_at 必须有值");
  assert.ok(closedTicket.closed_at !== undefined);

  // 库里的 closed_at 由触发器写（`guard_ticket_status`），不是应用层传的。
  const row = await one<{ closed_at: Date | null; status: string }>(
    "select closed_at, status from tickets where id = $1::bigint",
    [ticket.id],
  );
  assert.equal(row?.status, "closed");
  assert.ok(row?.closed_at !== null && row?.closed_at !== undefined, "closed_at 必须由触发器写入");

  // 审计：一条 ticket.update，payload 里存了前后差异。
  assert.equal(await auditCount(), 1, "关单必须恰好写一条审计");
  const audit = await one<{ action: string; payload: { before: { status: string }; after: { status: string }; changed: string[] } }>(
    "select action, payload from audit_log where target = $1 order by id desc limit 1",
    [ticket.no],
  );
  assert.equal(audit?.action, "ticket.update");
  assert.equal(audit?.payload.before.status, "open");
  assert.equal(audit?.payload.after.status, "closed");
  assert.ok((audit?.payload.changed ?? []).includes("status"));

  // 已关单再改任何字段 → 409 TICKET_IMMUTABLE（不是 500，也不是"改成功了但没生效"）。
  const patches: unknown[] = [{ status: "open" }, { resolution: "想改一下结论内容" }, { assignee_id: null }];
  for (const payload of patches) {
    const reply = await call({ method: "PATCH", url: `/api/console/tickets/${ticket.id}`, payload });
    assert.equal(reply.status, 409, `已关单的补丁期望 409，实际 ${reply.status}：${reply.raw}`);
    assert.equal((reply.body as ErrorBody).error.code, "TICKET_IMMUTABLE");
    assert.equal(reply.raw.includes("at "), false, `409 响应体不得含堆栈：${reply.raw}`);
  }

  // 幂等性检查：三次被拒之后库里仍是那一条审计，结论也没被改动。
  assert.equal(await auditCount(), 1, "被 409 拒掉的补丁不得写审计");
  const after = await one<{ resolution: string | null }>("select resolution from tickets where id = $1::bigint", [
    ticket.id,
  ]);
  assert.equal(after?.resolution, resolution);

  // 没关的单可以只改结论（body 字段全可选）。
  const another = await newTicket({ question: `只改结论 ${tag}` });
  const onlyResolution = await call({
    method: "PATCH",
    url: `/api/console/tickets/${another.id}`,
    payload: { resolution: "先记录一次预处理要点" },
  });
  assert.equal(onlyResolution.status, 200, `只改结论期望 200，实际 ${onlyResolution.status}：${onlyResolution.raw}`);
  assert.equal((onlyResolution.body as { data: { ticket: { status: string } } }).data.ticket.status, "open");

  await query("delete from audit_log where target = $1", [another.no]);
});

/* ─────────────────────── ⑧ 预留端点与统计 ─────────────────────── */

test("预留端点：translate / export 固定 501；draft 已转正（09#06）但仍要令牌", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  for (const name of ["translate", "export"]) {
    const reply = await call({ method: "POST", url: `/api/console/${name}`, payload: {} });
    assert.equal(reply.status, 501, `${name} 期望 501，实际 ${reply.status}：${reply.raw}`);
    assert.equal((reply.body as ErrorBody).error.code, "NOT_IMPLEMENTED");

    // 501 是"功能没做"，不是"可以匿名探测"。
    const anonymous = await call({ method: "POST", url: `/api/console/${name}`, token: null, payload: {} });
    assert.equal(anonymous.status, 401, `${name} 缺令牌期望 401，实际 ${anonymous.status}`);
  }

  // `draft` 不再是占位：它是「转 FAQ 草稿」的真接口（`09#06`）。这里只验两件事 ——
  // 没令牌 401（门禁没退化）、空 body 400（不再是 501，也不再"什么都不做就 200"）。
  const anon = await call({ method: "POST", url: "/api/console/draft", token: null, payload: {} });
  assert.equal(anon.status, 401, `draft 缺令牌期望 401，实际 ${anon.status}`);
  const empty = await call({ method: "POST", url: "/api/console/draft", payload: {} });
  assert.equal(empty.status, 400, `draft 空 body 期望 400，实际 ${empty.status}：${empty.raw}`);
  assert.equal((empty.body as ErrorBody).error.code, "VALIDATION");
});

test("统计：工单数 / 拒答率 / 平均 SLA 剩余都是真实数字", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  // 造一张已知有截止时间的单，让平均 SLA 一定是个数（不依赖库里原有数据）。
  await newTicket({
    question: `统计用例 ${mark("stats")}`,
    dueAt: new Date(Date.now() + 3600_000).toISOString(),
  });

  const reply = await call({ method: "GET", url: "/api/console/stats" });
  assert.equal(reply.status, 200, `统计期望 200，实际 ${reply.status}：${reply.raw}`);
  const data = (reply.body as {
    data: {
      tickets_total: number;
      tickets_pending: number;
      tickets_by_status: Record<string, number>;
      runs_total: number;
      runs_refused: number;
      refusal_rate: number;
      sla_seconds_left_avg: number | null;
    };
  }).data;

  assert.equal(Number.isInteger(data.tickets_total), true);
  assert.ok(data.tickets_total > 0, "工单总数应该是真实聚合出来的正数");
  assert.equal(Number.isInteger(data.tickets_pending), true);
  // 各状态数之和必须等于总数：这是"聚合真的在 SQL 里做"最容易露馅的地方。
  const sum = Object.values(data.tickets_by_status).reduce((acc, value) => acc + value, 0);
  assert.equal(sum, data.tickets_total, `各状态之和 ${sum} 应等于总数 ${data.tickets_total}`);
  assert.ok(data.tickets_pending <= data.tickets_total);

  assert.equal(Number.isInteger(data.runs_total), true);
  assert.equal(Number.isInteger(data.runs_refused), true);
  assert.equal(typeof data.refusal_rate, "number");
  assert.ok(data.refusal_rate >= 0 && data.refusal_rate <= 1, `拒答率必须在 0–1，实际 ${data.refusal_rate}`);
  assert.equal(
    typeof data.sla_seconds_left_avg,
    "number",
    "库里至少有一张带截止时间的未关闭工单，平均值不该是 null",
  );
});

/* ──────────────── ⑨ 看板口径基线（`09#01`：exclude_demo + 时间窗） ──────────────── */

type StatsData = {
  tickets_total: number;
  tickets_pending: number;
  tickets_by_status: Record<string, number>;
  runs_total: number;
  runs_refused: number;
  refusal_rate: number;
  sla_seconds_left_avg: number | null;
  window: string;
  exclude_demo: boolean;
};

function statsUrl(query: Record<string, string> = {}): string {
  const search = new URLSearchParams(query).toString();
  return search === "" ? "/api/console/stats" : `/api/console/stats?${search}`;
}

/** 原始响应体：口径一致性那条用例要比的是**字节**，不是解析后的对象。 */
async function rawStats(query: Record<string, string> = {}): Promise<Reply> {
  return call({ method: "GET", url: statsUrl(query) });
}

async function stats(query: Record<string, string> = {}): Promise<StatsData> {
  const reply = await rawStats(query);
  assert.equal(reply.status, 200, `统计期望 200，实际 ${reply.status}：${reply.raw}`);
  return (reply.body as { data: StatsData }).data;
}

/**
 * 去掉 `sla_seconds_left_avg` 之后重新序列化。
 *
 * 它必须被排除，因为它**按设计**就随时间走：SQL 里是 `avg(due_at - now())`，两次调用相差几毫秒，
 * 平均值就跟着动几毫秒，`Math.round` 落在 .5 附近时会翻一位。用它做逐字节比较，
 * 得到的是一个 ~2% 概率失败的假红。抛掉它之后剩下的每个数字都只由库里的行决定 ——
 * 那才是"同一时间窗连调两次必须一致"要守的东西。
 */
function stableStatsBody(raw: string): string {
  const body = JSON.parse(raw) as { data: StatsData };
  delete (body.data as Partial<StatsData>).sla_seconds_left_avg;
  return JSON.stringify(body);
}

test("看板口径：exclude_demo=true|false 的 total 之差 == 库里 demo 工单张数（默认排除）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { one } = await import("../src/db.ts");
  const tag = mark("stats-demo");
  // 自己造两张带 `demo` 标签的单，而不是依赖 `make demo` 跑过：README 的五步里它是可选的，
  // 一条断言"库里正好有 8 张"的用例会在没跑 demo 的环境上永远红。
  await newTicket({ question: `演示单甲 ${tag}`, tags: ["demo"] });
  await newTicket({ question: `演示单乙 ${tag}`, tags: ["demo"] });

  const demoRow = await one<{ n: number }>("select count(*)::int as n from tickets where 'demo' = any(tags)");
  const demoCount = demoRow?.n ?? 0;
  assert.ok(demoCount >= 2, `库里 demo 工单至少是刚造的两张，实际 ${demoCount}`);

  const withoutDemo = await stats({ exclude_demo: "true" });
  const withDemo = await stats({ exclude_demo: "false" });

  assert.equal(withoutDemo.exclude_demo, true);
  assert.equal(withDemo.exclude_demo, false);
  assert.equal(
    withDemo.tickets_total - withoutDemo.tickets_total,
    demoCount,
    `含 demo 的 total ${withDemo.tickets_total} 减不含 demo 的 ${withoutDemo.tickets_total} 应等于 demo 张数 ${demoCount}`,
  );
  // 各状态之和必须跟着同一套条件走：总数换了口径而状态分布没换，是"两段 where 各写一份"的经典症状。
  for (const [label, data] of [
    ["exclude_demo=true", withoutDemo],
    ["exclude_demo=false", withDemo],
  ] as const) {
    const sum = Object.values(data.tickets_by_status).reduce((acc, value) => acc + value, 0);
    assert.equal(sum, data.tickets_total, `${label}：各状态之和 ${sum} 应等于 total ${data.tickets_total}`);
  }

  // 默认值只能是"排除"，而且不传参数与显式 true 必须逐字节一致（默认值只有一处出处）。
  const byDefault = await rawStats();
  assert.equal(byDefault.status, 200, `默认口径期望 200，实际 ${byDefault.status}：${byDefault.raw}`);
  assert.equal((byDefault.body as { data: StatsData }).data.exclude_demo, true);
  assert.equal((byDefault.body as { data: StatsData }).data.window, "all");
  const explicitTrue = await rawStats({ exclude_demo: "true" });
  assert.equal(explicitTrue.status, 200, `显式 exclude_demo=true 期望 200，实际 ${explicitTrue.status}：${explicitTrue.raw}`);
  assert.equal(
    stableStatsBody(byDefault.raw),
    stableStatsBody(explicitTrue.raw),
    "不传参数与显式 exclude_demo=true 必须是同一份结果",
  );

  // `window=today` 也照样排除 demo：两个维度互不影响。
  const todayWithDemo = await stats({ exclude_demo: "false", window: "today" });
  const todayWithoutDemo = await stats({ exclude_demo: "true", window: "today" });
  assert.ok(
    todayWithDemo.tickets_total >= todayWithoutDemo.tickets_total,
    `today 口径下含 demo ${todayWithDemo.tickets_total} 不应少于不含 demo ${todayWithoutDemo.tickets_total}`,
  );
});

test("看板口径：时间窗以 created_at 为准（today / week / all 的包含关系）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  // 断言全部用"自己造一行，看哪个窗的 total 动了 1"来做，不拿 SQL 把实现的算法抄一遍当预言：
  // 抄一遍只能证明两段代码写得一样，证明不了它算的是"最近 7 天"。
  const weekBefore = (await stats({ window: "week" })).tickets_total;

  // ① 刚刚建的 → week 与 today 都必须算进去。
  await newTicket({ question: `刚建的单 ${mark("stats-window-now")}` });
  assert.equal(
    (await stats({ window: "week" })).tickets_total,
    weekBefore + 1,
    "刚建的工单必须落在 week 窗口内",
  );
  const todayAfter = (await stats({ window: "today" })).tickets_total;
  await newTicket({ question: `又一张刚建的单 ${mark("stats-window-now2")}` });
  assert.equal(
    (await stats({ window: "today" })).tickets_total,
    todayAfter + 1,
    "刚建的工单必须落在 today 窗口内（today = 本地当天 0 点起）",
  );

  // ② 10 天前建的 → week / today 都不含，all 含。
  const weekBeforeOld = (await stats({ window: "week" })).tickets_total;
  const allBeforeOld = (await stats({ window: "all" })).tickets_total;
  await newTicket({
    question: `十天前的单 ${mark("stats-window-old")}`,
    createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(
    (await stats({ window: "week" })).tickets_total,
    weekBeforeOld,
    "10 天前的工单不得落进 week（week = 滚动最近 7 天）",
  );
  assert.equal(
    (await stats({ window: "all" })).tickets_total,
    allBeforeOld + 1,
    "10 天前的工单必须落进 all",
  );

  // ③ 三个窗口是包含关系（today ⊆ week ⊆ all），且 pending ≤ total。
  const today = await stats({ window: "today" });
  const week = await stats({ window: "week" });
  const all = await stats({ window: "all" });
  assert.ok(today.tickets_total <= week.tickets_total, "today 不应多于 week");
  assert.ok(week.tickets_total <= all.tickets_total, "week 不应多于 all");
  assert.ok(today.tickets_pending <= today.tickets_total);
  assert.equal(today.window, "today");
  assert.equal(week.window, "week");
  assert.equal(all.window, "all");
});

test("看板口径：同一时间窗连调两次，结果逐字节一致（`sla_seconds_left_avg` 除外）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  for (const window of ["today", "week", "all"]) {
    const first = await rawStats({ window });
    const second = await rawStats({ window });
    assert.equal(first.status, 200, `window=${window} 期望 200，实际 ${first.status}：${first.raw}`);
    assert.equal(second.status, 200, `window=${window} 期望 200，实际 ${second.status}：${second.raw}`);
    assert.equal(
      stableStatsBody(first.raw),
      stableStatsBody(second.raw),
      `window=${window}：同一份库连调两次必须给出同一份数字`,
    );
    // 被排除的那一个也得有个界：两次相隔几毫秒，平均剩余秒数只该动零秒（至多 1 秒的取整边界）。
    const a = (first.body as { data: StatsData }).data.sla_seconds_left_avg;
    const b = (second.body as { data: StatsData }).data.sla_seconds_left_avg;
    if (a !== null && b !== null) {
      assert.ok(Math.abs(a - b) <= 1, `window=${window}：平均剩余秒数两次相差 ${Math.abs(a - b)} 秒，超出取整误差`);
    }
  }
});

test("看板口径：非法参数 → 400 VALIDATION，不静默回落成默认值", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const cases = [
    { search: "?window=month", hint: "today" },
    { search: "?window=yesterday", hint: "today" },
    { search: "?exclude_demo=yes", hint: "true" },
    { search: "?exclude_demo=1", hint: "true" },
    { search: "?exclude_demo=0", hint: "true" },
    { search: "?window=all&exclude_demo=maybe", hint: "true" },
  ];
  for (const item of cases) {
    const reply = await call({ method: "GET", url: `/api/console/stats${item.search}` });
    assert.equal(reply.status, 400, `${item.search} 期望 400（不许静默回落），实际 ${reply.status}：${reply.raw}`);
    const body = reply.body as ErrorBody;
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "VALIDATION");
    assert.equal(typeof body.error.trace_id, "string");
    assert.ok(body.error.trace_id.length > 0, "错误体必须带 trace_id");
    // 消息里点出允许值：前端不必去猜"到底哪几个能用"。
    assert.ok(body.error.message.includes(item.hint), `${item.search} 的 400 应列出允许值，实际："${body.error.message}"`);
  }

  // 合法值一个都不能被误伤（尤其是空串 = 没给，属于默认口径而不是非法值）。
  for (const search of ["?window=today", "?window=week", "?window=all", "?exclude_demo=true", "?exclude_demo=false", "?exclude_demo=TRUE", "?window=&exclude_demo="]) {
    const reply = await call({ method: "GET", url: `/api/console/stats${search}` });
    assert.equal(reply.status, 200, `${search} 期望 200，实际 ${reply.status}：${reply.raw}`);
  }

  // 令牌先过：未授权 + 非法参数必须是 401，而不是一个能观察校验分支的 400。
  const anonymous = await call({ method: "GET", url: "/api/console/stats?window=month", token: null });
  assert.equal(anonymous.status, 401, `缺令牌期望 401，实际 ${anonymous.status}：${anonymous.raw}`);
  assert.equal((anonymous.body as ErrorBody).error.code, "AUTH_REQUIRED");
});

/**
 * 关单结论的长度口径必须与前端**逐字一致**（`src/static/lib/console-resolution.js` 用
 * `Array.from(...).length`，即码点数）。`String.length` 数的是 UTF-16 码元，一个 emoji 算 2：
 * 前后端口径不一致时，症状是"页面上还差 1 字、点下去却 400"/"页面说够了、后端说不够"，
 * 而关单是这个后台最不能被拦错的操作。
 */
test("关单：字符数按码点计（emoji 不算两倍），与前端 console-resolution.js 同口径", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("codepoint");
  const ticket = await newTicket({ question: `码点计数用例 ${tag}` });

  // 5 个 emoji = 5 个码点 / 10 个 UTF-16 码元 → 必须 400（差 5 个字，不是"刚好够"）。
  const fiveEmoji = await call({
    method: "PATCH",
    url: `/api/console/tickets/${ticket.id}`,
    payload: { status: "closed", resolution: "😀😀😀😀😀" },
  });
  assert.equal(
    fiveEmoji.status,
    400,
    `5 个 emoji 是 5 字（不是 10 字），期望 400，实际 ${fiveEmoji.status}：${fiveEmoji.raw}`,
  );
  assert.equal((fiveEmoji.body as ErrorBody).error.code, "VALIDATION");

  // 10 个 emoji = 10 个码点 → 必须通过。
  const tenEmoji = "😀😀😀😀😀😀😀😀😀😀";
  const closed = await call({
    method: "PATCH",
    url: `/api/console/tickets/${ticket.id}`,
    payload: { status: "closed", resolution: tenEmoji },
  });
  assert.equal(closed.status, 200, `10 个 emoji 是 10 字，期望 200，实际 ${closed.status}：${closed.raw}`);
  const body = closed.body as { data: { ticket: { resolution: string | null } } };
  assert.equal(body.data.ticket.resolution, tenEmoji);
});
