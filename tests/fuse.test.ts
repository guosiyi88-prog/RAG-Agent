/**
 * RRF 融合与归一化的纯单元测试（07-retrieval.md §5、§5.1）。
 *
 * **不连库、不打网络、不读语料**：全部断言在毫秒级跑完，`node --test tests/fuse.test.ts` 即可。
 *
 * `src/core/fuse.ts` 的 K 与两路权重来自 `src/config.ts`（唯一读 env 的地方），所以这里
 * 先按 `tests/healthz.test.ts` 同一套 .env 解析补齐环境，再用**动态** import 载入 fuse：
 * 静态 import 会在 .env 生效之前就被求值，缺 env 时 config 直接 exit(1)。
 * 真缺 .env 时补占位符 —— config 只校验"存在且非空"，不建立任何连接，
 * 于是纯函数测试在没有数据层的机器上也照样能跑。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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
for (const key of [
  "INTERNAL_TOKEN",
  "DATABASE_URL",
  "REDIS_URL",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_BUCKET",
]) {
  if (process.env[key] === undefined) process.env[key] = `test-placeholder-${key}`;
}

const { FTS_WEIGHT, RRF_K, VEC_WEIGHT, maxPossibleScore, normalizeScore, rankOf, rrf } = await import(
  "../src/core/fuse.ts"
);
const { config } = await import("../src/config.ts");

/** 浮点容差：几处除法必然带 1ulp 级误差，断言"算对了"不该被末位差异绊倒。 */
function closeTo(actual: number, expected: number, tolerance = 1e-12): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `期望 ${expected}（±${tolerance}），实际 ${actual}`,
  );
}

/** 方便在断言里写 Map 字面量：`ranks([[1, 0], [2, 1]])`。 */
function ranks(entries: readonly (readonly [number, number])[]): Map<number, number> {
  return new Map(entries.map(([id, rank]) => [id, rank]));
}

test("rankOf：数组顺序即 0-based 位次（未命中就没有 key）", () => {
  const r = rankOf([{ chunk_id: 7 }, { chunk_id: 3 }, { chunk_id: 9 }]);
  assert.deepEqual([...r.entries()], [[7, 0], [3, 1], [9, 2]]);
  // 0-based 是硬要求：公式是 weight / (k + rank0 + 1)，rank 从 1 起会整体错一位。
  assert.equal(r.get(7), 0);

  assert.equal(rankOf([]).size, 0, "空数组不应产生任何 key");

  // 同一路里重复出现只认首次位次：取后面的名次会把分数压低，反而掩盖"这条 SQL 出了重复行"。
  const dup = rankOf([{ chunk_id: 5 }, { chunk_id: 5 }, { chunk_id: 6 }]);
  assert.equal(dup.get(5), 0);
  assert.equal(dup.get(6), 2);
});

test("K 与两路权重取自 config，不在 fuse.ts 里写死", () => {
  assert.equal(RRF_K, config.rrfK);
  assert.equal(VEC_WEIGHT, config.retrievalVecWeight);
  assert.equal(FTS_WEIGHT, config.retrievalFtsWeight);
  // 与 07-retrieval.md §5 的规格值一致（.env.example 也钉的是这三个数）。
  assert.equal(RRF_K, 60);
  assert.equal(VEC_WEIGHT, 0.8);
  assert.equal(FTS_WEIGHT, 0.2);
});

