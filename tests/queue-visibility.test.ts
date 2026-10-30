/**
 * 队列可见性 + 派发权限（`09#03` 第三段 · `docs/output/boundary-change-R2.md` §7 三格默认值）。
 *
 * 依据（已签字，逐条对照）：
 *   - 「客服（agent）能不能看到同事工单的**标题**？」→ **不能**：队列里直接看不到他人工单，
 *     详情也不给看（403，不是 404 —— 口径是"看不到标题"，不是"这单不存在"）。
 *   - 派发（把单给他人 / 清空指派）是 `lead`/`admin` 的权力；`agent` 只能把单派给自己（= 认领）。
 *   - **写路径与读路径同一口径**（`09#04` 收口）：`agent` 拿着 id 直接 `PATCH` 他人工单也是 403 ——
 *     "看不见"不能只是界面上的话。判定顺序 404 → 409 → 403(可见) → 403(派发) → 400(uuid)。
 *
 * 断言的是**可观察契约**：队列的 `total` 与 `items`、详情的 403、补丁的 403/200、审计的 `actor`。
 * 不 assert 实现细节（where 里怎么拼、判定在哪一行）。
 *
 * 夹具全部自建、只按自己造的 id / 单号清理：`09#02` 之后 demo 工单可被 `exclude_demo` 排除，
 * 任何"库里正好有 8 张演示单"的断言都会在别人的环境上变红。
 *
 * 登录限速是"每 IP 5 次/分钟"，而 `app.inject` 的来源永远是 127.0.0.1：本文件只在 `before`
 * 里登录两次（agent 一张、lead 一张）然后全程复用，`after` 里删掉两张票据与限速键。
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

/** 演示账号（`sql/002_seed.sql`）：`wt-demo-2026`，部署前必须改。 */
const AGENT_EMAIL = "zhang.wei@wotai.demo";
const LEAD_EMAIL = "li.na@wotai.demo";
const DEMO_PASSWORD = "wt-demo-2026";

/** 本文件的唯一夹具前缀：问题摘要带它，清理只按它造出来的 id 删。 */
const FIXTURE = `qvis-${randomUUID().slice(0, 8)}`;

function mark(useCase: string): string {
  return `${FIXTURE}-${useCase}`;
}

type Staff = { staff_id: string; name: string; role: string };
type ErrorBody = { ok: false; error: { code: string; message: string; trace_id: string } };
type Reply = { status: number; body: unknown; raw: string };

const ticketIds: number[] = [];
const ticketNos: string[] = [];

let app: FastifyInstance;
/** 身份都在 `before` 里登录一次拿到，全程复用（限速 5 次/分钟）。 */
let agentTicket = "";
let leadTicket = "";
let agent: Staff = { staff_id: "", name: "", role: "" };
let lead: Staff = { staff_id: "", name: "", role: "" };

before(async () => {
  if (!hasRuntimeEnv) return;
  const [{ default: Fastify }, { registerConsoleRoutes }, { registerAuthRoutes }, { toErrorBody }] =
    await Promise.all([
      import("fastify"),
      import("../src/api/console.ts"),
      import("../src/api/auth.ts"),
      import("../src/errors.ts"),
    ]);

  // 与 `src/server.ts` 同一套错误信封：401/403/404 的形状必须是线上那一种。
  app = Fastify({ logger: false });
  app.setErrorHandler((err, request, reply) => {
    const { status, body } = toErrorBody(err, String(request.id));
    return reply.code(status).send(body);
  });
  await registerConsoleRoutes(app);
  await registerAuthRoutes(app);
  await app.ready();

  const agentLogin = await loginAs(AGENT_EMAIL);
  agentTicket = agentLogin.ticket;
  agent = agentLogin.staff;
  const leadLogin = await loginAs(LEAD_EMAIL);
  leadTicket = leadLogin.ticket;
  lead = leadLogin.staff;

  // 夹具前提先断言：这条权限矩阵的两个身份必须真是 agent / lead，否则后面全部断言
  // 只是在描述"某两个账号碰巧能做什么"。
  assert.equal(agent.role, "agent", `夹具前提：${AGENT_EMAIL} 必须是 agent，实际 "${agent.role}"`);
  assert.equal(lead.role, "lead", `夹具前提：${LEAD_EMAIL} 必须是 lead，实际 "${lead.role}"`);
});

