/**
 * 引用校验的纯单元测试（05-api.md §3.2 规则 1–4、06-agent.md §5.1 的 ②③④）。
 *
 * **不连库、不打网络、不读 .env**：`src/core/citations.ts` 没有任何 import，
 * 所以这里可以静态 import（不像 fuse.test.ts 得先补 env 再动态 import）。全部毫秒级跑完：
 *   node --test --test-concurrency=1 tests/citations.test.ts
 *
 * 这里钉的是本票据的红线：比对的是**本轮候选序号集合**，不是 `1..5` 的范围。
 * 下面"候选 {2,4} + [1]"那条用例就是这条红线本人 —— 它红了说明有人把集合写回了范围。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractMarks, validateCitations } from "../src/core/citations.ts";
import type { Candidate } from "../src/core/citations.ts";

const DOC_DE = "Installationshandbuch Wechselrichter";

/** 一条像模像样的德语候选：每个字段都与 idx 绑定，快照串字段时一眼能看出来。 */
function candidate(idx: number, overrides: Partial<Candidate> = {}): Candidate {
  return {
    idx,
    chunk_id: 1000 + idx,
    doc_title: DOC_DE,
    doc_lang: "de",
    page: 10 + idx,
    section: "Montage",
    snippet: `Wechselrichter Abschnitt ${idx}`,
    score: 0.42 - idx * 0.01,
    ...overrides,
  };
}

/** 正常一轮的候选：1..3（`retrieve()` 分配的连续编号）。 */
const CANDIDATES: readonly Candidate[] = [candidate(1), candidate(2), candidate(3)];

// ─────────────────────── extractMarks ───────────────────────

test("extractMarks：保留重复、保持出现顺序", () => {
  assert.deepEqual(extractMarks("先看 [2]，再看 [1]，还要看 [1]。"), [2, 1, 1]);
  assert.deepEqual(extractMarks("[3][2][1]"), [3, 2, 1]);
  // 没有角标就是空数组 —— 判 ③ 只认这一条。
  assert.deepEqual(extractMarks("这款逆变器保修十年。"), []);
  assert.deepEqual(extractMarks(""), []);
});

test("extractMarks：只认 [数字]，其它方括号不是角标", () => {
  // 前导零单独在下面测；这里确认"看起来像角标但不是"的一律取不到。
  assert.deepEqual(extractMarks("[a] [] [1,2] [ 3 ] [-1] [1.5]"), []);
  assert.deepEqual(extractMarks("规格见 [1]，数组是 a[0]。"), [1, 0]);
});

test("extractMarks：反复调用结果一致（正则不在模块级复用 /g 实例）", () => {
  // 模块级共享一个 /g 正则会残留 lastIndex：第二次调用会从上次停下的位置继续扫，
  // 于是"同一个函数，第二次调用少一半角标"。这条断言就是为了让那种写法立刻红。
  const text = "A [1] B [2] C [3]";
  assert.deepEqual(extractMarks(text), [1, 2, 3]);
  assert.deepEqual(extractMarks(text), [1, 2, 3]);
  assert.deepEqual(extractMarks(text), [1, 2, 3]);
});

// ─────────────────────── ② no_candidates ───────────────────────

test("② 空候选 + 正文有角标 → no_candidates（不管正文写了什么）", () => {
  const verdict = validateCitations("保修期是十年 [1]，详见手册 [2]。", []);
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok);
  assert.equal(verdict.reason, "no_candidates");
  // 角标照实回传，供日志看清"模型引了 2 个角标，但本轮根本没召回任何候选"。
  assert.deepEqual(verdict.marks, [1, 2]);
  assert.deepEqual(verdict.illegal, []);
});

test("② 空候选 + 正文没角标 → 仍是 no_candidates（② 先于 ③ 判）", () => {
  const verdict = validateCitations("这款机器很适合您的阳台。", []);
  assert.ok(!verdict.ok);
  assert.equal(verdict.reason, "no_candidates");
  assert.deepEqual(verdict.marks, []);
});

test("② 候选 idx 全不合法 → no_candidates（后端取号坏了，不冤枉模型编造）", () => {
  // 不可达的组合（retrieve 保证 idx 从 1 连续），但真出现时要说成"没有可引用的候选"，
  // 而不是"模型编了编号" —— 后者会让人去改 prompt，而问题在取号逻辑。
  const broken: readonly Candidate[] = [candidate(0), candidate(Number.NaN)];
  const verdict = validateCitations("见 [1]。", broken);
  assert.ok(!verdict.ok);
  assert.equal(verdict.reason, "no_candidates");
});

// ─────────────────────── ③ no_marks ───────────────────────

