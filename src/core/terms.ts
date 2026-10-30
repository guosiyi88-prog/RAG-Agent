/**
 * 术语一致性（12-i18n.md §5 / 02-corpus-ingestion「术语按术语表逐条对齐」）。
 *
 * 术语的**唯一真源是 PRD 里那张表**，所以这里不抄一份词表进代码：抄一份就是两个真源，
 * 改了文档不改代码，机检等于自欺。本模块只做纯事：
 *   1. 从 markdown 文本解析术语表（形状不对就抛错，绝不让空表静默通过）；
 *   2. 对一族语料查术语对齐（中文主源里出现的术语，目标语里必须是术语表写法或其屈折形式）；
 *   3. 找 Latin 语种里的 CJK 残留（拦截"荷兰语页面里蹦汉字"，且早于入库，不必等库里有数据）。
 *
 * 文件发现与打印在 `scripts/check-terms.ts`，读文件在调用方 —— 这样测试不碰数据库、
 * 也不会因为 import 本模块而建出连接池（`src/core/ingest.ts` 依赖 db.ts，所以它的
 * `langFromFilename` 不能在这里复用，文件名规则按同一口径各写一份）。
 */

import { LANGUAGES, type Lang } from "./chunk.ts";

/** 术语表覆盖的五语，列顺序就是 §5 表格的列顺序（zh|en|de|nl|es）。 */
export type TermLang = Lang;

export interface GlossaryTerm {
  zh: string;
  en: string;
  de: string;
  nl: string;
  es: string;
}

/** §5 的表是 10 条术语。数量变了说明文档被人改过：机检口径要跟着人看一眼，不能自动跟着走。 */
export const GLOSSARY_TERM_COUNT = 10;

/** 术语表形状不符合预期时抛这个：解析失败必须是**响亮的**失败，不能退化成"零条术语、零违规"。 */
export class GlossaryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlossaryParseError";
  }
}

/**
 * 屈折变体表：**为什么**需要它 ——
 *
 * §5 的德语栏给的是动词原形 `zurücksetzen`，而真实德语会屈折它，或者把可分前缀甩到句末：
 *   - "Muss das Gerät zurückgesetzt werden"（过去分词）
 *   - "nach drei Zurücksetzungen"（名词化的复数）
 *   - "Setzen Sie das Gerät nicht wiederholt zurück"（前缀单独落在句末）
 * 这些是**同一个词的屈折形式**，不是 §5 禁止的"同义替换"（把 Garantie 写成 Gewährleistung 才是）。
 * 所以按词逐条声明，而不是把匹配器放宽成词干/前缀匹配：放宽会顺带放过真正的同义替换，
 * 机检就退化成自我安慰。新增一条变体前先回答："这是同一个词的屈折，还是另一个词？"
 *
 * 键是术语表里的**标准写法**，值是目标语里同样可接受的写法。目前只有德语这一条，
 * 因为它是五语语料里唯一出现自然屈折的术语（其余九条五语都是名词，写法与表一致）。
 */
const INFLECTIONS: Record<string, Record<string, readonly string[]>> = {
  de: {
    // "zurück" 是同一动词的可分前缀单独出现（句末），是这张表里唯一的宽口径：
    // 它确实放宽了"复位"在德语里的判定，但放宽范围写在表里、可被审查，而不是藏在匹配器里。
    zurücksetzen: [
      "zurückgesetzt",
      "zurücksetzt",
      "zurücksetzte",
      "zurücksetzten",
      "Zurücksetzung",
      "Zurücksetzungen",
      "zurück",
    ],
  },
};

/** 目标语里可接受的写法：术语表原样 + 声明过的屈折变体。 */
export function acceptedForms(lang: string, expected: string): string[] {
  return [expected, ...(INFLECTIONS[lang]?.[expected] ?? [])];
}