after(async () => {
  if (!hasRuntimeEnv) return;
  // `src/auth.ts` 会 import `src/redis.ts`：ioredis 的连接会挂住事件循环，必须主动 quit。
  const [{ pool, query }, { redis }] = await Promise.all([import("../src/db.ts"), import("../src/redis.ts")]);
  if (app !== undefined) await app.close();

  // 顺序：审计（按单号）→ 工单。本文件不造会话与坐席（工单的 conv_id 一律为 null）。
  if (ticketNos.length > 0) await query("delete from audit_log where target = any($1::text[])", [ticketNos]);
  if (ticketIds.length > 0) await query("delete from tickets where id = any($1::bigint[])", [ticketIds]);

  for (const ticket of [agentTicket, leadTicket]) {
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

/**
 * 登录拿一张票据。先清 `login:127.0.0.1`：限速键是"每 IP 每分钟 5 次"，跨测试文件累计很容易
 * 在第 6 次撞上 429 —— 那是限速的**正确**行为，不该让一条无关的断言因此变红。
 */
async function loginAs(email: string): Promise<{ ticket: string; staff: Staff }> {
  const { redis } = await import("../src/redis.ts");
  await redis.del("login:127.0.0.1");
  const reply = toReply(
    await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: DEMO_PASSWORD } }),
  );
  assert.equal(reply.status, 200, `登录失败（${email}）：${reply.raw}`);
  return (reply.body as { data: { ticket: string; staff: Staff } }).data;
}

/** 带会话票据的 inject。默认用 agent 的票据，派发类用例显式传 `token: leadTicket`。 */
async function call(options: {
  method: "GET" | "PATCH";
  url: string;
  token?: string | null;
  payload?: unknown;
}): Promise<Reply> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? agentTicket : options.token;
  if (token !== null) headers["x-staff-session"] = token;
  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
  return toReply(response);
}

/** 造一张工单（`conv_id` 一律为 null：本文件只关心可见性与指派，不需要对话）。 */
async function newTicket(input: {
  question: string;
  status?: string;
  assignee?: string | null;
}): Promise<{ id: number; no: string }> {
  const { one } = await import("../src/db.ts");
  const row = await one<{ id: string; no: string }>(
    `insert into tickets (no, conv_id, reason, question, status, assignee)
     values (gen_ticket_no(), null, 'no_citation', $1, coalesce($2::text, 'open'), $3::uuid)
     returning id, no`,
    [input.question, input.status ?? null, input.assignee ?? null],
  );
  assert.ok(row !== null, "工单插入失败");
  ticketIds.push(Number(row.id));
  ticketNos.push(row.no);
  return { id: Number(row.id), no: row.no };
}

type ListItem = {
  id: number;
  no: string;
  status: string;
  question: string;
  assignee: string | null;
  assignee_id: string | null;
};

async function list(token: string, query: Record<string, string>): Promise<{ total: number; items: ListItem[] }> {
  const search = new URLSearchParams(query).toString();
  const reply = await call({ method: "GET", url: `/api/console/tickets?${search}`, token });
  assert.equal(reply.status, 200, `列表期望 200，实际 ${reply.status}：${reply.raw}`);
  return (reply.body as { data: { total: number; items: ListItem[] } }).data;
}

async function auditActor(no: string): Promise<{ actor: string; payload: { staff_id: string; changed: string[] } } | null> {
  const { one } = await import("../src/db.ts");
  return one<{ actor: string; payload: { staff_id: string; changed: string[] } }>(
    "select actor, payload from audit_log where target = $1 order by id desc limit 1",
    [no],
  );
}

/* ─────────────────── ① 队列可见性（§7 第 1 格） ─────────────────── */