test("③ 有候选但正文一个角标都没有 → no_marks（无角标的散文不许下发）", () => {
  const verdict = validateCitations(
    "Der Wechselrichter sollte im Schatten montiert werden und benötigt 60 cm Abstand.",
    CANDIDATES,
  );
  assert.ok(!verdict.ok);
  assert.equal(verdict.reason, "no_marks");
  assert.deepEqual(verdict.marks, []);
  assert.deepEqual(verdict.illegal, []);

  // 空正文同理（模型什么都没产出）。
  const empty = validateCitations("", CANDIDATES);
  assert.ok(!empty.ok);
  assert.equal(empty.reason, "no_marks");
});

// ─────────────────────── ④ illegal_mark ───────────────────────

test("④ 编造 [9] → illegal_mark，整条丢弃", () => {
  const verdict = validateCitations("保修期十年 [1]，电池八年 [9]。", CANDIDATES);
  assert.ok(!verdict.ok);
  assert.equal(verdict.reason, "illegal_mark");
  assert.deepEqual(verdict.illegal, [9]);
  assert.deepEqual(verdict.marks, [1, 9], "marks 是全量角标，合法的那几个也照实回传");
  // 关键：整条丢。合法的 [1] 不得被挑出来下发，否则前端引用列表与正文对不上。
  assert.equal("citations" in verdict, false);
});

test("④ 候选 {2,4} + 角标 [1] → illegal_mark（比的是集合，不是 1..5 范围）", () => {
  const sparse: readonly Candidate[] = [candidate(2), candidate(4)];

  // 这条就是本票据要防的 bug：写成 `mark >= 1 && mark <= candidates.length`
  // 或 `mark <= 5` 时 [1] 会被判合法，而它对应的候选根本不存在 —— 角标点开对不上原文。
  const bad = validateCitations("先把直流侧断开 [1]。", sparse);
  assert.ok(!bad.ok);
  assert.equal(bad.reason, "illegal_mark");
  assert.deepEqual(bad.illegal, [1]);

  // 同一条规则的另一半：候选集内的编号一切正常，顺序按升序而不是正文顺序。
  const good = validateCitations("先 [4] 再 [2]。", sparse);
  assert.ok(good.ok);
  assert.deepEqual(good.citations.map((c) => c.idx), [2, 4]);
  assert.deepEqual(good.citations.map((c) => c.chunk_id), [1002, 1004]);
});

test("④ [0] 不算合法：集合里没有 0 就是非法（不做特判）", () => {
  // `retrieve()` 的 idx 从 1 起，所以 0 永远不在候选集里；这里不需要"0 特判"的分支，
  // 集合比对本身就把它判成非法。若哪天有人给 0 开了后门，这条断言会红。
  const verdict = validateCitations("见 a[0]。", CANDIDATES);
  assert.ok(!verdict.ok);
  assert.equal(verdict.reason, "illegal_mark");
  assert.deepEqual(verdict.marks, [0]);
  assert.deepEqual(verdict.illegal, [0]);
});

test("④ 超大编号不抛错（不引入任何算术假设）", () => {
  // Number("999999999999999999999") === 1e21：有限、可比较，落不进候选集 → 非法。
  assert.doesNotThrow(() => extractMarks("[999999999999999999999]"));
  const huge = validateCitations("见 [1] 与 [999999999999999999999]。", CANDIDATES);
  assert.ok(!huge.ok);
  assert.equal(huge.reason, "illegal_mark");
  assert.deepEqual(huge.illegal, [Number("999999999999999999999")]);

  // 400 位数字 → Number 得到 Infinity，同样不抛、同样判非法。校验函数不许因为
  // 一个荒唐数字炸掉整轮对话（炸了就是 500 面对客户，而这本来只是一次拒答）。
  const digits = "9".repeat(400);
  assert.equal(Number(digits), Number.POSITIVE_INFINITY);
  const overflow = validateCitations(`见 [${digits}]。`, CANDIDATES);
  assert.ok(!overflow.ok);
  assert.equal(overflow.reason, "illegal_mark");
  assert.deepEqual(overflow.illegal, [Number.POSITIVE_INFINITY]);
});

// ─────────────────────── 通过：升序、去重、快照 ───────────────────────

test("通过：[2][1][1] → 引用按 idx 升序且去重", () => {
  const verdict = validateCitations("先看 [2]，再看 [1]，最后重申 [1]。", CANDIDATES);
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.citations.map((c) => c.idx), [1, 2], "升序，与首次出现顺序 [2,1] 无关");
  assert.equal(verdict.citations.length, 2, "[1] 出现两次只算一条引用");
  // 去重不能把重复的角标并成一条别的候选：两条的 chunk_id 必须各自对应。
  assert.deepEqual(verdict.citations.map((c) => c.chunk_id), [1001, 1002]);
});

