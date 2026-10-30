/**
 * 输入语言检测与回落链（D5 / D18 / D20 / D28）。
 *
 * 两个被测函数：
 *   - `detectLang(text)`：规则法检测，判不出来必须返回 `null`（宁可回落，不许猜）；
 *   - `resolveTurnLang({...})`：回落链 `检测 → 会话记忆 → 客户端声明 → Accept-Language → en`。
 *
 * 对照集直接用 `corpus/.fixtures/qa_gold.json` 的 30 题 —— 它们每道都标了 `lang`，是仓库里
 * 现成、且与产品语料同源的语言样本；另加短码/混写/平票这些"刻意判不出来"的用例
 * （D20 说过不承诺准确率数字，那就不许只拿 30 道好句子自证）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** TS 模块由 node 直接跑（仓库无构建步骤），非字面量 import 绕开 tsconfig 的 include 约束。 */
const mod = await import("../src/core/lang-detect.ts") as {
  detectLang: (text: string) => "zh" | "en" | "de" | "nl" | "es" | null;
  resolveTurnLang: (input: {
    text: string;
    declared?: "zh" | "en" | "de" | "nl" | "es";
    remembered?: string;
    acceptLanguage?: "zh" | "en" | "de" | "nl" | "es";
  }) => "zh" | "en" | "de" | "nl" | "es";
};
const { detectLang, resolveTurnLang } = mod;

/** 30 道评测题的题面与标注语言。读盘而不是 import：夹具在 `.fixtures/`（被 ingest 跳过）。 */
const gold = JSON.parse(
  await readFile(join(repoRoot, "corpus", ".fixtures", "qa_gold.json"), "utf8"),
) as { items: { lang: string; question: string }[] };

test("对照集：qa_gold 的 30 道题逐条判对语言", () => {
  const wrong: string[] = [];
  for (const item of gold.items) {
    const got = detectLang(item.question);
    if (got !== item.lang) wrong.push(`${item.lang}→${String(got)}: ${item.question.slice(0, 50)}`);
  }
  assert.deepEqual(wrong, [], `判错 ${wrong.length}/${gold.items.length} 道`);
});

test("五语代表句：中/英/德/荷/西各自命中", () => {
  assert.equal(detectLang("我的逆变器报 E03 怎么办"), "zh", "汉字直接定论");
  assert.equal(detectLang("How long is the warranty on the inverter?"), "en");
  assert.equal(detectLang("Wie hoch ist die Garantie?"), "de");
  assert.equal(detectLang("Hoe lang is de garantie?"), "nl");
  assert.equal(detectLang("¿Cuánto dura la garantía?"), "es", "倒问号直接定论");
  // 变音字母是德语的强信号：即使整句只有一个词也能定论。
  assert.equal(detectLang("Garantie für Wechselrichter"), "de");
  assert.equal(detectLang("Duur van de garantie voor omvormers"), "nl", "ij/oe 类荷兰语拼写");
});

test("判不出来就是 null：裸码、招呼语、纯数字、空白、超短", () => {
  for (const text of ["E03", "e03", "E99", "123", "230V", "", "   ", "?", "hallo", "de", "ok"]) {
    assert.equal(detectLang(text), null, `"${text}" 不该被猜成一门语言（回落链会处理）`);
  }
  // 裸故障码是最常见的一类：它在对话里必须靠"会话记忆"或"界面语言"决定，不能靠检测器。
  assert.equal(detectLang("E03"), null);
});

test("混写：中文夹故障码仍判中文，德语夹英文术语仍判德语", () => {
  assert.equal(detectLang("我的机器显示 E03，怎么处理？"), "zh");
  assert.equal(detectLang("Batterie zeigt Fault E07, was tun?"), "de");
  assert.equal(detectLang("¿Cómo resuelvo el código de fallo E03?"), "es");
});

test("回落链顺序：检测 → 会话记忆 → 客户端声明 → Accept-Language → en", () => {
  // ① 检测命中：压过其余三格（界面语言是德语，但客户输入的是中文 —— 录音里的核心场景）。
  assert.equal(resolveTurnLang({ text: "我的逆变器报 E03 怎么办", declared: "de", remembered: "de", acceptLanguage: "de" }), "zh");
  // ② 检测不出来时，会话记忆压过界面语言（裸码只能靠它）。
  assert.equal(resolveTurnLang({ text: "E03", declared: "en", remembered: "zh" }), "zh", "上一轮说中文，裸码也答中文");
  // ③ 没有记忆才看客户端声明。
  assert.equal(resolveTurnLang({ text: "E03", declared: "nl" }), "nl");
  // ④ 连声明都没有，用 Accept-Language。
  assert.equal(resolveTurnLang({ text: "E03", acceptLanguage: "es" }), "es");
  // ⑤ 什么都没有：en（与 `chat.ts` 端点兜底一致）。
  assert.equal(resolveTurnLang({ text: "E03" }), "en");
  // 记忆里是脏值（老版本写进去的、或语言表被改过）时跳过它，不要让脏值 500。
  assert.equal(resolveTurnLang({ text: "E03", declared: "de", remembered: "fr" }), "de");
  // 空白输入在上层就被 400 了，这里只保证不抛。
  assert.equal(resolveTurnLang({ text: "   ", declared: "zh" }), "zh");
});
