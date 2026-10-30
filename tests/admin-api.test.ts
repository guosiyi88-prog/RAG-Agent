/**
 * 管理端接口的黑盒验收（`09#04` · `.scratch/09-admin-console/issues/04-admin-panels.md`）。
 *
 * 断言的是**可观察契约**，不是实现：
 *   - 角色矩阵（`lead` 查看/编辑/建 draft；`admin` 发布/归档/字典/人员）；
 *   - 发布门槛（五语十列必须全非空 → 缺语时 409 `CONFLICT`，不是 400：形状没错，是状态不允许）；
 *   - 新建一律落 `draft`（body 里写 `status:"published"` 也不算数）；
 *   - `published` 的码改一个字就落回 `draft`（要重新发布）；
 *   - 归档只改 `status`、**行还在**，而且对外的 `/api/fault/:code` 立刻查不到；
 *   - 人员列表绝不下发口令列；
 *   - `PATCH` 的 `severity` 是三态（不传 = 不改 / `null` = 清空 / 有值 = 校验写入，`09#04` 未做第 5 条）。
 *
 * 夹具自造自清：本次运行用一个独有的产品线 code（`adm-<uuid8>`），故障码的清理只按
 * `product_line = 这个值` 删 —— 绝不 `delete ... where code = 'E03'`（那会删掉别处还在用的行）。
 *
 * 登录限速 5 次/分钟、来源永远是 127.0.0.1：三个身份只在 `before` 里各登一次，全程复用票据。
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

/**
 * 本次运行的独有产品线。所有故障码都挂在这条线上，于是：
 *   - 列表按 `product_line` 一筛就只剩自己造的行（别人的夹具一行都混不进来）；
 *   - 清理可以整条线删干净，不用按 code 猜。
 */
const FIXTURE = `adm-${randomUUID().slice(0, 8)}`;

function mark(useCase: string): string {
  return `${FIXTURE}-${useCase}`;
}

type Staff = { staff_id: string; name: string; email: string; role: string };
type ErrorBody = { ok: false; error: { code: string; message: string; trace_id: string } };
type Reply = { status: number; body: unknown; raw: string };
type FaultBody = {
  code: string;
  product_line: string;
  severity: string | null;
  status: string;
  desc: Record<string, string | null>;
  act: Record<string, string | null>;
  lang_count: number;
  complete_langs: string[];
  missing_langs: string[];
  created_at: string;
  updated_at: string;
};

let app: FastifyInstance;
/** 三个身份各一张票据，`before` 里登录完复用（限速 5 次/分钟）。 */
let agentTicket = "";
let leadTicket = "";
let adminTicket = "";
let admin: Staff = { staff_id: "", name: "", email: "", role: "" };
let lead: Staff = { staff_id: "", name: "", email: "", role: "" };

const LANGS = ["zh", "en", "de", "nl", "es"] as const;

