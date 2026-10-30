/**
 * 故障码快路的黑盒验收（`04-agent-chat` #02 · 05-api.md §3.3、§5.2；06-agent.md §3.2）。
 *
 * 只在本进程里注册本卡的 `registerInternalFaultRoutes`，不走 `buildApp`：这一卡要证明的是
 * "两道门 + 入参校验 + 主键查询 + 语言列选择"这一段接对了，整机装配由 `tests/healthz.test.ts`
 * 和 `tests/retrieval-search.test.ts` 负责。少一层依赖，红了就知道是谁的锅。
 *
 * 期望值**从库里按列取**（`desc_de` / `desc_nl` / `act_de` …）而不是抄 `corpus/fault_codes.json`：
 * 本文件要抓的错正是"取错了语言列"，所以三个语言的列都要取出来比对 —— 若实现只按 `en` 返回，
 * 断言立刻红；抄语料 JSON 则做不到这一点（它不证明库里存的就是它）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 tests/healthz.test.ts / retrieval-search.test.ts 同一套 .env 解析：`node --test` 不带 --env-file。 */
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

const ROUTE = "/internal/fault";
const internalToken = String(process.env.INTERNAL_TOKEN ?? "").trim();

/* ─────────────────────────── 响应体形状（05 §3.3） ─────────────────────────── */

type HitData = {
  found: true;
  code: string;
  severity: string;
  meaning: string;
  actions: string[];
  doc_lang: string;
  product_line: string;
};

type HitBody = { ok: true; data: HitData };
type MissBody = { ok: true; data: { found: false; code: string } };
type ErrorBody = { ok: false; error: { code: string; message: string; trace_id: string } };

let app: FastifyInstance | undefined;

before(async () => {
  if (!hasRuntimeEnv) return;
  const { default: Fastify } = await import("fastify");
  const { registerInternalFaultRoutes } = await import("../src/api/internal-fault.ts");
  const { toErrorBody } = await import("../src/errors.ts");

  const instance = Fastify({ logger: false });
  // 与 src/server.ts 的两个处理器保持同形：这里的 400 / 404 断言要能代表线上行为。
  instance.setErrorHandler((err, request, reply) => {
    const { status, body } = toErrorBody(err, String(request.id));
    return reply.code(status).send(body);
  });
  instance.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ ok: false, error: { code: "NOT_FOUND", message: "Not found", trace_id: String(request.id) } }),
  );
  await registerInternalFaultRoutes(instance);
  await instance.ready();
  app = instance;
});

after(async () => {
  if (app !== undefined) await app.close();
  if (!hasRuntimeEnv) return;
  const { pool } = await import("../src/db.ts");
  await pool.end().catch(() => undefined);
});

/* ─────────────────────────── 调用与取数 ─────────────────────────── */

type InjectOptions = {
  /** `null` = 不带该请求头；省略 = 带正确令牌。 */
  token?: string | null;
  /** light-my-request 的假 socket 地址；省略即 127.0.0.1（回环）。 */
  remoteAddress?: string;
};

async function injectFault(
  url: string,
  init: { method: "GET" | "POST"; payload?: unknown },
  options: InjectOptions = {},
): Promise<{ status: number; body: unknown }> {
  const instance = app;
  assert.ok(instance !== undefined, "app 未初始化");
  const headers: Record<string, string> = {};
  if (options.token !== null) headers["x-internal-token"] = options.token ?? internalToken;
  const response = await instance.inject({
    method: init.method,
    url,
    headers,
    ...(init.payload === undefined ? {} : { payload: init.payload as Record<string, unknown> }),
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
  });
  return { status: response.statusCode, body: response.json() };
}

async function getFault(query: string, options: InjectOptions = {}): Promise<{ status: number; body: unknown }> {
  return injectFault(`${ROUTE}${query}`, { method: "GET" }, options);
}

type FaultColumns = {
  severity: string;
  desc_zh: string;
  desc_en: string;
  desc_de: string;
  desc_nl: string;
  act_de: string;
  act_nl: string;
};

/** 直接从库里取期望值：断言"取的是哪一列"，而不是"取到了字符串"。 */
async function fetchColumns(code: string, productLine: string): Promise<FaultColumns> {
  const { query } = await import("../src/db.ts");
  const rows = await query<FaultColumns>(
    `select severity, desc_zh, desc_en, desc_de, desc_nl, act_de, act_nl
       from fault_codes
      where code = $1 and product_line = $2`,
    [code, productLine],
  );
  const row = rows[0];
  assert.ok(row !== undefined, `库里没有 (${code}, ${productLine})：先跑 npm run ingest`);
  return row;
}

/** 去掉步骤编号与分隔符，只比较正文：切分口径变了不会伪装成"内容丢了"。 */
function normalizeSteps(raw: string): string {
  return raw.replace(/[;；]\s*/g, " ").replace(/\s+/g, " ").trim();
}

/* ─────────────────────────── 正向：de ─────────────────────────── */

