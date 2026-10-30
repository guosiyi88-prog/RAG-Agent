import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { RecalledChunk, RetrievalFallback } from "../src/core/retrieval.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与其它测试同一套 .env 解析：`node --test` 不带 --env-file，而 config.ts 在 import 阶段就读 env。 */
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

// 必须**动态** import：静态 import 会被提升到上面的补 env 之前，config.ts 会直接 exit(1)。
const { CONTENT_MAX_CHARS, MAX_PER_DOC, fallbackOf, fuseAndPostProcess, isDbUnavailable, retrieve } =
  await import("../src/core/retrieval.ts");
const { EmbedError } = await import("../src/core/embed.ts");

/** 造一条候选。默认值只为可读，断言只依赖显式传入的字段。 */
function chunk(overrides: Partial<RecalledChunk> & { chunk_id: number }): RecalledChunk {
  return {
    doc_id: "doc-default",
    doc_title: "Installationshandbuch 600W",
    doc_lang: "de",
    lang: "de",
    page: 12,
    section: "4.2 Netzanschluss",
    content: "Die Netzspannung muss zwischen 195 und 253 V liegen.",
    score: 0.5,
    ...overrides,
  };
}

test("常量与 07 §6 一致：每文档 ≤3 条、正文截断 600 字", () => {
  assert.equal(MAX_PER_DOC, 3);
  assert.equal(CONTENT_MAX_CHARS, 600);
});

test("按 doc 去重：6 条候选来自 2 份文档，没有任何文档贡献超过 3 条，且留下的是该文档最高分的 3 条", () => {
  // 向量路（唯一一路）的数组顺序就是本路位次：doc-a 占前四名，doc-b 占后两名。
  const vector = [
    chunk({ chunk_id: 101, doc_id: "doc-a" }),
    chunk({ chunk_id: 102, doc_id: "doc-a" }),
    chunk({ chunk_id: 103, doc_id: "doc-a" }),
    chunk({ chunk_id: 104, doc_id: "doc-a" }),
    chunk({ chunk_id: 201, doc_id: "doc-b" }),
    chunk({ chunk_id: 202, doc_id: "doc-b" }),
  ];

  const { chunks } = fuseAndPostProcess({ vector, fts: [], topK: 10 });

  const perDoc = new Map<string, number>();
  for (const item of chunks) perDoc.set(item.doc_id, (perDoc.get(item.doc_id) ?? 0) + 1);
  for (const [docId, count] of perDoc) {
    assert.ok(count <= MAX_PER_DOC, `${docId} 贡献了 ${count} 条，超过每文档 ${MAX_PER_DOC} 条上限`);
  }

  assert.deepEqual(
    chunks.map((item) => item.chunk_id),
    [101, 102, 103, 201, 202],
    "doc-a 应留下位次最靠前（分数最高）的 101/102/103，104 被每文档上限挤掉",
  );
  assert.equal(perDoc.get("doc-a"), MAX_PER_DOC);
  assert.equal(perDoc.get("doc-b"), 2, "不足上限的文档按现有数量返回，不补空");
});

test("topK 生效；候选少于 topK 时按现有数量返回，idx 连续无空洞", () => {
  const five = [
    chunk({ chunk_id: 1, doc_id: "d1" }),
    chunk({ chunk_id: 2, doc_id: "d2" }),
    chunk({ chunk_id: 3, doc_id: "d3" }),
    chunk({ chunk_id: 4, doc_id: "d4" }),
    chunk({ chunk_id: 5, doc_id: "d5" }),
  ];

  const cut = fuseAndPostProcess({ vector: five, fts: [], topK: 2 });
  assert.equal(cut.chunks.length, 2, "topK=2 时只返回 2 条");
  assert.deepEqual(cut.chunks.map((item) => item.idx), [1, 2]);
  assert.equal(cut.topScore, cut.chunks[0]?.score, "topScore 必须等于第 1 条的分数");

  const shorter = fuseAndPostProcess({ vector: five.slice(0, 2), fts: [], topK: 5 });
  assert.equal(shorter.chunks.length, 2, "只有 2 条候选时不补齐到 topK");
  assert.deepEqual(shorter.chunks.map((item) => item.idx), [1, 2], "idx 从 1 连续编号，没有空洞");
  assert.deepEqual(shorter.chunks.map((item) => item.chunk_id), [1, 2]);
});

