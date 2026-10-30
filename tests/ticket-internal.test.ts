/**
 * 内部工单接口的黑盒验收（`04-agent-chat` #02 · 05 §5.3–§5.4、06 §3.3–§3.4）。
 *
 * 为什么走 HTTP 而不是直接调 `createInternalTicket`：store 的 SQL 由 TypeScript 与数据库
 * 自己保证，这一层要证明的是**接线** —— 序列生成的号是不是 `WT-YYYY-NNNN`、`reason` 是不是
 * 被常量顶掉、`due_at` 是不是真的算到了 SLA 小时后、两个入口（POST /lookup 与 GET /:no）
 * 是不是同一份形状、两道门失败时是不是与"路径不存在"逐字一致。这些都是"接错线不会报错、
 * 只会在坐席队列或工具调用里出怪事"的性质。
 *
 * 只注册本卡的两条（三条）路由，不 import `src/routes.ts`：本文件要能在别的路由半成品时
 * 独立变绿或变红，把别人的 bug 算到自己头上是最费时间的排查。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 tests/healthz.test.ts 同一套 .env 解析：`node --test` 不带 --env-file，得自己补。 */
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

/** 05 §4：工单号 `WT-YYYY-NNNN`（序列生成，跨年不重置，靠年份前缀区分）。 */
const TICKET_NO_RE = /^WT-\d{4}-\d{4}$/;

const CREATE_URL = "/internal/ticket";
const LOOKUP_POST_URL = "/internal/ticket/lookup";
const lookupGetUrl = (no: string): string => `/internal/ticket/${encodeURIComponent(no)}`;

/** 本文件建出来的单号：清理只删自己造的行，绝不按 reason/tag 批量删（那是删别人数据）。 */
const createdNos: string[] = [];

let app: FastifyInstance;

before(async () => {
  if (!hasRuntimeEnv) return;
  const [{ default: Fastify }, { registerInternalTicketRoutes }, { toErrorBody }] = await Promise.all([
    import("fastify"),
    import("../src/api/internal-ticket.ts"),
    import("../src/errors.ts"),
  ]);

  // 与 `src/server.ts` 同两段处理器：错误体形状与 404 文案必须一致，否则"错令牌 → 404 与
  // 路径不存在不可区分"这条安全性质在本文件里就成了自说自话。
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
  await registerInternalTicketRoutes(app);
  await app.ready();
});

after(async () => {
  if (!hasRuntimeEnv) return;
  const { pool, query } = await import("../src/db.ts");
  if (app !== undefined) await app.close();
  if (createdNos.length > 0) {
    // 只删自己建的号。`ticket_events` 在 001_init.sql 里不存在，所以没有级联事件要清；
    // 万一将来加上了，`on delete cascade` 会自动跟上。
    await query("delete from tickets where no = any($1::text[])", [createdNos]);
  }
  const { redis } = await import("../src/redis.ts");
  await redis.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

/* ─────────────────────────── 响应体形状（05 §5.3–§5.4） ─────────────────────────── */

type CreateData = { no: string; due_at: string; status: string };
type LookupData = {
  found: boolean;
  no: string;
  status?: string;
  reason?: string;
  created_at?: string;
};
type ErrorBody = { ok: false; error: { code: string; message: string; trace_id?: string } };
type SuccessBody<T> = { ok: true; data: T };

type InjectOptions = {
  /** `null` = 不带该请求头；省略 = 带正确令牌。 */
  token?: string | null;
  /** light-my-request 的假 socket 地址；省略即 127.0.0.1。 */
  remoteAddress?: string;
};

function authHeaders(options: InjectOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.token !== null) headers["x-internal-token"] = options.token ?? internalToken;
  return headers;
}

async function post(
  url: string,
  payload: unknown,
  options: InjectOptions = {},
): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({
    method: "POST",
    url,
    payload: payload as Record<string, unknown>,
    headers: authHeaders(options),
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
  });
  return { status: response.statusCode, body: response.json() };
}