test("通过：长句里的角标照常取到（[2] [3] 在同一行）", () => {
  const verdict = validateCitations(
    "Die Garantie für den Wechselrichter beträgt zehn Jahre [2] [3].",
    CANDIDATES,
  );
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.citations.map((c) => c.idx), [2, 3]);
});

test("通过：[007] 折成 7（Number(\"007\") === 7），与 [7] 指同一条候选", () => {
  const seven: readonly Candidate[] = [candidate(7, { chunk_id: 7007, page: null })];
  assert.deepEqual(extractMarks("[007]"), [7]);

  const verdict = validateCitations("详见 [007]。", seven);
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.citations.map((c) => c.idx), [7]);

  // 前导零只是写法差异，不是新编号：`[7]` 与 `[007]` 一起出现时仍然只有一条引用。
  const both = validateCitations("先 [7]，再 [007]。", seven);
  assert.ok(both.ok);
  assert.equal(both.citations.length, 1);
});

test("通过：快照逐字复制候选字段（title/page/lang/snippet/score/chunk_id）", () => {
  const first: Candidate = {
    idx: 1,
    chunk_id: 4242,
    doc_title: DOC_DE,
    doc_lang: "de",
    page: 37,
    section: "6.2 Fehlercodes",
    snippet: "Der Wechselrichter meldet E03 bei Netzüberspannung.",
    score: 0.4321,
  };
  // page 为 null 的候选（同一文档跨页的块）：null 必须原样留住，不能被补成 0 或丢掉字段。
  const second: Candidate = {
    idx: 2,
    chunk_id: 4343,
    doc_title: "Warranty Terms",
    doc_lang: "en",
    page: null,
    snippet: "The warranty period is ten years.",
    score: 0.3987,
  };

  const verdict = validateCitations("保修十年 [2]，故障码见 [1]。", [first, second]);
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.citations, [
    {
      idx: 1,
      chunk_id: 4242,
      doc_title: DOC_DE,
      doc_lang: "de",
      page: 37,
      snippet: "Der Wechselrichter meldet E03 bei Netzüberspannung.",
      score: 0.4321,
    },
    {
      idx: 2,
      chunk_id: 4343,
      doc_title: "Warranty Terms",
      doc_lang: "en",
      page: null,
      snippet: "The warranty period is ten years.",
      score: 0.3987,
    },
  ]);

  // 快照的字段集合就是下发契约：多一个 doc_id/section 都会漏进前端，
  // 少一个（page/snippet）后端兜底在前端就无从渲染。用 key 集合把契约钉住。
  assert.deepEqual(
    Object.keys(verdict.citations[0]!).sort(),
    ["chunk_id", "doc_lang", "doc_title", "idx", "page", "score", "snippet"],
  );
});

test("快照不是对候选对象的引用（改候选不影响已产出的引用）", () => {
  // 快照要能在片段被重新索引后仍然可读，所以它是值拷贝而不是别名。
  const mutable: Candidate = candidate(1);
  const verdict = validateCitations("见 [1]。", [mutable]);
  assert.ok(verdict.ok);
  mutable.doc_title = "被改过的标题";
  mutable.snippet = "被改过的正文";
  assert.equal(verdict.citations[0]!.doc_title, DOC_DE);
  assert.equal(verdict.citations[0]!.snippet, "Wechselrichter Abschnitt 1");
});

test("同一 idx 出现两条候选时认第一条（不让 Map 的写入顺序决定快照）", () => {
  const duplicated: readonly Candidate[] = [
    candidate(1, { chunk_id: 111, snippet: "第一条" }),
    candidate(1, { chunk_id: 222, snippet: "第二条" }),
  ];
  const verdict = validateCitations("见 [1]。", duplicated);
  assert.ok(verdict.ok);
  assert.equal(verdict.citations.length, 1);
  assert.equal(verdict.citations[0]!.chunk_id, 111);
  assert.equal(verdict.citations[0]!.snippet, "第一条");
});

test("候选自带 chunk_id 缺失时落成 null（列可空），而不是 undefined", () => {
  // 类型上不可能，但要保证进 JSON 时该字段存在：undefined 会整个字段消失，
  // 落库/下发时会变成"少一列"，比 null 难查得多。
  const noChunkId = { ...candidate(1), chunk_id: undefined } as unknown as Candidate;
  const verdict = validateCitations("见 [1]。", [noChunkId]);
  assert.ok(verdict.ok);
  assert.equal(verdict.citations[0]!.chunk_id, null);
  assert.deepEqual(Object.keys(verdict.citations[0]!).sort(), [
    "chunk_id",
    "doc_lang",
    "doc_title",
    "idx",
    "page",
    "score",
    "snippet",
  ]);
});
