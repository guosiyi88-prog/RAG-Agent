/**
 * 术语一致性（12-i18n.md §5 / 02-corpus-ingestion「术语按术语表逐条对齐」）。
 *
 * 纯函数 + 纯文件断言，不连数据库、不建连接池：`src/core/terms.ts` 不 import `src/db.ts`，
 * 本文件也不 import，所以哪怕数据层没起也能跑完（几毫秒）。
 *
 * 三个方向都要有：
 *   - 正例：真实语料每族每语种都对齐（这份断言会随语料更新而自动收紧）；
 *   - 负例：合成一族故意写错术语必须被抓出来 —— 没有负例，匹配器"永远返回空数组"也能全绿；
 *   - 形状：术语表解析出 10 条、列序不能错（列错位会让机检对齐到错误的语言）。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  acceptedForms,
  checkFamily,
  findCjkResidue,
  GLOSSARY_TERM_COUNT,
  GlossaryParseError,
  groupFamilies,
  parseGlossary,
  termsPresentIn,
  type FamilyDoc,
  type GlossaryTerm,
} from "../src/core/terms.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const GLOSSARY_DOC = join(repoRoot, "docs/prdv1.1/12-i18n.md");
const CORPUS_DIR = join(repoRoot, "corpus");

async function loadGlossary(): Promise<GlossaryTerm[]> {
  return parseGlossary(await readFile(GLOSSARY_DOC, "utf8"));
}

/** 递归收集 corpus 下除 `.` 开头条目外的 markdown —— 与 ingest / scripts/check-terms.ts 同一口径。 */
async function collectMarkdown(dir: string, prefix = ""): Promise<{ path: string; text: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const docs: { path: string; text: string }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) docs.push(...(await collectMarkdown(join(dir, entry.name), path)));
    else if (entry.name.toLowerCase().endsWith(".md")) {
      docs.push({ path, text: await readFile(join(dir, entry.name), "utf8") });
    }
  }
  return docs;
}

test("术语表解析出 10 条，五列不串位", async () => {
  const glossary = await loadGlossary();
  assert.equal(glossary.length, GLOSSARY_TERM_COUNT, "§5 术语表必须解析出 10 条");
  for (const term of glossary) {
    for (const [lang, value] of Object.entries(term)) {
      assert.ok(value !== "", `${term.zh} 的 ${lang} 栏不该为空`);
    }
  }
  // 抽查一条五语：列序错了（比如把 de 读成 nl）会让机检对齐到错误语言，那是假绿灯
  assert.deepEqual(
    glossary.find((term) => term.zh === "复位"),
    { zh: "复位", en: "reset", de: "zurücksetzen", nl: "resetten", es: "reiniciar" },
  );
});

test("术语表形状不对时抛 GlossaryParseError，不退化成零条", () => {
  // 只有两列
  assert.throws(
    () => parseGlossary("| zh | en |\n|---|---|\n| 逆变器 | inverter |\n"),
    (err: unknown) => err instanceof GlossaryParseError,
  );
  // 五列表头但少行
  const sixRows = [
    "| zh | en | de | nl | es |",
    "|---|---|---|---|---|",
    "| 逆变器 | inverter | Wechselrichter | omvormer | inversor |",
  ].join("\n");
  assert.throws(
    () => parseGlossary(sixRows),
    (err: unknown) => err instanceof GlossaryParseError && /期望 10 条/.test(err.message),
  );
  // 空单元格
  const emptyCell = [
    "| zh | en | de | nl | es |",
    "|---|---|---|---|---|",
    ...Array.from({ length: GLOSSARY_TERM_COUNT }, (_, i) => `| 词${i} | en${i} | de${i} | nl${i} |  |`),
  ].join("\n");
  assert.throws(
    () => parseGlossary(emptyCell),
    (err: unknown) => err instanceof GlossaryParseError && /为空/.test(err.message),
  );
});

test("负例：目标语换了词必须被抓出来（匹配器不能空转）", async () => {
  const glossary = await loadGlossary();
  const docs: FamilyDoc[] = [
    { lang: "zh", file: "demo.zh.md", text: "## 1 复位\n\n设备需要复位时，长按按键五秒。\n" },
    // "neu gestartet" 是换个说法，不是屈折：§5 明令不得同义替换
    { lang: "de", file: "demo.de.md", text: "## 1 Neustart\n\nMuss das Gerät neu gestartet werden, halten Sie die Taste fünf Sekunden.\n" },
  ];
  const violations = checkFamily("demo", docs, glossary);
  assert.equal(violations.length, 1, "德语把 复位 写成 neustarten 必须算违规");
  assert.equal(violations[0]?.zhTerm, "复位");
  assert.equal(violations[0]?.expected, "zurücksetzen");
  assert.equal(violations[0]?.lang, "de");
  assert.equal(violations[0]?.file, "demo.de.md");
});