async function get(url: string, options: InjectOptions = {}): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: authHeaders(options),
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
  });
  return { status: response.statusCode, body: response.json() };
}

/** 建单并登记到清理名单。断言放在调用方，这里只负责"造出来"与"记得删"。 */
async function createTicket(question: string, extra: Record<string, unknown> = {}): Promise<CreateData> {
  const { status, body } = await post(CREATE_URL, { question, ...extra });
  assert.equal(status, 200, `建单期望 200，实际 ${status}：${JSON.stringify(body)}`);
  const ok = body as SuccessBody<CreateData>;
  assert.equal(ok.ok, true, "响应体缺少 ok:true");
  createdNos.push(ok.data.no);
  return ok.data;
}

/* ─────────────────────────── 建单 ─────────────────────────── */

test("建单：号匹配 WT-YYYY-NNNN、status=open、due_at 落在 SLA 之后、库里 reason=user_request", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { one } = await import("../src/db.ts");

  const created = await createTicket("Wechselrichter zeigt E03, bitte Rückruf");

  assert.match(created.no, TICKET_NO_RE, `号不符合 ^WT-\\d{4}-\\d{4}$：${created.no}`);
  assert.equal(created.status, "open", "新单状态必须是 open（05 §4 四态之一）");

  // due_at 的来源是 `settings` 里的 SLA 小时数（读不到则 4h）。测试按**库里实际的值**算期望，
  // 而不是写死 4：写死会让"运营把 SLA 改成 8 小时"这件事把测试变红，而那不是回归。
  const slaRow = await one<{ value: unknown }>(
    "select value from settings where key in ('slas.hours', 'sla.hours') order by key = 'slas.hours' desc limit 1",
  );
  const hours = Number(slaRow?.value ?? 4);
  const expectedMs = Date.now() + (Number.isFinite(hours) ? hours : 4) * 3_600_000;
  const dueMs = Date.parse(created.due_at);
  assert.ok(Number.isFinite(dueMs), `due_at 不是合法时间：${created.due_at}`);
  assert.ok(
    Math.abs(dueMs - expectedMs) < 5 * 60_000,
    `due_at 应在 ${hours} 小时后（±5 分钟容差），实际 ${created.due_at}（now=${new Date().toISOString()}）`,
  );

  const row = await one<{
    reason: string;
    status: string;
    question: string;
    conv_id: string | null;
    requester: string | null;
    due_at: Date;
  }>("select reason, status, question, conv_id, requester, due_at from tickets where no = $1", [
    created.no,
  ]);
  assert.ok(row !== null, `工单 ${created.no} 没落库`);
  // 内部建单恒为"转人工"：模型/前端传什么都改不了这个值（05 §2、§3.4）。
  assert.equal(row.reason, "user_request", `reason 必须是 user_request，实际 ${row.reason}`);
  assert.equal(row.status, "open");
  assert.equal(row.question, "Wechselrichter zeigt E03, bitte Rückruf");
  assert.equal(row.conv_id, null, "没传 conv_id 时应落 null（匿名单，05 §5.3）");
  assert.equal(row.requester, null, "没传 requester 时应落 null（内部建单不需要邮箱）");
  assert.equal(row.due_at.toISOString(), created.due_at, "due_at 落库值应与响应一致");
});

test("建单：调用方传 reason 被忽略，仍写 user_request", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { one } = await import("../src/db.ts");

  // 06 §3.3 的工具 schema 里还带着 reason，所以最可能被传进来的就是这些值。
  const created = await createTicket("Batterie lädt nicht, was kann ich tun?", {
    reason: "no_citation",
  });

  const row = await one<{ reason: string }>("select reason from tickets where no = $1", [created.no]);
  assert.equal(
    row?.reason,
    "user_request",
    `调用方传的 reason 必须被顶掉（模型不得选择原因），实际 ${row?.reason}`,
  );
});