/** 表格行 → 单元格；不是表格行返回 null。 */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (trimmed.length < 2 || !trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

const SEPARATOR_CELL_RE = /^:?-{3,}:?$/u;

/**
 * 从 §5 的 markdown 里解析术语表。
 * 定位方式是"表头五列正好是 zh|en|de|nl|es"，而不是"§5 标题下的第一张表"：
 * 文档章节会重编号，列名不会（12-i18n.md §4 的 key 表只有两列，不会撞上）。
 */
export function parseGlossary(markdown: string): GlossaryTerm[] {
  const lines = markdown.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => {
    const cells = tableCells(line);
    return (
      cells !== null &&
      cells.length === LANGUAGES.length &&
      cells.every((cell, index) => cell === LANGUAGES[index])
    );
  });
  if (headerIndex < 0) {
    throw new GlossaryParseError(
      `12-i18n.md 里找不到表头为 | ${LANGUAGES.join(" | ")} | 的术语表（§5）`,
    );
  }

  const separator = tableCells(lines[headerIndex + 1] ?? "");
  if (
    separator === null ||
    separator.length !== LANGUAGES.length ||
    !separator.every((cell) => SEPARATOR_CELL_RE.test(cell))
  ) {
    throw new GlossaryParseError(
      `术语表表头下面不是 ${LANGUAGES.length} 列的分隔行（12-i18n.md §5）`,
    );
  }

  const terms: GlossaryTerm[] = [];
  const seen = new Set<string>();
  for (let i = headerIndex + 2; i < lines.length; i += 1) {
    const row = lines[i] ?? "";
    const cells = tableCells(row);
    if (cells === null) break; // 表格结束
    if (cells.length !== LANGUAGES.length) {
      throw new GlossaryParseError(
        `术语表第 ${terms.length + 1} 行有 ${cells.length} 列，应为 ${LANGUAGES.length} 列：${row.trim()}`,
      );
    }
    const empty = LANGUAGES.filter((_, index) => (cells[index] ?? "") === "");
    if (empty.length > 0) {
      throw new GlossaryParseError(
        `术语表第 ${terms.length + 1} 行的 ${empty.join(",")} 栏为空：${row.trim()}`,
      );
    }
    const zh = cells[0] ?? "";
    if (seen.has(zh)) {
      throw new GlossaryParseError(`术语表里中文术语重复：${zh}`);
    }
    seen.add(zh);
    terms.push({
      zh,
      en: cells[1] ?? "",
      de: cells[2] ?? "",
      nl: cells[3] ?? "",
      es: cells[4] ?? "",
    });
  }

  if (terms.length !== GLOSSARY_TERM_COUNT) {
    throw new GlossaryParseError(
      `术语表解析到 ${terms.length} 条，期望 ${GLOSSARY_TERM_COUNT} 条（12-i18n.md §5 被改过？` +
        `确认后同步改 GLOSSARY_TERM_COUNT）`,
    );
  }
  return terms;
}

export interface FamilyDoc {
  /** 语种取自文件名（08 §4.2：按文档语言，不猜字符） */
  lang: string;
  /** 相对语料目录的路径，只用于报错定位 */
  file: string;
  text: string;
}

export interface Violation {
  family: string;
  lang: string;
  file: string;
  zhTerm: string;
  expected: string;
}

/** 大小写不敏感：德语名词首字母大写、句首大写都不是"另一个词"，只有换词才是违规。 */
function contains(haystack: string, form: string): boolean {
  return haystack.includes(form.toLowerCase());
}

/** 中文主源里出现过的术语 —— 只有这些才需要目标语逐条对齐，没提到的不该硬塞。 */
export function termsPresentIn(text: string, glossary: readonly GlossaryTerm[]): GlossaryTerm[] {
  const haystack = text.toLowerCase();
  return glossary.filter((term) => contains(haystack, term.zh));
}

function expectedFor(term: GlossaryTerm, lang: string): string | null {
  if (!(LANGUAGES as readonly string[]).includes(lang)) return null;
  if (lang === "zh") return term.zh;
  return term[lang as Exclude<TermLang, "zh">];
}

/**
 * 一族语料（同名文件：warranty / install / spec …）的术语对齐检查。
 *
 * 规则：中文主源里出现的每条术语，目标语文件里必须出现术语表写法或声明过的屈折形式。
 * 没有中文主源 = 没有基准，不算违规（那是"语料没写"，由语料清单与 check-corpus 管）；
 * 某一族没有 nl/es（spec 就是三语）也不算违规 —— 只检查**存在**的语言。
 */
