/**
 * 反馈闭环的黑盒验收（`09#04` · `.scratch/09-admin-console/issues/04-admin-panels.md` 的
 * `fault_reports` 待审 + 看板三计数，决策 D16 / D26，风险 R26）。
 *
 * 断言的是**可观察契约**，不是实现：
 *   - 用户在故障码页查一个不存在的码 → 落一条 `source='page'` 的待审反馈；
 *     24 小时内同一个码再查一次 → **行数不变**（去重口径是"存在就不插"，不是计数 +1）；
 *   - `GET /api/admin/fault-reports` 默认只给 `status=new`；`PATCH .../:id` 的
 *     `merge` → `merged` / `reject` → `rejected`，处置后从默认列表消失；
 *   - 角色：`lead` 两个都通，`agent` 两个都 403 `FORBIDDEN`，无票据 401 `AUTH_REQUIRED`；
 *   - 每次处置都留 `audit_log`（`fault_report.merge` / `fault_report.reject`）；
 *   - `GET /api/console/stats` 的 `reports.{new,last24h,merge_rate}` 与直接 SQL 查出来的数一致，
 *     且**不随 `window` / `exclude_demo` 变**（它们是队列健康度，不是看板筛选）。
 *
 * 夹具自造自清：产品线用本次运行独有的 `rpt-<uuid8>`，于是
 *   - 清理只按 `product_line = 这个值` 删（绝不按 code 猜 —— `E99` 可能正是别处有用的行）；
 *   - 列表断言按 id 认自己那两行，不假设库里只有我的行（其它测试也会往这张表里写）。
 *
 * 登录限速 5 次/分钟、来源永远是 127.0.0.1：两个身份只在 `before` 里各登一次，全程复用票据。
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
const DEMO_PASSWORD = "wt-demo-2026";
const LEAD_NAME = "李娜";

/**
 * 本次运行独有的产品线：所有反馈都挂在这条线上，清理与"我这两行"的定位都靠它。
 * 顺带满足了一条隐含前提 —— 这条线上**不存在任何真实的故障码**，所以 `X99` 必然是 miss。
 */
const FIXTURE = `rpt-${randomUUID().slice(0, 8)}`;

type Staff = { staff_id: string; name: string; email: string; role: string };
type Reply = { status: number; body: unknown; raw: string };
type ReportBody = {
  id: number;
  code: string;
  product_line: string;
  source: string;
  lang: string;
  quote: string | null;
  status: string;
  created_at: string;
};
type StatsBody = {
  tickets_total: number;
  window: string;
  exclude_demo: boolean;
  reports: { new: number; last24h: number; merge_rate: number };
};

let app: FastifyInstance;
let agentTicket = "";
let leadTicket = "";
let lead: Staff = { staff_id: "", name: "", email: "", role: "" };

/** 本次运行创建过的审计目标串（`fault_report:<id>`），`after` 按它精确清理。 */
const auditTargets = new Set<string>();

before(async () => {
  if (!hasRuntimeEnv) return;
  const [{ default: Fastify }, { registerAdminRoutes }, { registerAuthRoutes }, { registerConsoleRoutes }, { registerFaultRoutes }, { toErrorBody }] =
    await Promise.all([
      import("fastify"),
      import("../src/api/admin.ts"),
      import("../src/api/auth.ts"),
      import("../src/api/console.ts"),
      import("../src/api/fault.ts"),
      import("../src/errors.ts"),
    ]);

  // 与 `src/server.ts` 同一套错误信封：401/403/404/409 的形状必须是线上那一种。
  app = Fastify({ logger: false });
  app.setErrorHandler((err, request, reply) => {
    const { status, body } = toErrorBody(err, String(request.id));
    return reply.code(status).send(body);
  });
  await registerAdminRoutes(app);
  await registerAuthRoutes(app);
  // 待审与看板同源：stats 的 `reports` 三计数在 console 那一路，列表/处置在 admin 那一路。
  await registerConsoleRoutes(app);
  // 捕获点是**公开**的故障码直查（无令牌），必须挂上：反馈是从这条路上产生的。
  await registerFaultRoutes(app);
  await app.ready();

  const agentLogin = await loginAs(AGENT_EMAIL);
  agentTicket = agentLogin.ticket;
  const leadLogin = await loginAs(LEAD_EMAIL);
  leadTicket = leadLogin.ticket;
  lead = leadLogin.staff;

  // 夹具前提先断言：否则后面的角色断言只是在描述"某两个账号碰巧能做什么"。
  assert.equal(lead.role, "lead", `夹具前提：${LEAD_EMAIL} 必须是 lead，实际 "${lead.role}"`);
});

