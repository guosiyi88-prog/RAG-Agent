/**
 * `POST /internal/search` 的黑盒验收（`03-hybrid-retrieval` #02 · 07 §5.1–§6、§8、§11、§12）。
 *
 * 为什么走 HTTP 而不是直接打 `fuseAndPostProcess`：纯函数的正确性已由
 * `tests/retrieval-postprocess.test.ts` 钉住（构造好的候选数组）。这里要证明的是**接线**——
 * 从 API 入参 → `retrieve()` → 融合/归一化/去重/截断 → 响应体这一段没有把方向接反、
 * 没有把归一化漏在某一步之前、也没有把降级吞成"没搜到"。归一化写反的线上症状是
 * "全部拒答"，看起来只是"这些问题没有语料"，日志里什么都看不出来，所以每条断言都同时
 * 印出观测值：这份文件就是人代替代码去读的证词。
 *
 * 成本说明：每个真实查询都要走一次 dashscope embedding（150–400ms 网络），
 * 因此相同请求只真打一次（`cachedData`）；用例之间不共享可写状态，执行顺序无关。
 */
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

const SEARCH_URL = "/internal/search";
const internalToken = String(process.env.INTERNAL_TOKEN ?? "").trim();

/**
 * 下面三个数字来自**规格**（07 §5.1、§6.1、§6.2），刻意不从 `src/core/retrieval.ts` import：
 * 用实现自己的阈值去证明实现的方向，等于自己证明自己（实现若把 0.30 改成 0.10，测试会跟着一起错）。
 * 测试文件启动时 `src/config.ts` 会因缺 env 直接 exit，所以这些常量必须是字面量（见文件末尾的
 * "规格数字与实现常量一致"用例，它负责在运行环境到位时把两边对齐）。
 */
const MIN_SCORE = 0.3;
const MAX_PER_DOC = 3;
const CONTENT_MAX_CHARS = 600;

/** 07 §9 / 05 §5.1 的长度上界。 */
const MAX_QUERY_CHARS = 2_000;
const MAX_TOP_K = 20;

/** 07 §12 的预算：合计 < 450ms，融合段 ≤ 5ms（这两条是本卡要守的）。 */
const TOTAL_BUDGET_MS = 450;
const FUSE_BUDGET_MS = 5;

/* ─────────────────────────── 响应体形状（05 §5.1） ─────────────────────────── */

type SearchChunk = {
  idx: number;
  chunk_id: number;
  doc_id: string;
  doc_title: string;
  doc_lang: string;
  page: number | null;
  section: string | null;
  content: string;
  score: number;
};

type SearchTimings = {
  embed_ms: number;
  vector_ms: number;
  fts_ms: number;
  fuse_ms: number;
  total_ms: number;
};

type SearchData = {
  lang: string;
  topScore: number;
  fallback: "none" | "fts_only" | "empty";
  chunks: SearchChunk[];
  timings_ms: SearchTimings;
};

type SearchBody = { ok: true; data: SearchData };

type ErrorBody = { ok: false; error: { code: string; message: string; trace_id?: string } };

type SearchPayload = {
  query?: string;
  lang?: string;
  top_k?: number;
  prev_user?: string;
};

/* ─────────────────────────── 夹具：五条锚点 + 四条补充 ─────────────────────────── */

/** 07 §8 / §11 的正例：语义上一定相关，必须过 0.30 阈值。 */
const POSITIVE_QUERIES: readonly SearchPayload[] = [
  { query: "Garantie Batterie", lang: "de" },
  { query: "保修期多久", lang: "zh" },
  { query: "Wechselrichter Wirkungsgrad", lang: "de" },
];

/** 07 §11 用例 5、6：语料里根本没有的内容，必须被阈值拦下（或用空结果拦下）。 */
const NEGATIVE_QUERIES: readonly SearchPayload[] = [
  { query: "今天天气怎么样", lang: "zh" },
  { query: "20% korting", lang: "nl" },
];

/** 07 §11 用例 1：精确故障码。本卡只断言语言与形状，不断言阈值（`E03` 的语料分布与语义查询不同）。 */
const FAULT_CODE_QUERY: SearchPayload = { query: "E03", lang: "de" };

