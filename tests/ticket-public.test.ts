/**
 * 用户端工单接口的黑盒验收（`05-refusal-and-tickets` #02 · 05 §3.4–§3.5）。
 *
 * 为什么走 HTTP 而不是直接调 `createPublicTicket`：core 的 SQL 由 TypeScript 与数据库保证，
 * 这一层要证明的是**接线与安全性质**——五条都是"接错线不会报错、只会出事"的东西：
 *   ① 缺令牌是 401 而非 403/500；②邮箱不合法在落库之前就被挡住；
 *   ③ 别人的会话与不存在的会话回**同一个** 404（否则这台接口成了会话存在性预言机）；
 *   ④ 重复提交拿到同一张单，且**不扣第二张额度**（顺序：先查幂等、后扣配额）；
 *   ⑤ 查单时"号不存在"与"邮箱不匹配"是**逐字相同**的 404（否则能从 0001 撞号）。
 *
 * 只注册本卡的两条路由，不 import `src/routes.ts`：本文件要能在别人的路由半成品时独立
 * 变绿或变红。每个用例用自己的令牌（配额是按令牌计的，共用令牌会让用例互相烧额度）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 tests/ticket-internal.test.ts 同一套 .env 解析：`node --test` 不带 --env-file，得自己补。 */
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
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT && process.env.INTERNAL_TOKEN,
);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

/** 05 §4：工单号 `WT-YYYY-NNNN`（序列生成，跨年不重置）。 */
const TICKET_NO_RE = /^WT-\d{4}-\d{4}$/;

/** 05 §3.4：每 token 每小时 3 张。 */
const QUOTA_PER_HOUR = 3;

const CREATE_URL = "/api/ticket";

/** 本文件造出来的令牌与会话：清理只删自己的行与自己的键。 */
const tokens: string[] = [];
const convIds: string[] = [];

let app: FastifyInstance;

before(async () => {
  if (!hasRuntimeEnv) return;
  const [{ default: Fastify }, { registerTicketRoutes }, { toErrorBody }] = await Promise.all([
    import("fastify"),
    import("../src/api/ticket.ts"),
    import("../src/errors.ts"),
  ]);

  // 与 `src/server.ts` 同一段错误处理器：错误体形状必须与线上一致，否则"两个 404 逐字相同"
  // 这条性质在本文件里就成了自说自话。`genReqId` 也照抄线上那条（无头则本地生成），
  // 这样 trace_id 是每次请求各自的值 —— 两个 404 的比较必须忽略它，比较的是 code + message。
  app = Fastify({ logger: false });
  app.setErrorHandler((err, request, reply) => {
    const { status, body } = toErrorBody(err, String(request.id));
    return reply.code(status).send(body);
  });
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ ok: false, error: { code: "NOT_FOUND", message: "Not found", trace_id: String(request.id) } }),
  );
  await registerTicketRoutes(app);
  await app.ready();
});

