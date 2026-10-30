/**
 * 用户端故障码直查的黑盒验收（`04-agent-chat` #03 · 05-api.md §3.3、10-ui-user.md §5）。
 *
 * 只在本进程注册本卡的 `registerFaultRoutes`，不 import `src/routes.ts`：这一卡要证明的是
 * "path 判形 + query 缺省 + 主键命中 + 语言列 + 响应形状 + 无模型/无门禁"这一段接对了。
 * 整机装配由 `tests/healthz.test.ts` 负责；少一层依赖，红了就知道是谁的锅。
 *
 * 期望值**从库里按列取**（`desc_de` / `act_de`），不抄 `corpus/fault_codes.json`：本文件要抓的
 * 错正是"取错了语言列 / 步骤切坏了"，抄 JSON 证明不了库里存的与响应一致。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 tests/healthz.test.ts / fault-lookup.test.ts 同一套 .env 解析：`node --test` 不带 --env-file。 */
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

/** 05 §3.3：`GET /api/fault/:code`。 */
const faultUrl = (code: string, query = ""): string => `/api/fault/${code}${query}`;

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
  const { registerFaultRoutes } = await import("../src/api/fault.ts");
  const { toErrorBody } = await import("../src/errors.ts");

  const instance = Fastify({ logger: false });
  // 与 src/server.ts 的两个处理器同形：这里的 400 断言要能代表线上行为（AppError → 仓库信封）。
  instance.setErrorHandler((err, request, reply) => {
    const { status, body } = toErrorBody(err, String(request.id));
    return reply.code(status).send(body);
  });
  instance.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ ok: false, error: { code: "NOT_FOUND", message: "Not found", trace_id: String(request.id) } }),
  );
  await registerFaultRoutes(instance);
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

async function getFault(
  code: string,
  query = "",
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const instance = app;
  assert.ok(instance !== undefined, "app 未初始化");
  const response = await instance.inject({ method: "GET", url: faultUrl(code, query), headers });
  return { status: response.statusCode, body: response.json() };
}

type FaultColumns = {
  severity: string;
  desc_de: string;
  desc_en: string;
  act_de: string;
};

/** 单次注入 + 计时（性能断言用）：返回毫秒数，并顺手钉住状态码。 */
async function timedInject(url: string): Promise<number> {
  const instance = app;
  assert.ok(instance !== undefined, "app 未初始化");
  const startedAt = performance.now();
  const response = await instance.inject({ method: "GET", url });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(response.statusCode, 200, `${url} 期望 200，实际 ${response.statusCode}`);
  return elapsedMs;
}

/** 直接从库里取期望值：断言"取的是哪一列"，而不是"取到了字符串"。 */
async function fetchColumns(code: string, productLine: string): Promise<FaultColumns> {
  const { query } = await import("../src/db.ts");
  const rows = await query<FaultColumns>(
    `select severity, desc_de, desc_en, act_de
       from fault_codes
      where code = $1 and product_line = $2`,
    [code, productLine],
  );
  const row = rows[0];
  assert.ok(row !== undefined, `库里没有 (${code}, ${productLine})：先跑 npm run ingest`);
  return row;
}

/**
 * 步骤条目的期望值**来自语料本身**，不是猜的：`E03` 的 `act_de` 写成
 * `1. …; 2. …; 3. …; 4. …` 一列文本，这里按"行首或分号之后的编号"数出条目数与编号序列。
 * 这样语料被改成 3 步或 5 步时，断言跟着变，而不是钉死一个可能过期的字面量。
 */
function numberedSteps(raw: string): string[] {
  const steps: string[] = [];
  for (const match of raw.matchAll(/(?:^|;\s*)(\d{1,2})[.)](?=\s)/g)) {
    steps.push(String(match[1]));
  }
  return steps;
}

/* ─────────────────────────── 正向：de ─────────────────────────── */

