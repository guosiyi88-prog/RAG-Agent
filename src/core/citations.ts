/**
 * 引用校验（05-api.md §3.2 规则 1–4、06-agent.md §5.1 的 ②③④）。
 *
 * 一句话职责：**候选**（工具结果里的附加字段，只在后端）→ 正文 → **引用**（真正下发并落库的那些）。
 * 候选全集绝不下发：前端会把没用到的角标也画出来，客户点开发现"这段没支持那句话"，信任直接崩。
 *
 * 三段式拒答里本文件负责后半截（①② 在检索/缓冲阶段判完）：
 *   ③ `no_marks`      正文一个 `[n]` 都没有 —— 通篇没有角标的散文不许发给客户
 *   ④ `illegal_mark`  出现候选集之外的编号 —— 模型编出来的 `[9]` 整条丢弃，不挑着用
 * `no_candidates` 是 ② 的兜底：传进来的候选集根本不可用（空，或 idx 全不合法）。
 *
 * 为什么是个**纯函数**：这段逻辑是"引用可溯源"这个卖点的唯一闸门，必须能在毫秒级被单测
 * 逐个分支钉死，而不依赖 DB、模型、时钟或任何一个真实请求。无 import、无 I/O、无副作用。
 * 校验放在收尾流程里、落库之前（05#01 的顺序：先校验后批量写快照，内部引用接口只写不校验）。
 */

/** 本轮候选：就是 `kb_search` 的 top-K，`idx` 由 `retrieve()` 分配（1..n 连续无空洞）。 */
export type Candidate = {
  idx: number;
  chunk_id: number;
  doc_title: string;
  doc_lang: string;
  page: number | null;
  section?: string | null;
  snippet: string;
  score: number;
};

/**
 * 一条**快照**引用：落库后不再依赖片段行存活，片段重索引后历史引用仍然可读。
 * 所以这里存的是值拷贝，而不是 `chunk_id` 的外键查询结果。
 *
 * `chunk_id` 可以为 null（列可空）：候选带着它就原样透传，候选本身没带（不可能发生，
 * 但要让它显式变成 null 而不是 undefined —— 进 JSON 后 undefined 会整个字段消失）。
 */
export type Citation = {
  idx: number;
  chunk_id: number | null;
  doc_title: string;
  doc_lang: string;
  page: number | null;
  snippet: string;
  score: number;
};

/**
 * 判定结果。ok 时 `citations` 已升序去重；不 ok 时 `reason` 直接对应拒答路径，
 * `marks` / `illegal` 是给日志和断言用的证据（拒答本身不看它们，只看 `reason`）。
 *
 * 三条失败原因最终都落到同一个拒答动作（06 §5.1 的四步），但原因必须分开记：
 * ③ 是"模型写了解释却没标注"，④ 是"模型编了编号"，两者的模型侧修法完全不同。
 */
export type CitationVerdict =
  | { ok: true; citations: Citation[] }
  | { ok: false; reason: "no_candidates" | "no_marks" | "illegal_mark"; marks: number[]; illegal: number[] };

/**
 * 取出正文里的全部角标（05 §3.2 规则 1 的字面实现）：保留重复、保持出现顺序。
 *
 * 三点刻意的选择：
 *   - 正则**在函数内新建**，不在模块级复用带 `/g` 的实例：`lastIndex` 会跨调用残留，
 *     第二次调用的结果取决于第一次跑到了哪 —— 这种 bug 只在重复调用时才现形，最难查。
 *   - 只认 `\d+`：`[a]`、`[1,2]`、`[]` 都不是角标，前端也不会把它们画成角标。
 *   - 数字用 `Number()` 归一：`[007]` → 7，即前导零折进同一个编号（下面 `validateCitations`
 *     的集合比对是数值比对，`[007]` 与 `[7]` 必须指同一条候选，否则同一份候选会出现两种写法）。
 *     超大数字同理不抛错：`Number("9".repeat(400))` 是 `Infinity`，落不进候选集，走 illegal。
 */
export function extractMarks(text: string): number[] {
  const marks: number[] = [];
  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    marks.push(Number(match[1]));
  }
  return marks;
}