/** 07 §11 用例 4 / §3：短追问借上一轮主语。 */
const STITCH_QUERY: SearchPayload = {
  query: "Und wie viel Watt?",
  lang: "de",
  prev_user: "Welcher Wechselrichter ist für eine 600W-Anlage geeignet?",
};

/** §3 的反向：长问句自带主语，**不**该拼接（拼接会稀释当前问题）。 */
const LONG_STANDALONE_QUERY: SearchPayload = {
  query: "Welcher Wechselrichter ist für eine 600W-Anlage mit Batteriespeicher und Notstromversorgung geeignet?",
  lang: "de",
};

const TOP_K_TWO_QUERY: SearchPayload = { query: "Garantie Batterie", lang: "de", top_k: 2 };

/**
 * 结构不变量要在**每一条成功响应**上成立，所以这里列全本文件真打过的成功请求（除降级用例，
 * 它自带全局 fetch 桩，单独跑）。这些条目大多命中 `cachedData`，不会重复付费。
 */
const EVIDENCE_QUERIES: readonly SearchPayload[] = [
  ...POSITIVE_QUERIES,
  ...NEGATIVE_QUERIES,
  FAULT_CODE_QUERY,
  STITCH_QUERY,
  LONG_STANDALONE_QUERY,
  TOP_K_TWO_QUERY,
];

function labelOf(payload: SearchPayload): string {
  return `${JSON.stringify(payload)}`;
}

let app: FastifyInstance;

before(async () => {
  if (!hasRuntimeEnv) return;
  const { buildApp } = await import("../src/server.ts");
  app = await buildApp();

  // 预热一条 embedding 连接（请求体刻意选一条不在断言集里的查询，且不走 cachedData）。
  // 为什么：undici 的 keep-alive 让**进程内第一次** embedding 多背一次 DNS+TLS 握手 ——
  // 实测首个请求 embed_ms 211/262/392/402ms，之后稳定在 113–172ms。
  // 07 §12 自己也注明"首轮含冷启动可到 600ms"，所以 §12 的 450ms 是**稳定态**预算；
  // 不预热会让 total<450 在慢网络上随机变红，把真正的回归埋进噪声里。
  // 这里不校验结果：预热失败不影响任何断言（真断链时阈值与降级用例会红）。
  await app
    .inject({
      method: "POST",
      url: SEARCH_URL,
      payload: { query: "Netzanschluss Spannung", lang: "de" },
      headers: { "x-internal-token": internalToken },
    })
    .catch(() => undefined);
});

