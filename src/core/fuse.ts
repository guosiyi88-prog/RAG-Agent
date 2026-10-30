/**
 * 带权 RRF 融合与归一化（07-retrieval.md §5、§5.1）。**纯函数模块**：不查库、不发请求、不打日志、
 * 不做后处理（按 doc_id 去重、600 字截断、分配引用角标 `idx` 都在 `retrieval.ts` 那一侧）。
 *
 * 这一卡真正容易写错的不是公式，而是**量纲**：融合后的原始 RRF 分在 0.01 量级
 * （理论上限 ≈0.0164），而拒答阈值 `RETRIEVAL_MIN_SCORE=0.30` 是按 0..1 的归一化分定的。
 * 拿原始分直接和 0.30 比，每一次检索都会被判成低置信 —— 表现是"百分之百拒答"，
 * 而且**日志里看不出任何异常**：没有报错、没有空结果、分数看着也落在 0..1 里（只是很小）。
 * 所以这里把归一化做成唯一出口：原始分只用于排序，与阈值比较**只能**用 `normalizeScore()`
 * 的结果（07 §5.1 的"必须归一化后才能和 RETRIEVAL_MIN_SCORE 比较"）。
 *
 * K 与两路权重一律从 `config` 取，不在本文件写死：调参（07 §10 把 FTS 权重提到 0.35）
 * 只该改一个地方，而分母会跟着动（见 `maxPossibleScore`）。
 */
import { config } from "../config.ts";

/** 平滑常数：打分分母 `k + rank0 + 1` 里的 k，防止 rank0 时被 0 除，也压低靠前名次的权重差。 */
export const RRF_K: number = config.rrfK;

/** 向量路权重（语义召回是主力）。 */
export const VEC_WEIGHT: number = config.retrievalVecWeight;

/** 全文路权重（只负责故障码 / 型号 / 短术语的精确命中，所以是配角）。 */
export const FTS_WEIGHT: number = config.retrievalFtsWeight;

/**
 * 把某一路的召回结果转成 `chunk_id -> 0-based rank`（数组顺序即该路的排序位次）。
 * 未命中的 chunk 不会有这个 key —— 缺 key 与 rank 为 0 是两回事，融合时靠它区分"这一路没召回"
 * 与"这一路排第一"。
 *
 * 同一路里同一个 chunk 出现多次只会取**首次**位次：重复说明那条 SQL 出了问题，
 * 这里悄悄取后面的名次会把分数压低，反而掩盖故障。
 */
export function rankOf(chunks: readonly { chunk_id: number }[]): Map<number, number> {
  const ranks = new Map<number, number>();
  for (const [index, chunk] of chunks.entries()) {
    if (!ranks.has(chunk.chunk_id)) ranks.set(chunk.chunk_id, index);
  }
  return ranks;
}

/** 融合后的候选。`score` 是**原始 RRF 分**（0.01 量级），拿去和阈值比就是 §5.1 那个坑。 */
export type RankedCandidate = { chunk_id: number; score: number };

/**
 * 理论上界：两路都把同一个 chunk 排在第 1（rank0 = 0）时的原始分，
 * 也就是 `vecWeight / (k+1) + ftsWeight / (k+1)`（当前配置 ≈ 0.016393）。
 *
 * 分母必须**由公式从权重算出来**，不许写成 `0.016393` 这类魔数：把 `RETRIEVAL_FTS_WEIGHT`
 * 从 0.2 提到 0.35 之后，魔数分母不会跟着变，所有归一化分集体偏低，
 * 表现出来是"调完权重拒答变多了"，而不是一眼看出分母过期。
 * 权重是运行时可配的（`config` 读 env），分母就只能跟着算。
 */
export function maxPossibleScore(input?: { vecWeight?: number; ftsWeight?: number; k?: number }): number {
  const vecWeight = input?.vecWeight ?? VEC_WEIGHT;
  const ftsWeight = input?.ftsWeight ?? FTS_WEIGHT;
  const k = input?.k ?? RRF_K;
  return vecWeight / (k + 1) + ftsWeight / (k + 1);
}

/**
 * 加权 RRF：`sum(weight / (k + rank0 + 1))`，只累加该 chunk 实际命中的那几路。
 *
 * 排序必须**确定性**：分数降序，平分时按 `chunk_id` 升序。平分在这里不是理论情况 ——
 * 两路权重相同、或同一份内容被切成的两块拿到相同名次时都会平分。
 * 若靠 `Set`/`Map` 的迭代顺序兜底，同一份输入在不同调用栈里能给出不同顺序，
 * 于是"同一个问题两次问出不同引用编号"，没法复现也没法对账。
 */
export function rrf(input: {
  vecRank: ReadonlyMap<number, number>;
  ftsRank: ReadonlyMap<number, number>;
  vecWeight?: number;
  ftsWeight?: number;
  k?: number;
}): RankedCandidate[] {
  const vecWeight = input.vecWeight ?? VEC_WEIGHT;
  const ftsWeight = input.ftsWeight ?? FTS_WEIGHT;
  const k = input.k ?? RRF_K;

  const ids = new Set<number>([...input.vecRank.keys(), ...input.ftsRank.keys()]);
  const out: RankedCandidate[] = [];
  for (const chunk_id of ids) {
    let score = 0;
    const vecRank = input.vecRank.get(chunk_id);
    if (vecRank !== undefined) score += vecWeight / (k + vecRank + 1);
    const ftsRank = input.ftsRank.get(chunk_id);
    if (ftsRank !== undefined) score += ftsWeight / (k + ftsRank + 1);
    out.push({ chunk_id, score });
  }

  out.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.chunk_id - b.chunk_id;
  });
  return out;
}

/**
 * 归一化到 0..1：`min(1, raw / 理论上界)`。**与 `RETRIEVAL_MIN_SCORE` 比较只用这个值。**
 *
 * 两侧都夹住：上界防浮点误差让"两路都第一"算出 1.0000000000000002；
 * 下界防调用方把负分或脏数据传下来（融合本身不会产生负分，但阈值判断不该依赖这个前提）。
 * 分母为 0 / 负数 / 非有限值（权重配错、k 配成 -1）以及 raw 是 NaN 时返回 0：
 * 宁可判低置信走拒答，也不要让 NaN 顺着 `< 0.30` 的比较静默通过（NaN 比较恒为 false，
 * 那会变成"永远不拒答"，正好是 §5.1 那个坑的镜像）。
 */
export function normalizeScore(rawScore: number, maxPossible?: number): number {
  const denom = maxPossible ?? maxPossibleScore();
  if (!Number.isFinite(rawScore) || !Number.isFinite(denom) || denom <= 0) return 0;
  return Math.min(1, Math.max(0, rawScore / denom));
}
