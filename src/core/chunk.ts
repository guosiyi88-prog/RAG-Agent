/**
 * 分块（08-ingestion.md §4）。参数是常量，不是可调项：改这里等于改评测可复现性，
 * 必须同时改规格文档，否则同一份语料在两次评测里块边界不同、hit@5 不可比。
 *
 * 顺序（§4.1，不许重排）：
 *   按标题行切章节 → 章节内按空行切段 → 累加到目标长度断块 → 断块回退到最近句末
 *   → 相邻块保留 OVERLAP_CHARS 重叠（句首对齐）→ 过短块并入上一块（无上一块则丢弃）
 *
 * 目标长度按**文档语言**取（§4.2），不按字符类型猜：中文 500、西文 1200。
 * 猜字符类型会让"英文说明书里夹一段中文故障码"整篇被按 500 切，块变短、召回变差。
 */

export type Lang = "zh" | "en" | "de" | "nl" | "es";

export const LANGUAGES: readonly Lang[] = ["zh", "en", "de", "nl", "es"];

export const TARGET_CHARS_ZH = 500;
export const TARGET_CHARS_LATIN = 1_200;
export const OVERLAP_CHARS = 80;
export const MIN_CHUNK_CHARS = 60;

/** 08 §10 的质量检查口径：>2000 字符说明切分失败，入库后会被 SQL 断言抓出来。 */
export const MAX_CHUNK_CHARS = 2_000;

/** 重叠窗口按句首对齐后至少要留这么多字符，否则退回原始窗口（不然重叠退化成几个字）。 */
const OVERLAP_ALIGN_MIN_CHARS = 20;