test("E03 / de：主键命中，含义与步骤取自德语列，doc_lang=de", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const columns = await fetchColumns("E03", "balcony");
  const { status, body } = await getFault("?code=E03&lang=de");
  assert.equal(status, 200, `期望 200，实际 ${status}：${JSON.stringify(body)}`);

  const data = (body as HitBody).data;
  assert.equal(data.found, true);
  assert.equal(data.code, "E03");
  assert.equal(data.severity, "warn");
  assert.equal(data.product_line, "balcony");

  // 语言列选择的证明：等于德语列，且**不等于**英文列（五语内容互不相同）
  assert.equal(data.meaning, columns.desc_de, "meaning 必须逐字等于 desc_de");
  assert.notEqual(data.meaning, columns.desc_en, "meaning 不能退化成英文列");
  assert.equal(data.doc_lang, "de", "doc_lang 必须报告实际取用的列语言");

  // 语料的 act_de 是 "1. …; 2. …; 3. …; 4. …"：四步（工单里写的"三步"是笔误，以语料为准）
  assert.equal(data.actions.length, 4, `E03 德语处理步骤应为 4 条，实际 ${JSON.stringify(data.actions)}`);
  assert.deepEqual(
    data.actions.map((action) => action.slice(0, 2)),
    ["1.", "2.", "3.", "4."],
    "步骤必须保留编号且顺序不乱",
  );
  for (const action of data.actions) {
    assert.ok(!/[;；]\s*$/.test(action), `步骤尾部不应残留分隔符：${JSON.stringify(action)}`);
    assert.ok(action.length > 3, `步骤正文不能为空：${JSON.stringify(action)}`);
  }
  // 切分不能丢正文：步骤拼回去必须与语料那一段等价（只差分隔符与空白）
  assert.equal(normalizeSteps(data.actions.join("; ")), normalizeSteps(columns.act_de));

  t.diagnostic(
    `E03/de → doc_lang=de、severity=warn、${data.actions.length} 步，meaning 取自 desc_de（${data.meaning.length} 字）`,
  );
});

test("E03 / nl：荷兰语请求走 act_nl / desc_nl，回退链未触发", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const columns = await fetchColumns("E03", "balcony");
  const { status, body } = await getFault("?code=E03&lang=nl");
  assert.equal(status, 200, `期望 200，实际 ${status}：${JSON.stringify(body)}`);

  const data = (body as HitBody).data;
  assert.equal(data.doc_lang, "nl");
  assert.equal(data.meaning, columns.desc_nl);
  assert.notEqual(data.meaning, columns.desc_en, "nl 有内容时不许回退到英文");
  assert.equal(normalizeSteps(data.actions.join("; ")), normalizeSteps(columns.act_nl));
  t.diagnostic(`E03/nl → doc_lang=nl（desc_nl / act_nl），未发生回退`);
});

test("product_line 是主键的一半：F21 只在 residential 存在，缺省 balcony 必须未命中", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const zh = await getFault("?code=F21&lang=zh&product_line=residential");
  assert.equal(zh.status, 200);
  const data = (zh.body as HitBody).data;
  assert.equal(data.found, true);
  assert.equal(data.product_line, "residential");
  assert.equal(data.doc_lang, "zh");
  assert.equal(data.severity, "warn");

  const balcony = await getFault("?code=F21&lang=de");
  assert.equal(balcony.status, 200);
  assert.deepEqual(balcony.body, { ok: true, data: { found: false, code: "F21" } });
  t.diagnostic("F21 → residential 命中（doc_lang=zh）；缺省 product_line=balcony 时未命中");
});

/* ─────────────────────────── 未命中 ─────────────────────────── */

test("E99：未命中是 200 + found:false，不是 404", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { status, body } = await getFault("?code=E99&lang=de");
  assert.equal(status, 200, "未命中不是错误：工具要把它翻成 CODE_NOT_FOUND 告诉模型");
  assert.deepEqual(body, { ok: true, data: { found: false, code: "E99" } });
  t.diagnostic("E99 → 200 {found:false, code:'E99'}（无 severity/actions 字段）");
});

/* ─────────────────────────── 入参校验（400） ─────────────────────────── */

test("入参校验：坏 code / 缺 code / lang=fr / 空 lang 都是 400 VALIDATION", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const cases: readonly { name: string; query: string }[] = [
    { name: "code=X1（位数不足）", query: "?code=X1&lang=de" },
    { name: "code=E1234（位数过多）", query: "?code=E1234&lang=de" },
    { name: "缺 code", query: "?lang=de" },
    { name: "lang=fr（不在五语内）", query: "?code=E03&lang=fr" },
    { name: "显式空 lang", query: "?code=E03&lang=" },
    { name: "product_line 过长", query: `?code=E03&lang=de&product_line=${"x".repeat(33)}` },
  ];

  for (const item of cases) {
    const { status, body } = await getFault(item.query);
    assert.equal(status, 400, `${item.name} 期望 400，实际 ${status}：${JSON.stringify(body)}`);
    const error = (body as ErrorBody).error;
    assert.equal(error.code, "VALIDATION", `${item.name} 的错误码必须是 VALIDATION`);
    assert.ok(error.message.length > 0, `${item.name} 的错误信息不能为空`);
  }
  t.diagnostic(`校验：${cases.map((item) => item.name).join(" / ")} 均为 400 VALIDATION`);
});