test("idx 与分数方向：分数严格降序，idx 从 1 连续升序，归一化分落在 0..1", () => {
  const vector = [
    chunk({ chunk_id: 11, doc_id: "d1" }),
    chunk({ chunk_id: 12, doc_id: "d2" }),
    chunk({ chunk_id: 13, doc_id: "d3" }),
    chunk({ chunk_id: 14, doc_id: "d4" }),
    chunk({ chunk_id: 15, doc_id: "d5" }),
  ];

  const { chunks, topScore } = fuseAndPostProcess({ vector, fts: [], topK: 5 });

  assert.deepEqual(chunks.map((item) => item.idx), [1, 2, 3, 4, 5]);
  for (let i = 1; i < chunks.length; i += 1) {
    const previous = chunks[i - 1];
    const current = chunks[i];
    assert.ok(previous !== undefined && current !== undefined);
    assert.ok(
      previous.score > current.score,
      `第 ${previous.idx} 条分数 ${previous.score} 必须大于第 ${current.idx} 条 ${current.score}`,
    );
    assert.ok(current.score >= 0 && current.score <= 1, `归一化分必须落在 0..1，实际 ${current.score}`);
  }
  assert.equal(topScore, chunks[0]?.score);
});

test("正文截断：1500 字的片段回来正好 600 字，短片段原样返回", () => {
  const long = "x".repeat(1_500);
  const short = "E03 表示电网电压超出范围。";
  const { chunks } = fuseAndPostProcess({
    vector: [
      chunk({ chunk_id: 21, doc_id: "d-long", content: long }),
      chunk({ chunk_id: 22, doc_id: "d-short", content: short }),
    ],
    fts: [],
    topK: 5,
  });

  const byId = new Map(chunks.map((item) => [item.chunk_id, item]));
  assert.equal(byId.get(21)?.content.length, CONTENT_MAX_CHARS, "1500 字必须截到正好 600 字");
  assert.equal(byId.get(21)?.content, long.slice(0, CONTENT_MAX_CHARS));
  assert.equal(byId.get(22)?.content, short, "短片段不能被截断，也不能被补长");
});

test("最终分 = 归一化 RRF × 余弦²（07 §5.2）：同排名下相似度决定分数高低", () => {
  // chunk 1 两路都是 rank0（归一化正好 1），余弦 0.8 → 最终分 1 × 0.64；
  // chunk 2 只被向量路命中（归一化 0.8），余弦同为 0.8 → 0.512；
  // chunk 3 只被全文路命中：没有余弦，按 1 处理 → 0.2。
  const vector = [
    chunk({ chunk_id: 1, doc_id: "d1", score: 0.8 }),
    chunk({ chunk_id: 2, doc_id: "d2", score: 0.8 }),
  ];
  const fts = [
    chunk({ chunk_id: 1, doc_id: "d1" }),
    chunk({ chunk_id: 3, doc_id: "d3" }),
  ];

  const { chunks, topScore } = fuseAndPostProcess({ vector, fts, topK: 5 });
  const byId = new Map(chunks.map((item) => [item.chunk_id, item]));
  const close = (actual: number | undefined, expected: number, label: string): void => {
    assert.ok(
      actual !== undefined && Math.abs(actual - expected) < 1e-9,
      `${label}：期望 ${expected}，实际 ${String(actual)}`,
    );
  };

  assert.equal(chunks[0]?.chunk_id, 1, "两路都排第一且余弦更高 → 必须是第 1 条");
  close(byId.get(1)?.score, 1 * 0.8 * 0.8, "两路 rank0");
  // 向量路里 chunk 2 是 rank1（chunk 1 占了第一位），原始分 0.8/62；分母是 (0.8+0.2)/61
  close(byId.get(2)?.score, (0.8 / 62) / (1 / 61) * 0.8 * 0.8, "只被向量路命中（rank1）");
  // 全文路里 chunk 3 也是 rank1（chunk 1 占了第一位），原始分 0.2/62；余弦缺失 → 不再乘相似度
  close(byId.get(3)?.score, (0.2 / 62) / (1 / 61), "只被全文路命中（rank1，余弦缺失按 1）");
  close(topScore, chunks[0]?.score, "topScore 就是第 1 条的分数");
});