/**
 * 比对集合：**候选序号集合**，不是 `1..5` 的范围。
 *
 * 这是本票据存在的理由。候选由 `retrieve()` 分配 1..n，看着和"1 到 topK"完全一样，
 * 于是很容易被写成 `mark >= 1 && mark <= 5` 或 `mark <= candidates.length`：
 *   - 候选是 {2,4} 时 `[1]` 会被判合法 —— 正文里那个角标点开是**另一条**片段，
 *     这正是"点开对不上原文"的成因，也是客户信任崩掉的那一刻；
 *   - 候选是 {1,2} 时 `[3]` 被范围判非法、`[0]` 却被别的分支放过，规则随实现漂移。
 * 用集合判定则"模型编了一个不存在的编号"与"编号错位"被同一条规则抓住，
 * 不依赖候选是否连续、也不依赖 topK 配置是多少。
 */
export function validateCitations(text: string, candidates: readonly Candidate[]): CitationVerdict {
  const marks = extractMarks(text);

  // 候选集里能用来对账的只有 idx 合法的那些（06 §5.2 的 `Number.isInteger(c.idx) && c.idx >= 1`）。
  // 同一 idx 出现两次只认第一条：取值必然同源（同一次检索的同一行），认后面那条纯属让
  // "后写覆盖前写"决定快照内容。绝不在这里"补"候选 —— 补一条等于伪造引用。
  const byIdx = new Map<number, Candidate>();
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate.idx) || candidate.idx < 1) continue;
    if (!byIdx.has(candidate.idx)) byIdx.set(candidate.idx, candidate);
  }

  // ② 本轮没有可引用的候选（`citationBuffer` 为空）。
  // idx 全不合法也归到这里而不是 illegal_mark：那是装配侧/检索侧的 bug，
  // 记成"模型编了编号"会污染模型侧统计，让人去改 prompt 而不是去修取号逻辑。
  if (byIdx.size === 0) return { ok: false, reason: "no_candidates", marks, illegal: [] };

  // ③ 候选有，正文里一个角标都没有：这是"通篇没有角标的散文"，
  //    说得再像样也不能发给客户 —— 一句都无法回溯。
  if (marks.length === 0) return { ok: false, reason: "no_marks", marks, illegal: [] };

  // ④ 只要有一个编号不在候选集里就整条丢。**不挑着用合法的那几个**：
  //    正文里既然有对不上的角标，其余部分的说法同样不可信；
  //    只下发一半还会让前端画出"正文有 [2] 但引用列表里没有"的错位。
  //    `illegal` 保留重复与出现顺序（与 06 §5.2 的 `used.filter(...)` 逐字一致），调用方只看 length。
  const illegal = marks.filter((mark) => !byIdx.has(mark));
  if (illegal.length > 0) return { ok: false, reason: "illegal_mark", marks, illegal };

  // 通过：去重后按 idx **升序**（05 §3.2 规则 4），与正文首次出现顺序无关 ——
  // 前端按这个顺序画引用列表，"哪段先说"不该改变列表顺序。
  const citations: Citation[] = [];
  for (const idx of [...new Set(marks)].sort((a, b) => a - b)) {
    const candidate = byIdx.get(idx);
    // 不可达：走到这里的每个 mark 都在 byIdx 里（illegal 那关已经挡掉了不存在的编号）。
    // 真出现了也只跳过，不编一条空快照 —— 空引用比少引用更像事故。
    if (candidate === undefined) continue;
    citations.push(snapshotOf(candidate));
  }
  return { ok: true, citations };
}

/**
 * 候选 → 快照：字段**逐个显式拷贝**，不用对象展开。
 * 展开会把 `doc_id` / `section` 这类不该下发的字段一起带出去（前端契约里没有它们），
 * 而显式列举让"快照包含什么"在类型之外也一眼可见。
 */
function snapshotOf(candidate: Candidate): Citation {
  return {
    idx: candidate.idx,
    // 列可空：候选带了就透传，没带就显式 null（不是 undefined —— 见类型注释）。
    chunk_id: Number.isInteger(candidate.chunk_id) ? candidate.chunk_id : null,
    doc_title: candidate.doc_title,
    doc_lang: candidate.doc_lang,
    page: candidate.page,
    snippet: candidate.snippet,
    score: candidate.score,
  };
}
