/**
 * 三档鉴权与安全边界的黑盒验收（`07-console-and-security` #01 · 05 §1/§4/§7/§8 · 18 §8 G5）。
 *
 * 这一层要证明的是**边界**，不是业务：三档凭据各自的失败形状、失败之间是否可区分、
 * 限流是否发生在落库之前、错误响应里有没有不该有的东西。全部走 `app.inject` + 真实
 * `buildApp()`（`src/server.ts`）：404 的"逐字同形"只有在**线上那一个** `setNotFoundHandler`
 * 参与时才是可断言的事实，测试里另写一份 404 就成了自说自话。来源地址用 inject 的
 * `remoteAddress` 伪造 —— 那是这道门唯一的数据来源（`socket.remoteAddress`）。
 *
 * **规格内部矛盾已裁定**：`07` spec §Testing Decisions 与 `18` §8 写"回环 + 错令牌 → 401"，
 * 而 spec 的 §Implementation Decisions、工单 01 与既有实现/既有断言都是 404。这里断言 404，
 * 理由见 `src/auth.ts` 的 `sendNotFound`（401 等于向扫描器承认端点存在）。
 *
 * 并发提示：本文件与其它 agent 的测试共用同一个库。所有夹具用 `auth07-` 前缀（邮箱、坐席），
 * 清理只删自己造的行与 Redis 键；**不碰** `rl:session:*`（那是按 IP 计的、会被别人同时在用）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 tests/ticket-public.test.ts 同一套 .env 解析：`node --test` 不带 --env-file，得自己补。 */
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
  "缺少 .env（或其中没有数据层连接串 / INTERNAL_TOKEN）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

const internalToken = String(process.env.INTERNAL_TOKEN ?? "").trim();

/** 演示账号（`sql/002_seed.sql`）：口令 `wt-demo-2026`，部署前必须改。 */
const DEMO_EMAIL = "zhang.wei@wotai.demo";
const DEMO_PASSWORD = "wt-demo-2026";

/** 本文件造出来的夹具，`after` 只清这些。 */
const tokens: string[] = [];
/** 本文件签出来的坐席会话票据（`staff_session:{ticket}` 要删掉，否则 Redis 里留一堆死会话）。 */
const staffTickets: string[] = [];
const ticketNos: string[] = [];
const ticketRequesters: string[] = [];
const staffIds: string[] = [];

/** 唯一的邮箱/坐席前缀：同时跑测试的 agent 不会撞到同一行。 */
const FIXTURE = `auth07-${randomUUID().slice(0, 8)}`;

type ErrorBody = { ok: false; error: { code: string; message: string; trace_id: string } };
type Reply = { status: number; body: unknown; raw: string };

let app: FastifyInstance;
let adminApp: FastifyInstance;

before(async () => {
  if (!hasRuntimeEnv) return;
  const { buildApp } = await import("../src/server.ts");
  app = await buildApp();
  await registerThrowProbes(app);
  // 坐席端此刻还没有业务路由（07#02 才做），所以 `requireAdmin` 用一个只跑守卫的临时实例探针。
  // 探针与主实例共用 `toErrorBody`，401 的信封形状才是线上的那一种。
  adminApp = await buildAdminProbe();
});

/**
 * 脱敏用例需要的两条"故意坏掉"的路由：一条抛带连接串与堆栈特征的异常，一条带 JSON Schema。
 * 加在同一个 app 上（而不是另起一个实例）：脱敏断言必须落在**线上那个**错误处理器上。
 */
async function registerThrowProbes(target: FastifyInstance): Promise<void> {
  target.get("/__probe/boom", async () => {
    throw new Error(
      "connect ECONNREFUSED 127.0.0.1:5432 (postgres://wt:sup3rsecret@127.0.0.1:5432/wt_dev) at E:\\app\\src\\db.ts:42",
    );
  });
  target.post(
    "/__probe/schema",
    { schema: { body: { type: "object", required: ["n"], properties: { n: { type: "integer" } } } } },
    async (request) => ({ ok: true, n: (request.body as { n: number }).n }),
  );
}