test("余弦是阈值能不能用的关键：同排名、不同余弦的分数必须分开（07 §5.1 的勘误）", () => {
  // 两条都只在向量路 rank0/rank1，排名证据相同或相近，区别只在余弦：
  // 相关（0.74）与无关（0.42）在平方后必须明显分成两档，否则 0.30 阈值形同虚设。
  const related = fuseAndPostProcess({
    vector: [chunk({ chunk_id: 10, doc_id: "d-related", score: 0.74 })],
    fts: [],
    topK: 5,
  });
  const unrelated = fuseAndPostProcess({
    vector: [chunk({ chunk_id: 11, doc_id: "d-unrelated", score: 0.42 })],
    fts: [],
    topK: 5,
  });

  assert.ok(related.topScore > 0.3, `相关查询必须过线，实际 ${related.topScore}`);
  assert.ok(unrelated.topScore < 0.3, `无关查询必须落在线下，实际 ${unrelated.topScore}`);
  assert.ok(
    related.topScore > unrelated.topScore * 2,
    `平方必须把两档拉开：相关 ${related.topScore}、无关 ${unrelated.topScore}`,
  );
});

test("降级映射：嵌入超时/不可用 → fts_only；数据库与未知失败 → empty", () => {
  assert.equal(fallbackOf(new EmbedError("EMBED_TIMEOUT")), "fts_only");
  assert.equal(fallbackOf(new EmbedError("EMBED_UNAVAILABLE")), "fts_only");

  // pg 超时（statement_timeout）与连接失败都归"空"，让上层走拒答而不是 500。
  assert.equal(fallbackOf({ code: "57014" }), "empty");
  assert.equal(fallbackOf(Object.assign(new Error("Connection terminated"), { code: "ECONNRESET" })), "empty");
  assert.equal(fallbackOf(new Error("boom")), "empty");
  assert.equal(fallbackOf(undefined), "empty");
  assert.equal(fallbackOf("not-an-error"), "empty");

  const mapped: RetrievalFallback[] = [
    fallbackOf(new EmbedError("EMBED_TIMEOUT")),
    fallbackOf({ code: "57014" }),
  ];
  assert.deepEqual(mapped, ["fts_only", "empty"]);
});

test("维度错误不是降级：fallbackOf 原样抛出，不会被吞成 empty（否则数据事故伪装成'没搜到'）", () => {
  const mismatch = new EmbedError("EMBED_DIM_MISMATCH", "查询向量维度 768，契约要求 1024");
  assert.throws(
    () => fallbackOf(mismatch),
    (err: unknown) => {
      assert.ok(err instanceof EmbedError, `期望原样抛出 EmbedError，实际 ${String(err)}`);
      assert.equal(err.code, "EMBED_DIM_MISMATCH");
      return true;
    },
    "fallbackOf 对 EMBED_DIM_MISMATCH 必须抛出，绝不能返回降级标签",
  );

  // 反向断言：只有"非维度"的失败才可能被映射成降级（EmbedError → fts_only，其它 → empty）。
  for (const err of [
    new EmbedError("EMBED_TIMEOUT"),
    { code: "57014" },
    new Error("unexpected"),
  ]) {
    assert.notEqual(fallbackOf(err), "none", `${String(err)} 不该被当成'没有降级'`);
  }
});

test("isDbUnavailable 只认数据库不可用/超时，不认 SQL 写错", () => {
  assert.equal(isDbUnavailable({ code: "57014" }), true, "statement_timeout 的 SQLSTATE");
  assert.equal(isDbUnavailable({ code: "57P01" }), true, "服务端关闭连接");
  assert.equal(isDbUnavailable({ code: "08006" }), true, "连接异常 class 08");
  assert.equal(isDbUnavailable({ code: "ECONNREFUSED" }), true, "连接被拒");
  assert.equal(
    isDbUnavailable(new Error("timeout exceeded when trying to connect")),
    true,
    "node-postgres 连接池超时没有 code，只能按文案认",
  );

  // 42P01 = 表不存在：这是迁移或代码的 bug，必须 500 并留日志，不能降级成"没搜到"。
  assert.equal(isDbUnavailable({ code: "42P01" }), false);
  assert.equal(isDbUnavailable(new Error("boom")), false);
  assert.equal(isDbUnavailable(undefined), false);
});

test("空白 query：不调嵌入、不查库，直接返回空结果 + fallback=empty，timings 全 0", async () => {
  const result = await retrieve({ query: "   ", lang: "de", prevUser: "Welcher Wechselrichter?" });

  assert.equal(result.query, "", "空白 query 归一化为空串");
  assert.deepEqual(result.chunks, []);
  assert.equal(result.topScore, 0);
  assert.equal(result.fallback, "empty");
  assert.deepEqual(result.timings, { embed_ms: 0, vector_ms: 0, fts_ms: 0, fuse_ms: 0, total_ms: 0 });
  assert.deepEqual(result.lang_scope, ["de", "en"], "语言视野仍要透出，方便排查");
});
