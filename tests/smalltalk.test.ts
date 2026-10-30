/**
 * 寒暄前置的判据（R1-1）。
 *
 * 这条判据的失败方式不对称，所以两个方向都要钉：
 *   - **漏判**（真招呼被当问题）→ 走检索 → 拒答 + 建单，队列灌满噪声（实测每句 +1 张单）；
 *   - **误判**（真问题被当招呼）→ 用户问"保修多久"却收到"你好，我能做三件事"，问题被吃掉。
 * 后者的代价更大，所以判据是"整句都是招呼词"，而不是"包含招呼词"。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const mod = await import("../src/core/smalltalk.ts") as {
  isGreeting: (text: string) => boolean;
  greetingReply: (text: string, lang: "zh" | "en" | "de" | "nl" | "es") => string | null;
};
const { isGreeting, greetingReply } = mod;

test("五语招呼都算招呼（含大小写、标点、致谢）", () => {
  for (const text of ["你好", "您好！", "在吗", "谢谢", "Hello", "hi!", "thanks", "Hallo", "Guten Tag!", "Danke schön", "Hoi", "Goedendag", "Bedankt", "Hola", "Buenos días", "Gracias"]) {
    assert.equal(isGreeting(text), true, `"${text}" 应当是招呼`);
  }
});

test("带实体的句子不是招呼：问题不能被招呼话术吃掉", () => {
  for (const text of [
    "你好，请问保修多久？",
    "Hallo, wie lange ist die Garantie?",
    "Hello, how long is the warranty?",
    "你好 我的逆变器报 E03 怎么办",
    "Hola, ¿cuánto dura la garantía?",
    "Hallo, ik heb een vraag over de installatie",
  ]) {
    assert.equal(isGreeting(text), false, `"${text}" 带实体，不能判成招呼`);
  }
});

test("短但不像招呼的输入一律不判（数字、单词、空白）", () => {
  for (const text of ["E03", "2032", "230V", "ok", "garantie", "warranty", "", "   ", "?", "!!!", "谢谢E03"]) {
    assert.equal(isGreeting(text), false, `"${text}" 不该判成招呼`);
  }
});

test("招呼话术按已解析的语言给，且五语各不相同", () => {
  const langs = ["zh", "en", "de", "nl", "es"] as const;
  const copies = langs.map((lang) => greetingReply("你好", lang));
  for (const [i, copy] of copies.entries()) {
    assert.equal(typeof copy, "string");
    assert.ok((copy as string).length > 20, `${langs[i]} 的话术不能是空串`);
    assert.ok((copy as string).includes("E03"), `${langs[i]} 的话术要给一个可照抄的例子（E03）`);
  }
  assert.equal(new Set(copies).size, langs.length, "五语话术必须互不相同（复制粘贴漏改会立刻暴露）");
  // 非招呼输入不产生话术：这条保证调用方不需要自己再判一次。
  assert.equal(greetingReply("保修多久？", "zh"), null);
});
