import assert from "node:assert/strict";
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

const RECALL_URL = "/internal/retrieval/recall";
const internalToken = String(process.env.INTERNAL_TOKEN ?? "").trim();

/** 响应体里一个候选片段（内部接口的字段名，不是 #02 的 RetrievedChunk）。 */
type RecallRow = {
  rank: number;
  chunk_id: number;
  doc_id: string;
  doc_title: string;
  doc_lang: string;
  lang: string;
  page: number | null;
  section: string | null;
  content: string;
  score: number;
};

type RecallBody = {
  ok: true;
  query: string;
  lang: string;
  lang_scope: string[];
  lane: string;
  recall_top_n: number;
  embed_backend: string;
  timings_ms: { embed_ms: number; vector_ms: number; fts_ms: number; total_ms: number };
  vector: RecallRow[] | null;
  fts: RecallRow[] | null;
};

type InjectOptions = {
  q?: string;
  lang?: string;
  lane?: string;
  token?: string | null;
  /** light-my-request 的假 socket 地址；省略即 127.0.0.1。 */
  remoteAddress?: string;
};

let app: FastifyInstance;

before(async () => {
  if (!hasRuntimeEnv) return;
  const { buildApp } = await import("../src/server.ts");
  app = await buildApp();
});

after(async () => {
  if (app !== undefined) await app.close();
  if (!hasRuntimeEnv) return;
  const { pool } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");
  await redis.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

async function callRecall(
  options: InjectOptions,
): Promise<{ status: number; body: RecallBody }> {
  const query: Record<string, string> = {};
  if (options.q !== undefined) query.q = options.q;
  if (options.lang !== undefined) query.lang = options.lang;
  if (options.lane !== undefined) query.lane = options.lane;

  const headers: Record<string, string> = {};
  if (options.token !== null) headers["x-internal-token"] = options.token ?? internalToken;

  const response = await app.inject({
    method: "GET",
    url: RECALL_URL,
    query,
    headers,
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
  });
  return { status: response.statusCode, body: response.json() as RecallBody };
}

/** 同一查询只真打一次：每次调用都要走真实 embedding（约 150–370ms 网络），重复调用纯浪费。 */
const bodyCache = new Map<string, Promise<RecallBody>>();
function cachedRecall(options: InjectOptions): Promise<RecallBody> {
  const key = JSON.stringify(options);
  let pending = bodyCache.get(key);
  if (pending === undefined) {
    pending = callRecall(options).then((result) => {
      assert.equal(result.status, 200, `期望 200，实际 ${result.status}`);
      return result.body;
    });
    bodyCache.set(key, pending);
  }
  return pending;
}

function allRows(body: RecallBody): RecallRow[] {
  return [...(body.vector ?? []), ...(body.fts ?? [])];
}

function langsOf(rows: readonly RecallRow[]): string[] {
  return [...new Set(rows.map((row) => row.doc_lang))].sort();
}

async function chunkCountOfLang(lang: string): Promise<number> {
  const { query } = await import("../src/db.ts");
  const rows = await query<{ n: string }>(
    "select count(*)::text as n from chunks where lang = $1::char(2)",
    [lang],
  );
  return Number(rows[0]?.n ?? 0);
}

test("不带令牌 / 错令牌 → 404，且与真正的 404 逐字不可区分", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const bare = await app.inject({ method: "GET", url: RECALL_URL, query: { q: "warranty", lang: "en" } });
  const wrong = await callRecall({ q: "warranty", lang: "en", token: "not-the-token" });
  const real404 = await app.inject({ method: "GET", url: "/definitely-not-a-route" });

  const shape = (raw: string): unknown => {
    const body = JSON.parse(raw) as { ok: boolean; error: { code: string; message: string } };
    return { ok: body.ok, code: body.error.code, message: body.error.message };
  };

  // 401 会告诉扫描器"端点存在、只缺凭据"，因此这里必须是 404（`src/api/internal.ts` 的说明）。
  assert.equal(bare.statusCode, 404, `不带令牌期望 404，实际 ${bare.statusCode}`);
  assert.equal(wrong.status, 404, `错令牌期望 404，实际 ${wrong.status}`);
  assert.deepEqual(shape(bare.body), shape(real404.body), "内部接口的 404 必须与普通 404 同形");
  assert.deepEqual(shape(JSON.stringify(wrong.body)), shape(real404.body));
});

test("非回环来源即使令牌正确也 404；回环的 IPv6 与 IPv4-mapped 形态放行", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const remote = await callRecall({ q: "warranty", lang: "en", remoteAddress: "10.1.2.3" });
  assert.equal(remote.status, 404, `非回环来源期望 404，实际 ${remote.status}`);

  const v6 = await callRecall({ q: "warranty", lang: "en", lane: "fts", remoteAddress: "::1" });
  assert.equal(v6.status, 200, `::1 是回环，期望 200，实际 ${v6.status}`);

  const mapped = await callRecall({
    q: "warranty",
    lang: "en",
    lane: "fts",
    remoteAddress: "::ffff:127.0.0.1",
  });
  assert.equal(mapped.status, 200, `::ffff:127.0.0.1 是回环，期望 200，实际 ${mapped.status}`);
});