after(async () => {
  if (!hasRuntimeEnv) return;
  const [{ pool, query }, { redis }] = await Promise.all([import("../src/db.ts"), import("../src/redis.ts")]);
  if (app !== undefined) await app.close();

  // 顺序：先删工单再删会话。`tickets.conv_id` 是 `on delete set null`，反过来的话
  // 会话被删掉、工单留下来变成一张没有来源的孤儿单，下一次跑测试就会数到它。
  if (convIds.length > 0) {
    await query("delete from tickets where conv_id = any($1::uuid[])", [convIds]);
    // `messages` 随会话 `on delete cascade` 一起走。
    await query("delete from conversations where id = any($1::uuid[])", [convIds]);
  }

  const keys = [
    ...tokens.map((token) => `sess:${token}`),
    ...tokens.map((token) => `quota:ticket:${token}`),
    ...convIds.map((convId) => `ticket:idem:${convId}`),
  ];
  if (keys.length > 0) await redis.del(...keys);

  await redis.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

/* ─────────────────────────── 夹具 ─────────────────────────── */

/**
 * 签发一个"已登录"的令牌：只写 `sess:{token}`，不调 `/api/session`
 * （那条路由有 IP 限流，10 次/分钟；本文件要的令牌数会顶到它，而限流不是本卡要测的东西）。
 */
async function newToken(): Promise<string> {
  const { redis } = await import("../src/redis.ts");
  const token = randomUUID();
  await redis.setex(`sess:${token}`, 600, "1");
  tokens.push(token);
  return token;
}

/** 造一条属于某令牌的会话（`/api/chat` 建会话时写的也是 `token_id`）。 */
async function newConv(token: string): Promise<string> {
  const { one } = await import("../src/db.ts");
  const row = await one<{ id: string }>(
    "insert into conversations (token_id, lang) values ($1::uuid, 'en') returning id",
    [token],
  );
  assert.ok(row !== null, "会话没造出来");
  convIds.push(row.id);
  return row.id;
}

async function addUserMessage(convId: string, content: string): Promise<void> {
  const { query } = await import("../src/db.ts");
  await query(
    "insert into messages (conv_id, role, content, lang) values ($1::uuid, 'user', $2, 'en')",
    [convId, content],
  );
}

type ErrorBody = { ok: false; error: { code: string; message: string; trace_id?: string } };
type CreateData = { no: string; due_at: string; status: string; idempotent: boolean };
type LookupData = { found: true; no: string; status: string; created_at: string };
type SuccessBody<T> = { ok: true; data: T };
type Reply = { status: number; body: unknown };

function headersOf(token: string | null): Record<string, string> {
  return token === null ? {} : { "x-user-session": token };
}

/** `token: null` = 不带凭据头。 */
async function postTicket(payload: Record<string, unknown>, token: string | null): Promise<Reply> {
  const response = await app.inject({ method: "POST", url: CREATE_URL, payload, headers: headersOf(token) });
  return { status: response.statusCode, body: response.json() };
}

/** `email: null` = 不带该 query 参数。 */
async function getTicket(no: string, email: string | null, token: string | null): Promise<Reply> {
  const query = email === null ? "" : `?email=${encodeURIComponent(email)}`;
  const response = await app.inject({
    method: "GET",
    url: `/api/ticket/${encodeURIComponent(no)}${query}`,
    headers: headersOf(token),
  });
  return { status: response.statusCode, body: response.json() };
}

/** 404 只允许 trace_id 不同：去掉它再逐字比较（trace_id 是每次请求各自的值）。 */
function withoutTraceId(body: unknown): unknown {
  const parsed = body as ErrorBody;
  return { ok: parsed.ok, error: { code: parsed.error.code, message: parsed.error.message } };
}

async function createTicket(
  token: string,
  convId: string,
  email: string,
  extra: Record<string, unknown> = {},
): Promise<CreateData> {
  const { status, body } = await postTicket({ conv_id: convId, email, ...extra }, token);
  assert.equal(status, 200, `建单期望 200，实际 ${status}：${JSON.stringify(body)}`);
  const ok = body as SuccessBody<CreateData>;
  assert.equal(ok.ok, true, "响应体缺少 ok:true");
  return ok.data;
}

/* ─────────────────────────── 鉴权 ─────────────────────────── */

test("鉴权：缺令牌 401 AUTH_REQUIRED，假令牌 401 AUTH_INVALID（两条路由都是）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const conv = await newConv(await newToken());

  const missing = await postTicket({ conv_id: conv, email: "installer@example.com" }, null);
  assert.equal(missing.status, 401, `缺令牌期望 401，实际 ${missing.status}`);
  assert.equal((missing.body as ErrorBody).error.code, "AUTH_REQUIRED");

  // 形状对但 Redis 里没有：令牌过期（前端该重新 POST /api/session）。
  const unknown = await postTicket({ conv_id: conv, email: "installer@example.com" }, randomUUID());
  assert.equal(unknown.status, 401);
  assert.equal((unknown.body as ErrorBody).error.code, "AUTH_INVALID");

  // 形状都不对：不能拿它去撞 uuid 列（那会变成 500），一律按"过期"处理。
  const malformed = await postTicket({ conv_id: conv, email: "installer@example.com" }, "not-a-token");
  assert.equal(malformed.status, 401);
  assert.equal((malformed.body as ErrorBody).error.code, "AUTH_INVALID");

  const getMissing = await getTicket("WT-2026-0001", "installer@example.com", null);
  assert.equal(getMissing.status, 401, "查单同样需要用户令牌（05 §2 端点表：User）");
});

/* ─────────────────────────── 入参校验 ─────────────────────────── */

test("建单：邮箱不合法一律 400 VALIDATION，且不落库", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const token = await newToken();
  const conv = await newConv(token);

  // 务实校验的边界：没有本地部分 / 没有 @ / 域名里没点 / 顶级域只 1 位 / 中间带空格 / 超 254。
  const bad = [
    "",
    "   ",
    "installer",
    "installer@example",
    "installer@example.c",
    "installer @example.com",
    "a@b@example.com",
    `${"x".repeat(250)}@example.com`,
  ];
  for (const email of bad) {
    const { status, body } = await postTicket({ conv_id: conv, email, question: "E03 反复出现" }, token);
    assert.equal(status, 400, `email=${JSON.stringify(email.slice(0, 40))} 期望 400，实际 ${status}`);
    assert.equal((body as ErrorBody).error.code, "VALIDATION", `响应体：${JSON.stringify(body)}`);
  }

  // 缺 email（不是空串）同样是 400：它是这张单唯一的联系方式，不能省。
  const missing = await postTicket({ conv_id: conv, question: "E03 反复出现" }, token);
  assert.equal(missing.status, 400);

  const { one } = await import("../src/db.ts");
  const leaked = await one<{ count: string }>(
    "select count(*)::text as count from tickets where conv_id = $1::uuid",
    [conv],
  );
  assert.equal(leaked?.count, "0", "校验失败的请求不得写入任何工单");

  // 上界必须放行：`installer+wt@sub.example.com` 是真实存在的写法。
  const ok = await createTicket(token, conv, "installer+wt@sub.example.com", { question: "E03 反复出现" });
  assert.match(ok.no, TICKET_NO_RE);
});