after(async () => {
  if (!hasRuntimeEnv) return;
  const [{ pool, query }, { redis }] = await Promise.all([import("../src/db.ts"), import("../src/redis.ts")]);
  if (app !== undefined) await app.close();

  // 顺序：审计 → 反馈（按产品线整条线删）。反馈行清了，24h 去重窗口也跟着清 —— 不留下
  // "下一次跑同一个码"的隐藏依赖（虽然 FIXTURE 每次都不同，但清理就该是干净的）。
  if (auditTargets.size > 0) {
    await query("delete from audit_log where target = any($1::text[])", [[...auditTargets]]);
  }
  await query("delete from fault_reports where product_line = $1", [FIXTURE]);

  for (const ticket of [agentTicket, leadTicket]) {
    if (ticket !== "") await redis.del(`staff_session:${ticket}`);
  }
  await redis.del("login:127.0.0.1");

  // 不 quit 的话 `node --test` 跑完断言也不退出（表现是"卡住"而不是"失败"）。
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

/**
 * 带会话票据的 inject。默认用 lead 的票据；权限用例显式传 `token`（`null` = 不带票据）。
 * `PATCH` 的 body 是可选的（处置动作才需要）。
 */
async function call(options: {
  method: "GET" | "POST" | "PATCH";
  url: string;
  token?: string | null;
  payload?: unknown;
}): Promise<Reply> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? leadTicket : options.token;
  if (token !== null) headers["x-staff-session"] = token;
  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
  return toReply(response);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等一条反馈落库。捕获点是**异步**写入（`void recordFaultReport(...)`，不阻塞出卡），
 * 所以断言不能靠"响应 200 之后它一定在了"，也不能用一个固定 sleep 猜时间：
 * 轮询到 deadline 为止，超时才有意义地失败。
 */
async function waitForReport(code: string, timeoutMs = 3000): Promise<ReportBody> {
  const { one } = await import("../src/db.ts");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await one<{
      id: string;
      code: string;
      product_line: string;
      source: string;
      lang: string;
      quote: string | null;
      status: string;
      created_at: Date;
    }>(
      `select id, code, product_line, source, lang, quote, status, created_at
         from fault_reports
        where code = $1 and product_line = $2
        order by id desc limit 1`,
      [code, FIXTURE],
    );
    if (row !== null) {
      return {
        id: Number(row.id),
        code: row.code,
        product_line: row.product_line,
        source: row.source,
        lang: row.lang,
        quote: row.quote,
        status: row.status,
        created_at: row.created_at.toISOString(),
      };
    }
    if (Date.now() > deadline) {
      throw new Error(`等不到 ${code}@${FIXTURE} 的反馈落库（${timeoutMs}ms 超时）：捕获点没有写库`);
    }
    await sleep(50);
  }
}

/** 某个码在本次夹具产品线上的反馈行数（去重断言就看这个数）。 */
async function countReports(code: string): Promise<number> {
  const { one } = await import("../src/db.ts");
  const row = await one<{ n: string }>(
    "select count(*)::text as n from fault_reports where code = $1 and product_line = $2",
    [code, FIXTURE],
  );
  return Number(row?.n ?? "0");
}

/** 公开故障码直查（无令牌）。`X99@rpt-xxx` 这条线上没有任何故障码 → 必然 `found:false`。 */
async function publicLookup(code: string): Promise<{ status: number; found: boolean; raw: string }> {
  const reply = toReply(
    await app.inject({
      method: "GET",
      url: `/api/fault/${code}?product_line=${encodeURIComponent(FIXTURE)}&lang=de`,
    }),
  );
  return { status: reply.status, found: (reply.body as { data?: { found?: boolean } }).data?.found === true, raw: reply.raw };
}

/** 待审列表（默认 `status=new`）。显式 `size` 是因为库里还有别的测试留下的行。 */
async function listReports(
  token: string | null,
  query = "",
): Promise<{ status: number; body: unknown; items: ReportBody[]; total: number; raw: string }> {
  const reply = await call({ method: "GET", url: `/api/admin/fault-reports?size=50${query}`, token });
  const data = (reply.body as { data?: { total: number; items: ReportBody[] } }).data;
  return {
    status: reply.status,
    body: reply.body,
    items: data?.items ?? [],
    total: data?.total ?? 0,
    raw: reply.raw,
  };
}

async function stats(query = ""): Promise<StatsBody> {
  const reply = await call({ method: "GET", url: `/api/console/stats${query}` });
  assert.equal(reply.status, 200, `stats 期望 200，实际 ${reply.status}：${reply.raw}`);
  return (reply.body as { data: StatsBody }).data;
}

function rememberAudit(id: number): void {
  auditTargets.add(`fault_report:${id}`);
}

async function auditRows(target: string): Promise<{ actor: string; action: string; payload: Record<string, unknown> }[]> {
  const { query } = await import("../src/db.ts");
  return query("select actor, action, payload from audit_log where target = $1 order by id", [target]);
}

/* ────────────── ① 捕获点 + 24h 去重（"存在就不插"） ────────────── */

test("查不存在的码 → 落一条 page 反馈；24h 内再查一次不再新增行", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  const first = await publicLookup("X99");
  assert.equal(first.status, 200, `故障码直查期望 200（未命中是正常结果），实际 ${first.status}：${first.raw}`);
  assert.equal(first.found, false, "这条产品线上不该存在 X99");

  const report = await waitForReport("X99");
  rememberAudit(report.id);
  assert.equal(report.source, "page", "捕获点只有故障码页，source 必须是 page");
  assert.equal(report.lang, "de", "lang 记的是这次查询的语言（请求里给的是 de）");
  assert.equal(report.status, "new", "新落库的反馈必须是待审态");
  assert.equal(report.quote, null, "这一路没有可摘录的问题文本（只有码），所以 quote 为空");

  // 第二次同码：仍然 200 且 found:false，但**不新增行**（24h 窗口内"存在就不插"）。
  const second = await publicLookup("X99");
  assert.equal(second.status, 200);
  assert.equal(second.found, false);
  // 负向断言只能靠"等过一段合理的时间再数"：写入是异步的，不等就可能数在写入之前。
  await sleep(500);
  assert.equal(await countReports("X99"), 1, "同一码同一产线 24h 内只该留一条（去重口径：存在就不插）");

  // 列表里能看到它，且**没有**问题原文类的字段（PII 口径：只存短摘录）。
  const list = await listReports(leadTicket);
  assert.equal(list.status, 200, `待审列表期望 200，实际 ${list.status}：${list.raw}`);
  const mine = list.items.find((item) => item.id === report.id);
  assert.ok(mine, "待审列表里应该有刚落的这一条");
  assert.equal(mine.code, "X99");
  assert.equal(mine.product_line, FIXTURE);
  assert.equal(mine.status, "new");
  assert.equal(Object.hasOwn(mine as unknown as Record<string, unknown>, "question"), false, "列表不该有 question 字段");
});