/** 只跑 `requireAdmin` 的探针实例：坐席业务路由属于 07#02，本卡不为测试提前实现它们。 */
async function buildAdminProbe(): Promise<FastifyInstance> {
  const [{ default: Fastify }, { toErrorBody }, { requireAdmin }] = await Promise.all([
    import("fastify"),
    import("../src/errors.ts"),
    import("../src/auth.ts"),
  ]);
  const probe = Fastify({ logger: false });
  probe.setErrorHandler((err, request, reply) => {
    const { status, body } = toErrorBody(err, String(request.id));
    return reply.code(status).send(body);
  });
  probe.get("/__probe/admin", async (request, reply) => {
    const principal = await requireAdmin(request);
    return reply.code(200).send({ ok: true, data: principal });
  });
  await probe.ready();
  return probe;
}

after(async () => {
  if (!hasRuntimeEnv) return;
  const [{ pool, query }, { redis }] = await Promise.all([import("../src/db.ts"), import("../src/redis.ts")]);
  if (app !== undefined) await app.close();
  if (adminApp !== undefined) await adminApp.close();

  if (ticketNos.length > 0) await query("delete from tickets where no = any($1::text[])", [ticketNos]);
  if (ticketRequesters.length > 0) {
    await query("delete from tickets where requester = any($1::text[])", [ticketRequesters]);
  }
  if (staffIds.length > 0) await query("delete from staff where id = any($1::uuid[])", [staffIds]);

  const keys = [
    ...tokens.map((token) => `sess:${token}`),
    ...tokens.map((token) => `quota:ticket:${token}`),
    ...staffTickets.map((ticket) => `staff_session:${ticket}`),
    // 登录限速按 IP 计数，而 app.inject 的来源永远是 127.0.0.1：不清掉就会让同机器的
    // 下一个测试文件（或下一次手动登录）撞 429。
    "login:127.0.0.1",
  ];
  if (keys.length > 0) await redis.del(...keys);

  await redis.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

/* ─────────────────────────── 夹具 ─────────────────────────── */

/** 签发一个"已登录"的令牌：直接写 `sess:{token}`，不调 `/api/session`（那条路由有 IP 限流）。 */
async function newToken(): Promise<string> {
  const { redis } = await import("../src/redis.ts");
  const token = randomUUID();
  await redis.setex(`sess:${token}`, 600, "1");
  tokens.push(token);
  return token;
}

function toReply(response: { statusCode: number; body: string }): Reply {
  return { status: response.statusCode, body: JSON.parse(response.body) as unknown, raw: response.body };
}

/**
 * 404 只允许 `trace_id` 不同（它是每次请求各自的值）。去掉它再逐字比较 —— 这是"端点存在性
 * 不外泄"唯一能被机器判定的形式：状态码、code、message 三者都要一致。
 */
function withoutTraceId(body: unknown): unknown {
  const parsed = body as ErrorBody;
  return { ok: parsed.ok, error: { code: parsed.error.code, message: parsed.error.message } };
}

/* ─────────────────────── ① 内部接口：回环 + 令牌 ─────────────────────── */

/** 四个内部端点都要过同一道门。查单最便宜（一条主键查询，不嵌入、不模型）。 */
const INTERNAL_CALLS = [
  { method: "POST", url: "/internal/ticket/lookup", payload: { no: "WT-2026-9999" } },
  { method: "GET", url: "/internal/fault", query: { code: "E03", lang: "en" } },
  { method: "POST", url: "/internal/search", payload: { query: "warranty", lang: "en" } },
  {
    method: "POST",
    url: "/internal/citations",
    payload: {
      message_id: 1,
      citations: [
        { idx: 1, chunk_id: null, doc_title: "t", doc_lang: "en", page: null, snippet: "s", score: 0.5 },
      ],
    },
  },
] as const;

async function callInternal(
  call: (typeof INTERNAL_CALLS)[number],
  options: { token?: string | null; remoteAddress?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token !== null) headers["x-internal-token"] = options.token ?? internalToken;
  const response = await app.inject({
    method: call.method,
    url: call.url,
    headers,
    ...("payload" in call ? { payload: call.payload } : {}),
    ...("query" in call ? { query: call.query } : {}),
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
  });
  return toReply(response);
}

test("内部接口：回环（127.0.0.1 / ::1 / ::ffff:127.x）+ 正确令牌 → 200", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const loopbacks = [undefined, "127.0.0.1", "::1", "::ffff:127.0.0.1", "127.9.9.9"];
  for (const remoteAddress of loopbacks) {
    const call = { method: "GET", url: "/internal/fault", query: { code: "E03", lang: "en" } } as const;
    const reply = await callInternal(call, { remoteAddress });
    assert.equal(
      reply.status,
      200,
      `来源 ${remoteAddress ?? "默认"} 应放行，实际 ${reply.status}：${reply.raw}`,
    );
  }
});

test("内部接口：错令牌 / 缺令牌 / 非回环来源 → 404，且与「路径不存在」逐字同形", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const absent = await app.inject({ method: "GET", url: "/__auth07-definitely-not-a-route" });
  assert.equal(absent.statusCode, 404);
  const baseline = withoutTraceId(JSON.parse(absent.body));
  assert.deepEqual(baseline, { ok: false, error: { code: "NOT_FOUND", message: "Not found" } });

  // 四个内部端点 × 四种失败方式：全部必须与"路径不存在"不可区分。
  const failures: [string, Reply][] = [];
  for (const call of INTERNAL_CALLS) {
    const label = `${call.method} ${call.url}`;
    failures.push([`${label} · 错令牌`, await callInternal(call, { token: "not-the-token" })]);
    failures.push([`${label} · 缺令牌`, await callInternal(call, { token: null })]);
    // 伪造非回环来源：令牌是对的也不行 —— 两道门缺一不可。
    failures.push([
      `${label} · 非回环来源 10.1.2.3`,
      await callInternal(call, { remoteAddress: "10.1.2.3" }),
    ]);
    // 前缀相同的非回环地址：`startsWith("127.")` 那种写法会在这里放行（G5 黑线）。
    failures.push([`${label} · 127 前缀伪造 127.evil.com`, await callInternal(call, { remoteAddress: "127.evil.com" })]);
  }

  for (const [label, reply] of failures) {
    assert.equal(reply.status, 404, `${label} 期望 404（不是 401：401 会承认端点存在），实际 ${reply.status}`);
    assert.deepEqual(withoutTraceId(reply.body), baseline, `${label} 的 404 必须与真 404 逐字同形：${reply.raw}`);
  }
});