export function checkFamily(
  family: string,
  docs: readonly FamilyDoc[],
  glossary: readonly GlossaryTerm[],
): Violation[] {
  const baseline = docs.find((doc) => doc.lang === "zh");
  if (baseline === undefined) return [];
  const terms = termsPresentIn(baseline.text, glossary);

  const violations: Violation[] = [];
  for (const doc of docs) {
    if (doc.lang === "zh") continue;
    const haystack = doc.text.toLowerCase();
    for (const term of terms) {
      const expected = expectedFor(term, doc.lang);
      // 术语表缺这一栏（理论上被 parseGlossary 拦掉了）→ 不在这里判，避免造出假违规
      if (expected === null || expected === "") continue;
      if (acceptedForms(doc.lang, expected).some((form) => contains(haystack, form))) continue;
      violations.push({
        family,
        lang: doc.lang,
        file: doc.file,
        zhTerm: term.zh,
        expected,
      });
    }
  }
  return violations;
}

/** 与 08 §10 的 SQL 断言同一口径（`[一-龥]`）：机翻漏译或文件贴错时，汉字会留在 Latin 语种里。 */
export const CJK_RESIDUE_RE = /[\u4e00-\u9fa5]/u;

/** 返回含 CJK 的**行号**（从 1 开始），空数组即干净。zh 文件本来就该有汉字，直接返回空。 */
export function findCjkResidue(lang: string, text: string): number[] {
  if (lang === "zh") return [];
  const lines: number[] = [];
  text.split(/\r?\n/u).forEach((line, index) => {
    if (CJK_RESIDUE_RE.test(line)) lines.push(index + 1);
  });
  return lines;
}

/** 语种只从文件名读（`warranty.de.md`），与 ingest 的 `langFromFilename` 同一口径。 */
export function langFromPath(relPath: string): Lang | null {
  const name = relPath.split("/").pop() ?? relPath;
  for (const lang of LANGUAGES) {
    if (new RegExp(`(^|[._-])${lang}([._-]|$)`, "i").test(name)) return lang;
  }
  return null;
}

/** 族名 = 去掉 `.<lang>.<ext>` 后的路径：`install.de.md` → `install`（嵌套目录保留前缀）。 */
export function familyOf(relPath: string): string {
  const lang = langFromPath(relPath);
  if (lang === null) return relPath;
  return relPath
    .replace(/\.[^.]+$/u, "")
    .replace(new RegExp(`\\.${lang}$`, "i"), "");
}

export interface FamilyDocSource {
  /** 相对语料目录的路径（以 `/` 分隔） */
  path: string;
  text: string;
}

export interface CorpusFamily {
  name: string;
  docs: FamilyDoc[];
}

/**
 * 按族分组，并挑出"文件名里读不出语种"的文件：它们既进不了任何一族、也不会被入库
 * （ingest 的 `resolveLang` 返回 null），因此必须显式报出来，不能默默漏检。
 */
export function groupFamilies(sources: readonly FamilyDocSource[]): {
  families: CorpusFamily[];
  unclassified: string[];
} {
  const grouped = new Map<string, FamilyDoc[]>();
  const unclassified: string[] = [];

  for (const source of sources) {
    const lang = langFromPath(source.path);
    if (lang === null) {
      unclassified.push(source.path);
      continue;
    }
    const name = familyOf(source.path);
    const docs = grouped.get(name) ?? [];
    docs.push({ lang, file: source.path, text: source.text });
    grouped.set(name, docs);
  }

  const families = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, docs]) => ({
      name,
      // 按 LANGUAGES 的顺序排：输出稳定，两次运行的日志可以直接 diff
      docs: [...docs].sort(
        (a, b) => (LANGUAGES as readonly string[]).indexOf(a.lang) - (LANGUAGES as readonly string[]).indexOf(b.lang),
      ),
    }));
  return { families, unclassified: unclassified.sort() };
}