test("队列：agent 看不到他人工单（标题也拿不到），lead 看全部", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("scope");
  // 三张单覆盖三种可见性：未分配池（谁都能看）、我认领的、别人认领的。
  const pool = await newTicket({ question: `可见性池子 ${tag}` });
  const mine = await newTicket({ question: `我认领的 ${tag}`, status: "claimed", assignee: agent.staff_id });
  const others = await newTicket({ question: `同事的单 ${tag}`, status: "claimed", assignee: lead.staff_id });

  const asAgent = await list(agentTicket, { q: tag, size: "100" });
  assert.equal(asAgent.total, 2, `agent 只该看到 2 张（未分配池 + 自己的），实际 ${asAgent.total}`);
  assert.deepEqual(
    asAgent.items.map((item) => item.id).sort((a, b) => a - b),
    [pool.id, mine.id].sort((a, b) => a - b),
    "agent 的队列里不许出现指派给他人的工单",
  );
  // 逐行再确认一次：可见的行只能是"未分配"或"指派给我"。
  for (const item of asAgent.items) {
    assert.ok(
      item.assignee_id === null || item.assignee_id === agent.staff_id,
      `agent 的队列混进了他人工单：${item.no}（assignee_id=${String(item.assignee_id)}）`,
    );
  }
  // 他人工单的标题（问题摘要）一个字都不该出现在响应体里 —— `question` 是客户 PII。
  assert.equal(asAgent.items.some((item) => item.id === others.id), false);

  const asLead = await list(leadTicket, { q: tag, size: "100" });
  assert.equal(asLead.total, 3, `lead 该看到全部 3 张，实际 ${asLead.total}`);
  const anyItem = asLead.items.find((item) => item.id === others.id);
  assert.ok(anyItem !== undefined, "lead 必须能看到指派给他人的工单");
  assert.equal(anyItem.assignee_id, lead.staff_id);
});

/* ─────────────────── ② 详情可见性 ─────────────────── */

test("详情：agent 查他人工单 403（FORBIDDEN，不是 404），lead 查同一张 200", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("detail");
  const others = await newTicket({ question: `他人工单详情 ${tag}`, status: "claimed", assignee: lead.staff_id });
  const pool = await newTicket({ question: `未分配详情 ${tag}` });

  const denied = await call({ method: "GET", url: `/api/console/tickets/${others.id}` });
  assert.equal(denied.status, 403, `agent 查他人工单期望 403，实际 ${denied.status}：${denied.raw}`);
  assert.equal((denied.body as ErrorBody).error.code, "FORBIDDEN");
  assert.equal(denied.raw.includes("at "), false, `403 响应体不得含堆栈：${denied.raw}`);
  // 不是 404：那会让坐席以为锚点失效而反复刷新；而且 `others.no` / 标题一个字都不该回显。
  assert.equal(denied.raw.includes(others.no), false, `403 响应体不得回显单号：${denied.raw}`);
  assert.equal(denied.raw.includes(tag), false, `403 响应体不得回显标题：${denied.raw}`);

  // 未分配的单对 agent 可见：那是等待认领的池子，点不开就认领不了。
  const poolDetail = await call({ method: "GET", url: `/api/console/tickets/${pool.id}` });
  assert.equal(poolDetail.status, 200, `未分配工单详情期望 200，实际 ${poolDetail.status}：${poolDetail.raw}`);

  // 自己认领的照样能看。
  const mine = await newTicket({ question: `我的单详情 ${tag}`, status: "claimed", assignee: agent.staff_id });
  const mineDetail = await call({ method: "GET", url: `/api/console/tickets/${mine.id}` });
  assert.equal(mineDetail.status, 200, `自己的工单详情期望 200，实际 ${mineDetail.status}：${mineDetail.raw}`);

  // lead 查同一张：200，且拿到的就是那一张。
  const asLead = await call({ method: "GET", url: `/api/console/tickets/${others.id}`, token: leadTicket });
  assert.equal(asLead.status, 200, `lead 查他人工单期望 200，实际 ${asLead.status}：${asLead.raw}`);
  assert.equal((asLead.body as { data: { ticket: { id: number } } }).data.ticket.id, others.id);
});

/* ─────────────────── ③ 派发权限：agent ─────────────────── */