/* ─────────────────────── ② 用户端：401 的两种语义 ─────────────────────── */

test("用户端：缺令牌 401 AUTH_REQUIRED、伪造令牌 401 AUTH_INVALID（chat 与 ticket 同一份实现）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  const calls = [
    { label: "POST /api/chat", method: "POST" as const, url: "/api/chat", payload: { text: "E03" } },
    {
      label: "POST /api/ticket",
      method: "POST" as const,
      url: "/api/ticket",
      payload: { email: `${FIXTURE}@example.com`, question: "Bitte um Rückruf" },
    },
    { label: "GET /api/ticket/:no", method: "GET" as const, url: "/api/ticket/WT-2026-0001?email=a@b.co" },
  ];

  const shapes: unknown[] = [];
  for (const call of calls) {
    const missing = toReply(
      await app.inject({
        method: call.method,
        url: call.url,
        ...("payload" in call ? { payload: call.payload } : {}),
      }),
    );
    assert.equal(missing.status, 401, `${call.label} 缺令牌期望 401，实际 ${missing.status}：${missing.raw}`);
    assert.equal((missing.body as ErrorBody).error.code, "AUTH_REQUIRED");

    // 形状对但 Redis 里没有：令牌过期（前端该重新 POST /api/session）。
    const unknown = toReply(
      await app.inject({
        method: call.method,
        url: call.url,
        headers: { "x-user-session": randomUUID() },
        ...("payload" in call ? { payload: call.payload } : {}),
      }),
    );
    assert.equal(unknown.status, 401, `${call.label} 伪造令牌期望 401，实际 ${unknown.status}`);
    assert.equal((unknown.body as ErrorBody).error.code, "AUTH_INVALID");

    // 形状都不对：不能拿它去撞 uuid 列（那会变成 500），一律按"过期"处理。
    const malformed = toReply(
      await app.inject({
        method: call.method,
        url: call.url,
        headers: { "x-user-session": "not-a-token" },
        ...("payload" in call ? { payload: call.payload } : {}),
      }),
    );
    assert.equal(malformed.status, 401, `${call.label} 畸形令牌期望 401，实际 ${malformed.status}`);
    assert.equal((malformed.body as ErrorBody).error.code, "AUTH_INVALID");

    shapes.push({
      missing: withoutTraceId(missing.body),
      unknown: withoutTraceId(unknown.body),
      malformed: withoutTraceId(malformed.body),
    });
  }

  // 三处入口的 401 **逐字相同**：这正是不再各抄一份的证明 —— 两份拷贝迟早会在文案或码上漂。
  for (const shape of shapes.slice(1)) assert.deepEqual(shape, shapes[0], "三个用户端入口的 401 必须同形");
});