/** §4.1 第 1 条：命中即视为章节标题，该行成为 section 名。 */
const HEADING_RE =
  /^(?:#{1,3}\s+.+|\d+(?:\.\d+)*\s+[A-ZÄÖÜ].{0,60}|\d+(?:\.\d+)*\s+[\u4e00-\u9fa5].{0,30})$/u;

/** 句末：中文句号/问叹号/省略号 + 西文 .!? 。断块时回退到最后一个句末之后。 */
const SENTENCE_END_RE = /[。！？…；;.!?]/;

export interface Chunk {
  /** 从 1 开始，按文档顺序；不在这里生成 id（id 是 bigserial，插入后才有）。 */
  seq: number;
  section: string | null;
  content: string;
  /** 该块**正文**的起始页；重叠前缀来自上一块，不计入页码。 */
  page: number;
}

export function targetChars(lang: Lang): number {
  return lang === "zh" ? TARGET_CHARS_ZH : TARGET_CHARS_LATIN;
}

interface Unit {
  page: number;
  section: string | null;
  text: string;
  table: boolean;
}

function headingName(line: string): string {
  return line.replace(/^#{1,3}\s+/, "").trim();
}

/**
 * 第一步：把按页切好的文本变成"段"序列，同时记下每段的起始页与所属章节。
 * 表格（连续 ≥2 行含 `|`）在这里独立成一个 unit（§4.3）。
 */
function splitUnits(pages: readonly string[]): Unit[] {
  const lines: { page: number; text: string }[] = [];
  pages.forEach((pageText, pageIndex) => {
    for (const raw of pageText.split("\n")) lines.push({ page: pageIndex + 1, text: raw.trim() });
  });

  const units: Unit[] = [];
  let section: string | null = null;
  let paragraph: { page: number; text: string }[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    units.push({
      page: paragraph[0]!.page,
      section,
      text: paragraph.map((line) => line.text).join("\n"),
      table: false,
    });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    if (line.text === "") {
      flushParagraph();
      continue;
    }

    if (HEADING_RE.test(line.text)) {
      flushParagraph();
      section = headingName(line.text);
      // 标题行本身不进正文：它已经是 section 元数据，再塞一遍会让每个块都以标题开头、稀释向量
      continue;
    }

    const next = lines[i + 1];
    if (line.text.includes("|") && next !== undefined && next.text.includes("|")) {
      flushParagraph();
      const tableStart = i;
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.text.includes("|")) {
        rows.push(lines[i]!.text);
        i += 1;
      }
      i -= 1; // 外层循环还会 +1，先退回来，免得吃掉表格后面的第一行
      units.push({
        page: lines[tableStart]!.page,
        section,
        text: rows.join("\n"),
        table: true,
      });
      continue;
    }

    paragraph.push(line);
  }
  flushParagraph();

  return units;
}

/** 重叠窗口：取尾部 OVERLAP_CHARS 字符，再对齐到窗口内第一个句末之后。 */
export function overlapTail(text: string): string {
  if (text.length <= OVERLAP_CHARS) return "";
  const window = text.slice(text.length - OVERLAP_CHARS);
  for (let i = 0; i < window.length; i += 1) {
    const ch = window[i]!;
    if (SENTENCE_END_RE.test(ch) || ch === "\n") {
      const aligned = window.slice(i + 1).trimStart();
      if (aligned.length >= OVERLAP_ALIGN_MIN_CHARS) return aligned;
      break;
    }
  }
  return window.trimStart();
}

interface Draft {
  content: string;
  page: number;
  section: string | null;
}

/**
 * 第二步：段 → 块。
 * 靠三个不变量保证块质量：
 *   - 正文（不含重叠前缀）不超过 target；
 *   - 块长不低于 MIN_CHUNK_CHARS（否则并入上一块，没有上一块就丢弃）；
 *   - 相邻块之间，后块以「前块尾部、句首对齐」开头（OVERLAP_CHARS 窗口）。
 * 另外一条工程约束：块不跨章节。章节边界是天然的语义边界，混在一块的后果是 `section`
 * 只能填其中一半，引用抽屉里显示出来的章节名会是错的。
 */
function assemble(units: readonly Unit[], target: number): Draft[] {
  const drafts: Draft[] = [];
  let overlapPrefix = ""; // 上一块留给当前块的重叠前缀
  let parts: string[] = []; // 当前块的正文段（不含重叠前缀）
  let chunkPage: number | null = null;
  let chunkSection: string | null = null;

  const partsLength = (): number => parts.join("\n\n").length;
  const chunkText = (): string =>
    [overlapPrefix, ...parts].filter((part) => part !== "").join("\n\n").trim();

  const flush = (): void => {
    if (parts.length === 0) return; // 只有重叠前缀、没有正文：不构成块，前缀留给下一块
    const content = chunkText();
    const page = chunkPage ?? 1;
    const section = chunkSection;
    parts = [];
    chunkPage = null;

    if (content.length < MIN_CHUNK_CHARS) {
      const previous = drafts[drafts.length - 1];
      if (previous === undefined) {
        // 规格：没有上一块就丢弃。与其留一个 20 字的孤块污染向量空间，不如不要
        overlapPrefix = "";
        return;
      }
      previous.content = `${previous.content}\n\n${content}`;
      overlapPrefix = overlapTail(previous.content);
      return;
    }

    if (content.length > MAX_CHUNK_CHARS) {
      // 走到这里说明单段本身超长且切分逻辑被绕过；宁可整篇失败，也不写超长块
      throw new Error(`块长 ${content.length} 超过上限 ${MAX_CHUNK_CHARS}，分块逻辑有缺陷`);
    }

    drafts.push({ content, page, section });
    overlapPrefix = overlapTail(content);
  };

  /** 断块点在 target 之内、且尽量落在句末；找不到句末就退到最近的空格，最后才硬切。 */
  const cutPoint = (text: string, room: number): number => {
    const limit = Math.min(room, text.length);
    for (let i = limit - 1; i >= MIN_CHUNK_CHARS; i -= 1) {
      if (SENTENCE_END_RE.test(text[i]!)) return i + 1;
    }
    for (let i = limit - 1; i >= Math.floor(limit / 2); i -= 1) {
      if (text[i] === " " || text[i] === "\n") return i + 1;
    }
    return limit;
  };

  const take = (text: string, page: number, section: string | null): void => {
    let rest = text.trim();
    // 块不跨章节：章节边界就是语义边界，混在一块的后果是 section 字段只能填其中一半
    if (parts.length > 0 && section !== chunkSection) flush();

    while (rest.length > 0) {
      if (parts.length === 0) {
        chunkPage = page;
        chunkSection = section;
      }

      const separator = parts.length > 0 ? 2 : 0; // "\n\n"
      const used = partsLength();
      if (used + separator + rest.length <= target) {
        parts.push(rest);
        return;
      }

      const room = target - used - separator;
      if (room < MIN_CHUNK_CHARS) {
        // 剩余空间装不下一个有意义的块：先交出当前块，让这段从新块开始
        flush();
        continue;
      }

      const cut = cutPoint(rest, room);
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
      flush();
    }
  };

  /** 表格独立成块、块首重复表头、不做重叠（§4.3）。 */
  const takeTable = (unit: Unit): void => {
    flush();
    overlapPrefix = "";

    const rows = unit.text.split("\n");
    const header = rows[0] ?? "";
    let group: string[] = [];

    const emit = (): void => {
      if (group.length === 0) return;
      const content = [header, ...group].join("\n").trim();
      if (content.length >= MIN_CHUNK_CHARS) {
        drafts.push({ content, page: unit.page, section: unit.section });
      } else {
        const previous = drafts[drafts.length - 1];
        if (previous !== undefined) previous.content = `${previous.content}\n\n${content}`;
      }
      group = [];
    };

    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i]!;
      const candidate = [header, ...group, row].join("\n").length;
      if (group.length > 0 && candidate > target) emit();
      group.push(row);
    }
    emit();
  };

  for (const unit of units) {
    if (unit.table) takeTable(unit);
    else take(unit.text, unit.page, unit.section);
  }
  flush();

  return drafts;
}

/**
 * 分块入口：`pages` 是按 `\f` 切好的原文（已清洗），返回按文档顺序编号的块。
 * 纯函数：不碰数据库、不读环境变量、不含时间与随机数 —— 同样的输入永远同样的输出。
 */
export function chunkPages(pages: readonly string[], lang: Lang): Chunk[] {
  const target = targetChars(lang);
  return assemble(splitUnits(pages), target).map((draft, index) => ({
    seq: index + 1,
    section: draft.section,
    content: draft.content,
    page: draft.page,
  }));
}