/* ────────────── ② 角色：lead 通 / agent 403 / 无票据 401 ────────────── */

test("待审列表与处置：lead 通过，agent 403，无票据 401", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  const forbidden = await listReports(agentTicket);
  assert.equal(forbidden.status, 403, `agent 看待审列表应 403，实际 ${forbidden.status}：${forbidden.raw}`);
  assert.equal((forbidden.body as { error: { code: string } }).error.code, "FORBIDDEN");

  const anonymous = await listReports(null);
  assert.equal(anonymous.status, 401, `无票据应 401，实际 ${anonymous.status}：${anonymous.raw}`);
  assert.equal((anonymous.body as { error: { code: string } }).error.code, "AUTH_REQUIRED");

  // 处置的动作门与查看同档：agent 连"忽略"都不许。
  const agentPatch = await call({
    method: "PATCH",
    url: `/api/admin/fault-reports/${1}`,
    token: agentTicket,
    payload: { action: "reject" },
  });
  assert.equal(agentPatch.status, 403, `agent 处置应 403，实际 ${agentPatch.status}：${agentPatch.raw}`);

  // 形状与取值：动作拼错是 400（静默当成 reject 会让一次误点变成一条错误结论）；
  // 不存在的 id 是 404（id 失效时前端该刷新列表，不是该重试）。
  const badAction = await call({
    method: "PATCH",
    url: "/api/admin/fault-reports/1",
    payload: { action: "approve" },
  });
  assert.equal(badAction.status, 400, `action 取值非法应 400，实际 ${badAction.status}：${badAction.raw}`);
  const missing = await call({ method: "PATCH", url: "/api/admin/fault-reports/999999999", payload: { action: "reject" } });
  assert.equal(missing.status, 404, `不存在的 id 应 404，实际 ${missing.status}：${missing.raw}`);
});