/* ─────────────────────── ③ 坐席端：requireAdmin（服务端会话） ─────────────────────── */

/**
 * 登录拿票据。先清 `login:127.0.0.1` 的限速计数：限速键是"每 IP 每分钟 5 次"，而 app.inject
 * 的来源永远是 127.0.0.1 —— 跨测试文件累计（加上人手在浏览器里登录）很容易在第 6 次撞 429，
 * 那是限速的**正确**行为，但不该让一条无关的断言变红。
 */
async function loginAs(
  email: string,
  password: string,
): Promise<{ ticket: string; staff: { staff_id: string; name: string; role: string; email: string } }> {
  const { redis } = await import("../src/redis.ts");
  await redis.del("login:127.0.0.1");
  const reply = toReply(
    await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } }),
  );
  assert.equal(reply.status, 200, `登录失败（${email}）：${reply.raw}`);
  const data = (
    reply.body as { data: { ticket: string; staff: { staff_id: string; name: string; role: string; email: string } } }
  ).data;
  if (typeof data.ticket === "string" && data.ticket !== "") staffTickets.push(data.ticket);
  return data;
}

test("坐席端：无票据 401、伪造票据 401、旧的 x-admin-token 401（一律 AUTH_REQUIRED）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const call = async (headers: Record<string, string>): Promise<Reply> =>
    toReply(await adminApp.inject({ method: "GET", url: "/__probe/admin", headers }));

  const missing = await call({});
  assert.equal(missing.status, 401);
  assert.equal((missing.body as ErrorBody).error.code, "AUTH_REQUIRED");

  // 伪造票据与"没登录"必须是**同一个码**：两者对坐席的行动完全一致（重新登录），
  // 而给它们不同的码等于回答"这个票据存在过没有"——一台会话存在性预言机。
  const forged = await call({ "x-staff-session": randomUUID() });
  assert.equal(forged.status, 401, `伪造票据期望 401，实际 ${forged.status}：${forged.raw}`);
  assert.equal((forged.body as ErrorBody).error.code, "AUTH_REQUIRED");

  // 形状也不对的票据（不是 64 位 hex）：同样 401，且不能进任何查询（这里也没有库可查）。
  const malformed = await call({ "x-staff-session": "not-a-ticket" });
  assert.equal(malformed.status, 401, `畸形票据期望 401，实际 ${malformed.status}`);
  assert.equal((malformed.body as ErrorBody).error.code, "AUTH_REQUIRED");

  // 旧的共享令牌头已退场（boundary-change-R2 §3 B5、§6「不做双轨」）：它现在只是一段没人读的
  // 请求头。带上它 + 自称的坐席 id 也进不来 —— 这正是本卡要取消的行为。
  const legacy = await call({
    "x-admin-token": "change-me-admin-token",
    "x-admin-staff": randomUUID(),
  });
  assert.equal(legacy.status, 401, `旧令牌头期望 401，实际 ${legacy.status}：${legacy.raw}`);
  assert.equal((legacy.body as ErrorBody).error.code, "AUTH_REQUIRED");
});