test("两路可分别观察：lane=vec 只出向量路，lane=fts 只出全文路", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const vecOnly = await cachedRecall({ q: "warranty period", lang: "en", lane: "vec" });
  assert.ok(Array.isArray(vecOnly.vector), "lane=vec 时 vector 必须存在");
  assert.equal(vecOnly.fts, null, "lane=vec 时 fts 必须为 null（没跑就是没跑，不给空数组）");
  assert.ok(vecOnly.timings_ms.embed_ms > 0, "向量路必须真的调用过 embedding");

  const ftsOnly = await cachedRecall({ q: "warranty period", lang: "en", lane: "fts" });
  assert.ok(Array.isArray(ftsOnly.fts), "lane=fts 时 fts 必须存在");
  assert.equal(ftsOnly.vector, null, "lane=fts 时 vector 必须为 null");
  assert.equal(ftsOnly.timings_ms.embed_ms, 0, "全文路不许调用 embedding");

  const both = await cachedRecall({ q: "warranty period", lang: "en", lane: "both" });
  assert.ok(Array.isArray(both.vector) && Array.isArray(both.fts), "lane=both 时两路都要有");
});

test("英语查询 'warranty period'：两路结果只出现 en", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const body = await cachedRecall({ q: "warranty period", lang: "en", lane: "both" });
  assert.deepEqual(body.lang_scope, ["en"], "英语视野只有 en");

  const rows = allRows(body);
  if (rows.length === 0) {
    t.skip("en 语料还没入库，无法断言语言过滤（02-corpus-ingestion #02 未完成）");
    return;
  }
  assert.ok((body.vector ?? []).length > 0, "向量路应召回到 en 语料");
  assert.deepEqual(langsOf(rows), ["en"], `只允许 en，实际 ${langsOf(rows).join(",")}`);
  for (const row of rows) {
    assert.equal(row.doc_lang, "en");
    assert.equal(row.lang, "en", "片段语言也必须是 en");
  }
});

test("中文查询 '保修期多久'：结果不出现 de/nl/es", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const body = await cachedRecall({ q: "保修期多久", lang: "zh", lane: "both" });
  assert.deepEqual(body.lang_scope, ["zh", "en"], "中文视野是中 + 英");

  const rows = allRows(body);
  if (rows.length === 0) {
    t.skip("zh 语料还没入库，无法断言语言过滤");
    return;
  }
  const langs = langsOf(rows);
  for (const forbidden of ["de", "nl", "es"]) {
    assert.equal(langs.includes(forbidden), false, `中文查询不得召回 ${forbidden}，实际 ${langs.join(",")}`);
  }
  assert.ok(langs.includes("zh"), `中文查询应召回 zh 片段，实际 ${langs.join(",")}`);
});

test("德语查询不出现 zh，且 top1 语言为 de 或 en", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const body = await cachedRecall({ q: "Garantie Batterie", lang: "de", lane: "both" });
  assert.deepEqual(body.lang_scope, ["de", "en"], "德语视野是德 + 英");

  const rows = allRows(body);
  // 语料可能只有 en/zh：此时"结果为空或无 zh"照样成立，必须断言。
  assert.equal(langsOf(rows).includes("zh"), false, `德语查询串到中文：${langsOf(rows).join(",")}`);

  const deChunks = await chunkCountOfLang("de");
  if (deChunks === 0) {
    t.skip(
      "de 语料尚未入库（新环境没跑过 make ingest）：已断言结果不含 zh，跳过 top1 断言。" +
        " 语料到位后本用例会自动开始校验 top1 ∈ {de,en}",
    );
    return;
  }

  assert.ok(rows.length > 0, "de 语料已在库，德语查询不应召回为空");
  const top1 = (body.vector ?? [])[0];
  assert.ok(top1 !== undefined, "向量路应有结果");
  assert.ok(
    top1.doc_lang === "de" || top1.doc_lang === "en",
    `德语查询 top1 语言必须是 de 或 en，实际 ${top1.doc_lang}（${top1.doc_title}）`,
  );
});