/* ─────────────────────────── 门禁（不可区分的 404） ─────────────────────────── */

test("门禁：缺令牌 / 错令牌 / 非回环来源都是与普通 404 逐字同形的 404", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const instance = app;
  assert.ok(instance !== undefined);
  // 基准：这个路径真的不存在，它的响应体就是"什么都没有"的样子
  const real404 = await instance.inject({ method: "GET", url: "/definitely-not-a-route" });
  const real404Body = real404.json() as ErrorBody;
  assert.equal(real404.statusCode, 404);

  const gates: readonly { name: string; options: InjectOptions }[] = [
    { name: "缺 X-Internal-Token", options: { token: null } },
    { name: "错 X-Internal-Token", options: { token: "wrong-token" } },
    { name: "非回环来源 10.1.2.3", options: { remoteAddress: "10.1.2.3" } },
  ];

  for (const gate of gates) {
    const { status, body } = await getFault("?code=E03&lang=de", gate.options);
    assert.equal(status, 404, `${gate.name} 期望 404，实际 ${status}`);
    const error = (body as ErrorBody).error;
    // 逐字同形：除了 trace_id（每个请求都不同）以外不能有任何可区分的特征
    assert.deepEqual(
      { ok: (body as ErrorBody).ok, code: error.code, message: error.message },
      { ok: real404Body.ok, code: real404Body.error.code, message: real404Body.error.message },
      `${gate.name} 的 404 响应体必须与普通 404 逐字相同`,
    );
    assert.equal(typeof error.trace_id, "string");
    assert.ok(error.trace_id.length > 0);
    assert.equal("data" in (body as Record<string, unknown>), false, "门禁失败的响应体不能带 data");
  }

  // 精确形状（`trace_id` 是唯一变量）：字段少一个、多一个都算泄露端点存在性
  const missing = await getFault("?code=E03&lang=de", { token: null });
  assert.deepEqual(missing.body, {
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: "Not found",
      trace_id: (missing.body as ErrorBody).error.trace_id,
    },
  });
  t.diagnostic("门禁：缺令牌 / 错令牌 / 非回环 均为 404 NOT_FOUND，与普通 404 同形");
});

/* ─────────────────────────── POST 形态（05 §5.2） ─────────────────────────── */

test("POST /internal/fault：与 GET 同一结果，门禁同样生效", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const post = await injectFault(ROUTE, { method: "POST", payload: { code: "E03", lang: "de" } });
  assert.equal(post.status, 200, `期望 200，实际 ${post.status}：${JSON.stringify(post.body)}`);
  const viaGet = await getFault("?code=E03&lang=de");
  assert.deepEqual(post.body, viaGet.body, "GET 与 POST 必须是同一条实现的结果");

  // 未命中在 POST 上同样是 200 + found:false
  const miss = await injectFault(ROUTE, { method: "POST", payload: { code: "E99" } });
  assert.equal(miss.status, 200);
  assert.deepEqual(miss.body, { ok: true, data: { found: false, code: "E99" } });

  const noToken = await injectFault(ROUTE, { method: "POST", payload: { code: "E03" } }, { token: null });
  assert.equal(noToken.status, 404);
  assert.equal((noToken.body as ErrorBody).error.code, "NOT_FOUND");
  t.diagnostic("POST 与 GET 结果逐字相同；POST 缺令牌同样 404");
});

/* ─────────────────────────── 纯函数：步骤切分 ─────────────────────────── */

test("splitActions：按编号切分，保留编号，单步/无编号/空串原样处理", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { splitActions } = await import("../src/core/fault-codes.ts");

  // 只有一步：切成 1 条就等于"整段"，编号保留
  assert.deepEqual(splitActions("1. Nur ein Schritt"), ["1. Nur ein Schritt"]);
  // 多步：编号 → 数组，分隔符不残留
  assert.deepEqual(splitActions("1. A messen; 2. B prüfen; 3. C zurücksetzen"), [
    "1. A messen",
    "2. B prüfen",
    "3. C zurücksetzen",
  ]);
  // 中文全角分号同一条规则
  assert.deepEqual(splitActions("1. 测量电压；2. 检查端子"), ["1. 测量电压", "2. 检查端子"]);
  // 正文里的 "3.65 V" 不是步骤编号（电池电压不能被切成新的一步）
  assert.deepEqual(splitActions("1. Zellspannung über 3.65 V prüfen; 2. zurücksetzen"), [
    "1. Zellspannung über 3.65 V prüfen",
    "2. zurücksetzen",
  ]);
  // 没有编号：整段返回（宁可不切，也不要把正文拆坏）
  assert.deepEqual(splitActions("keine Nummerierung"), ["keine Nummerierung"]);
  assert.deepEqual(splitActions("   "), []);
  t.diagnostic("splitActions：单步/多步/全角分号/小数/无编号/空串 六种输入均为预期");
});