after(async () => {
  if (app !== undefined) await app.close();
  if (!hasRuntimeEnv) return;
  const { pool } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");
  await redis.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

/* ─────────────────────────── 调用与缓存 ─────────────────────────── */

type InjectOptions = {
  /** `null` = 不带该请求头；省略 = 带正确令牌。 */
  token?: string | null;
  /** light-my-request 的假 socket 地址；省略即 127.0.0.1。 */
  remoteAddress?: string;
};

/** 一次真实注入。不做断言：反例用例（404 / 400）也走这里。 */
async function rawSearch(
  payload: unknown,
  options: InjectOptions = {},
): Promise<{ status: number; body: SearchBody | ErrorBody }> {
  const headers: Record<string, string> = {};
  if (options.token !== null) headers["x-internal-token"] = options.token ?? internalToken;

  const response = await app.inject({
    method: "POST",
    url: SEARCH_URL,
    payload: payload as Record<string, unknown>,
    headers,
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
  });
  return { status: response.statusCode, body: response.json() as SearchBody | ErrorBody };
}

/**
 * 同一请求只真打一次。key 只用 payload：缓存只服务"正确令牌 + 回环来源"的正常路径，
 * 反例（错令牌、非回环）显式走 `rawSearch`，不会把 404 的响应体缓存成"成功结果"。
 */
const dataCache = new Map<string, Promise<SearchData>>();

function cachedData(payload: SearchPayload): Promise<SearchData> {
  const key = JSON.stringify(payload);
  let pending = dataCache.get(key);
  if (pending === undefined) {
    pending = rawSearch(payload).then(({ status, body }) => {
      assert.equal(status, 200, `${labelOf(payload)} 期望 200，实际 ${status}：${JSON.stringify(body)}`);
      const ok = body as SearchBody;
      assert.equal(ok.ok, true, `${labelOf(payload)} 的响应体缺少 ok:true`);
      return ok.data;
    });
    dataCache.set(key, pending);
  }
  return pending;
}

/* ─────────────────────────── 结构不变量 ─────────────────────────── */

/**
 * 07 §6 的后处理不变量（第 4 条要求）：这几条是"引用能对上号"的前提，
 * 任何一条破了都会让前端角标指向错片段或指向不存在的片段。
 */
function assertPostProcessInvariants(data: SearchData, label: string): void {
  const count = data.chunks.length;

  // idx = 1..n 连续：正文里的 [n] 直接用这个数字，断号等于坏引用。
  assert.deepEqual(
    data.chunks.map((chunk) => chunk.idx),
    Array.from({ length: count }, (_unused, index) => index + 1),
    `${label}：idx 必须是 1..${count} 连续无空洞，实际 [${data.chunks.map((chunk) => chunk.idx).join(",")}]`,
  );

  for (let index = 1; index < count; index += 1) {
    const previous = data.chunks[index - 1] as SearchChunk;
    const current = data.chunks[index] as SearchChunk;
    // 降序（允许相等）：并列由 chunk_id 决定，所以只会相等不会回升；回升说明排序或融合写错了。
    assert.ok(
      previous.score >= current.score,
      `${label}：第 ${previous.idx} 条分 ${previous.score} 小于第 ${current.idx} 条 ${current.score}（必须按分数降序）`,
    );
    assert.ok(
      current.score >= 0 && current.score <= 1,
      `${label}：第 ${current.idx} 条归一化分必须在 0..1，实际 ${current.score}`,
    );
  }

  for (const chunk of data.chunks) {
    // 只有下发时截断（07 §6.2）：超长正文会撑爆 prompt 预算，也说明截断漏在了排序之后以外的地方。
    assert.ok(
      chunk.content.length <= CONTENT_MAX_CHARS,
      `${label}：chunk_id=${chunk.chunk_id} 的正文 ${chunk.content.length} 字，超过 ${CONTENT_MAX_CHARS} 字上限`,
    );
    assert.equal(
      typeof chunk.doc_title,
      "string",
      `${label}：chunk_id=${chunk.chunk_id} 缺少 doc_title（引用要显示文档名）`,
    );
  }

  if (count === 0) {
    // 空结果必须是 topScore=0 + chunks=[]（配对出现），否则上层拿"有分没片段"去做阈值判断会走岔。
    assert.equal(data.topScore, 0, `${label}：chunks 为空时 topScore 必须为 0，实际 ${data.topScore}`);
  } else {
    const top = data.chunks[0] as SearchChunk;
    assert.equal(
      data.topScore,
      top.score,
      `${label}：topScore 必须等于 chunks[0].score（${top.score}），实际 ${data.topScore}`,
    );
  }
}

/**
 * 第 3 条要求：单文档独占。两个失效模式——
 *   ① 同一份手册的连续小节挤满 top5 → 每文档 ≤3；
 *   ② 五语副本同时上榜 → 表现为"片段很多，独立信息只有 1 条"，所以
 *      ≥3 条片段时必须来自不止一份文档（单文档最多 3 条，4 条以上必然多文档，只有 3 条时要显式查）。
 */
function assertPerDocLimit(data: SearchData, label: string): void {
  const perDoc = new Map<string, SearchChunk[]>();
  for (const chunk of data.chunks) {
    const list = perDoc.get(chunk.doc_title) ?? [];
    list.push(chunk);
    perDoc.set(chunk.doc_title, list);
  }

  for (const [title, list] of perDoc) {
    assert.ok(
      list.length <= MAX_PER_DOC,
      `${label}：文档《${title}》贡献了 ${list.length} 条（chunk_id=${list
        .map((chunk) => chunk.chunk_id)
        .join(",")}），超过每文档 ${MAX_PER_DOC} 条上限`,
    );
  }

  if (data.chunks.length >= 3) {
    assert.ok(
      perDoc.size > 1,
      `${label}：${data.chunks.length} 条片段全部来自同一份文档《${[...perDoc.keys()].join("》《")}》，` +
        `独立文档数必须 > 1（单文档不允许独占整个答案）`,
    );
  }
}

/* ─────────────────────────── 用例 ─────────────────────────── */

test("规格数字与实现常量一致：每文档 ≤3 条、正文截断 600 字", async (t) => {
  if (!hasRuntimeEnv) {
    // import 链会读 env（src/config.ts 缺 env 直接 exit），所以这条也在没有运行环境时跳过。
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { CONTENT_MAX_CHARS: implContentMax, MAX_PER_DOC: implPerDoc } = await import(
    "../src/core/retrieval.ts"
  );
  // 本文件的其余断言用的是字面量（避免"用实现证明实现"），这条负责把两边钉在一起：
  // 实现若改了数字，这条先红，人就知道后面那些 600/3 的断言需要跟着规格一起改。
  assert.equal(implPerDoc, MAX_PER_DOC, `实现每文档上限 ${implPerDoc}，规格是 ${MAX_PER_DOC}`);
  assert.equal(
    implContentMax,
    CONTENT_MAX_CHARS,
    `实现截断长度 ${implContentMax}，规格是 ${CONTENT_MAX_CHARS}`,
  );
});

test("阈值方向：三条正例 topScore > 0.30 且 fallback=none；两条反例为空或 < 0.30", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  const rows: string[] = [];
  for (const payload of POSITIVE_QUERIES) {
    const data = await cachedData(payload);
    rows.push(`${labelOf(payload)} → topScore=${data.topScore.toFixed(4)} fallback=${data.fallback}`);
    // 正例必须"能答"：有片段、不是降级、过阈值。三者缺一，上层都会走拒答，
    // 而线上表现只是"客户问保修，机器人说没有这条信息"，看不出是归一化写反了。
    assert.ok(
      data.chunks.length > 0,
      `${labelOf(payload)}：正例必须召回片段，实际空结果（fallback=${data.fallback}）`,
    );
    assert.ok(
      data.topScore > MIN_SCORE,
      `${labelOf(payload)}：正例 topScore 必须 > ${MIN_SCORE}，实际 ${data.topScore}（归一化/阈值方向可能写反）`,
    );
    assert.equal(
      data.fallback,
      "none",
      `${labelOf(payload)}：正例不该降级，实际 fallback=${data.fallback}`,
    );
  }

  for (const payload of NEGATIVE_QUERIES) {
    const data = await cachedData(payload);
    rows.push(`${labelOf(payload)} → topScore=${data.topScore.toFixed(4)} fallback=${data.fallback}`);
    // 反例允许两种拒答路径（07 §8）：返回空（no_citation）或低分（low_conf）。只要求"接不住"。
    assert.ok(
      data.chunks.length === 0 || data.topScore < MIN_SCORE,
      `${labelOf(payload)}：反例必须返回空或 topScore < ${MIN_SCORE}，实际 ${data.chunks.length} 条 / ${data.topScore}`,
    );
  }

  // 一行一条：TAP 会把诊断里的换行转义成 "\n"，多行拼成一个字符串反而看不清（这张表要给人读）。
  t.diagnostic("阈值方向实测：");
  for (const row of rows) t.diagnostic(`  ${row}`);
});

test("方向性证明：任一正例的最高分都高于任一反例（不依赖 0.30 这条线）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  const positives: { label: string; topScore: number }[] = [];
  for (const payload of POSITIVE_QUERIES) {
    const data = await cachedData(payload);
    positives.push({ label: labelOf(payload), topScore: data.topScore });
  }
  const negatives: { label: string; topScore: number }[] = [];
  for (const payload of NEGATIVE_QUERIES) {
    const data = await cachedData(payload);
    negatives.push({ label: labelOf(payload), topScore: data.topScore });
  }

  // 为什么这条比"正例 > 0.30"更重要：0.30 是**人挑的**常数，只要调低它，反例也会"过线"。
  // 两组的**相对次序**才是归一化方向没写反的硬证据——它不随阈值取值变化。
  const lowestPositive = positives.reduce((min, item) => (item.topScore < min.topScore ? item : min));
  const highestNegative = negatives.reduce((max, item) => (item.topScore > max.topScore ? item : max));

  assert.ok(
    lowestPositive.topScore > highestNegative.topScore,
    `方向反了：最低的正例 ${lowestPositive.label} topScore=${lowestPositive.topScore} 不高于最高的反例 ` +
      `${highestNegative.label} topScore=${highestNegative.topScore}（正例应全部高于反例）`,
  );

  // 余量也要看一眼：差距太小意味着阈值稍动就翻车，属于"刚好过"而不是"方向正确"。
  t.diagnostic(
    `方向性：最低正例 ${lowestPositive.topScore.toFixed(4)}（${lowestPositive.label}）` +
      ` > 最高反例 ${highestNegative.topScore.toFixed(4)}（${highestNegative.label}）` +
      `，余量 ${(lowestPositive.topScore - highestNegative.topScore).toFixed(4)}`,
  );
});

test("语言隔离：德语不串中文、中文不串 de/nl/es、E03 的 top1 落在 de|en", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  // 段一：德语视野是 de + en（07 §2）。出现 zh/nl/es 说明 SQL 的语言过滤漏了或视野表被改错。
  const de = await cachedData(POSITIVE_QUERIES[0] as SearchPayload);
  assert.equal(de.lang, "de", `响应体的 lang 必须回显请求语言，实际 ${de.lang}`);
  const deLangs = [...new Set(de.chunks.map((chunk) => chunk.doc_lang))].sort();
  // 先保证集合非空，否则下面那个"每个 doc_lang 都合法"的循环在空结果上永远成立（假绿）。
  assert.ok(deLangs.length > 0, `「Garantie Batterie」/de 召回为空，无法判断语言隔离（fallback=${de.fallback}）`);
  for (const docLang of deLangs) {
    assert.ok(
      docLang === "de" || docLang === "en",
      `德语查询「Garantie Batterie」召回了 ${docLang} 片段（doc_lang 集合 ${deLangs.join(",")}），只允许 de/en`,
    );
  }

  // 段二：中文视野是 zh + en（07 §2）。de/nl/es 出现 = 五语副本没被过滤，top5 会被稀释成 1 条独立信息。
  const zh = await cachedData(POSITIVE_QUERIES[1] as SearchPayload);
  const zhLangs = [...new Set(zh.chunks.map((chunk) => chunk.doc_lang))].sort();
  assert.ok(zhLangs.length > 0, `「保修期多久」/zh 召回为空，无法判断语言隔离（fallback=${zh.fallback}）`);
  for (const forbidden of ["de", "nl", "es"]) {
    assert.equal(
      zhLangs.includes(forbidden),
      false,
      `中文查询「保修期多久」召回了 ${forbidden} 片段（doc_lang 集合 ${zhLangs.join(",")}），只允许 zh/en`,
    );
  }

  // 段三：精确故障码走的也是同一条语言过滤（两路 SQL 都必须带语言数组，07 §4）。
  const fault = await cachedData(FAULT_CODE_QUERY);
  const top1 = fault.chunks[0];
  assert.ok(top1 !== undefined, `「E03」/de 应有召回，实际空结果（fallback=${fault.fallback}）`);
  assert.ok(
    top1.doc_lang === "de" || top1.doc_lang === "en",
    `「E03」/de 的 top1 语言必须是 de 或 en，实际 ${top1.doc_lang}（《${top1.doc_title}》）`,
  );

  t.diagnostic(
    `语言集合：Garantie Batterie/de → [${deLangs.join(",")}]；保修期多久/zh → [${zhLangs.join(",")}]；` +
      `E03/de top1 → ${top1.doc_lang}`,
  );
});