test("坐席端：登录票据能过守卫，身份（id / 名字 / 角色 / 邮箱）就是登录的那个账号", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const login = await loginAs(DEMO_EMAIL, DEMO_PASSWORD);

  const reply = toReply(
    await adminApp.inject({
      method: "GET",
      url: "/__probe/admin",
      headers: { "x-staff-session": login.ticket },
    }),
  );
  assert.equal(reply.status, 200, `票据应放行，实际 ${reply.status}：${reply.raw}`);
  const data = (reply.body as { data: { staffId: string; staffName: string; role: string; email: string } }).data;
  // 身份来自服务端会话，不是客户端自称：`staffId` 必须是登录账号自己的 id。
  assert.equal(data.staffId, login.staff.staff_id, "身份必须来自会话，不能是任意坐席");
  assert.equal(data.staffName, login.staff.name);
  assert.equal(data.role, login.staff.role, "`role` 由会话带出（第三段按角色过滤时要它）");
  assert.equal(data.email, login.staff.email);

  // 同一个票据访问真实坐席接口也放行（守卫与路由用的是同一份实现）。
  const queue = await app.inject({
    method: "GET",
    url: "/api/console/tickets?size=1",
    headers: { "x-staff-session": login.ticket },
  });
  assert.equal(queue.statusCode, 200, `真实队列接口应放行，实际 ${queue.statusCode}：${queue.body}`);
});

test("坐席端：无票据访问 /api/console/* → 401；登出之后原票据 → 401", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  // ① 没有票据（且带着已退场的旧令牌头）：坐席接口一律 401，不是 404 也不是 200。
  const anonymous = await app.inject({
    method: "GET",
    url: "/api/console/tickets",
    headers: { "x-admin-token": "change-me-admin-token" },
  });
  assert.equal(anonymous.statusCode, 401, `无票据应 401，实际 ${anonymous.statusCode}：${anonymous.body}`);
  assert.equal((JSON.parse(anonymous.body) as ErrorBody).error.code, "AUTH_REQUIRED");

  // ② 登录 → 票据可用 → 登出 → 同一张票据立刻失效（Redis 会话被删，不等 TTL）。
  const login = await loginAs(DEMO_EMAIL, DEMO_PASSWORD);
  const before = await app.inject({
    method: "GET",
    url: "/api/console/tickets",
    headers: { "x-staff-session": login.ticket },
  });
  assert.equal(before.statusCode, 200, `登录后应 200，实际 ${before.statusCode}：${before.body}`);

  const logout = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { "x-staff-session": login.ticket },
  });
  assert.equal(logout.statusCode, 200, `登出应 200，实际 ${logout.statusCode}：${logout.body}`);

  const after = await app.inject({
    method: "GET",
    url: "/api/console/tickets",
    headers: { "x-staff-session": login.ticket },
  });
  assert.equal(after.statusCode, 401, `登出后原票据应 401，实际 ${after.statusCode}：${after.body}`);
  assert.equal((JSON.parse(after.body) as ErrorBody).error.code, "AUTH_REQUIRED");
});

/* ─────────────────────── ④ 工单查单：不可区分 ─────────────────────── */