test("建单：别人的会话与不存在的会话回同一个 404（不确认存在性）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const mine = await newToken();
  const other = await newToken();
  const foreignConv = await newConv(other);
  const unknownConv = randomUUID();

  const foreign = await postTicket({ conv_id: foreignConv, email: "installer@example.com" }, mine);
  const unknown = await postTicket({ conv_id: unknownConv, email: "installer@example.com" }, mine);

  assert.equal(foreign.status, 404, `别人的会话期望 404，实际 ${foreign.status}`);
  assert.equal(unknown.status, 404, `不存在的会话期望 404，实际 ${unknown.status}`);
  assert.deepEqual(
    withoutTraceId(foreign.body),
    withoutTraceId(unknown.body),
    `两条 404 必须逐字相同（去掉 trace_id 后），实际：${JSON.stringify([foreign.body, unknown.body])}`,
  );
  assert.equal((foreign.body as ErrorBody).error.code, "NOT_FOUND");

  // 越权请求不能留下任何单：别人的会话上多出一张单，坐席会以为是那位用户提交的。
  const { one } = await import("../src/db.ts");
  const leaked = await one<{ count: string }>(
    "select count(*)::text as count from tickets where conv_id = $1::uuid",
    [foreignConv],
  );
  assert.equal(leaked?.count, "0", "越权建单不得写入工单");
});

test("建单：conv_id 形状不合法是 400（参数错与「不属于你」必须分开）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const token = await newToken();
  const { status, body } = await postTicket({ conv_id: "abc", email: "installer@example.com" }, token);
  assert.equal(status, 400, `非 uuid 的 conv_id 期望 400，实际 ${status}`);
  assert.equal((body as ErrorBody).error.code, "VALIDATION");
});

/* ─────────────────────────── 正常建单 ─────────────────────────── */