/* ────────────── ③ reject → 从默认列表消失；merge 同理，且留审计 ────────────── */

test("reject：状态转 rejected、从默认列表消失、审计留痕（actor 是登录人）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  const report = await waitForReport("X99");
  const reply = await call({
    method: "PATCH",
    url: `/api/admin/fault-reports/${report.id}`,
    payload: { action: "reject" },
  });
  assert.equal(reply.status, 200, `reject 期望 200，实际 ${reply.status}：${reply.raw}`);
  const patched = (reply.body as { data: { report: ReportBody; changed: string[] } }).data;
  assert.equal(patched.report.status, "rejected");
  assert.deepEqual(patched.changed, ["status"]);

  // 默认列表（status=new）里不该再有它；显式翻 rejected 才看得到。
  const defaults = await listReports(leadTicket);
  assert.equal(defaults.items.some((item) => item.id === report.id), false, "处置过的反馈必须从默认（new）列表消失");
  const rejected = await listReports(leadTicket, "&status=rejected");
  assert.equal(rejected.items.some((item) => item.id === report.id), true, "显式 status=rejected 才该看到它");

  // 幂等：同一动作再来一次是 200 + 空改动（双击"忽略"不该报错）。
  const again = await call({
    method: "PATCH",
    url: `/api/admin/fault-reports/${report.id}`,
    payload: { action: "reject" },
  });
  assert.equal(again.status, 200, `重复 reject 期望 200，实际 ${again.status}：${again.raw}`);
  assert.deepEqual((again.body as { data: { changed: string[] } }).data.changed, []);

  // 反向冲突：已经 rejected 的不能再 merge（合并率口径指的就是这一列，不能事后改写）。
  const conflict = await call({
    method: "PATCH",
    url: `/api/admin/fault-reports/${report.id}`,
    payload: { action: "merge" },
  });
  assert.equal(conflict.status, 409, `已处置成 rejected 再 merge 应 409，实际 ${conflict.status}：${conflict.raw}`);

  // 审计：每次**真实**状态变化一条（两次 reject 只写了一条，那条幂等调用什么都没写）。
  const rows = await auditRows(`fault_report:${report.id}`);
  assert.equal(rows.length, 1, `处置只该留一条审计，实际 ${rows.length} 条`);
  assert.equal(rows[0]?.action, "fault_report.reject");
  assert.equal(rows[0]?.actor, LEAD_NAME, "审计 actor 必须是登录坐席的名字");
  assert.equal(rows[0]?.payload.code, "X99");
  assert.equal(Object.hasOwn(rows[0]?.payload ?? {}, "quote"), false, "审计里不该有 quote（用户输入不进审计）");
});