test("查单：「单号不存在」与「邮箱不匹配」回同一个 404（避免撞号）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const token = await newToken();
  const email = `${FIXTURE}-lookup@example.com`;
  ticketRequesters.push(email);

  const created = toReply(
    await app.inject({
      method: "POST",
      url: "/api/ticket",
      headers: { "x-user-session": token },
      payload: { email, question: "E03 反复出现，请回电" },
    }),
  );
  assert.equal(created.status, 200, `建单期望 200，实际 ${created.status}：${created.raw}`);
  const no = (created.body as { data: { no: string } }).data.no;
  ticketNos.push(no);

  const unknownNo = toReply(
    await app.inject({
      method: "GET",
      url: `/api/ticket/WT-2026-9999?email=${encodeURIComponent(email)}`,
      headers: { "x-user-session": token },
    }),
  );
  const wrongEmail = toReply(
    await app.inject({
      method: "GET",
      url: `/api/ticket/${encodeURIComponent(no)}?email=${encodeURIComponent(`${FIXTURE}-other@example.com`)}`,
      headers: { "x-user-session": token },
    }),
  );

  assert.equal(unknownNo.status, 404);
  assert.equal(wrongEmail.status, 404);
  assert.equal((wrongEmail.body as ErrorBody).error.code, "NOT_FOUND");
  assert.deepEqual(
    withoutTraceId(wrongEmail.body),
    withoutTraceId(unknownNo.body),
    `两个 404 必须逐字相同（去掉 trace_id 后），实际：${JSON.stringify([wrongEmail.body, unknownNo.body])}`,
  );
});

/* ─────────────────────── ⑤ 限流在落库之前 ─────────────────────── */

test("限流：同一令牌第 4 张工单 429 QUOTA_TICKET，且数据库里没有新增记录", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { one } = await import("../src/db.ts");
  const token = await newToken();
  // 每张单用独立邮箱（同一个 requester 会被计数串味）：配额维度是令牌，不是邮箱。
  const email = `${FIXTURE}-quota@example.com`;
  ticketRequesters.push(email);

  const count = async (): Promise<number> => {
    const row = await one<{ n: string }>("select count(*)::text as n from tickets where requester = $1", [email]);
    return Number(row?.n ?? 0);
  };

  // 3 张以内照常建（每张都换邮箱后缀会让 requester 不同，所以这里用一个会话外的"冷启动"
  // 入口：没有 conv_id 就没有 5 分钟幂等，重复提交才真的会撞配额）。
  for (let i = 1; i <= 3; i += 1) {
    const ok = toReply(
      await app.inject({
        method: "POST",
        url: "/api/ticket",
        headers: { "x-user-session": token },
        payload: { email, question: `配额用例 ${i}：E03 反复出现` },
      }),
    );
    assert.equal(ok.status, 200, `第 ${i} 张期望 200，实际 ${ok.status}：${ok.raw}`);
    const no = (ok.body as { data: { no: string } }).data.no;
    assert.match(no, /^WT-\d{4}-\d{4}$/);
    ticketNos.push(no);
  }
  const beforeBlocked = await count();
  assert.equal(beforeBlocked, 3, `前三张必须落 3 行，实际 ${beforeBlocked}`);

  const blocked = toReply(
    await app.inject({
      method: "POST",
      url: "/api/ticket",
      headers: { "x-user-session": token },
      payload: { email, question: "配额用例 4：E03 反复出现" },
    }),
  );
  assert.equal(blocked.status, 429, `第 4 张期望 429，实际 ${blocked.status}：${blocked.raw}`);
  assert.equal((blocked.body as ErrorBody).error.code, "QUOTA_TICKET");

  // 关键一条：被限流的请求**没有**留下任何新行（限流发生在落库之前，而不是之后）。
  assert.equal(await count(), beforeBlocked, "429 之后不得新增工单行");
});

/* ─────────────────────── ⑥ 错误脱敏 ─────────────────────── */