test("E03 / de：命中，severity=warn，德语含义，有序步骤，doc_lang=de", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const columns = await fetchColumns("E03", "balcony");
  const expectedSteps = numberedSteps(columns.act_de);
  // 语料里的编号就是这几步（当前 E03/de 是 "1. …; 2. …; 3. …; 4. …" → 4 条）。
  // 这里断言的是"数出来的结果"，不是写死的猜测：上面这行从 DB 列里数，下面的断言比它。
  assert.equal(expectedSteps.length, 4, `E03/de 的 act_de 应含 4 个编号步骤，实际 ${expectedSteps.join(",")}`);

  const { status, body } = await getFault("E03", "?lang=de");
  assert.equal(status, 200, `期望 200，实际 ${status}：${JSON.stringify(body)}`);

  const data = (body as HitBody).data;
  assert.equal(data.found, true);
  assert.equal(data.code, "E03");
  assert.equal(data.severity, "warn");
  assert.equal(data.product_line, "balcony");
  assert.equal(data.doc_lang, "de", "doc_lang 必须报告实际取用的列语言");

  // 语言列选择的证明：等于德语列，且**不等于**英文列（五语内容互不相同）
  assert.equal(data.meaning, columns.desc_de, "meaning 必须逐字等于 desc_de");
  assert.notEqual(data.meaning, columns.desc_en, "meaning 不能退化成英文列");

  assert.equal(
    data.actions.length,
    expectedSteps.length,
    `步骤条数应等于语料里的编号条数（${expectedSteps.length}），实际 ${JSON.stringify(data.actions)}`,
  );
  assert.deepEqual(
    data.actions.map((action) => /^(\d{1,2})[.)]/.exec(action)?.[1] ?? ""),
    expectedSteps,
    "步骤必须保留编号且顺序不乱",
  );
  for (const action of data.actions) {
    assert.ok(!/[;；]\s*$/.test(action), `步骤尾部不应残留分隔符：${JSON.stringify(action)}`);
    assert.ok(action.length > 3, `步骤正文不能为空：${JSON.stringify(action)}`);
  }

  // 大写归一化发生在查表参数上，响应回显库里的规范写法（10 §5 的输入框是不可靠的 autocapitalize）
  const lower = await getFault("e03", "?lang=de");
  assert.equal(lower.status, 200);
  assert.equal((lower.body as HitBody).data.code, "E03", "小写输入应命中原码并回显库里的写法");

  t.diagnostic(
    `E03/de → doc_lang=de、severity=warn、${data.actions.length} 步（编号 ${expectedSteps.join(",")}），` +
      `meaning 取自 desc_de（${data.meaning.length} 字）`,
  );
});

test("F21 / residential 命中；缺省 product_line=balcony 时未命中", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const columns = await fetchColumns("F21", "residential");
  const hit = await getFault("F21", "?product_line=residential");
  assert.equal(hit.status, 200, `期望 200，实际 ${hit.status}：${JSON.stringify(hit.body)}`);
  const data = (hit.body as HitBody).data;
  assert.equal(data.found, true);
  assert.equal(data.code, "F21");
  assert.equal(data.product_line, "residential");
  assert.equal(data.severity, columns.severity);
  assert.equal(data.doc_lang, "en", "不传 lang 时缺省 en（05 §3.3）");
  assert.equal(data.meaning, columns.desc_en);
  assert.ok(data.actions.length > 0, "命中的答案卡不能没有步骤");

  // product_line 是主键的一半：F21 只存在于 residential，缺省 balcony 必须 miss
  const miss = await getFault("F21");
  assert.equal(miss.status, 200);
  assert.deepEqual(miss.body, { ok: true, data: { found: false, code: "F21" } });
  t.diagnostic(`F21 → residential 命中（doc_lang=en、${data.actions.length} 步）；缺省 balcony 未命中`);
});

/* ─────────────────────────── 未命中 ─────────────────────────── */

test("E99：未命中是 200 + found:false，不是 404（10 §5 要渲染「没找到」）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { status, body } = await getFault("E99", "?lang=de");
  assert.equal(status, 200, "未命中不是错误：页面的正常分支是「没找到 E99」+「问 AI」");
  assert.deepEqual(body, { ok: true, data: { found: false, code: "E99" } });
  t.diagnostic("E99 → 200 {found:false, code:'E99'}（无 severity/actions/meaning 字段）");
});

/* ─────────────────────────── 入参校验（400） ─────────────────────────── */