test("派发：agent 派给他人 / 清空 → 403；派给自己（认领）→ 200", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("dispatch-agent");
  const pool = await newTicket({ question: `agent 派发池 ${tag}` });
  const mine = await newTicket({ question: `agent 清空 ${tag}`, status: "claimed", assignee: agent.staff_id });

  // ① 派给他人 → 403（哪怕同时把状态设成 claimed）。
  const toOthers = await call({
    method: "PATCH",
    url: `/api/console/tickets/${pool.id}`,
    payload: { status: "claimed", assignee_id: lead.staff_id },
  });
  assert.equal(toOthers.status, 403, `agent 派给他人期望 403，实际 ${toOthers.status}：${toOthers.raw}`);
  assert.equal((toOthers.body as ErrorBody).error.code, "FORBIDDEN");

  // ② 清空指派 → 403。`{assignee_id: null}` 表达的是"把单从某人手上摘下来"，那是派发权，
  //    不因为同时把状态退回 open 就变成普通操作。
  for (const payload of [{ assignee_id: null }, { status: "open", assignee_id: null }]) {
    const clear = await call({ method: "PATCH", url: `/api/console/tickets/${mine.id}`, payload });
    assert.equal(clear.status, 403, `agent 清空指派期望 403（${JSON.stringify(payload)}），实际 ${clear.status}：${clear.raw}`);
    assert.equal((clear.body as ErrorBody).error.code, "FORBIDDEN");
  }

  // 被拒的补丁不得留下任何痕迹：状态、指派、审计一个字都不能动。
  const { one } = await import("../src/db.ts");
  const after = await one<{ status: string; assignee: string | null }>(
    "select status, assignee from tickets where id = $1::bigint",
    [pool.id],
  );
  assert.equal(after?.status, "open", "被 403 拒掉的派发不得改动状态");
  assert.equal(after?.assignee, null, "被 403 拒掉的派发不得改动指派");
  assert.equal(await auditActor(pool.no), null, "被 403 拒掉的派发不得写审计");

  // ③ 派给自己 = 认领 → 200（`{status:"claimed"}` 不带 assignee_id 走自动指派给"我"）。
  const selfClaim = await call({
    method: "PATCH",
    url: `/api/console/tickets/${pool.id}`,
    payload: { status: "claimed" },
  });
  assert.equal(selfClaim.status, 200, `agent 认领期望 200，实际 ${selfClaim.status}：${selfClaim.raw}`);
  const claimed = (selfClaim.body as { data: { ticket: ListItem } }).data.ticket;
  assert.equal(claimed.assignee_id, agent.staff_id, "认领必须落到当前登录的坐席");
  assert.equal(claimed.assignee, agent.name);

  // ④ 显式把自己写成 assignee_id 同样允许：它和"我要这单"是同一个动作。
  const explicitSelf = await newTicket({ question: `agent 显式认领 ${tag}` });
  const explicit = await call({
    method: "PATCH",
    url: `/api/console/tickets/${explicitSelf.id}`,
    payload: { status: "claimed", assignee_id: agent.staff_id },
  });
  assert.equal(explicit.status, 200, `agent 显式派给自己期望 200，实际 ${explicit.status}：${explicit.raw}`);
  assert.equal((explicit.body as { data: { ticket: ListItem } }).data.ticket.assignee_id, agent.staff_id);
});

/* ─────────────────── ④ 派发权限：lead + 审计 actor ─────────────────── */

test("派发：lead 派给他人 → 200，审计 actor 是李娜（真实登录人，不是默认第一条坐席）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("dispatch-lead");
  const ticket = await newTicket({ question: `lead 派发 ${tag}` });

  const dispatched = await call({
    method: "PATCH",
    url: `/api/console/tickets/${ticket.id}`,
    token: leadTicket,
    payload: { status: "claimed", assignee_id: agent.staff_id },
  });
  assert.equal(dispatched.status, 200, `lead 派发给他人期望 200，实际 ${dispatched.status}：${dispatched.raw}`);
  const row = (dispatched.body as { data: { ticket: ListItem; changed: string[] } }).data;
  assert.equal(row.ticket.assignee_id, agent.staff_id);
  assert.equal(row.ticket.assignee, agent.name);
  assert.deepEqual(row.changed, ["status", "assignee"], "派发同时改了状态与指派");

  // 审计的 actor 必须是**真实登录人**（李娜），payload.staff_id 是她的 id。
  // 这是 `09#03` 之前做不到的事：那时"谁操作"来自客户端自称 / staff 表第一条。
  const audit = await auditActor(ticket.no);
  assert.ok(audit !== null, "派发必须写一条审计");
  assert.equal(audit.actor, lead.name, `审计 actor 必须是李娜，实际 "${audit.actor}"`);
  assert.equal(audit.payload.staff_id, lead.staff_id, "审计 payload.staff_id 必须是李娜的 staff_id");
  assert.notEqual(audit.payload.staff_id, agent.staff_id, "审计不得记成被派发的那个坐席");

  // lead 也做得了"清空指派"（另一条派发权）。
  const cleared = await call({
    method: "PATCH",
    url: `/api/console/tickets/${ticket.id}`,
    token: leadTicket,
    payload: { status: "open", assignee_id: null },
  });
  assert.equal(cleared.status, 200, `lead 清空指派期望 200，实际 ${cleared.status}：${cleared.raw}`);
  assert.equal((cleared.body as { data: { ticket: ListItem } }).data.ticket.assignee_id, null);
});