test("无关查询 '今天天气怎么样'：每路不超过 20 条且不跨语种串味（不判阈值）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const body = await cachedRecall({ q: "今天天气怎么样", lang: "zh", lane: "both" });
  assert.ok((body.vector ?? []).length <= 20, `向量路最多 20 条，实际 ${body.vector?.length}`);
  assert.ok((body.fts ?? []).length <= 20, `全文路最多 20 条，实际 ${body.fts?.length}`);

  const langs = langsOf(allRows(body));
  for (const forbidden of ["de", "nl", "es"]) {
    assert.equal(langs.includes(forbidden), false, `语言过滤失效，召回出现 ${forbidden}：${langs.join(",")}`);
  }
  // 阈值判定（topScore < 0.30 → 拒答）归 03-hybrid-retrieval #02：本卡看完召回就停手，
  // 在这里断言"低分"会把 #02 的归一化口径提前钉死。
});

test("向量维度 ≠1024 时整体失败，不静默返回空", async () => {
  const { recallVectorByEmbedding } = await import("../src/core/retrieval.ts");
  const { EmbedError } = await import("../src/core/embed.ts");

  const tooShort = new Array<number>(768).fill(0.01);
  await assert.rejects(
    () => recallVectorByEmbedding(tooShort, "en"),
    (err: unknown) => {
      assert.ok(err instanceof EmbedError, `期望 EmbedError，实际 ${String(err)}`);
      assert.equal(err.code, "EMBED_DIM_MISMATCH");
      assert.match(err.message, /768/);
      return true;
    },
  );

  const NaNVector = new Array<number>(1024).fill(0.01);
  NaNVector[7] = Number.NaN;
  await assert.rejects(
    () => recallVectorByEmbedding(NaNVector, "en"),
    (err: unknown) => err instanceof EmbedError && err.code === "EMBED_DIM_MISMATCH",
  );
});

test("静态兜底：两条 SQL 都带 any($n::char(2)[])，语言数组不在 SQL 里写死", async () => {
  const source = await readFile(join(repoRoot, "src/core/retrieval.ts"), "utf8");
  // 注释里也提到这段写法（"cast 不可省"），统计前先把注释行剥掉，否则数出来的是散文不是代码。
  const codeOnly = source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !/^(?:\/\*\*?|\*|\/\/|\*\/)/.test(trimmed);
    })
    .join("\n");
  const casts = codeOnly.match(/any\(\$\d+::char\(2\)\[\]\)/g) ?? [];
  assert.equal(casts.length, 2, `SQL 代码里应恰好两处 any($n::char(2)[])，实际 ${casts.length} 处`);

  const { FTS_RECALL_SQL, LANG_SCOPE, VECTOR_RECALL_SQL } = await import("../src/core/retrieval.ts");
  for (const [name, sql] of [
    ["VECTOR_RECALL_SQL", VECTOR_RECALL_SQL],
    ["FTS_RECALL_SQL", FTS_RECALL_SQL],
  ] as const) {
    assert.equal(
      (sql.match(/any\(\$2::char\(2\)\[\]\)/g) ?? []).length,
      1,
      `${name} 必须恰好带一处 any($2::char(2)[])`,
    );
    // 语言数组只能来自 LANG_SCOPE：SQL 里出现 'de' / 'en' 这类字面量就是第二份真源。
    assert.equal(/'[a-z]{2}'/.test(sql), false, `${name} 里出现了硬编码语言字面量`);
    assert.equal(/array\s*\[/i.test(sql), false, `${name} 里出现了硬编码 array[...] 语言数组`);
  }

  // LANG_SCOPE 是唯一真源：这里把 07-retrieval.md §2 的表逐条钉住。
  assert.deepEqual(LANG_SCOPE, { zh: ["zh", "en"], en: ["en"], de: ["de", "en"], nl: ["nl", "en"], es: ["es", "en"] });
});

test("lang 不在视野表里 → 400（不把未知语言当'不过滤'）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const bad = await callRecall({ q: "warranty", lang: "fr" });
  assert.equal(bad.status, 400, `未知语言期望 400，实际 ${bad.status}`);

  const empty = await callRecall({ q: "   ", lang: "en" });
  assert.equal(empty.status, 400, `空白 query 期望 400，实际 ${empty.status}`);

  const badLane = await callRecall({ q: "warranty", lang: "en", lane: "both_lanes" });
  assert.equal(badLane.status, 400, `未知 lane 期望 400，实际 ${badLane.status}`);
});