test("建单：两次建单拿到不同的号（序列生效，不撞号）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const first = await createTicket("Garantie: wie lange gilt sie?");
  const second = await createTicket("Garantie: gilt sie auch für Zubehör?");

  assert.notEqual(first.no, second.no, `两张单拿到同一个号 ${first.no}`);
  // 序列是严格递增的：同进程内后建的一定更大，能顺带证明号来自 `ticket_seq` 而不是随机串。
  const seqOf = (no: string): number => Number(no.split("-")[2]);
  assert.ok(
    seqOf(second.no) > seqOf(first.no),
    `后建的单号应更大：${first.no} → ${second.no}`,
  );
});

/* ─────────────────────────── 查单（两个入口） ─────────────────────────── */

test("查单 POST /lookup：命中返回同一 status", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const created = await createTicket("Wie schließe ich den Wechselrichter an?");

  const { status, body } = await post(LOOKUP_POST_URL, { no: created.no });
  assert.equal(status, 200, `查单期望 200，实际 ${status}：${JSON.stringify(body)}`);
  const ok = body as SuccessBody<LookupData>;
  assert.equal(ok.ok, true);
  assert.equal(ok.data.found, true);
  assert.equal(ok.data.no, created.no);
  assert.equal(ok.data.status, created.status);
  assert.equal(ok.data.reason, "user_request");
  assert.ok(
    Number.isFinite(Date.parse(String(ok.data.created_at))),
    `created_at 不是合法时间：${ok.data.created_at}`,
  );
});

test("查单 GET /ticket/:no：与 POST 形状一致（同一份查询的别名）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const created = await createTicket("Fehlercode E05, was bedeutet das?");

  const viaGet = await get(lookupGetUrl(created.no));
  const viaPost = await post(LOOKUP_POST_URL, { no: created.no });
  assert.equal(viaGet.status, 200);
  assert.equal(viaPost.status, 200);
  assert.deepEqual(
    viaGet.body,
    viaPost.body,
    "两个入口必须给出逐字相同的响应体：工具侧解析的是同一份形状",
  );
  assert.equal((viaGet.body as SuccessBody<LookupData>).data.status, created.status);
});

test("查单：不存在的号返回 found=false，不是 404", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const unknown = "WT-2026-9999";

  const viaPost = await post(LOOKUP_POST_URL, { no: unknown });
  assert.equal(viaPost.status, 200, "查不到不是错误状态：工具要能回答「未找到该工单」");
  assert.deepEqual(viaPost.body, { ok: true, data: { found: false, no: unknown } });

  const viaGet = await get(lookupGetUrl(unknown));
  assert.equal(viaGet.status, 200);
  assert.deepEqual(viaGet.body, { ok: true, data: { found: false, no: unknown } });
});

test("查单：模型复述的小写 / 带空格单号也能命中", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const created = await createTicket("Speicher entlädt sich zu schnell");

  const { status, body } = await get(lookupGetUrl(` ${created.no.toLowerCase()} `));
  assert.equal(status, 200);
  const ok = body as SuccessBody<LookupData>;
  assert.equal(ok.data.found, true, `小写/带空格的号必须能查到：${JSON.stringify(ok.data)}`);
  assert.equal(ok.data.no, created.no, "返回的号必须是库里的规范拼写");
});

/* ─────────────────────────── 校验 ─────────────────────────── */

test("建单：question 少于 4 字回 400 VALIDATION", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  for (const question of ["abc", "   a   ", ""]) {
    const { status, body } = await post(CREATE_URL, { question });
    assert.equal(status, 400, `question=${JSON.stringify(question)} 期望 400，实际 ${status}`);
    assert.equal((body as ErrorBody).ok, false);
    assert.equal((body as ErrorBody).error.code, "VALIDATION", `响应体：${JSON.stringify(body)}`);
  }

  // 长度按 trim 后计算：3 个可见字符 + 空格仍然是 3 个字符，不该被当成 9 个放过去。
  // 下界必须放行 —— 门槛写成 `>` 还是 `>=` 只有这条断言能发现。
  const boundary = await createTicket("drei");
  assert.equal(boundary.status, "open", "4 个字符（下界）必须放行");
});