test("merge：状态转 merged、从默认列表消失、再 reject 被 409 拦住", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  const lookup = await publicLookup("Y77");
  assert.equal(lookup.found, false);
  const report = await waitForReport("Y77");
  rememberAudit(report.id);

  const reply = await call({
    method: "PATCH",
    url: `/api/admin/fault-reports/${report.id}`,
    payload: { action: "merge" },
  });
  assert.equal(reply.status, 200, `merge 期望 200，实际 ${reply.status}：${reply.raw}`);
  const patched = (reply.body as { data: { report: ReportBody } }).data;
  assert.equal(patched.report.status, "merged");
  assert.equal(patched.report.code, "Y77");

  const defaults = await listReports(leadTicket);
  assert.equal(defaults.items.some((item) => item.id === report.id), false, "merge 后必须从默认列表消失");

  const rows = await auditRows(`fault_report:${report.id}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.action, "fault_report.merge");

  const conflict = await call({
    method: "PATCH",
    url: `/api/admin/fault-reports/${report.id}`,
    payload: { action: "reject" },
  });
  assert.equal(conflict.status, 409, `已 merge 再 reject 应 409，实际 ${conflict.status}：${conflict.raw}`);
});

/* ────────────── ④ 看板三计数：与 SQL 一致，且不随 window/exclude_demo 变 ────────────── */

test("stats.reports 三个数与直接 SQL 一致，且不受 window / exclude_demo 影响", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  const { one } = await import("../src/db.ts");
  const row = await one<{ new_count: number; last24h: number; merged: number; rejected: number }>(
    `select (count(*) filter (where status = 'new'))::int as new_count,
            (count(*) filter (where created_at > now() - interval '24 hours'))::int as last24h,
            (count(*) filter (where status = 'merged'))::int as merged,
            (count(*) filter (where status = 'rejected'))::int as rejected
       from fault_reports`,
  );
  const merged = row?.merged ?? 0;
  const rejected = row?.rejected ?? 0;
  const expected = {
    new: row?.new_count ?? 0,
    last24h: row?.last24h ?? 0,
    merge_rate: merged + rejected === 0 ? 0 : Math.round((merged / (merged + rejected)) * 1000) / 1000,
  };

  const all = await stats();
  assert.deepEqual(all.reports, expected, `reports 三计数必须与直接 SQL 一致：${JSON.stringify(all.reports)} vs ${JSON.stringify(expected)}`);

  // 本次夹具自己的两行必须体现在数里：一条 merged、一条 rejected（①的 X99 被 reject，③的 Y77 被 merge）。
  assert.ok(merged >= 1, `merge_rate 的分子至少该有本次的 Y77（实际 merged=${merged}）`);
  assert.ok(rejected >= 1, `分母里至少该有本次的 X99（实际 rejected=${rejected}）`);

  // 口径固定为全量：`window` 与 `exclude_demo` 只影响工单侧，不该影响这三个数。
  const today = await stats("?window=today");
  const withDemo = await stats("?exclude_demo=false&window=week");
  assert.deepEqual(today.reports, expected, "window=today 不该切这三个数（它们是队列健康度，不是筛选结果）");
  assert.deepEqual(withDemo.reports, expected, "exclude_demo=false 不该改这三个数（fault_reports 没有 demo 标记）");
  assert.equal(today.window, "today", "回显仍要如实说出工单侧用的是哪个窗");
  assert.equal(withDemo.exclude_demo, false);
});