before(async () => {
  if (!hasRuntimeEnv) return;
  const [{ default: Fastify }, { registerAdminRoutes }, { registerAuthRoutes }, { registerFaultRoutes }, { toErrorBody }] =
    await Promise.all([
      import("fastify"),
      import("../src/api/admin.ts"),
      import("../src/api/auth.ts"),
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
  // 公开故障码接口也挂上：本卡的一条判据是"归档后用户侧查不到"，那条只能由真接口回答。
  await registerFaultRoutes(app);
  await app.ready();

  const agentLogin = await loginAs(AGENT_EMAIL);
  agentTicket = agentLogin.ticket;
  const leadLogin = await loginAs(LEAD_EMAIL);
  leadTicket = leadLogin.ticket;
  lead = leadLogin.staff;
  const adminLogin = await loginAs(ADMIN_EMAIL);
  adminTicket = adminLogin.ticket;
  admin = adminLogin.staff;

  // 夹具前提先断言：三个身份必须真是三个角色，否则后面的断言只是在描述
  // "某三个账号碰巧能做什么"，而不是权限矩阵。
  assert.equal(lead.role, "lead", `夹具前提：${LEAD_EMAIL} 必须是 lead，实际 "${lead.role}"`);
  assert.equal(admin.role, "admin", `夹具前提：${ADMIN_EMAIL} 必须是 admin，实际 "${admin.role}"`);
});

after(async () => {
  if (!hasRuntimeEnv) return;
  // `src/auth.ts` / `src/core/auth-login.ts` 都会拉起 redis：不主动 quit 的话 `node --test`
  // 跑完所有断言也不退出（表现是"卡住"而不是"失败"）。
  const [{ pool, query }, { redis }] = await Promise.all([import("../src/db.ts"), import("../src/redis.ts")]);
  if (app !== undefined) await app.close();

  // 顺序：审计 → 故障码（按产品线整条线删）→ 产品线。
  await query("delete from audit_log where target = $1 or target like $2", [
    `product_line:${FIXTURE}`,
    `fault:%@${FIXTURE}`,
  ]);
  await query("delete from fault_codes where product_line = $1", [FIXTURE]);
  // 本文件会查不存在的码（`publicLookup`），`09#04` 之后那会异步写进 `fault_reports`。
  // 不在这里删，每跑一次就留一批待审噪声（实测 id 6–9），而待审列表是给人看的。
  await query("delete from fault_reports where product_line = $1", [FIXTURE]);
  await query("delete from product_lines where code = $1", [FIXTURE]);

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

/** 带会话票据的 inject。默认用 admin 的票据；权限用例显式传 `token`（`null` = 不带票据）。 */
async function call(options: {
  method: "GET" | "POST" | "PATCH";
  url: string;
  token?: string | null;
  payload?: unknown;
}): Promise<Reply> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? adminTicket : options.token;
  if (token !== null) headers["x-staff-session"] = token;
  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
  return toReply(response);
}

/** 五语文案：一门语言写"含义"与"步骤"两段，值里带标记方便断言回显的是自己写的那段。 */
function textFor(useCase: string, kind: "desc" | "act", lang: string): string {
  return `${kind}.${lang} ${mark(useCase)}`;
}

function fullText(useCase: string): { desc: Record<string, string>; act: Record<string, string> } {
  const desc = Object.fromEntries(LANGS.map((lang) => [lang, textFor(useCase, "desc", lang)]));
  const act = Object.fromEntries(LANGS.map((lang) => [lang, textFor(useCase, "act", lang)]));
  return { desc, act };
}

function twoLangText(useCase: string): { desc: Record<string, string>; act: Record<string, string> } {
  return {
    desc: { zh: textFor(useCase, "desc", "zh"), en: textFor(useCase, "desc", "en") },
    act: { zh: textFor(useCase, "act", "zh"), en: textFor(useCase, "act", "en") },
  };
}

/** 新建一条故障码（默认走 admin 票据；建出来的永远是 draft）。 */
async function createFault(input: {
  code: string;
  useCase: string;
  full?: boolean;
  token?: string;
  extra?: Record<string, unknown>;
}): Promise<FaultBody> {
  const text = input.full === true ? fullText(input.useCase) : twoLangText(input.useCase);
  const reply = await call({
    method: "POST",
    url: "/api/admin/faults",
    token: input.token,
    payload: { code: input.code, product_line: FIXTURE, severity: "warn", ...text, ...input.extra },
  });
  assert.equal(reply.status, 200, `新建故障码期望 200，实际 ${reply.status}：${reply.raw}`);
  return (reply.body as { data: FaultBody }).data;
}

async function dbStatus(code: string): Promise<string | null> {
  const { one } = await import("../src/db.ts");
  const row = await one<{ status: string }>("select status from fault_codes where code = $1 and product_line = $2", [
    code,
    FIXTURE,
  ]);
  return row?.status ?? null;
}

/** 库里的 `severity`（NULL 与"行不存在"必须能区分：清空这条判据靠的就是 NULL）。 */
async function dbSeverity(code: string): Promise<string | null> {
  const { one } = await import("../src/db.ts");
  const row = await one<{ severity: string | null }>(
    "select severity from fault_codes where code = $1 and product_line = $2",
    [code, FIXTURE],
  );
  assert.ok(row !== null, `${code} 必须还在库里（夹具被误删了？）`);
  return row.severity;
}

async function auditRows(code: string): Promise<{ actor: string; action: string; payload: Record<string, unknown> }[]> {
  const { query } = await import("../src/db.ts");
  return query(
    "select actor, action, payload from audit_log where target = $1 order by id",
    [`fault:${code}@${FIXTURE}`],
  );
}

/** 公开故障码接口（无令牌，只认 published）。`found:false` = 用户侧看不到这个码。 */
async function publicLookup(code: string): Promise<{ status: number; found: boolean; raw: string }> {
  const reply = toReply(
    await app.inject({ method: "GET", url: `/api/fault/${code}?product_line=${encodeURIComponent(FIXTURE)}` }),
  );
  const found = (reply.body as { data?: { found?: boolean } }).data?.found === true;
  return { status: reply.status, found, raw: reply.raw };
}

/* ─────────────────── ① 角色矩阵（纯查表，不碰库） ─────────────────── */

test("角色表：10 条 /api/admin/* 的最低角色与已签字的矩阵一致", async (t) => {
  const { minRoleFor } = await import("../src/api/roles.ts");
  const expected: Record<string, "lead" | "admin"> = {
    "GET /api/admin/faults": "lead",
    "GET /api/admin/faults/:code": "lead",
    "POST /api/admin/faults": "lead",
    "PATCH /api/admin/faults/:code": "lead",
    "POST /api/admin/faults/:code/publish": "admin",
    "POST /api/admin/faults/:code/archive": "admin",
    "GET /api/admin/product-lines": "lead",
    "POST /api/admin/product-lines": "admin",
    "PATCH /api/admin/product-lines/:code": "admin",
    // `09#05` 把人员列表从 `admin` 降到 `lead`：派发下拉的消费者是 `lead`
    // （`09#03` 的派发权就是给了 `lead`/`admin`），`admin` 专属会让主管有派单权却读不到名单。
    "GET /api/admin/staff": "lead",
  };
  for (const [key, min] of Object.entries(expected)) {
    const [method, url] = key.split(" ") as [string, string];
    assert.equal(minRoleFor(method, url), min, `${key} 的最低角色必须是 ${min}`);
  }
  t.diagnostic(`已核对 ${Object.keys(expected).length} 条管理端路由的最低角色`);
});

/* ─────────────────── ② lead：能看、能建 draft、能编辑 ─────────────────── */

test("lead：列表（全状态）/ 详情 / 建 draft / 编辑，四个读改写都通", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("lead-crud");
  const created = await createFault({ code: "Z01", useCase: tag, token: leadTicket });
  assert.equal(created.status, "draft", "新建必须落 draft");
  assert.equal(created.product_line, FIXTURE);
  assert.equal(created.lang_count, 2, "只写了 zh + en，语言完整度应是 2/5");
  assert.deepEqual(created.complete_langs, ["zh", "en"]);
  assert.deepEqual(created.missing_langs, ["de", "nl", "es"]);
  assert.equal(created.updated_at.length > 0, true, "列表/详情要带更新时间");

  // 列表：status 不筛时能看到 draft（这正是与对外接口的区别）。
  const listReply = await call({
    method: "GET",
    url: `/api/admin/faults?product_line=${FIXTURE}&size=50`,
    token: leadTicket,
  });
  assert.equal(listReply.status, 200, `列表期望 200，实际 ${listReply.status}：${listReply.raw}`);
  const list = (listReply.body as { data: { total: number; items: Record<string, unknown>[] } }).data;
  assert.equal(list.total, 1, `这条产品线下只该有人造的这一条，实际 ${list.total}`);
  const item = list.items[0] as unknown as FaultBody;
  assert.equal(item.code, "Z01");
  assert.equal(item.status, "draft");
  assert.equal(item.lang_count, 2);
  // 列表不带正文（十列长文不该进列表）：正文只在详情里。
  assert.equal(Object.hasOwn(item, "desc"), false, "列表行不该带 desc 正文");

  // 状态筛选：草稿筛得到、已发布筛不到。
  const publishedOnly = await call({
    method: "GET",
    url: `/api/admin/faults?product_line=${FIXTURE}&status=published`,
    token: leadTicket,
  });
  assert.equal((publishedOnly.body as { data: { total: number } }).data.total, 0, "status=published 不该筛到 draft");

  // 缺语筛选：这条确实缺语。
  const missing = await call({
    method: "GET",
    url: `/api/admin/faults?product_line=${FIXTURE}&missing_lang=true`,
    token: leadTicket,
  });
  assert.equal((missing.body as { data: { total: number } }).data.total, 1, "missing_lang=true 应筛到这条缺语的行");
  const complete = await call({
    method: "GET",
    url: `/api/admin/faults?product_line=${FIXTURE}&missing_lang=false`,
    token: leadTicket,
  });
  assert.equal((complete.body as { data: { total: number } }).data.total, 0, "missing_lang=false 不该筛到缺语的行");

  // 详情：带十列全文，回显的是自己写的那两段。
  const detailReply = await call({
    method: "GET",
    url: `/api/admin/faults/Z01?product_line=${FIXTURE}`,
    token: leadTicket,
  });
  assert.equal(detailReply.status, 200, `详情期望 200，实际 ${detailReply.status}：${detailReply.raw}`);
  const detail = (detailReply.body as { data: FaultBody }).data;
  assert.equal(detail.desc.zh, textFor(tag, "desc", "zh"));
  assert.equal(detail.act.en, textFor(tag, "act", "en"));
  assert.equal(detail.desc.de, null, "没写过的语言必须是 null（不是空串）");

  // 缺 product_line 的详情请求：400（主键是两列，缺一半就不该查）。
  const missingKey = await call({ method: "GET", url: "/api/admin/faults/Z01", token: leadTicket });
  assert.equal(missingKey.status, 400, `缺 product_line 期望 400，实际 ${missingKey.status}：${missingKey.raw}`);
  assert.equal((missingKey.body as ErrorBody).error.code, "VALIDATION");

  // 编辑：补一门德语 → 200，changed 只报真改了的字段。
  const patched = await call({
    method: "PATCH",
    url: `/api/admin/faults/Z01?product_line=${FIXTURE}`,
    token: leadTicket,
    payload: { desc: { de: textFor(tag, "desc", "de") }, act: { de: textFor(tag, "act", "de") } },
  });
  assert.equal(patched.status, 200, `编辑期望 200，实际 ${patched.status}：${patched.raw}`);
  const patchedData = (patched.body as { data: { fault: FaultBody; changed: string[] } }).data;
  assert.deepEqual(patchedData.changed.sort(), ["act.de", "desc.de"], "changed 只报真变了的两个字段");
  assert.equal(patchedData.fault.lang_count, 3, "补完德语后语言完整度应是 3/5");
  assert.equal(patchedData.fault.status, "draft", "draft 编辑完还是 draft");

  // 空补丁：一个可识别字段都没有 → 400（与 console 补丁同口径）。
  const empty = await call({
    method: "PATCH",
    url: `/api/admin/faults/Z01?product_line=${FIXTURE}`,
    token: leadTicket,
    payload: { status: "published" },
  });
  assert.equal(empty.status, 400, `空补丁期望 400，实际 ${empty.status}：${empty.raw}`);

  // 审计留痕：actor 是真实登录人（李娜），payload 只记字段名不记正文。
  const audits = await auditRows("Z01");
  assert.equal(audits.length, 2, `新建 + 编辑各一条审计，实际 ${audits.length} 条`);
  assert.equal(audits[0]?.action, "fault.create");
  assert.equal(audits[1]?.action, "fault.update");
  assert.equal(audits[1]?.actor, lead.name, `审计 actor 必须是李娜，实际 "${String(audits[1]?.actor)}"`);
  const updatePayload = JSON.stringify(audits[1]?.payload ?? {});
  assert.equal(
    updatePayload.includes(textFor(tag, "desc", "de")),
    false,
    "审计 payload 不该存整段文案（只记字段名与状态）",
  );
});

/* ─────────────────── ③ lead 做不了 admin 的事 ─────────────────── */

test("lead：不能发布（403）、不能建产品线（403），且库里一字未动", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("lead-denied");
  // 五语齐全的 draft：能发布的条件全满足，唯一挡住它的必须是角色。
  await createFault({ code: "Z02", useCase: tag, full: true, token: leadTicket });

  const publish = await call({
    method: "POST",
    url: `/api/admin/faults/Z02/publish?product_line=${FIXTURE}`,
    token: leadTicket,
  });
  assert.equal(publish.status, 403, `lead 发布期望 403，实际 ${publish.status}：${publish.raw}`);
  assert.equal((publish.body as ErrorBody).error.code, "FORBIDDEN");
  assert.equal(await dbStatus("Z02"), "draft", "被 403 拒掉的发布不得改状态");
  assert.equal((await auditRows("Z02")).length, 1, "被拒的发布不该留下 publish 审计（只有 create 那一条）");

  const archive = await call({
    method: "POST",
    url: `/api/admin/faults/Z02/archive?product_line=${FIXTURE}`,
    token: leadTicket,
  });
  assert.equal(archive.status, 403, `lead 归档期望 403，实际 ${archive.status}：${archive.raw}`);
  assert.equal(await dbStatus("Z02"), "draft", "被 403 拒掉的归档不得改状态");

  const productLine = await call({
    method: "POST",
    url: "/api/admin/product-lines",
    token: leadTicket,
    payload: { code: `${FIXTURE}-x`, name: "不该建出来的产线" },
  });
  assert.equal(productLine.status, 403, `lead 建产品线期望 403，实际 ${productLine.status}：${productLine.raw}`);
  assert.equal((productLine.body as ErrorBody).error.code, "FORBIDDEN");

  // `09#05` 起人员列表对 `lead` 开放（派发下拉要读名单）；它仍是"只读的管理面"，
  // 口令列一样不许下发 —— 降档不等于放松脱敏。
  const staffList = await call({ method: "GET", url: "/api/admin/staff", token: leadTicket });
  assert.equal(staffList.status, 200, `lead 看人员列表期望 200，实际 ${staffList.status}：${staffList.raw}`);
  assert.equal(staffList.raw.toLowerCase().includes("password"), false, "lead 拿到的人员列表也不得含 password");

  // 没票据 → 401（不是 403）：前端据此回登录页，而不是"权限不足"。
  const anonymous = await call({ method: "GET", url: "/api/admin/faults", token: null });
  assert.equal(anonymous.status, 401, `无票据期望 401，实际 ${anonymous.status}：${anonymous.raw}`);
  assert.equal((anonymous.body as ErrorBody).error.code, "AUTH_REQUIRED");

  // agent 连 lead 那一档都进不去。
  const asAgent = await call({ method: "GET", url: "/api/admin/faults", token: agentTicket });
  assert.equal(asAgent.status, 403, `agent 看故障卡列表期望 403，实际 ${asAgent.status}：${asAgent.raw}`);
});

/* ─────────────────── ④ 发布门槛：缺语 409，补齐 200 ─────────────────── */

test("admin：发布缺语的 draft → 409 CONFLICT；补五语后 → 200 且对外可查", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("publish-gate");
  await createFault({ code: "Z03", useCase: tag, full: false });

  const denied = await call({
    method: "POST",
    url: `/api/admin/faults/Z03/publish?product_line=${FIXTURE}`,
  });
  // 实际状态码 = **409 `CONFLICT`**。理由：请求形状没问题（path/query/body 都对），资源也在，
  // 是这行的**状态**不允许这个动作（五语还缺 de/nl/es）。400 会让人去翻请求体，
  // 而真正要做的动作是"把缺的那几语补上"；403 更不对（admin 有这个权限）。
  assert.equal(denied.status, 409, `缺语发布期望 409，实际 ${denied.status}：${denied.raw}`);
  const deniedBody = (denied.body as ErrorBody).error;
  assert.equal(deniedBody.code, "CONFLICT");
  assert.equal(deniedBody.message.includes("de"), true, `报错要点名缺哪几门语，实际 "${deniedBody.message}"`);
  assert.equal(await dbStatus("Z03"), "draft", "发布失败后必须还是 draft");
  assert.equal((await publicLookup("Z03")).found, false, "草稿对用户不可见");

  // 补齐剩下的三门语 → 发布 200。
  const complete = await createFault({ code: "Z04", useCase: tag, full: true });
  assert.equal(complete.lang_count, 5, "五语齐全的夹具应报 5/5");
  const published = await call({
    method: "POST",
    url: `/api/admin/faults/Z04/publish?product_line=${FIXTURE}`,
  });
  assert.equal(published.status, 200, `五语齐全发布期望 200，实际 ${published.status}：${published.raw}`);
  const publishedData = (published.body as { data: { fault: FaultBody; changed: string[] } }).data;
  assert.equal(publishedData.fault.status, "published");
  assert.deepEqual(publishedData.changed, ["status"]);
  assert.equal(await dbStatus("Z04"), "published");

  // 发布之后对外接口立刻查得到（这就是"发布"这两个字的意思）。
  const visible = await publicLookup("Z04");
  assert.equal(visible.status, 200, `公开接口期望 200，实际 ${visible.status}：${visible.raw}`);
  assert.equal(visible.found, true, "已发布的码必须能被公开接口查到");

  // 再发布一次 → 200 且 changed 为空（幂等；双击按钮不该报错）。
  const again = await call({ method: "POST", url: `/api/admin/faults/Z04/publish?product_line=${FIXTURE}` });
  assert.equal(again.status, 200, `重复发布期望 200，实际 ${again.status}：${again.raw}`);
  assert.deepEqual((again.body as { data: { changed: string[] } }).data.changed, []);

  // 审计：发布那条的 actor 是王强（真实登录人）。
  const audits = await auditRows("Z04");
  const publishAudit = audits.find((row) => row.action === "fault.publish");
  assert.ok(publishAudit !== undefined, "发布必须写一条审计");
  assert.equal(publishAudit.actor, admin.name, `发布审计 actor 必须是王强，实际 "${publishAudit.actor}"`);
});