test("建单：conv_id 形状不合法或不存在都回 400", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const notUuid = await post(CREATE_URL, { question: "Bitte um Rückruf", conv_id: "abc" });
  assert.equal(notUuid.status, 400);
  assert.equal((notUuid.body as ErrorBody).error.code, "VALIDATION");

  // 形状正确但库里没有这个会话：必须是 400（调用方给错了 id），不能是外键报错翻出来的 500。
  const missing = await post(CREATE_URL, { question: "Bitte um Rückruf", conv_id: randomUUID() });
  assert.equal(
    missing.status,
    400,
    `不存在的 conv_id 期望 400，实际 ${missing.status}：${JSON.stringify(missing.body)}`,
  );
  assert.equal((missing.body as ErrorBody).error.code, "VALIDATION");
});

test("查单：body 缺 no 回 400（参数错与「查不到」必须分开）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { status, body } = await post(LOOKUP_POST_URL, {});
  assert.equal(status, 400);
  assert.equal((body as ErrorBody).error.code, "VALIDATION");
});

/* ─────────────────────────── 两道门 ─────────────────────────── */

/** 404 只允许 trace_id 不同：去掉它再逐字比较。 */
function withoutTraceId(body: unknown): unknown {
  const parsed = body as ErrorBody;
  return { ok: parsed.ok, error: { code: parsed.error.code, message: parsed.error.message } };
}

test("错令牌 / 非回环来源：与「路径不存在」逐字一致的通用 404", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  // 基准：真实不存在的路径。两道门失败必须与它不可区分（05 §1 的安全模型：401 等于
  // 承认端点存在，会给扫描器一个可以持续爆破的目标）。
  const baseline = await get("/internal/does-not-exist");
  assert.equal(baseline.status, 404);
  assert.deepEqual(withoutTraceId(baseline.body), {
    ok: false,
    error: { code: "NOT_FOUND", message: "Not found" },
  });
  const baselineShape = withoutTraceId(baseline.body);

  const attempts = [
    // 错令牌
    await post(CREATE_URL, { question: "Bitte um Rückruf" }, { token: "wrong-token" }),
    await post(LOOKUP_POST_URL, { no: "WT-2026-0001" }, { token: "wrong-token" }),
    await get(lookupGetUrl("WT-2026-0001"), { token: "wrong-token" }),
    // 不带令牌
    await post(CREATE_URL, { question: "Bitte um Rückruf" }, { token: null }),
    // 令牌对但来源不是回环（`X-Forwarded-For` 一律不认，只看 socket 地址）
    await post(CREATE_URL, { question: "Bitte um Rückruf" }, { remoteAddress: "10.1.2.3" }),
    await get(lookupGetUrl("WT-2026-0001"), { remoteAddress: "10.1.2.3" }),
  ];

  for (const [index, attempt] of attempts.entries()) {
    assert.equal(attempt.status, 404, `第 ${index} 个越门请求期望 404，实际 ${attempt.status}`);
    assert.deepEqual(
      withoutTraceId(attempt.body),
      baselineShape,
      `第 ${index} 个越门请求的响应体与「路径不存在」不一致：${JSON.stringify(attempt.body)}`,
    );
  }

  // 门没开成功的请求不能建出任何单：上面那次被拒的建单若真写进去了，这里会多出一行。
  const { one } = await import("../src/db.ts");
  const leaked = await one<{ count: string }>(
    "select count(*)::text as count from tickets where question = 'Bitte um Rückruf'",
  );
  assert.equal(leaked?.count, "0", "被 404 拦下的建单请求不应写入任何工单");
});