test("后处理不变量：idx 连续、分数非递增、正文 ≤600 字、topScore = chunks[0].score", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  let checked = 0;
  for (const payload of EVIDENCE_QUERIES) {
    const data = await cachedData(payload);
    assertPostProcessInvariants(data, labelOf(payload));
    checked += 1;
  }
  // 自检：遍历本身要是空的，这条用例就成了"永远通过"。
  assert.ok(checked === EVIDENCE_QUERIES.length, `应检查 ${EVIDENCE_QUERIES.length} 条响应，实际 ${checked}`);
  t.diagnostic(`后处理不变量已在 ${checked} 条成功响应上成立（07 §6）`);
});

test("五语副本不独占：每文档 ≤3 条，且片段 ≥3 条时不止一份文档", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  const summary: string[] = [];
  for (const payload of EVIDENCE_QUERIES) {
    const data = await cachedData(payload);
    assertPerDocLimit(data, labelOf(payload));
    const perDoc = new Map<string, number>();
    for (const chunk of data.chunks) perDoc.set(chunk.doc_title, (perDoc.get(chunk.doc_title) ?? 0) + 1);
    summary.push(
      `${labelOf(payload)} → ${data.chunks.length} 条 / ${perDoc.size} 份文档` +
        `（${[...perDoc.entries()].map(([title, count]) => `${title}×${count}`).join(", ")}）`,
    );
  }
  t.diagnostic("单文档占比：");
  for (const row of summary) t.diagnostic(`  ${row}`);
});