/* ─────────────────── ⑤ 新建时 body 写 published 也不算数 ─────────────────── */

test("新建一律 draft：body 里写 status:\"published\" 也落 draft，对外查不到", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("force-draft");
  // 五语都给了（唯一可能挡发布的条件不存在），再把 status 塞进 body。
  const created = await createFault({
    code: "Z05",
    useCase: tag,
    full: true,
    extra: { status: "published" },
  });
  assert.equal(created.status, "draft", "body 里的 status 必须被忽略，新建只能落 draft");
  assert.equal(await dbStatus("Z05"), "draft", "库里也必须还是 draft（不是响应体骗人）");
  assert.equal((await publicLookup("Z05")).found, false, "没经过 publish 的码对用户不可见");

  // 同主键再建一次 → 409（不静默覆盖：覆盖会绕过"编辑 published 要落回 draft"这条口径）。
  const duplicate = await call({
    method: "POST",
    url: "/api/admin/faults",
    payload: { code: "Z05", product_line: FIXTURE, desc: { zh: "重复" }, act: { zh: "重复" } },
  });
  assert.equal(duplicate.status, 409, `重复新建期望 409，实际 ${duplicate.status}：${duplicate.raw}`);
  assert.equal((duplicate.body as ErrorBody).error.code, "CONFLICT");
});

