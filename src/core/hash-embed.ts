/**
 * 本地兜底向量：FNV-1a 32bit → 1024 维 → L2 归一化（08-ingestion.md §5.3）。
 *
 * 存在理由：`DASHSCOPE_API_KEY` 缺失、离线演示、评测要可复现。它只保证"确定性"，
 * 不保证语义质量 —— 同一个 token 永远落同一个维度，所以同文本同向量、不同文本不同向量。
 *
 * 不要在这里加"特征工程"（词干化、同义词表、停用词表）：一旦加了，召回失败就无法归因，
 * 到底是兜底向量的锅还是检索公式的锅，评审时分不清。质量差就该换后端，不是改这里。
 */

/** 与 `chunks.embedding vector(1024)` 和 `EMBED_DIM=1024` 锁死，改这里必须同时改 DDL。 */
export const HASH_DIM = 1024;

/** CJK 按字切，其它语言按词切 —— 见 tokenize 的原因说明。 */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const WORD_RUN = /[\p{L}\p{N}]+/gu;

/**
 * 切 token：西文按"字母数字连续段"切，CJK 连续段再逐字拆开。
 *
 * 为什么 CJK 要逐字拆：中文没有空格，"储能电池的保修期限" 整句当一个 token 的话，
 * 只有逐字完全相同的句子才能撞上同一维度，兜底向量会退化成"文档指纹"。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // 统一小写：兜底向量不承担大小写敏感性，Warranty 与 warranty 应该是同一个 token。
  // （原文大小写由清洗步骤 §3.5 保留，跟这里的归一化是两件事。）
  for (const match of text.toLowerCase().matchAll(WORD_RUN)) {
    const run = match[0];
    if (CJK_CHAR.test(run)) {
      for (const ch of run) tokens.push(ch);
    } else {
      tokens.push(run);
    }
  }
  return tokens;
}

/** FNV-1a 32bit。用 Math.imul 而不是 `*`：JS 的 `*` 走浮点，乘积超过 2^53 会丢低位。 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 文本 → 1024 维单位向量。空文本（没有 token）返回全零向量：
 * 全零向量的余弦距离无定义，但调用方（入库/检索）都不该送空串进来，
 * 这里选择"返回零"而不是抛错，是为了让纯函数可测、边界行为可预期。
 */
export function hashEmbed(text: string): number[] {
  const vector = new Array<number>(HASH_DIM).fill(0);
  for (const token of tokenize(text)) {
    const index = fnv1a(token) % HASH_DIM;
    vector[index] += 1;
  }

  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  const norm = Math.sqrt(sumOfSquares);
  if (norm === 0) return vector;

  return vector.map((value) => value / norm);
}