test("top_k 生效：top_k=2 最多 2 条；越界（0 / 21）→ 400 VALIDATION", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  const two = await cachedData(TOP_K_TWO_QUERY);
  // 静默夹取（收到 50 只给 5）比报错更难查，所以上界由接口显式拒绝；这里先证明下界方向也没被写死。
  assert.ok(two.chunks.length <= 2, `top_k=2 应最多返回 2 条，实际 ${two.chunks.length} 条`);
  assert.ok(two.chunks.length > 0, "top_k=2 时仍有候选，不该返回空");
  assert.deepEqual(
    two.chunks.map((chunk) => chunk.idx),
    Array.from({ length: two.chunks.length }, (_unused, index) => index + 1),
    "top_k 截断后 idx 仍要从 1 连续编号",
  );

  for (const topK of [0, MAX_TOP_K + 1]) {
    const response = await rawSearch({ query: "Garantie Batterie", lang: "de", top_k: topK });
    assert.equal(
      response.status,
      400,
      `top_k=${topK} 期望 400，实际 ${response.status}：${JSON.stringify(response.body)}`,
    );
    const error = (response.body as ErrorBody).error;
    assert.equal(error.code, "VALIDATION", `top_k=${topK} 的错误码必须是 VALIDATION，实际 ${error.code}`);
  }

  t.diagnostic(`top_k=2 → ${two.chunks.length} 条（chunk_id=${two.chunks.map((chunk) => chunk.chunk_id).join(",")}）`);
});