/* ─────────────────── ⑥ published 改一个字 → 落回 draft ─────────────────── */

test("published 的码被编辑后自动落回 draft（要重新发布）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("demote");
  await createFault({ code: "Z06", useCase: tag, full: true });
  const published = await call({ method: "POST", url: `/api/admin/faults/Z06/publish?product_line=${FIXTURE}` });
  assert.equal(published.status, 200, `发布期望 200，实际 ${published.status}：${published.raw}`);
  assert.equal(await dbStatus("Z06"), "published");

  const edited = await call({
    method: "PATCH",
    url: `/api/admin/faults/Z06?product_line=${FIXTURE}`,
    token: leadTicket,
    payload: { act: { zh: `${textFor(tag, "act", "zh")} 已修订` } },
  });
  assert.equal(edited.status, 200, `编辑期望 200，实际 ${edited.status}：${edited.raw}`);
  const data = (edited.body as { data: { fault: FaultBody; changed: string[] } }).data;
  assert.equal(data.fault.status, "draft", "published 被改过之后必须落回 draft");
  assert.equal(data.changed.includes("status"), true, "changed 里要能看见状态被降级了");
  assert.equal(await dbStatus("Z06"), "draft");
  assert.equal((await publicLookup("Z06")).found, false, "降回 draft 之后用户侧立刻查不到");
});