test("maxPossibleScore = 0.8/61 + 0.2/61（由权重算出，不是魔数）", () => {
  closeTo(maxPossibleScore(), 0.8 / 61 + 0.2 / 61);
  closeTo(maxPossibleScore(), 1 / 61);
  // 07 §5.1 给的参考值 ≈0.016393：量级是 0.01，而阈值是 0.30 —— 这就是必须归一化的原因。
  closeTo(maxPossibleScore(), 0.0163934, 1e-6);

  // 分母跟着权重/常数走：改权重后分母自动变化，不需要人去同步一个魔法数字。
  closeTo(maxPossibleScore({ vecWeight: 0.5, ftsWeight: 0.5 }), 0.5 / 61 + 0.5 / 61);
  closeTo(maxPossibleScore({ ftsWeight: 0.35, vecWeight: 0.65 }), 1 / 61);
  closeTo(maxPossibleScore({ k: 10 }), 0.8 / 11 + 0.2 / 11);
  closeTo(maxPossibleScore({ k: 0 }), VEC_WEIGHT + FTS_WEIGHT, 1e-12);
  closeTo(maxPossibleScore({ vecWeight: 0, ftsWeight: 0.2 }), 0.2 / 61);
  assert.equal(maxPossibleScore({ vecWeight: 0, ftsWeight: 0 }), 0, "权重全 0 时上界为 0（下游按脏分母处理）");
});

test("两路都排第一 → 原始分正好是理论上界 → 归一化 = 1（分母没写错的定盘星）", () => {
  const fused = rrf({ vecRank: ranks([[1, 0]]), ftsRank: ranks([[1, 0]]) });
  assert.equal(fused.length, 1);
  const top = fused[0];
  assert.ok(top !== undefined);
  assert.equal(top.chunk_id, 1);
  closeTo(top.score, maxPossibleScore(), 0); // 与上界同一串浮点运算，逐位相同
  // 用上界分母除回去必须落在 1：分母偏大则这里 <1，偏小则被夹到 1（同样暴露问题）。
  assert.equal(normalizeScore(top.score), 1);
  assert.equal(normalizeScore(top.score, maxPossibleScore()), 1);
});

test("单路第一：向量路归一化后 ≈0.8，全文路 ≈0.2（权重即分数占比）", () => {
  const vecOnly = rrf({ vecRank: ranks([[11, 0]]), ftsRank: new Map() });
  const ftsOnly = rrf({ vecRank: new Map(), ftsRank: ranks([[22, 0]]) });

  assert.equal(vecOnly.length, 1);
  assert.equal(ftsOnly.length, 1);
  closeTo(normalizeScore(vecOnly[0]!.score), 0.8, 1e-12);
  closeTo(normalizeScore(ftsOnly[0]!.score), 0.2, 1e-12);

  // 同一路里名次越靠后分数越低，但都落在 0..1 内。
  const vecDeep = rrf({ vecRank: ranks([[11, 19]]), ftsRank: new Map() });
  closeTo(normalizeScore(vecDeep[0]!.score), 0.8 * (61 / 80), 1e-12);
  assert.ok(normalizeScore(vecDeep[0]!.score) < normalizeScore(vecOnly[0]!.score));
});

test("normalizeScore：上界夹到 1，脏分母/脏分子一律回 0", () => {
  const max = maxPossibleScore();
  assert.equal(normalizeScore(max * 10), 1, "超过上界夹到 1");
  assert.equal(normalizeScore(max, max), 1);
  assert.equal(normalizeScore(0), 0, "0 分就是 0");
  assert.equal(normalizeScore(Number.NaN), 0, "NaN 不能顺着 `< 0.30` 静默通过（NaN 比较恒 false）");
  assert.equal(normalizeScore(Number.POSITIVE_INFINITY), 0);
  assert.equal(normalizeScore(0.001, 0), 0, "分母为 0 回 0");
  assert.equal(normalizeScore(0.001, -1), 0, "分母为负回 0");
  assert.equal(normalizeScore(0.001, Number.NaN), 0, "分母非有限回 0");
  assert.equal(normalizeScore(-0.001), 0, "负分夹到 0（不把阈值判断押在'融合不会产生负分'上）");
});

test("等位次时向量路的 chunk 排在全文路之前（顺序由权重决定，不由路名决定）", () => {
  const fused = rrf({ vecRank: ranks([[1, 0]]), ftsRank: ranks([[2, 0]]) });
  assert.deepEqual(fused.map((c) => c.chunk_id), [1, 2]);

  // 权重对调后顺序必须跟着翻：证明排的是分数而不是"向量优先"的硬编码。
  const swapped = rrf({ vecRank: ranks([[1, 0]]), ftsRank: ranks([[2, 0]]), vecWeight: 0.2, ftsWeight: 0.8 });
  assert.deepEqual(swapped.map((c) => c.chunk_id), [2, 1]);
});