test("门禁与校验：缺/错令牌与非回环来源都是不可区分的 404；坏 lang / 空 query 是 400", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  // 真正的 404（路由不存在）作为基准：内部接口的 404 必须与它**逐字同形**，
  // 否则 404 本身就泄露了"这个端点存在"。401 同理不可用（等于告诉扫描器只缺凭据）。
  const real404 = await app.inject({ method: "POST", url: "/definitely-not-a-route" });
  const real404Body = real404.json() as ErrorBody;
  assert.equal(real404.statusCode, 404);
  const generic = { ok: real404Body.ok, code: real404Body.error.code, message: real404Body.error.message };

  const gates: { name: string; promise: ReturnType<typeof rawSearch>; }[] = [
    {
      name: "不带令牌",
      promise: rawSearch({ query: "Garantie Batterie", lang: "de" }, { token: null }),
    },
    {
      name: "错令牌",
      promise: rawSearch({ query: "Garantie Batterie", lang: "de" }, { token: "not-the-token" }),
    },
    {
      name: "非回环来源（令牌正确）",
      promise: rawSearch({ query: "Garantie Batterie", lang: "de" }, { remoteAddress: "10.1.2.3" }),
    },
  ];

  for (const gate of gates) {
    const response = await gate.promise;
    assert.equal(response.status, 404, `${gate.name} 期望 404，实际 ${response.status}`);
    const body = response.body as ErrorBody;
    assert.deepEqual(
      { ok: body.ok, code: body.error.code, message: body.error.message },
      generic,
      `${gate.name} 的 404 响应体必须与普通 404 逐字相同，实际 ${JSON.stringify(body)}`,
    );
    // 门禁失败时绝不能已经打过 embedding（那等于给未授权方留了一条计费通道）。
    assert.equal("data" in body, false, `${gate.name} 不该返回 data 字段`);
  }

  // 未知语言必须 400，不能默认成 en：把英文片段返给德语用户，响应体里看不出来（07 §2）。
  const badLang = await rawSearch({ query: "Garantie Batterie", lang: "fr" });
  assert.equal(badLang.status, 400, `lang=fr 期望 400，实际 ${badLang.status}`);
  assert.equal((badLang.body as ErrorBody).error.code, "VALIDATION", "lang=fr 的错误码必须是 VALIDATION");

  const emptyQuery = await rawSearch({ query: "   ", lang: "de" });
  assert.equal(emptyQuery.status, 400, `空白 query 期望 400，实际 ${emptyQuery.status}`);
  assert.equal(
    (emptyQuery.body as ErrorBody).error.code,
    "VALIDATION",
    "空白 query 的错误码必须是 VALIDATION",
  );

  // 07 §9：query 超 2000 字符明确报错（不静默截断——静默改查询会让"为什么没命中"无从查起）。
  const tooLong = await rawSearch({ query: "x".repeat(MAX_QUERY_CHARS + 1), lang: "de" });
  assert.equal(tooLong.status, 400, `超过 ${MAX_QUERY_CHARS} 字符期望 400，实际 ${tooLong.status}`);

  t.diagnostic(`门禁：${gates.map((gate) => gate.name).join(" / ")} 均为 404 且与普通 404 同形；lang=fr、空白 query 为 400`);
});