/* ─────────────────── ⑦ 归档：行还在、公开查不到、不许再改 ─────────────────── */

test("归档：只改 status（行还在），公开接口查不到，归档后不可再编辑/发布（409）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("archive");
  await createFault({ code: "Z07", useCase: tag, full: true });
  const { one } = await import("../src/db.ts");
  const publish = await call({ method: "POST", url: `/api/admin/faults/Z07/publish?product_line=${FIXTURE}` });
  assert.equal(publish.status, 200, `发布期望 200，实际 ${publish.status}：${publish.raw}`);
  assert.equal((await publicLookup("Z07")).found, true, "归档前用户侧应当查得到");

  const before = await one<{ n: string }>("select count(*)::text as n from fault_codes where product_line = $1", [
    FIXTURE,
  ]);
  const archived = await call({ method: "POST", url: `/api/admin/faults/Z07/archive?product_line=${FIXTURE}` });
  assert.equal(archived.status, 200, `归档期望 200，实际 ${archived.status}：${archived.raw}`);
  assert.equal((archived.body as { data: { fault: FaultBody } }).data.fault.status, "archived");
  assert.equal(await dbStatus("Z07"), "archived");

  // 行还在（归档 ≠ 删除）：总数不变，十列文案也一个字没丢。
  const after = await one<{ n: string }>("select count(*)::text as n from fault_codes where product_line = $1", [
    FIXTURE,
  ]);
  assert.equal(after?.n, before?.n, "归档不得删行：这张表的行数必须不变");
  const still = await one<{ desc_zh: string | null }>(
    "select desc_zh from fault_codes where code = 'Z07' and product_line = $1",
    [FIXTURE],
  );
  assert.equal(still?.desc_zh, textFor(tag, "desc", "zh"), "归档不得清空文案");

  // 对外立刻查不到（公开接口只认 published）。
  const gone = await publicLookup("Z07");
  assert.equal(gone.status, 200, `公开接口对已归档的码仍是 200 + found:false，实际 ${gone.status}：${gone.raw}`);
  assert.equal(gone.found, false, "已归档的码不该被用户查到");

  // 归档态是终点：不能再改、不能再发布（都是 409 CONFLICT，不是 404）。
  const patch = await call({
    method: "PATCH",
    url: `/api/admin/faults/Z07?product_line=${FIXTURE}`,
    token: leadTicket,
    payload: { desc: { zh: "归档后不该改得动" } },
  });
  assert.equal(patch.status, 409, `改已归档的码期望 409，实际 ${patch.status}：${patch.raw}`);
  assert.equal((patch.body as ErrorBody).error.code, "CONFLICT");

  const republish = await call({ method: "POST", url: `/api/admin/faults/Z07/publish?product_line=${FIXTURE}` });
  assert.equal(republish.status, 409, `发布已归档的码期望 409，实际 ${republish.status}：${republish.raw}`);

  // 但归档可以重复点（幂等）：再归档一次仍是 200 且 changed 为空。
  const again = await call({ method: "POST", url: `/api/admin/faults/Z07/archive?product_line=${FIXTURE}` });
  assert.equal(again.status, 200, `重复归档期望 200，实际 ${again.status}：${again.raw}`);
  assert.deepEqual((again.body as { data: { changed: string[] } }).data.changed, []);
});

