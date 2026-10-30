/**
 * 术语一致性检查（12-i18n.md §5 / 08-ingestion.md §9「术语表机检」）。
 *
 * 一条命令回答一个问题：**这份语料的术语，能不能对得上术语表？** 检查三件事：
 *   1. 每一族语料（warranty / install / spec …）里，中文主源出现过的术语，目标语必须是
 *      术语表写法或表里声明过的屈折形式（`src/core/terms.ts` 的 INFLECTIONS）；
 *   2. de/nl/es 文件里不得有汉字（机翻漏译、文件贴错）；
 *   3. 每个文件名都能读出语种（读不出就进不了任何一族，等于漏检）。
 *
 * 术语表从 PRD 现场解析，不在代码里留第二份：解析失败就退出码 1，绝不"零条术语、零违规"地通过。
 * 纯文件检查、不连数据库 —— 入库之前就能跑，不必等语料灌完。
 *
 * 不做（08 §3 的"不做"清单）：不翻译、不纠错、不改写语料，只报告差异由人决定。
 *
 * 用法：node --env-file-if-exists=.env scripts/check-terms.ts [语料目录，默认 corpus]
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  checkFamily,
  CJK_RESIDUE_RE,
  findCjkResidue,
  GLOSSARY_TERM_COUNT,
  groupFamilies,
  parseGlossary,
  termsPresentIn,
  type FamilyDoc,
  type GlossaryTerm,
} from "../src/core/terms.ts";

const GLOSSARY_DOC = "docs/prdv1.1/12-i18n.md";
const LABEL_WIDTH = 12;

interface Line {
  ok: boolean;
  label: string;
  detail: string;
}

function line(ok: boolean, label: string, detail: string): Line {
  return { ok, label, detail };
}

/**
 * 标签列按**显示宽度**补齐：`install.de` 与「术语表」混排时，padEnd 按码元算会让
 * 中文标签那几行整体左移，人眼扫一眼就发现对不齐（CJK 在等宽字体里占两列）。
 */
function padLabel(label: string): string {
  const width = [...label].reduce((sum, ch) => sum + (CJK_RESIDUE_RE.test(ch) ? 2 : 1), 0);
  return label + " ".repeat(Math.max(0, LABEL_WIDTH - width));
}

/** 递归收集语料目录下的 markdown；`.` 开头的文件/目录跳过（与 ingest 的 `isIgnored` 同一口径，`.fixtures/` 是夹具）。 */
async function collectMarkdown(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectMarkdown(full, files);
    else if (entry.name.toLowerCase().endsWith(".md")) files.push(full);
  }
  return files;
}

async function loadCorpus(root: string): Promise<{ path: string; text: string }[]> {
  const files = await collectMarkdown(root);
  return Promise.all(
    files.map(async (file) => ({
      path: relative(root, file).split("\\").join("/"),
      text: await readFile(file, "utf8"),
    })),
  );
}

function pairLines(
  name: string,
  docs: readonly FamilyDoc[],
  glossary: readonly GlossaryTerm[],
): Line[] {
  const baseline = docs.find((doc) => doc.lang === "zh");
  // 没有中文主源就没有基准：不是术语违规（缺文件由语料清单与 check-corpus 管），
  // 但 CJK 残留照样要查 —— 那是文件级问题，与有没有基准无关
  const terms = baseline === undefined ? [] : termsPresentIn(baseline.text, glossary);
  const lines: Line[] = [];
  if (baseline !== undefined) {
    lines.push(line(true, `${name}.zh`, `中文主源 ${baseline.text.length} 字符，术语基准 ${terms.length} 条`));
  }

  // 一族只算一次：checkFamily 内部已经是"每条术语 × 每个语种"，逐文件重算只是白跑
  const violations = checkFamily(name, docs, glossary);
  for (const doc of docs) {
    if (doc.lang === "zh") continue;
    const own = violations.filter((item) => item.file === doc.file);
    const cjk = findCjkResidue(doc.lang, doc.text);
    const detail: string[] = [
      baseline === undefined ? "无中文主源，未查术语（不是违规）" : `术语 ${terms.length - own.length}/${terms.length} 对齐`,
    ];
    if (cjk.length > 0) detail.push(`CJK 残留 ${cjk.length} 行（第 ${cjk.join(",")} 行）`);
    lines.push(line(own.length === 0 && cjk.length === 0, `${name}.${doc.lang}`, detail.join("；")));
    // 违规逐条单列：一行里堆三处差异没法读，也没法直接定位
    for (const item of own) {
      lines.push(
        line(
          false,
          `${name}.${doc.lang}`,
          `${item.zhTerm} → 应为 "${item.expected}"（或术语表里声明的屈折形），${doc.file} 里没有出现`,
        ),
      );
    }
  }
  return lines;
}

async function main(): Promise<void> {
  const corpusRoot = process.argv[2] ?? "corpus";

  process.stdout.write(
    `术语一致性检查：术语表 ${GLOSSARY_DOC} §5、语料目录 ${corpusRoot}、` +
      `de/nl/es 不得含 CJK、每个文件名必须写明语种\n`,
  );

  const glossary = parseGlossary(await readFile(GLOSSARY_DOC, "utf8"));
  const { families, unclassified } = groupFamilies(await loadCorpus(corpusRoot));

  const lines: Line[] = [
    line(
      true,
      "术语表",
      `从 ${GLOSSARY_DOC} §5 解析到 ${glossary.length} 条（期望 ${GLOSSARY_TERM_COUNT} 条；` +
        `表形状不对会直接抛错，不会静默通过）`,
    ),
  ];

  let termsChecked = 0;
  for (const family of families) {
    lines.push(...pairLines(family.name, family.docs, glossary));
    const baseline = family.docs.find((doc) => doc.lang === "zh");
    if (baseline !== undefined) {
      termsChecked += termsPresentIn(baseline.text, glossary).length * (family.docs.length - 1);
    }
  }

  // 空跑与漏检也是失败：语料目录读空、或没有任何术语落到目标语检查上，都不该给绿灯
  if (families.length === 0) {
    lines.push(line(false, "语料目录", `${corpusRoot} 下没有 .md 文件（阈值 ≥1）`));
  }
  if (termsChecked === 0) {
    lines.push(line(false, "覆盖", `目标语上一共查了 0 条术语（阈值 ≥1），机检形同虚设`));
  }
  for (const path of unclassified) {
    lines.push(line(false, "命名", `${path} 的文件名里读不出语种（如 warranty.de.md），无法分组也无法入库`));
  }

  for (const item of lines) {
    process.stdout.write(`[${item.ok ? "ok  " : "fail"}] ${padLabel(item.label)}${item.detail}\n`);
  }

  const failed = lines.filter((item) => !item.ok);
  // 同一族的违规会各占一行，摘要里只列一次标签，否则"demo.de、demo.de"读起来像两个问题
  const failedLabels = [...new Set(failed.map((item) => item.label))];
  process.stdout.write(
    failed.length === 0
      ? `结论：${families.length} 族语料术语对齐，共查 ${termsChecked} 处，可用于评测。\n`
      : `结论：${failed.length} 项不达标（${failedLabels.join("、")}），先修语料再评测。\n`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  // GlossaryParseError 走这里：表解析失败必须让命令失败，而不是"零条术语、零违规"通过
  process.stderr.write(`术语检查失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