/* ─────────────────── ⑤ 可见性覆盖写路径（PATCH） ─────────────────── */

/**
 * `09#03` 留下的缺口：读路径早就 403 了（队列 + 详情），写路径没判 —— 于是"看不见标题"只挡住了
 * 眼睛，拿着 id 直接 PATCH 仍能改状态/结论。这一条把可见性补到**写**上，并守住三条不该被它
 * 误伤的正当动作：认领未分配单、改自己的单、lead 改他人工单。
 */
test("补丁也判可见性：agent 改他人工单 → 403 且库里一字未动；未分配 / 自己的照常可写，lead 改他人 200", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("patch-scope");
  const { one } = await import("../src/db.ts");
  const others = await newTicket({ question: `他人补丁 ${tag}`, status: "claimed", assignee: lead.staff_id });
  const leadEdits = await newTicket({ question: `lead 改我的单 ${tag}`, status: "claimed", assignee: agent.staff_id });

  // ① agent 关他人工单：body 完全合法（结论 13 字 ≥ 门槛），唯一挡住它的必须是可见性
  //    —— 这样这条断言才在说"权限"，而不是在说"结论太短"。
  const deniedClose = await call({
    method: "PATCH",
    url: `/api/console/tickets/${others.id}`,
    payload: { status: "closed", resolution: "电话指导复位后恢复正常运行" },
  });
  assert.equal(deniedClose.status, 403, `agent 关他人工单期望 403，实际 ${deniedClose.status}：${deniedClose.raw}`);
  assert.equal((deniedClose.body as ErrorBody).error.code, "FORBIDDEN");
  assert.equal(deniedClose.raw.includes("at "), false, `403 响应体不得含堆栈：${deniedClose.raw}`);
  // 不是 404：单子在不在由队列的 `total` 回答，用 404 遮只会遮住我们自己人（与详情同口径）。
  assert.equal(deniedClose.raw.includes(others.no), false, `403 响应体不得回显单号：${deniedClose.raw}`);
  assert.equal(deniedClose.raw.includes(tag), false, `403 响应体不得回显标题：${deniedClose.raw}`);

  // ② agent 想把自己的 id 写进 `assignee_id` 去"抢"他人工单：也是 403。
  //    这条刻意选"派给自己"而不是"派给别人"：派给**自己**在派发权那一关是允许的
  //    （认领），所以挡住它的只能是可见性 —— 两条 403 不是同一原因。
  const steal = await call({
    method: "PATCH",
    url: `/api/console/tickets/${others.id}`,
    payload: { status: "claimed", assignee_id: agent.staff_id },
  });
  assert.equal(steal.status, 403, `agent 抢他人工单期望 403，实际 ${steal.status}：${steal.raw}`);
  assert.equal((steal.body as ErrorBody).error.code, "FORBIDDEN");

  // ③ 被拒的写不得留下任何痕迹：状态 / 指派 / 结论三个字段全等，审计一行都不许有。
  //    "只判了返回码、库里被改了"是这类补丁最容易出的错。
  const afterDenied = await one<{ status: string; assignee: string | null; resolution: string | null }>(
    "select status, assignee, resolution from tickets where id = $1::bigint",
    [others.id],
  );
  assert.equal(afterDenied?.status, "claimed", "被 403 拒掉的补丁不得改动状态");
  assert.equal(afterDenied?.assignee, lead.staff_id, "被 403 拒掉的补丁不得改动指派");
  assert.equal(afterDenied?.resolution, null, "被 403 拒掉的补丁不得写入结论");
  assert.equal(await auditActor(others.no), null, "被 403 拒掉的补丁不得写审计");

  // ④ 未分配单：认领必须继续通（`assignee is null` 是等待认领的池子，可见性要放行）。
  //    这条是这次收口最容易踩断的地方 —— 它一断，`09#03` 的认领路径就没了。
  const pool = await newTicket({ question: `未分配补丁 ${tag}` });
  const claim = await call({
    method: "PATCH",
    url: `/api/console/tickets/${pool.id}`,
    payload: { status: "claimed" },
  });
  assert.equal(claim.status, 200, `agent 认领未分配单期望 200，实际 ${claim.status}：${claim.raw}`);
  assert.equal(
    (claim.body as { data: { ticket: ListItem } }).data.ticket.assignee_id,
    agent.staff_id,
    "认领必须落到当前登录的坐席",
  );

  // ⑤ 自己的单：写结论（不关单）和关单都必须继续通 —— 那是坐席的日常工作。
  const mine = await newTicket({ question: `我的单补丁 ${tag}`, status: "claimed", assignee: agent.staff_id });
  const wroteResolution = await call({
    method: "PATCH",
    url: `/api/console/tickets/${mine.id}`,
    payload: { resolution: "先记录一次预处理要点" },
  });
  assert.equal(wroteResolution.status, 200, `agent 改自己单的结论期望 200，实际 ${wroteResolution.status}：${wroteResolution.raw}`);
  const wroteTicket = (wroteResolution.body as { data: { ticket: ListItem & { resolution: string | null } } }).data.ticket;
  assert.equal(wroteTicket.status, "claimed", "只写结论不该顺手改状态");
  assert.equal(wroteTicket.resolution, "先记录一次预处理要点");

  const closedOwn = await call({
    method: "PATCH",
    url: `/api/console/tickets/${mine.id}`,
    payload: { status: "closed", resolution: "电话指导复位后恢复正常运行" },
  });
  assert.equal(closedOwn.status, 200, `agent 关自己的单期望 200，实际 ${closedOwn.status}：${closedOwn.raw}`);
  assert.equal((closedOwn.body as { data: { ticket: ListItem } }).data.ticket.status, "closed");

  // ⑥ lead 改他人工单（`leadEdits` 归张伟）→ 200：主管/运维的正当动作，不受可见性限制。
  const asLead = await call({
    method: "PATCH",
    url: `/api/console/tickets/${leadEdits.id}`,
    token: leadTicket,
    payload: { status: "escalated" },
  });
  assert.equal(asLead.status, 200, `lead 改他人工单期望 200，实际 ${asLead.status}：${asLead.raw}`);
  const asLeadTicket = (asLead.body as { data: { ticket: ListItem } }).data.ticket;
  assert.equal(asLeadTicket.status, "escalated");
  assert.equal(asLeadTicket.assignee_id, agent.staff_id, "改状态不该顺手换掉指派人");
});