test("正例：声明的屈折形式算对齐，未声明的写法仍算违规", async () => {
  const glossary = await loadGlossary();
  const zh: FamilyDoc = { lang: "zh", file: "demo.zh.md", text: "设备需要复位。\n" };

  for (const [variant, text] of [
    ["原形", "Das Gerät muss zurücksetzen."],
    ["过去分词", "Das Gerät muss zurückgesetzt werden."],
    ["名词化复数", "nach drei Zurücksetzungen"],
    ["可分前缀在句末", "Setzen Sie das Gerät nicht wiederholt zurück."],
  ] as const) {
    assert.deepEqual(
      checkFamily("demo", [zh, { lang: "de", file: "demo.de.md", text }], glossary),
      [],
      `德语 ${variant}应算同一个词的屈折`,
    );
  }

  // 没有声明的屈折（这里故意用错词干）必须仍然失败：屈折表只放宽"同一个词"
  assert.equal(
    checkFamily("demo", [zh, { lang: "de", file: "demo.de.md", text: "Das Gerät muss neu starten." }], glossary).length,
    1,
  );
});

test("没有中文主源、或缺某语种（spec 无 nl/es）都不算违规", async () => {
  const glossary = await loadGlossary();
  // 只有 de/en、没有 zh：没有基准就没有可对齐的东西
  assert.deepEqual(
    checkFamily("demo", [{ lang: "de", file: "demo.de.md", text: "nur Deutsch" }], glossary),
    [],
  );
  const zh: FamilyDoc = { lang: "zh", file: "spec.zh.md", text: "逆变器与保修。\n" };
  assert.deepEqual(
    checkFamily("spec", [zh, { lang: "de", file: "spec.de.md", text: "Wechselrichter und Garantie." }], glossary),
    [],
    "只检查存在的语言：缺 nl/es 文件不是术语违规",
  );
});

test("真实语料每族每语种术语都对齐", async () => {
  const glossary = await loadGlossary();
  const { families, unclassified } = groupFamilies(await collectMarkdown(CORPUS_DIR));

  assert.deepEqual(unclassified, [], "语料文件名必须写明语种，否则无法分组也无法入库");
  assert.ok(families.length >= 3, `至少三族（warranty/install/spec），实际 ${families.length}`);

  const offenders = families.flatMap((family) => checkFamily(family.name, family.docs, glossary));
  const detail = offenders
    .map((item) => `${item.file}: ${item.zhTerm} 应为 "${item.expected}"`)
    .join("\n");
  assert.deepEqual(offenders, [], `语料里有术语没按 §5 术语表对齐：\n${detail}`);

  // 反向断言：真语料里确实有术语被检查到，否则"全绿"可能只是没找到任何术语
  const checked = families
    .filter((family) => family.docs.some((doc) => doc.lang === "zh"))
    .map((family) => {
      const baseline = family.docs.find((doc) => doc.lang === "zh")!;
      return { name: family.name, terms: termsPresentIn(baseline.text, glossary).length };
    });
  assert.equal(checked.length, 3, "warranty/install/spec 三族都该有中文主源");
  for (const family of checked) {
    assert.ok(family.terms >= 3, `${family.name}.zh 只命中 ${family.terms} 条术语，基准太少说明语料或术语表脱节`);
  }
});

test("de/nl/es 语料文件里没有汉字（机翻残留 / 文件贴错）", async () => {
  const docs = await collectMarkdown(CORPUS_DIR);
  const latin = docs.filter((doc) => /\.(de|nl|es)\.md$/i.test(doc.path));
  // 保修/安装各五语 → de/nl/es 各 2 个；产品参数三类（中/英/德）→ de 多 1 个 = 7
  assert.equal(latin.length, 7, `de/nl/es 语料文件数变了（${latin.length}）：确认语料清单后再改这条断言`);

  for (const doc of latin) {
    const lang = /\.(de|nl|es)\.md$/i.exec(doc.path)?.[1] ?? "";
    const lines = findCjkResidue(lang, doc.text);
    assert.deepEqual(lines, [], `${doc.path} 第 ${lines.join(",")} 行含汉字`);
  }
});

test("acceptedForms 对未知语言/未知术语返回原样", () => {
  assert.deepEqual(acceptedForms("fr", "reset"), ["reset"]);
  assert.deepEqual(acceptedForms("de", "Garantie"), ["Garantie"]);
  assert.deepEqual(acceptedForms("de", "zurücksetzen").length > 1, true);
});