/* ─────────────────── ⑧ 产品线字典 ─────────────────── */

test("产品线字典：admin 能建/改名/停用；lead 只读；重复 code → 409", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const created = await call({
    method: "POST",
    url: "/api/admin/product-lines",
    payload: { code: FIXTURE, name: "夹具产线" },
  });
  assert.equal(created.status, 200, `建产品线期望 200，实际 ${created.status}：${created.raw}`);
  const createdData = (created.body as { data: { code: string; name: string; active: boolean } }).data;
  assert.equal(createdData.code, FIXTURE);
  assert.equal(createdData.active, true, "新建产线默认启用");

  // lead 能读（故障卡表单的下拉要它）。
  const listReply = await call({ method: "GET", url: "/api/admin/product-lines", token: leadTicket });
  assert.equal(listReply.status, 200, `产品线列表期望 200，实际 ${listReply.status}：${listReply.raw}`);
  const list = (listReply.body as { data: { total: number; items: { code: string; active: boolean }[] } }).data;
  assert.equal(list.items.some((item) => item.code === FIXTURE), true, "列表里必须有刚建的产线");

  // 重复 code → 409。
  const duplicate = await call({
    method: "POST",
    url: "/api/admin/product-lines",
    payload: { code: FIXTURE, name: "同名再建一次" },
  });
  assert.equal(duplicate.status, 409, `重复 code 期望 409，实际 ${duplicate.status}：${duplicate.raw}`);
  assert.equal((duplicate.body as ErrorBody).error.code, "CONFLICT");

  // 改名 + 停用。
  const patched = await call({
    method: "PATCH",
    url: `/api/admin/product-lines/${FIXTURE}`,
    payload: { name: "夹具产线（已改名）", active: false },
  });
  assert.equal(patched.status, 200, `改产线期望 200，实际 ${patched.status}：${patched.raw}`);
  const patchedData = (patched.body as { data: { product_line: { name: string; active: boolean }; changed: string[] } })
    .data;
  assert.equal(patchedData.product_line.name, "夹具产线（已改名）");
  assert.equal(patchedData.product_line.active, false);
  assert.deepEqual(patchedData.changed.sort(), ["active", "name"]);

  // 字典没有删除：停用之后行还在（历史故障码仍挂在上面）。
  const { one } = await import("../src/db.ts");
  const row = await one<{ active: boolean }>("select active from product_lines where code = $1", [FIXTURE]);
  assert.equal(row?.active, false, "停用只改 active，行必须还在");

  // 不存在的产线 → 404；非法 code → 400。
  const missing = await call({ method: "PATCH", url: `/api/admin/product-lines/${FIXTURE}-nope`, payload: { active: true } });
  assert.equal(missing.status, 404, `不存在的产线期望 404，实际 ${missing.status}：${missing.raw}`);
  const badCode = await call({
    method: "POST",
    url: "/api/admin/product-lines",
    payload: { code: "Bad Code", name: "大写与空格都不合法" },
  });
  assert.equal(badCode.status, 400, `非法 code 期望 400，实际 ${badCode.status}：${badCode.raw}`);

  // 审计：建 + 改各一条，actor 是王强。
  const { query } = await import("../src/db.ts");
  const audits = await query<{ actor: string; action: string }>(
    "select actor, action from audit_log where target = $1 order by id",
    [`product_line:${FIXTURE}`],
  );
  assert.deepEqual(
    audits.map((audit) => audit.action),
    ["product_line.create", "product_line.update"],
    "建产线与改产线各写一条审计",
  );
  assert.equal(audits[0]?.actor, admin.name);
});