/* ─────────────────── ⑥ 判定顺序：409 早于 403 ─────────────────── */

/**
 * 一张单**同时**满足"agent 无权"与"已关闭"时，答案必须是 409。
 *
 * 理由与既有注释同源：不可改变的状态先答。坐席最需要知道的是"这单不能改了"（换个身份也过不去），
 * 而不是"你没权限"（听起来像找主管就能改）。这条断言把顺序钉住 —— 将来谁把可见性判断提到
 * closed 之前，这里会红。
 */
test("补丁顺序：已关单 + agent + 他人工单 → 409（状态优先于权限）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("patch-order");
  const target = await newTicket({ question: `顺序用例 ${tag}`, status: "claimed", assignee: lead.staff_id });

  // 先用**真实路径**把它关掉（lead 关单，结论 ≥10 字），而不是直接 insert 一行 closed。
  const closed = await call({
    method: "PATCH",
    url: `/api/console/tickets/${target.id}`,
    token: leadTicket,
    payload: { status: "closed", resolution: "远程排查后确认无更换需求" },
  });
  assert.equal(closed.status, 200, `前置关单失败：${closed.raw}`);
  assert.equal((closed.body as { data: { ticket: ListItem } }).data.ticket.status, "closed");

  // 现在 agent 既无权（不是他的单）又碰上一个不可变状态：409 必须赢。
  const denied = await call({
    method: "PATCH",
    url: `/api/console/tickets/${target.id}`,
    payload: { status: "open" },
  });
  assert.equal(denied.status, 409, `已关单 + 他人工单期望 409（状态优先于权限），实际 ${denied.status}：${denied.raw}`);
  assert.equal((denied.body as ErrorBody).error.code, "TICKET_IMMUTABLE");
});