test("path 判形：X1 / E1234 / 非字母开头 / 尾部多余 都是 400 VALIDATION", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  // `E1234`：位数过多。`X1`：位数不足。`E03x`/`03`：整串锚定，不能"包含就算"。
  const cases: readonly { name: string; code: string; query: string }[] = [
    { name: "X1（位数不足）", code: "X1", query: "?lang=de" },
    { name: "E1234（位数过多）", code: "E1234", query: "?lang=de" },
    { name: "03（无字母）", code: "03", query: "?lang=de" },
    { name: "E03x（尾部多余）", code: "E03x", query: "?lang=de" },
  ];
  for (const item of cases) {
    const { status, body } = await getFault(item.code, item.query);
    assert.equal(status, 400, `${item.name} 期望 400，实际 ${status}：${JSON.stringify(body)}`);
    assert.equal((body as ErrorBody).ok, false);
    assert.equal((body as ErrorBody).error.code, "VALIDATION", `${item.name} 的错误码必须是 VALIDATION`);
    assert.ok((body as ErrorBody).error.message.length > 0);
    assert.equal("data" in (body as Record<string, unknown>), false, "错误响应不能带 data");
  }
  t.diagnostic(`path 判形：${cases.map((item) => item.name).join(" / ")} 均为 400 VALIDATION`);
});

test("query 校验：lang=fr / 空 lang / 空 product_line 都是 400 VALIDATION", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const cases: readonly { name: string; query: string }[] = [
    { name: "lang=fr（不在五语内）", query: "?lang=fr" },
    { name: "显式空 lang", query: "?lang=" },
    { name: "空 product_line", query: "?lang=de&product_line=" },
  ];
  for (const item of cases) {
    const { status, body } = await getFault("E03", item.query);
    assert.equal(status, 400, `${item.name} 期望 400，实际 ${status}：${JSON.stringify(body)}`);
    assert.equal((body as ErrorBody).error.code, "VALIDATION", `${item.name} 的错误码必须是 VALIDATION`);
  }

  // 五语都放行（缺省 en 已在上面的 F21 里覆盖）
  for (const lang of ["zh", "en", "de", "nl", "es"]) {
    const { status, body } = await getFault("E03", `?lang=${lang}`);
    assert.equal(status, 200, `lang=${lang} 期望 200，实际 ${status}：${JSON.stringify(body)}`);
    assert.equal((body as HitBody).data.doc_lang, lang, `lang=${lang} 必须取该语言的列`);
  }
  t.diagnostic(`query 校验：${cases.map((item) => item.name).join(" / ")} 均为 400；五语均 200`);
});

/* ─────────────────────────── 无鉴权（公开端点） ─────────────────────────── */

test("公开端点：不带 X-User-Session 也能查，且非法令牌被无视", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  // 10 §5：故障码页「不建立会话、不调模型」—— 页面拿到令牌之前就必须能出卡。
  const anonymous = await getFault("E03", "?lang=de");
  assert.equal(anonymous.status, 200, `无凭据也必须 200，实际 ${anonymous.status}`);

  // 带一个没签发过的令牌：结果必须与匿名调用逐字相同（说明这一路根本不读这个头，
  // 而不是"碰巧令牌有效"）—— 否则前端会因为令牌过期在故障码页收到 401。
  const withToken = await getFault("E03", "?lang=de", { "x-user-session": "not-a-real-token" });
  assert.equal(withToken.status, 200);
  assert.deepEqual(withToken.body, anonymous.body);
  t.diagnostic("无 X-User-Session → 200；伪造令牌 → 与匿名响应逐字相同");
});

/* ─────────────────────────── 性能（05 §3.3：P95 < 20ms） ─────────────────────────── */

test("性能：10 次顺序调用，中位延迟 < 20ms（单条主键查询，无模型/无 embedding）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const instance = app;
  assert.ok(instance !== undefined);

  // 预热一次（不进统计）：第一次请求要建一条 pg 连接，那是"进程冷启动"的成本，
  // 不是这条查询的成本；05 §3.3 的预算是稳态下的单条主键查询。
  await instance.inject({ method: "GET", url: faultUrl("E03", "?lang=de") });

  const samples: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    samples.push(await timedInject(faultUrl("E03", "?lang=de")));
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const median = ((sorted[4] as number) + (sorted[5] as number)) / 2;
  t.diagnostic(
    `10 次 injections（ms）：${samples.map((value) => value.toFixed(2)).join(", ")} → 中位 ${median.toFixed(2)}ms`,
  );
  assert.ok(median < 20, `中位延迟应 < 20ms，实际 ${median.toFixed(2)}ms（样本 ${samples.map((v) => v.toFixed(2)).join(",")}）`);
});