/* ─────────────────── ⑨ 人员列表：绝不下发口令列 ─────────────────── */

test("人员列表（admin）：含三个演示账号，响应体里不出现 password", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const reply = await call({ method: "GET", url: "/api/admin/staff" });
  assert.equal(reply.status, 200, `人员列表期望 200，实际 ${reply.status}：${reply.raw}`);
  const list = (
    reply.body as { data: { total: number; items: { email: string; role: string; active: boolean }[] } }
  ).data;

  const emails = list.items.map((item) => item.email);
  for (const email of [AGENT_EMAIL, LEAD_EMAIL, ADMIN_EMAIL]) {
    assert.equal(emails.includes(email), true, `人员列表里必须有 ${email}（派发下拉要用）`);
  }
  const roles = new Set(list.items.map((item) => item.role));
  for (const role of ["agent", "lead", "admin"]) assert.equal(roles.has(role), true, `缺少 ${role} 角色的人`);

  // 口令列一个字都不能出现在响应体里（`select *` 就够把哈希送进浏览器）。
  const lowered = reply.raw.toLowerCase();
  assert.equal(lowered.includes("password"), false, `人员列表不得包含 password 字样：${reply.raw}`);
  assert.equal(lowered.includes("salt"), false, `人员列表不得包含 salt 字样：${reply.raw}`);
});

/* ─────────────────── ⑩ severity 三态（`09#04` 未做第 5 条） ─────────────────── */

/**
 * `PATCH` 的 `severity` 是**三态**：没传 = 不改；显式 `null` = 清空为 NULL；给了值 = 校验后写入。
 *
 * 为什么要单独钉这三条：把它写成 `body.severity === undefined || body.severity === null ? undefined : ...`
 * 时，"不传"与"显式 null"被折成同一件事，面板的"（未设置）"在已有值上一按就是空操作 ——
 * 用户看到的是"选了未设置、保存成功、值还在"。第 ① 条在没有旧 bug 的实现上也会绿，
 * 它守的是"修 ② 的时候别把 ① 弄坏"。
 */
