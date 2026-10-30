/**
 * 拒答判定的纯单元测试（06-agent.md §5.1 五条判定 + §5.3 五语话术）。
 *
 * **不连库、不打网络、不读 .env**：`src/core/refusal.ts` 只有三个 `import type`
 * （编译后全部消失，运行时零依赖），所以这里可以静态 import。全部毫秒级跑完：
 *   node --test --test-concurrency=1 tests/refusal.test.ts
 *
 * 这里钉的是本票据的两条红线：
 *   1. **顺序**：五条判定命中即返回，原因必须一一对上（③ 记 no_citation、④ 记 low_conf）；
 *   2. **话术是常量**：五句话逐字节比对，外加两条静态断言 —— 话术模块不许碰模型客户端，
 *      提示词里不许出现话术原文（否则模型会学着说，客户会看到"模型自己说要建单"）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { LANGUAGES } from "../src/core/chunk.ts";
import { REFUSAL, decideRefusal, refusalText } from "../src/core/refusal.ts";
import type { RefusalInput } from "../src/core/refusal.ts";
import type { CitationVerdict } from "../src/core/citations.ts";

/** 06 §5.3 的权威话术，测试里**再抄一遍**：两边不一致就说明有人改了其中一份。 */
const COPY = {
  zh: "这个问题我需要工程师确认。已为你创建工单，我们会在 4 小时内联系你。",
  en: "I need an engineer to confirm this. I've created a ticket for you; we'll get back to you within 4 hours.",
  de: "Das muss ein Techniker prüfen. Ich habe ein Ticket für Sie erstellt; wir melden uns innerhalb von 4 Stunden.",
  nl: "Dit moet een technicus bevestigen. Ik heb een ticket voor u aangemaakt; we nemen binnen 4 uur contact op.",
  es: "Necesito que lo confirme un técnico. He creado un ticket; te contactaremos en un plazo de 4 horas.",
} as const;

/** 校验通过的一轮：候选 1..2，正文两处角标都对得上。 */
function citationOk(): CitationVerdict {
  return {
    ok: true,
    citations: [
      {
        idx: 1,
        chunk_id: 1001,
        doc_title: "Installationshandbuch Wechselrichter",
        doc_lang: "de",
        page: 11,
        snippet: "Wechselrichter Abschnitt 1",
        score: 0.41,
      },
    ],
  };
}

function citationFail(reason: "no_candidates" | "no_marks" | "illegal_mark"): CitationVerdict {
  return { ok: false, reason, marks: [], illegal: [] };
}

/** 一个"正常可答"的基准输入：0.42 分、无降级、引用对得上。 */
function input(overrides: Partial<RefusalInput> = {}): RefusalInput {
  return {
    fallback: "none",
    topScore: 0.42,
    minScore: 0.3,
    citationVerdict: citationOk(),
    text: "这款逆变器保修十年 [1]。",
    ...overrides,
  };
}

// ─────────────────────── ⑤ 通过 ───────────────────────

test("基准一轮（分数够、引用对得上、无哨兵）：不拒答", () => {
  const verdict = decideRefusal(input());
  assert.deepEqual(verdict, { refuse: false });
  // 通过时**不许**带 reason：收尾流程靠 `refuse` 分支，多了个 reason 会诱使调用方
  // 在"通过"分支里也去建单。
  assert.equal("reason" in verdict, false);
});

// ─────────────────────── ①-a 检索空 ───────────────────────

test("①-a fallback=empty：直接 no_citation，不看分数与引用校验", () => {
  // 检索没结果时模型根本不该被调用；即使传进来的分数/引用看着正常，也必须拒答。
  const verdict = decideRefusal(input({ fallback: "empty", topScore: 0.9 }));
  assert.deepEqual(verdict, { refuse: true, reason: "no_citation" });
});

test("①-a 先于 ①-b：empty + 低分仍记 no_citation（不是 low_conf）", () => {
  const verdict = decideRefusal(input({ fallback: "empty", topScore: 0.01 }));
  assert.deepEqual(verdict, { refuse: true, reason: "no_citation" });
});

// ─────────────────────── ①-b 低置信 ───────────────────────

test("①-b 融合分低于阈值：low_conf", () => {
  const verdict = decideRefusal(input({ topScore: 0.29 }));
  assert.deepEqual(verdict, { refuse: true, reason: "low_conf" });
});

test("①-b 边界：topScore === minScore 不拒答（严格小于，不是小于等于）", () => {
  assert.deepEqual(decideRefusal(input({ topScore: 0.3, minScore: 0.3 })), { refuse: false });
  assert.deepEqual(decideRefusal(input({ topScore: 0.300001, minScore: 0.3 })), { refuse: false });
});

test("①-b 先于 ②：低分 + 无候选记 low_conf（低分先命中就返回）", () => {
  const verdict = decideRefusal(input({ topScore: 0.1, citationVerdict: citationFail("no_candidates"), text: "" }));
  assert.deepEqual(verdict, { refuse: true, reason: "low_conf" });
});