test("建单：单号 WT-YYYY-NNNN、requester=email、reason=user_request、due_at 对齐 SLA", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { one } = await import("../src/db.ts");
  const token = await newToken();
  const conv = await newConv(token);
  const email = "installer@example.com";

  const created = await createTicket(token, conv, email, { question: "E03 反复出现，请回电" });

  assert.match(created.no, TICKET_NO_RE, `号不符合 ^WT-\\d{4}-\\d{4}$：${created.no}`);
  assert.equal(created.status, "open", "新单状态必须是 open（05 §4 四态之一）");
  assert.equal(created.idempotent, false, "第一次提交不是幂等命中");

  const row = await one<{
    no: string;
    reason: string;
    question: string;
    requester: string | null;
    conv_id: string | null;
    status: string;
    due_at: Date;
  }>("select no, reason, question, requester, conv_id, status, due_at from tickets where no = $1", [
    created.no,
  ]);
  assert.ok(row !== null, `工单 ${created.no} 没落库`);
  // 公开入口的原因恒为"用户主动转人工"：前端传什么都改不了（05 §3.4「前端不得传原因」）。
  assert.equal(row.reason, "user_request", `reason 必须是 user_request，实际 ${row.reason}`);
  assert.equal(row.requester, email, "公开入口必须把邮箱落进 requester（否则查单永远查不到）");
  assert.equal(row.conv_id, conv, "工单必须挂在本令牌的这个会话上");
  assert.equal(row.question, "E03 反复出现，请回电");
  assert.equal(row.status, "open");

  // due_at 的来源是 `settings` 里的 SLA 小时数：按库里实际的值算期望，不写死 4
  // （运营把 SLA 改成 8 小时不该把测试变红，那不是回归）。
  const slaRow = await one<{ value: unknown }>(
    "select value from settings where key in ('slas.hours', 'sla.hours') order by key = 'slas.hours' desc limit 1",
  );
  const hours = Number(slaRow?.value ?? 4);
  const expectedMs = Date.now() + (Number.isFinite(hours) ? hours : 4) * 3_600_000;
  const dueMs = Date.parse(created.due_at);
  assert.ok(Number.isFinite(dueMs), `due_at 不是合法时间：${created.due_at}`);
  assert.ok(
    Math.abs(dueMs - expectedMs) < 5 * 60_000,
    `due_at 应在 ${hours} 小时后（±5 分钟容差），实际 ${created.due_at}`,
  );
});

test("建单：前端传的 reason 被忽略，仍写 user_request", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { one } = await import("../src/db.ts");
  const token = await newToken();
  const conv = await newConv(token);

  const created = await createTicket(token, conv, "installer@example.com", {
    question: "Bitte um Rückruf",
    reason: "no_citation",
  });
  const row = await one<{ reason: string }>("select reason from tickets where no = $1", [created.no]);
  assert.equal(row?.reason, "user_request", `前端传的 reason 必须被顶掉，实际 ${row?.reason}`);
});

test("建单：question 缺省时取会话里最后一条用户消息（短消息也放行）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { one } = await import("../src/db.ts");
  const token = await newToken();

  const conv = await newConv(token);
  await addUserMessage(conv, "E03 kommt immer wieder");
  await addUserMessage(conv, "Was kostet ein Ersatzteil?");
  const created = await createTicket(token, conv, "installer@example.com");
  const row = await one<{ question: string }>("select question from tickets where no = $1", [created.no]);
  assert.equal(row?.question, "Was kostet ein Ersatzteil?", "缺省 question 必须是**最后**一条用户消息");

  // 只有 3 个字符的提问（"E03"）也必须能转人工：4 字下限是挡公开接口灌水的，
  // 不是用来拒绝用户自己刚打过的那句话（见 core 的 `resolveQuestion`）。
  const shortConv = await newConv(token);
  await addUserMessage(shortConv, "E03");
  const shortTicket = await createTicket(token, shortConv, "installer@example.com");
  const shortRow = await one<{ question: string }>("select question from tickets where no = $1", [
    shortTicket.no,
  ]);
  assert.equal(shortRow?.question, "E03");

  // 空白 question 等价于"没填"：表单一上空着提交比填 3 个字常见得多，同样回落到会话历史。
  const blankConv = await newConv(token);
  await addUserMessage(blankConv, "Speicher lädt nicht");
  const blank = await createTicket(token, blankConv, "installer@example.com", { question: "   " });
  const blankRow = await one<{ question: string }>("select question from tickets where no = $1", [blank.no]);
  assert.equal(blankRow?.question, "Speicher lädt nicht", "空白 question 必须回落到会话历史");

  // 会话里一条用户消息都没有 → 400（不能建一张正文空白的单）。
  const emptyConv = await newConv(token);
  const empty = await postTicket({ conv_id: emptyConv, email: "installer@example.com" }, token);
  assert.equal(empty.status, 400, `空会话期望 400，实际 ${empty.status}`);
  assert.equal((empty.body as ErrorBody).error.code, "VALIDATION");
});

/* ─────────────────────────── 幂等与配额 ─────────────────────────── */