test("prev_user 拼接：短追问借上一轮主语后能答；长问句不拼也能答", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  // 07 §3：`Und wie viel Watt?` 只有 17 字符且主语在上一轮，不拼就检索不到"型号参数"。
  const stitched = await cachedData(STITCH_QUERY);
  assert.ok(
    stitched.chunks.length > 0,
    `拼接上一轮后必须有召回（fallback=${stitched.fallback}, topScore=${stitched.topScore}）`,
  );
  assert.notEqual(
    stitched.fallback,
    "empty",
    "拼接后仍标 empty：说明 buildQuery 没生效或两路都空",
  );

  // 反向：自带主语的完整问句不拼，照样能答。这条防的是"每轮都拼历史"——
  // query 会一轮一轮漂移成"整段对话的平均话题"，而且这条用例会先红。
  const standalone = await cachedData(LONG_STANDALONE_QUERY);
  assert.ok(
    standalone.chunks.length > 0,
    `长问句单跑必须有召回（fallback=${standalone.fallback}, topScore=${standalone.topScore}）`,
  );

  // 刻意不断言具体片段文本：语料一旦扩充（warranty/spec 改版），文本断言会假红，
  // 而这里要证明的是"路径通了、不是空手而归"。
  t.diagnostic(
    `prev_user：拼接 topScore=${stitched.topScore.toFixed(4)}、${stitched.chunks.length} 条；` +
      `长问句 topScore=${standalone.topScore.toFixed(4)}、${standalone.chunks.length} 条`,
  );
});