test("阈值可配：minScore 调到 0.38 时 0.35 变成 low_conf", () => {
  assert.deepEqual(decideRefusal(input({ topScore: 0.42 })), { refuse: false });
  assert.deepEqual(decideRefusal(input({ topScore: 0.35, minScore: 0.38 })), { refuse: true, reason: "low_conf" });
});

// ─────────────────────── fts_only 不单独拒答 ───────────────────────

test("降级标签 fts_only 本身不拒答：分数与引用说了算", () => {
  // fts_only 只说明向量召回降级到词法召回。把它当拒答理由，会让一次 embed 超时
  // 把接下来整段时间的正常问答全变成工单。
  assert.deepEqual(decideRefusal(input({ fallback: "fts_only", topScore: 0.42 })), { refuse: false });
});

test("fts_only + 低分：low_conf（理由来自分数，不是来自降级标签）", () => {
  const verdict = decideRefusal(input({ fallback: "fts_only", topScore: 0.2 }));
  assert.deepEqual(verdict, { refuse: true, reason: "low_conf" });
});

test("fts_only + 无角标散文：no_citation（降级不影响引用校验的结论）", () => {
  const verdict = decideRefusal(input({ fallback: "fts_only", citationVerdict: citationFail("no_marks") }));
  assert.deepEqual(verdict, { refuse: true, reason: "no_citation" });
});

// ─────────────────────── ② 哨兵与空候选 ───────────────────────

test("② 正文含 NO_ANSWER：no_citation（即使引用校验通过）", () => {
  const verdict = decideRefusal(input({ text: "NO_ANSWER" }));
  assert.deepEqual(verdict, { refuse: true, reason: "no_citation" });
});

test("② 哨兵可出现在任何位置：子串匹配，不要求整段", () => {
  const verdict = decideRefusal(input({ text: "抱歉，NO_ANSWER 我不确定 [1]。" }));
  assert.deepEqual(verdict, { refuse: true, reason: "no_citation" });
});

test("② 哨兵大小写敏感：散文里的小写 no_answer 不算哨兵", () => {
  // 规范口径是区分大小写的 includes。放宽成不区分大小写，会把正常散文误判成拒答。
  const verdict = decideRefusal(input({ text: "资料里写着 no_answer 这类备注，见 [1]。" }));
  assert.deepEqual(verdict, { refuse: false });
});

test("② 整段就是哨兵（大小写/结尾标点/首尾空白）：no_citation", () => {
  for (const text of ["  no_answer.\n", "NO_ANSWER。", "No_Answer", "NO_ANSWER!"]) {
    assert.deepEqual(decideRefusal(input({ text })), { refuse: true, reason: "no_citation" }, text);
  }
});

test("② 哨兵先于 ③④：哨兵 + 非法角标一致记 no_citation，不是 low_conf", () => {
  const verdict = decideRefusal(input({ text: "NO_ANSWER [9]", citationVerdict: citationFail("illegal_mark") }));
  assert.deepEqual(verdict, { refuse: true, reason: "no_citation" });
});

test("② 候选缓冲为空（no_candidates）：no_citation", () => {
  const verdict = decideRefusal(input({ citationVerdict: citationFail("no_candidates"), text: "" }));
  assert.deepEqual(verdict, { refuse: true, reason: "no_citation" });
});

// ─────────────────────── ③④ 引用校验的两个原因 ───────────────────────

test("③ 通篇没有角标（no_marks）：no_citation", () => {
  const verdict = decideRefusal(input({ citationVerdict: citationFail("no_marks"), text: "这款逆变器保修十年。" }));
  assert.deepEqual(verdict, { refuse: true, reason: "no_citation" });
});

test("④ 角标不在候选集（illegal_mark）：low_conf", () => {
  const verdict = decideRefusal(input({ citationVerdict: citationFail("illegal_mark"), text: "见 [9]。" }));
  assert.deepEqual(verdict, { refuse: true, reason: "low_conf" });
});

test("③ 与 ④ 的原因不同：no_marks → no_citation，illegal_mark → low_conf", () => {
  // 两者的模型侧修法不同（补标注 vs 别编编号），混成一个原因就没法按统计改 prompt。
  assert.deepEqual(decideRefusal(input({ citationVerdict: citationFail("no_marks") })), {
    refuse: true,
    reason: "no_citation",
  });
  assert.deepEqual(decideRefusal(input({ citationVerdict: citationFail("illegal_mark") })), {
    refuse: true,
    reason: "low_conf",
  });
});

test("三个拒答原因之外不产生别的 reason", () => {
  const cases: RefusalInput[] = [
    input({ fallback: "empty" }),
    input({ topScore: 0 }),
    input({ citationVerdict: citationFail("no_candidates") }),
    input({ citationVerdict: citationFail("no_marks") }),
    input({ citationVerdict: citationFail("illegal_mark") }),
    input({ text: "NO_ANSWER" }),
  ];
  for (const probe of cases) {
    const verdict = decideRefusal(probe);
    assert.equal(verdict.refuse, true);
    if (verdict.refuse) assert.ok(verdict.reason === "no_citation" || verdict.reason === "low_conf");
  }
});