test("severity 三态：不传=不改、显式 null=清空 NULL、给值=校验写入，非法值 400", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("severity");
  const created = await createFault({ code: "Z08", useCase: tag, token: leadTicket });
  assert.equal(created.severity, "warn", "夹具前提：新建时给了 warn");
  const patchUrl = `/api/admin/faults/Z08?product_line=${FIXTURE}`;

  // ① 不传 severity → 既有值不变（回归口径：这是"只改文案"的常规保存）。
  const untouched = await call({
    method: "PATCH",
    url: patchUrl,
    token: leadTicket,
    payload: { desc: { de: textFor(tag, "desc", "de") } },
  });
  assert.equal(untouched.status, 200, `补德语期望 200，实际 ${untouched.status}：${untouched.raw}`);
  const untouchedData = (untouched.body as { data: { fault: FaultBody; changed: string[] } }).data;
  assert.deepEqual(untouchedData.changed, ["desc.de"], "没传 severity 就不该出现 severity 这一项");
  assert.equal(untouchedData.fault.severity, "warn", "没传 severity 时既有值必须原样保留（响应）");
  assert.equal(await dbSeverity("Z08"), "warn", "没传 severity 时既有值必须原样保留（库）");

  // ② 显式 null → 清空为 NULL（面板的"（未设置）"就靠这一句）。
  const cleared = await call({ method: "PATCH", url: patchUrl, token: leadTicket, payload: { severity: null } });
  assert.equal(cleared.status, 200, `清空 severity 期望 200，实际 ${cleared.status}：${cleared.raw}`);
  const clearedData = (cleared.body as { data: { fault: FaultBody; changed: string[] } }).data;
  assert.equal(clearedData.fault.severity, null, "显式 null 必须把 severity 清成 NULL（响应）");
  assert.deepEqual(clearedData.changed, ["severity"], "清空是一次真实修改，changed 要报出来");
  assert.equal(await dbSeverity("Z08"), null, "库里 severity 必须是 NULL（不是空串，也不是旧值）");

  // ③ 本来就 NULL 再传 null → 200 且 changed 为空：值没变就不是修改，不写审计（与 updateTicket 同口径）。
  const again = await call({ method: "PATCH", url: patchUrl, token: leadTicket, payload: { severity: null } });
  assert.equal(again.status, 200, `重复清空期望 200（幂等），实际 ${again.status}：${again.raw}`);
  assert.deepEqual((again.body as { data: { changed: string[] } }).data.changed, [], "值本来就相等时不算变化");

  // ④ 给值 → 校验后写入（清空之后还能再设回来，否则"清空"就成了单向门）。
  const restored = await call({ method: "PATCH", url: patchUrl, token: leadTicket, payload: { severity: "fatal" } });
  assert.equal(restored.status, 200, `写入 severity 期望 200，实际 ${restored.status}：${restored.raw}`);
  assert.equal((restored.body as { data: { fault: FaultBody } }).data.fault.severity, "fatal");
  assert.equal(await dbSeverity("Z08"), "fatal");

  // ⑤ 非法值 → 400，且库里一字未动（拼错的 `warning` 静默变成 NULL 会让"这条是 fatal"凭空消失）。
  const bad = await call({ method: "PATCH", url: patchUrl, token: leadTicket, payload: { severity: "warning" } });
  assert.equal(bad.status, 400, `非法 severity 期望 400，实际 ${bad.status}：${bad.raw}`);
  assert.equal((bad.body as ErrorBody).error.code, "VALIDATION");
  assert.equal(await dbSeverity("Z08"), "fatal", "被 400 拒掉的补丁不得改动 severity");
});

/**
 * 清空 `severity` 也是**一次修改**，所以沿用既有的"`published` 改了就落回 `draft`"规则：
 * 严重度决定用户看到的提示语气，改了它就该重新点一次发布（"谁批准的"这一步不能被跳过）。
 * 这条断言把这个组合钉住 —— 它不是新规则，是既有规则在新三态上的延伸。
 */
test("published 的码被清空 severity → 落回 draft（既有「改了就落 draft」规则）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const tag = mark("severity-demote");
  await createFault({ code: "Z09", useCase: tag, full: true });

  const published = await call({ method: "POST", url: `/api/admin/faults/Z09/publish?product_line=${FIXTURE}` });
  assert.equal(published.status, 200, `发布期望 200，实际 ${published.status}：${published.raw}`);
  assert.equal((published.body as { data: { fault: FaultBody } }).data.fault.severity, "warn");

  const cleared = await call({
    method: "PATCH",
    url: `/api/admin/faults/Z09?product_line=${FIXTURE}`,
    token: leadTicket,
    payload: { severity: null },
  });
  assert.equal(cleared.status, 200, `清空 severity 期望 200，实际 ${cleared.status}：${cleared.raw}`);
  const data = (cleared.body as { data: { fault: FaultBody; changed: string[] } }).data;
  assert.equal(data.fault.severity, null);
  assert.equal(data.fault.status, "draft", "published 的码被改过（哪怕只改了 severity）必须落回 draft");
  assert.deepEqual(data.changed.slice().sort(), ["severity", "status"], "changed 要同时报出字段与降级");
  assert.equal(await dbSeverity("Z09"), null);
  assert.equal(await dbStatus("Z09"), "draft");
  // 降回 draft 之后用户侧立刻查不到（发布态是"用户能看到"，不是一句标签）。
  assert.equal((await publicLookup("Z09")).found, false, "降回 draft 后用户侧必须查不到");
});