test("6 个候选：分数降序、两次调用逐项相同、与 Map 插入顺序无关", () => {
  const vec = ranks([[1, 0], [2, 1], [3, 2], [5, 3]]);
  const fts = ranks([[1, 0], [4, 1], [6, 2]]);

  const first = rrf({ vecRank: vec, ftsRank: fts });
  // 手算（k=60、0.8/0.2）：1=0.01639（两路第一）> 2=0.8/62 > 3=0.8/63 > 5=0.8/64
  // > 4=0.2/62 > 6=0.2/63。
  assert.deepEqual(first.map((c) => c.chunk_id), [1, 2, 3, 5, 4, 6]);
  assert.equal(first.length, 6, "两路并集恰好 6 个候选，不重不漏");

  for (let i = 1; i < first.length; i += 1) {
    assert.ok(first[i - 1]!.score >= first[i]!.score, `第 ${i} 位分数没有严格降序`);
  }
  assert.equal(new Set(first.map((c) => c.chunk_id)).size, first.length, "同一 chunk 只能出现一次");

  // 同样内容、不同插入顺序的两个 Map：结果必须逐项相同（不靠迭代顺序的运气）。
  const vecReordered = ranks([[5, 3], [3, 2], [1, 0], [2, 1]]);
  const ftsReordered = ranks([[6, 2], [4, 1], [1, 0]]);
  const second = rrf({ vecRank: vecReordered, ftsRank: ftsReordered });
  assert.deepEqual(second, first);
  assert.deepEqual(rrf({ vecRank: vec, ftsRank: fts }), first, "同一输入两次调用结果一致");
});

test("平分时按 chunk_id 升序（不让 Set 迭代顺序决定引用编号）", () => {
  // vec/ fts 权重相同且两条候选名次互换：分数逐位相等，只能靠 chunk_id 定序。
  const tied = rrf({
    vecRank: ranks([[20, 0], [10, 1]]),
    ftsRank: ranks([[10, 0], [20, 1]]),
    vecWeight: 1,
    ftsWeight: 1,
  });
  assert.equal(tied[0]!.score, tied[1]!.score, "这一组必须是真平分，否则本用例失去意义");
  assert.deepEqual(tied.map((c) => c.chunk_id), [10, 20]);
});

test("两路都命中的 chunk 严格优于它只在更强那一路命中时（融合确实在加分）", () => {
  // chunk 1：向量第一 + 全文第六；chunk 2：只有向量第一。
  const fused = rrf({ vecRank: ranks([[1, 0], [2, 0]]), ftsRank: ranks([[1, 5]]) });
  assert.deepEqual(fused.map((c) => c.chunk_id), [1, 2]);
  const both = fused[0]!;
  const vecOnly = fused[1]!;
  assert.ok(both.score > vecOnly.score, `两路命中应更高：${both.score} vs ${vecOnly.score}`);
  assert.equal(both.chunk_id, 1);
  assert.equal(vecOnly.chunk_id, 2);
});

test("空输入 → 空数组（某一路没命中就是不贡献，不是报错）", () => {
  assert.deepEqual(rrf({ vecRank: new Map(), ftsRank: new Map() }), []);
  // 只有一路有候选时，另一路为空不该丢掉这一路的结果。
  const onlyVec = rrf({ vecRank: ranks([[1, 0], [2, 1]]), ftsRank: new Map() });
  assert.deepEqual(onlyVec.map((c) => c.chunk_id), [1, 2]);
  const onlyFts = rrf({ vecRank: new Map(), ftsRank: ranks([[3, 0]]) });
  assert.deepEqual(onlyFts.map((c) => c.chunk_id), [3]);
  assert.equal(onlyFts[0]!.chunk_id, 3);
});