// ─────────────────────── 话术是常量 ───────────────────────

test("五语话术逐字节一致（06 §5.3，共 5 种语言、无缺漏）", () => {
  assert.deepEqual(Object.keys(REFUSAL).sort(), [...LANGUAGES].sort());
  for (const lang of LANGUAGES) {
    assert.equal(REFUSAL[lang], COPY[lang], `${lang} 话术与 06 §5.3 不一致`);
    assert.ok(REFUSAL[lang].trim().length > 0, `${lang} 话术不能为空`);
    // 前后空白会让前端画出空行，也说明是拼出来的而不是抄的。
    assert.equal(REFUSAL[lang], REFUSAL[lang].trim());
  }
});

test("话术不带单号占位符（单号走 refusal 事件，不拼进话术）", () => {
  for (const lang of LANGUAGES) {
    assert.doesNotMatch(REFUSAL[lang], /\{[^}]*\}|\$\{|%s|%d|__\w+__/u, `${lang} 出现了占位符`);
  }
});

test("refusalText：五语各取自己那句", () => {
  for (const lang of LANGUAGES) assert.equal(refusalText(lang), COPY[lang]);
});

test('refusalText：未知语言回落英语（"fr"）', () => {
  assert.equal(refusalText("fr"), COPY.en);
  assert.equal(refusalText("ja"), COPY.en);
  assert.equal(refusalText(""), COPY.en);
  assert.equal(refusalText("  "), COPY.en);
});

test("refusalText：带地区的标签取主语言（de-DE / zh_CN / ES-es）", () => {
  assert.equal(refusalText("de-DE"), COPY.de);
  assert.equal(refusalText("zh_CN"), COPY.zh);
  assert.equal(refusalText("ES-es"), COPY.es);
});

test("refusalText：话术从表里取，调用方可换表（不是硬编码分支）", () => {
  const custom = { ...REFUSAL, de: "PLATZHALTER" };
  assert.equal(refusalText("de", custom), "PLATZHALTER");
  // 未知语言仍然回落该表的 en，而不是常量表的 en。
  assert.equal(refusalText("fr", { ...REFUSAL, en: "FALLBACK" }), "FALLBACK");
});

// ─────────────────────── 静态防回归 ───────────────────────

const REFUSAL_SRC = readFileSync(new URL("../src/core/refusal.ts", import.meta.url), "utf8");
const CONFIG_SRC = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");

test("静态：话术模块不引用模型客户端，也不打网络（话术不得来自模型）", () => {
  const specifiers = [...REFUSAL_SRC.matchAll(/from\s+["']([^"']+)["']/gu)].map((m) => m[1]!);
  assert.deepEqual(specifiers.sort(), ["./chunk.ts", "./citations.ts", "./retrieval.ts"]);

  for (const specifier of specifiers) {
    assert.doesNotMatch(specifier, /embed|agent|hash-embed|node:|http|fetch|undici|dashscope|deepseek|openai/iu);
  }
  // 白名单之外再加三处直接搜：只要出现这几个词，这段逻辑就不再是纯的。
  assert.doesNotMatch(REFUSAL_SRC, /\bfetch\s*\(/u);
  assert.doesNotMatch(REFUSAL_SRC, /node:http|node:https|undici/u);
  assert.doesNotMatch(REFUSAL_SRC, /process\.env/u);
  // 三个 import 必须全是 `import type`：运行时零依赖，单测才能毫秒级、无 env 跑起来。
  const importLines = REFUSAL_SRC.match(/^import\s.*$/gmu) ?? [];
  assert.equal(importLines.length, 3);
  for (const line of importLines) assert.match(line, /^import type /u);
});

test("静态：system prompt 里不出现五语话术原文（否则模型会学着说）", () => {
  const match = /export const SUPPORT_SYSTEM_PROMPT = `([\s\S]*?)`;/u.exec(CONFIG_SRC);
  assert.ok(match, "src/config.ts 里找不到 SUPPORT_SYSTEM_PROMPT 模板字面量");
  const prompt = match[1]!;

  // 正向前提：提示词里必须有哨兵词，否则规则 3 被删了这条断言就失去意义。
  assert.match(prompt, /NO_ANSWER/u);

  for (const lang of LANGUAGES) {
    assert.equal(prompt.includes(REFUSAL[lang]), false, `提示词里出现了 ${lang} 话术原文`);
  }
  // 几句话的特征片段也一并挡掉：整句被拆开抄进去同样会教坏模型。
  for (const fragment of [
    "我需要工程师确认",
    "I need an engineer",
    "Das muss ein Techniker prüfen",
    "Dit moet een technicus bevestigen",
    "Necesito que lo confirme un técnico",
    "4 小时内联系你",
    "within 4 hours",
    "innerhalb von 4 Stunden",
    "binnen 4 uur",
    "en un plazo de 4 horas",
  ]) {
    assert.equal(prompt.includes(fragment), false, `提示词里出现了话术片段：${fragment}`);
  }
});