test("脱敏：内部异常只回通用 INTERNAL + trace id，响应体不含堆栈与连接串", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const boom = toReply(await app.inject({ method: "GET", url: "/__probe/boom" }));
  assert.equal(boom.status, 500);
  const body = boom.body as ErrorBody;
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "INTERNAL");
  assert.equal(body.error.message, "Internal server error", "未捕获异常只回通用文案");
  assert.equal(typeof body.error.trace_id, "string");

  // 逐项都是"一次故障变成一次泄漏"的入口。
  const forbidden = [
    "at ", // 堆栈特征
    ".ts:", // 堆栈里的文件名
    "ECONNREFUSED",
    "postgres://",
    "postgresql://",
    "redis://",
    "://",
    "sup3rsecret",
    "password",
    "stack",
    "127.0.0.1",
  ];
  for (const needle of forbidden) {
    assert.equal(
      boom.raw.includes(needle),
      false,
      `响应体不得出现 ${JSON.stringify(needle)}：${boom.raw}`,
    );
  }
});

test("脱敏：schema 校验失败与坏 JSON 都是 400 VALIDATION（不是 500，也不带堆栈）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const schema = toReply(
    await app.inject({ method: "POST", url: "/__probe/schema", payload: { n: "abc" } }),
  );
  assert.equal(schema.status, 400, `schema 校验失败期望 400，实际 ${schema.status}：${schema.raw}`);
  assert.equal((schema.body as ErrorBody).error.code, "VALIDATION");
  assert.equal(schema.raw.includes("at "), false, `响应体不得出现堆栈：${schema.raw}`);

  // content-type 是 json 但 body 不是 json：解析层就挡住了，路由一次都没跑。
  // 不映射的话它会以 500 回 —— 前端把"我传错了"读成"服务崩了"，5xx 告警也被打红。
  const badJson = toReply(
    await app.inject({
      method: "POST",
      url: "/__probe/schema",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    }),
  );
  assert.equal(badJson.status, 400, `坏 JSON 期望 400，实际 ${badJson.status}：${badJson.raw}`);
  assert.equal((badJson.body as ErrorBody).error.code, "VALIDATION");
  assert.equal(badJson.raw.includes("at "), false, `响应体不得出现堆栈：${badJson.raw}`);
});

test("日志脱敏：maskEmail 之后不再有明文邮箱（日志里不允许出现本地部分）", async (t) => {
  const { maskEmail } = await import("../src/logger.ts");
  const masked = maskEmail(`${FIXTURE}-installer@example.com`);
  assert.equal(masked.includes(`${FIXTURE}-installer`), false, `打码后仍含明文本地部分：${masked}`);
  assert.equal(masked.includes("@example.com"), false, `打码后仍含明文域名：${masked}`);
  assert.equal(masked.includes("***"), true, `打码结果应含 ***：${masked}`);
  // 没有 @ 的串不是邮箱，不能原样带出去（它会成为"日志里出现原文"的漏洞）。
  assert.equal(maskEmail("installer"), "***");
  assert.equal(maskEmail(""), "***");
});

/* ─────────────────────── ⑦ 健康检查 ─────────────────────── */

test("/healthz：无需凭据即可访问，响应体不含连接串", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const reply = toReply(await app.inject({ method: "GET", url: "/healthz" }));
  // 200 还是 503 取决于 pi 标志（本进程装配过没有），但"公开可访问"意味着它不会是 401/403/404。
  assert.ok([200, 503].includes(reply.status), `healthz 不该被鉴权挡住，实际 ${reply.status}`);
  assert.equal(reply.raw.includes("://"), false, `响应体出现连接串：${reply.raw}`);
  assert.equal(/password/i.test(reply.raw), false, `响应体出现 password：${reply.raw}`);
  // 会话时代的"凭据"是随机票据，探活响应里不该出现任何令牌/票据字样。
  assert.equal(reply.raw.includes("staff_session"), false, "响应体不得出现会话键名");
  assert.equal(reply.raw.includes("ticket"), false, "响应体不得出现票据字样");
});