test("幂等：5 分钟内重复提交 → 同一单号、idempotent=true、只有一行、配额不前进", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const [{ one }, { redis }] = await Promise.all([import("../src/db.ts"), import("../src/redis.ts")]);
  const token = await newToken();
  const conv = await newConv(token);
  const quotaKey = `quota:ticket:${token}`;

  const first = await createTicket(token, conv, "installer@example.com", { question: "E03 反复出现" });
  const afterFirst = await redis.zcard(quotaKey);
  assert.equal(afterFirst, 1, `第一次建单应该只占 1 个额度，实际 ${afterFirst}`);

  // 立即重复：用户的连点 / 网络重试 / 前端超时自动重发都是这一种。
  const again = await postTicket(
    { conv_id: conv, email: "installer@example.com", question: "E03 反复出现（重试）" },
    token,
  );
  assert.equal(again.status, 200, `重复提交期望 200，实际 ${again.status}：${JSON.stringify(again.body)}`);
  const data = (again.body as SuccessBody<CreateData>).data;
  assert.equal(data.no, first.no, "5 分钟内的重复提交必须返回同一个单号");
  assert.equal(data.idempotent, true, "幂等命中必须标 idempotent:true");
  assert.equal(data.status, first.status);

  // 只落了一行：幂等命中不新建行，也不覆盖原来的正文（第二句"重试"不该出现在库里）。
  const rows = await one<{ count: string; question: string }>(
    "select count(*)::text as count, min(question) as question from tickets where conv_id = $1::uuid",
    [conv],
  );
  assert.equal(rows?.count, "1", `幂等命中不得新建行，实际 ${rows?.count} 行`);
  assert.equal(rows?.question, "E03 反复出现", "幂等命中不得改写已存在工单的正文");

  // 关键一条：幂等命中**不扣配额**。顺序要是反的（先扣配额再查幂等），用户重试两次
  // 就把一小时的额度烧光，第三次真的想建单时被 429 —— 限流反过来惩罚了最急的人。
  const afterRepeat = await redis.zcard(quotaKey);
  assert.equal(afterRepeat, afterFirst, `幂等命中不得扣配额：${afterFirst} → ${afterRepeat}`);
});

test("配额：同一令牌一小时第 4 张 → 429 QUOTA_TICKET（前 3 张照常建）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { one } = await import("../src/db.ts");
  const token = await newToken();

  const nos: string[] = [];
  // 每张单用**不同的会话**：同一个会话会被幂等合并成一张，测不到配额。
  for (let i = 0; i < QUOTA_PER_HOUR; i += 1) {
    const conv = await newConv(token);
    const created = await createTicket(token, conv, "installer@example.com", { question: `Frage ${i + 1}: E03` });
    nos.push(created.no);
  }
  assert.equal(new Set(nos).size, QUOTA_PER_HOUR, `前三张必须是三个不同的号：${nos.join(",")}`);

  const fourthConv = await newConv(token);
  const fourth = await postTicket({ conv_id: fourthConv, email: "installer@example.com", question: "Frage 4: E03" }, token);
  assert.equal(fourth.status, 429, `第 4 张期望 429，实际 ${fourth.status}：${JSON.stringify(fourth.body)}`);
  assert.equal((fourth.body as ErrorBody).error.code, "QUOTA_TICKET");

  // 被 429 的请求不能留下半张单。
  const leaked = await one<{ count: string }>(
    "select count(*)::text as count from tickets where conv_id = $1::uuid",
    [fourthConv],
  );
  assert.equal(leaked?.count, "0", "超配额的请求不得写入工单");
});

/* ─────────────────────────── 查单 ─────────────────────────── */

test("查单：单号 + 邮箱命中，形状与 05 §3.5 一致", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const token = await newToken();
  const conv = await newConv(token);
  const created = await createTicket(token, conv, "installer@example.com", { question: "E03 反复出现" });

  const { status, body } = await getTicket(created.no, "installer@example.com", token);
  assert.equal(status, 200, `查单期望 200，实际 ${status}：${JSON.stringify(body)}`);
  const ok = body as SuccessBody<LookupData>;
  assert.equal(ok.ok, true);
  assert.equal(ok.data.found, true);
  assert.equal(ok.data.no, created.no);
  assert.equal(ok.data.status, "open");
  assert.ok(Number.isFinite(Date.parse(ok.data.created_at)), `created_at 不是合法时间：${ok.data.created_at}`);

  // 邮箱大小写不敏感：用户换个大小写就查不到自己的单，是纯粹的伤害。
  const upper = await getTicket(created.no, "INSTALLER@Example.COM", token);
  assert.equal(upper.status, 200, `大小写不同应当仍能查到，实际 ${upper.status}`);

  // 单号也容忍大小写与空白：它是从邮件/截图里复制出来的。
  const noisy = await getTicket(` ${created.no.toLowerCase()} `, "installer@example.com", token);
  assert.equal(noisy.status, 200, `小写带空格的单号应当仍能查到，实际 ${noisy.status}`);
});