test("性能预算：三正例 total_ms < 450、fuse_ms ≤ 5（07 §12）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  const table: string[] = [
    "query".padEnd(34) + "embed_ms  vector_ms  fts_ms  fuse_ms  total_ms",
  ];

  for (const payload of POSITIVE_QUERIES) {
    const data = await cachedData(payload);
    const timings = data.timings_ms;
    table.push(
      labelOf(payload).padEnd(34) +
        [timings.embed_ms, timings.vector_ms, timings.fts_ms, timings.fuse_ms, timings.total_ms]
          .map((value) => String(value).padStart(8))
          .join("  "),
    );

    // 合计预算是墙钟：嵌入与全文路并行，所以 total 不等于三段相加。
    assert.ok(
      timings.total_ms < TOTAL_BUDGET_MS,
      `${labelOf(payload)}：total_ms=${timings.total_ms} 超预算 ${TOTAL_BUDGET_MS}ms` +
        `（embed=${timings.embed_ms} vector=${timings.vector_ms} fts=${timings.fts_ms}）`,
    );
    // 融合与后处理是纯 CPU（40 条候选的去重+排序），超过 5ms 说明混进了 IO 或死循环。
    assert.ok(
      timings.fuse_ms <= FUSE_BUDGET_MS,
      `${labelOf(payload)}：fuse_ms=${timings.fuse_ms} 超预算 ${FUSE_BUDGET_MS}ms（融合段不该有 IO）`,
    );
  }

  t.diagnostic("性能（单次实测，非 P95；四段预算 embed≤250 / vector≤120 / fts≤60 / fuse≤5，合计 <450）：");
  for (const row of table) t.diagnostic(`  ${row}`);

  // 段级预算（嵌入 ≤250 / 向量 ≤120 / 全文 ≤60）只做提示不断言：实测冷调用的 embed_ms
  // 在 211–402ms 之间抖（网络 + 首次 TLS 握手），07 §12 本身也允许"首轮含冷启动到 600ms"。
  // 把它写成断言只会让这条用例随机变红、掩盖真正的回归；所以数字照打，判定只留合计与融合段。
  const over: string[] = [];
  for (const payload of POSITIVE_QUERIES) {
    const timings = (await cachedData(payload)).timings_ms;
    if (timings.embed_ms > 250) over.push(`${labelOf(payload)} embed_ms=${timings.embed_ms} > 250`);
    if (timings.vector_ms > 120) over.push(`${labelOf(payload)} vector_ms=${timings.vector_ms} > 120`);
    if (timings.fts_ms > 60) over.push(`${labelOf(payload)} fts_ms=${timings.fts_ms} > 60`);
  }
  if (over.length > 0) t.diagnostic(`段级预算超出（仅提示，不判失败）：${over.join("；")}`);
});

/**
 * 降级必须**看得见**（07 §9）：嵌入失败时响应体要标 `fallback="fts_only"`，
 * 而不是悄悄返回一个低分结果让上层以为"语料没有覆盖"。
 *
 * 放在最后跑：这条会替换全局 fetch，虽然 finally 里恢复，但排最后可以避免任何
 * "上一条用例的桩还没恢复"的时序巧合。重试预算 500ms + 1500ms，所以给 60s 超时。
 */
test("降级可见：嵌入网络失败 → 200 + fallback=fts_only（不静默）", { timeout: 60_000 }, async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  const { embedBackend } = await import("../src/core/embed.ts");
  if (embedBackend() !== "dashscope") {
    // hash 后端不碰网络，桩不出失败——这里没有可降级的东西，跳过而不是造一个假场景。
    t.skip("EMBED_BACKEND=hash（或没有 DASHSCOPE_API_KEY）：嵌入不走网络，无法用 fetch 桩制造降级");
    return;
  }

  const payload: SearchPayload = { query: "Garantie Batterie", lang: "de" };
  const originalFetch = globalThis.fetch;
  let status: number;
  let body: SearchBody | ErrorBody;
  try {
    // 与 Node 自带 fetch 在 DNS/连接失败时的形状一致（TypeError），所以走的是 EmbedError("EMBED_UNAVAILABLE")。
    globalThis.fetch = (() => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    // 刻意不走 cachedData：同一个 payload 已被其它用例缓存为"正常结果"，
    // 复用缓存就测不到降级路径了。
    ({ status, body } = await rawSearch(payload));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    status,
    200,
    `嵌入失败不该变成 5xx（上层要据此拒答，而不是把错误抛给客户），实际 ${status}：${JSON.stringify(body)}`,
  );
  const data = (body as SearchBody).data;
  assert.ok(data !== undefined, `响应体缺少 data：${JSON.stringify(body)}`);
  assert.equal(
    data.fallback,
    "fts_only",
    `嵌入失败必须标 fallback=fts_only，实际 ${data.fallback}（topScore=${data.topScore}）——` +
      "降级被吞掉时线上只会表现为'召回率莫名偏低'",
  );
  // 只断言标签与形状，不断言 chunk 数量：`Garantie Batterie` 在全文路有没有逐字命中
  // 取决于语料用词，那是召回质量的事，不是本卡（降级可见性）的事。
  assertPostProcessInvariants(data, `${labelOf(payload)}（降级路径）`);

  t.diagnostic(
    `降级实测：fallback=${data.fallback} chunks=${data.chunks.length} topScore=${data.topScore.toFixed(4)}` +
      ` embed_ms=${data.timings_ms.embed_ms}（含两次退避重试 500+1500ms）`,
  );
});
