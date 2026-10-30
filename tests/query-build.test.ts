/**
 * Query 构建的断言（07-retrieval.md §3）。
 *
 * 纯函数、无库、无网络：毫秒级跑完，谁都能随手跑一遍。
 * 这里钉住两件事：一、什么时候拼上一轮；二、这个函数永远只做字符串拼接 ——
 * 一旦有人往 `src/core/query.ts` 里塞进模型调用、翻译或词典，静态那条断言会先红。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildQuery, QUERY_STITCH_MAX_CHARS } from "../src/core/query.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const PREV_DE = "Welcher Wechselrichter?";
const PREV_ZH = "这套储能系统的额定功率是多少？";

// ─────────────────────── 07 §3 的表格 ───────────────────────

test("07 §3 表格 1 行：首轮没有上一轮，直接用当前问题", () => {
  assert.equal(buildQuery("E03"), "E03");
  assert.equal(buildQuery("  保修期多久  "), "保修期多久", "首轮也要 trim");
  assert.equal(buildQuery("E03", undefined), "E03");
});

test("07 §3 表格 2 行：短追问（Und wie viel Watt?）拼上一轮", () => {
  const current = "Und wie viel Watt?";
  assert.equal(buildQuery(current, PREV_DE), `${PREV_DE}\n${current}`);
});

test("07 §3 表格 3 行：自带主语的完整问句不拼（长度以实测为准，见本用例说明）", () => {
  // 规格表格里的例外句子实测只有 22 个字符（不是"长问句"），按 §3 的分支 `长度 ≤ 25` 必须拼接。
  // 文档里的字符数是手写的（它把 18 字符的 "Und wie viel Watt?" 记成 24 字符），不可信；
  // 这里以 §3 的代码分支为准，把实测行为钉住，避免这个矛盾被悄悄改来改去。
  const specExample = "为什么太阳能板发烫正常吗这个问题我想确认一下";
  assert.equal(specExample.length, 22);
  assert.equal(buildQuery(specExample, PREV_ZH), `${PREV_ZH}\n${specExample}`);

  // 真正的长问句（> 25 字符）不拼：这才是表格那一行想表达的语义
  const longQuestion = `${specExample}请给出具体的型号、安装方式与排查步骤`;
  assert.ok(longQuestion.length > QUERY_STITCH_MAX_CHARS, `长问句例句必须超过 ${QUERY_STITCH_MAX_CHARS} 字符，实际 ${longQuestion.length}`);
  assert.equal(buildQuery(longQuestion, PREV_ZH), longQuestion);
});

test("07 §3 表格 4 行：上一轮不存在时直接用当前问题（长短都一样）", () => {
  assert.equal(buildQuery("那瓦数呢？"), "那瓦数呢？");
  assert.equal(buildQuery("那瓦数呢？", ""), "那瓦数呢？");
});

// ─────────────────────── 长度边界 ───────────────────────

test(`长度边界：正好 ${QUERY_STITCH_MAX_CHARS} 字符拼接，${QUERY_STITCH_MAX_CHARS + 1} 字符且含实词不拼`, () => {
  // 长度靠程序数，不靠眼睛数（规格文档就是在这里记错的）
  const atLimit = "Watt".padEnd(QUERY_STITCH_MAX_CHARS, "x");
  const overLimit = "Watt".padEnd(QUERY_STITCH_MAX_CHARS + 1, "x");
  assert.equal(atLimit.length, QUERY_STITCH_MAX_CHARS);
  assert.equal(overLimit.length, QUERY_STITCH_MAX_CHARS + 1);
  assert.match(atLimit, /[a-zA-Z]{3,}/, "边界用例必须含实词，否则命中的是另一条分支");
  assert.match(overLimit, /[a-zA-Z]{3,}/);

  assert.equal(buildQuery(atLimit, PREV_DE), `${PREV_DE}\n${atLimit}`);
  assert.equal(buildQuery(overLimit, PREV_DE), overLimit, "超过上限且含实词时原样返回，拼接会让 query 漂移");
});

test("短问题但没有实词：即使带上一轮也拼（长度已超上限时靠实词分支）", () => {
  // "OK?"只有两个字母、总长 ≤ 25：长短分支就会命中
  assert.equal(buildQuery("OK?", PREV_DE), `${PREV_DE}\nOK?`);
  assert.equal(buildQuery("??", PREV_DE), `${PREV_DE}\n??`);

  // 型号短串：长度已超 25 但没有连续三个字母/汉字 —— 命中"无实词"分支
  const noContentWord = "E03, F21, 600W, 12V, 24V, 48V?";
  assert.equal(noContentWord.length > QUERY_STITCH_MAX_CHARS, true);
  assert.doesNotMatch(noContentWord, /[a-zA-Z\u4e00-\u9fa5]{3,}/);
  assert.equal(buildQuery(noContentWord, PREV_DE), `${PREV_DE}\n${noContentWord}`);
});

// ─────────────────────── prevUser 的处理 ───────────────────────

test("prevUser：两侧空白被 trim，全空白的 prevUser 等同没有上一轮", () => {
  const current = "那瓦数呢？";
  assert.equal(buildQuery(current, `  ${PREV_ZH}\t\n`), `${PREV_ZH}\n${current}`);
  assert.equal(buildQuery(current, "   "), current, "空白 prevUser 不能拼出 '   \\n当前问题'");
  assert.equal(buildQuery(current, "\n\t "), current);
});

test("当前问题全空白返回空串，绝不把空白拼到上一轮后面", () => {
  assert.equal(buildQuery(""), "");
  assert.equal(buildQuery("   "), "");
  assert.equal(buildQuery("\n\t "), "");
  // 带上一轮时同样返回空串：调用方据此直接返回空结果，不去打嵌入接口
  assert.equal(buildQuery("   ", PREV_ZH), "");
  assert.equal(buildQuery("", PREV_ZH), "");
});

// ─────────────────────── 拼接形状与"什么都不做" ───────────────────────

test("拼接形状：单个换行分隔，上一轮在前、当前在后", () => {
  const current = "Und wie viel Watt?";
  const stitched = buildQuery(current, PREV_DE);

  assert.equal(stitched.startsWith(PREV_DE), true, "必须以上一轮开头");
  assert.equal(stitched.endsWith(current), true, "必须以当前问题结尾");
  assert.equal(stitched.split("\n").length, 2, "只能有一个分隔换行，拼成一个两行的 query");
  assert.equal(stitched, `${PREV_DE}\n${current}`);
});

test("不做小写化、不去标点、不翻译、不改写：原样保留大小写与标点", () => {
  assert.equal(buildQuery("  Garantie BATTERIE?  "), "Garantie BATTERIE?");
  assert.equal(buildQuery("WT-ESS-5K 的额定功率？"), "WT-ESS-5K 的额定功率？");
  assert.equal(
    buildQuery("e03?", "  Welcher FEHLER; bitte!  "),
    "Welcher FEHLER; bitte!\ne03?",
    "上一轮也只 trim，大小写与标点一律不动",
  );
  // 纯函数：同样的输入调两次结果相同（没有隐藏状态、没有时间/随机数）
  assert.equal(buildQuery("那瓦数呢？", PREV_ZH), buildQuery("那瓦数呢？", PREV_ZH));
});

// ─────────────────────── 反回归（静态） ───────────────────────

test("query.ts 不 import 任何东西：没有模型调用、翻译与词典的入口", async () => {
  const source = await readFile(join(repoRoot, "src/core/query.ts"), "utf8");

  // ADR-0003：不许用模型改写 query。一次改写要多 1.5s，改错了污染整条链路；
  // 只要有人加一行 import，这里就先红 —— 这是"不做改写"唯一可机器检查的形式。
  assert.doesNotMatch(source, /^import\s/m, "src/core/query.ts 必须无 import");
  assert.doesNotMatch(source, /\brequire\s*\(/, "不许 require 走旁路");
  assert.doesNotMatch(source, /\bfetch\s*\(/, "不许发网络请求");
  assert.doesNotMatch(source, /toLowerCase|toUpperCase/, "不改变大小写");
  assert.doesNotMatch(source, /translate|translat/i, "不做翻译");
  assert.doesNotMatch(source, /\basync\b|\bawait\b|Promise/, "必须保持纯同步");
});