test("查单：邮箱不匹配与单号不存在回同一个 404 体（避免枚举）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const token = await newToken();
  const conv = await newConv(token);
  const created = await createTicket(token, conv, "installer@example.com", { question: "E03 反复出现" });

  const unknownNo = await getTicket("WT-2026-9999", "installer@example.com", token);
  const wrongEmail = await getTicket(created.no, "someone-else@example.com", token);

  assert.equal(unknownNo.status, 404, `不存在的单号期望 404，实际 ${unknownNo.status}`);
  assert.equal(wrongEmail.status, 404, `邮箱不匹配期望 404，实际 ${wrongEmail.status}`);
  assert.deepEqual(
    withoutTraceId(wrongEmail.body),
    withoutTraceId(unknownNo.body),
    `两个 404 必须逐字相同（去掉 trace_id 后），实际：${JSON.stringify([wrongEmail.body, unknownNo.body])}`,
  );
  assert.equal((wrongEmail.body as ErrorBody).error.code, "NOT_FOUND");
});

test("查单：缺 email / 邮箱不合法回 400（参数错，不是「查不到」）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const token = await newToken();

  const missing = await getTicket("WT-2026-0001", null, token);
  assert.equal(missing.status, 400, `缺 email 期望 400，实际 ${missing.status}`);
  assert.equal((missing.body as ErrorBody).error.code, "VALIDATION");

  const malformed = await getTicket("WT-2026-0001", "installer", token);
  assert.equal(malformed.status, 400);
  assert.equal((malformed.body as ErrorBody).error.code, "VALIDATION");
});

/* ───────────────────── 冷启动：没有会话也能转人工（06#03） ───────────────────── */

test("冷启动建单：不带 conv_id → 200、单号合法、conv_id 落 null、reason 仍是 user_request", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  // 用户打开工单页就转人工（一次都没聊过 → 没有 conv_id）。这是 `06#03` 的真实入口，
  // 校验通过后落库的 conv_id 为 null：单子不属于任何对话，但必须能被坐席看到。
  const token = await newToken();
  const question = `冷启动转人工 ${Date.now()}`;
  const { status, body } = await postTicket({ email: "cold@example.com", question }, token);
  assert.equal(status, 200, `冷启动建单期望 200，实际 ${status}：${JSON.stringify(body)}`);
  const data = (body as SuccessBody<CreateData>).data;
  assert.match(data.no, /^WT-\d{4}-\d{4}$/);

  const { query } = await import("../src/db.ts");
  const rows = await query<{ conv_id: string | null; reason: string; requester: string }>(
    `select conv_id, reason, requester from tickets where no = $1`,
    [data.no],
  );
  assert.equal(rows.length, 1, "必须真的落了一行");
  assert.equal(rows[0]?.conv_id, null, "没有会话时应落 null，而不是编一个 uuid");
  assert.equal(rows[0]?.reason, "user_request", "公开入口原因恒为转人工");
  assert.equal(rows[0]?.requester, "cold@example.com", "邮箱进 requester");

  // 没有会话就没有幂等键：同一邮箱再提交一次是**新单**（不同单号）
  const again = await postTicket({ email: "cold@example.com", question: `${question} 再来一张` }, token);
  assert.equal(again.status, 200);
  assert.notEqual((again.body as SuccessBody<CreateData>).data.no, data.no, "无会话时不做 5 分钟幂等合并");

  // 清理：两张单 + 本次配额键
  await query(`delete from tickets where no = any($1::text[])`, [[data.no, (again.body as SuccessBody<CreateData>).data.no]]);
});

test("冷启动建单：没有会话又没填问题描述 → 400 VALIDATION（不能被当成空单收下）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const token = await newToken();
  const { status, body } = await postTicket({ email: "cold2@example.com" }, token);
  assert.equal(status, 400, `期望 400，实际 ${status}：${JSON.stringify(body)}`);
  assert.equal((body as ErrorBody).error.code, "VALIDATION");
});
