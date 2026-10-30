/**
 * 入库流水线（08-ingestion.md）。CLI（`scripts/ingest.ts`）和将来的 HTTP 入口共用这一份实现：
 * 命令里**不许**再复制一遍清洗或分块逻辑，否则两边参数漂移之后没人能说清库里到底是哪套规则。
 *
 *   文件 → 提取文本 → 清洗 → 分块 → 批量嵌入 → 事务写入（documents.status + chunks）
 *
 * 例外是结构化语料（`fault_codes*.json`）：它不进 documents / chunks，直接 upsert 到 `fault_codes` 表
 * —— 故障码的快路是主键命中，不是语义检索。分叉点见 `isFaultCodeFile`。
 *
 * 幂等靠 `documents.sha256`（唯一键）：同一份内容重跑 → 复用 doc id、先删旧片段、再批量插入。
 * 改完文件再入库 = 同一 `object_key` 换了内容：新版本写成功之后，旧版本行（及其片段）在同一事务里删掉
 * —— 否则库里同时留着改前改后两版，检索会引用到已经被改掉的段落。
 * 失败**不回滚已写入的片段**：现场排查需要看到"上次灌进去的是什么"，下次重索引会先删。
 *
 * 不做：不翻译、不纠错、不去 HTML、不做 OCR、不在入库阶段改写查询（08 §3 的"不做"清单）。
 *
 * **读源（09#05）**：正文可以来自两种源 —— 本地目录（开发回落，`localSource`）或对象存储的
 * `corpus/` 前缀（`minioSource`）。两者只负责"列出文件 + 交出字节"，解析/清洗/切块/入库是同一条链路
 * （`ingestSource` → `ingestEntry`），不在源里复制半条 pipeline。
 * `documents.object_key` 记的是**语料相对路径**（`warranty.zh.md`），与源无关：同一份文件从本地灌
 * 还是从 MinIO 灌都落在同一行上，`sha256` 判重与"旧版本退场"（按 object_key）才不会因为换入口而失效。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { one, query, tx } from "../db.ts";
import { logger } from "../logger.ts";
import { CORPUS_PREFIX, getObject, listCorpusObjects } from "../storage.ts";
import { cleanPages } from "./clean.ts";
import { chunkPages, LANGUAGES, type Chunk, type Lang } from "./chunk.ts";
import { embedBatch, EmbedError, toVectorLiteral } from "./embed.ts";

const execFileAsync = promisify(execFile);

/** 08 §2：提取结果 <100 字/页 判为无文本层（扫描版 PDF）。 */
export const MIN_CHARS_PER_PAGE = 100;
/** 08 §6：批量插入 100 条一批。 */
export const INSERT_BATCH_SIZE = 100;
/** 支持的后缀；其余文件类型直接跳过（不是失败，是"不归入库管"）。 */
export const SUPPORTED_EXTENSIONS: readonly string[] = [".pdf", ".txt", ".md", ".json"];

/**
 * `documents.err` 的取值集合。全部小写下划线，一个错误码只对应一个阶段，
 * 排障时看 err 就知道该去看提取、嵌入还是数据库。
 */
export type IngestErrorCode =
  | "no_text_layer"
  | "empty_after_clean"
  | "unsupported_type"
  | "lang_unknown"
  | "extract_failed"
  | "embed_unavailable"
  | "embed_timeout"
  | "embed_dim_mismatch"
  | "db_failed"
  | "internal_error";

export class IngestError extends Error {
  readonly code: IngestErrorCode;

  constructor(code: IngestErrorCode, message?: string) {
    super(message ?? code);
    this.name = "IngestError";
    this.code = code;
  }
}

/** `EmbedError.code` → `documents.err` 的词表映射；两套大小写风格会让 err 值无法聚合。 */
const EMBED_TO_INGEST: Record<string, IngestErrorCode> = {
  EMBED_UNAVAILABLE: "embed_unavailable",
  EMBED_TIMEOUT: "embed_timeout",
  EMBED_DIM_MISMATCH: "embed_dim_mismatch",
};

export function errorCodeOf(err: unknown): IngestErrorCode {
  if (err instanceof IngestError) return err.code;
  if (err instanceof EmbedError) return EMBED_TO_INGEST[err.code] ?? "embed_unavailable";
  return "internal_error";
}

export interface ExtractResult {
  title: string;
  /** 按页切好的原始文本；下标 0 即第 1 页。 */
  pages: string[];
}

export interface IngestOutcome {
  /** 相对语料根目录的路径，带正斜杠，用于命令行输出与 `documents.object_key`。 */
  relPath: string;
  title: string;
  lang: Lang | null;
  docId: string | null;
  chunkCount: number;
  /** 结构化语料（故障码）写进专用表的行数；`chunkCount` 恒为 0，因为它没进片段表。 */
  faultCodes?: number;
  ok: boolean;
  err: IngestErrorCode | null;
}

export interface IngestSummary {
  results: IngestOutcome[];
  okCount: number;
  failedCount: number;
}

export function isLang(value: string): value is Lang {
  return (LANGUAGES as readonly string[]).includes(value);
}

/**
 * 语言取自文件名里的 `.<lang>.`（如 `warranty.de.txt`），这是首要来源。
 * 不从内容里猜：08 §4.2 要求"按文档语言决定目标长度"，猜测会让同一份语料在不同机器上切成不同的块。
 * `.json` 允许自带 `lang` 字段，仅当文件名没写语言时才用（见 resolveLang）。
 */
export function langFromFilename(filePath: string): Lang | null {
  const name = basename(filePath);
  for (const lang of LANGUAGES) {
    if (new RegExp(`(^|[._-])${lang}([._-]|$)`, "i").test(name)) return lang;
  }
  return null;
}

/** 08 §2.1：`pdftotext -layout` 用 `\f` 分页，第 i 段即第 i+1 页。 */
export function splitPages(text: string): string[] {
  const pages = text.split("\f");
  // 末尾换页符会切出一个空页，去掉它，否则"页数"和"字/页"都会被拉低
  const last = pages[pages.length - 1];
  if (pages.length > 1 && last !== undefined && last.trim() === "") pages.pop();
  return pages.length > 0 ? pages : [""];
}

/**
 * 08 §2：无文本层判定。单独抽出来是为了能被直接单测（对空文本调一次就知道失败分支长什么样），
 * 不必依赖"宿主机恰好有一份扫描版 PDF"。
 */
export function assertTextLayer(pages: readonly string[]): void {
  const chars = pages.reduce((sum, page) => sum + page.trim().length, 0);
  const pagesCount = Math.max(pages.length, 1);
  const density = chars / pagesCount;
  if (density < MIN_CHARS_PER_PAGE) {
    throw new IngestError(
      "no_text_layer",
      `${Math.round(density)} 字/页 < ${MIN_CHARS_PER_PAGE}，判为无文本层（扫描版？）`,
    );
  }
}

async function extractPdf(absPath: string): Promise<string> {
  try {
    // 走系统 pdftotext（poppler/xpdf）：ADR-0005 的"克制技术栈"，不为解析 PDF 引入 JS 库
    const { stdout } = await execFileAsync("pdftotext", ["-layout", absPath, "-"], {
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout;
  } catch (err) {
    throw new IngestError("extract_failed", `pdftotext 失败：${String(err)}`);
  }
}

interface JsonDoc {
  title?: unknown;
  lang?: unknown;
  sections?: unknown;
}

function parseJsonDoc(raw: string): JsonDoc {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      throw new IngestError("extract_failed", "JSON 顶层不是对象");
    }
    return parsed as JsonDoc;
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError("extract_failed", `JSON 解析失败：${String(err)}`);
  }
}

/** `.json`：`{title, lang, sections:[{heading, body}]}`（08 §2）。 */
function extractJson(doc: JsonDoc): ExtractResult {
  if (!Array.isArray(doc.sections)) throw new IngestError("extract_failed", "JSON 缺少 sections[]");

  const lines: string[] = [];
  if (typeof doc.title === "string" && doc.title.trim() !== "") lines.push(`## ${doc.title.trim()}`);
  for (const section of doc.sections) {
    if (section === null || typeof section !== "object") continue;
    const heading = (section as { heading?: unknown }).heading;
    const body = (section as { body?: unknown }).body;
    // 统一成 `## 标题 + 正文 + 空行`：分块器只认这个形状，不为 JSON 再开一条分支
    if (typeof heading === "string" && heading.trim() !== "") lines.push(`## ${heading.trim()}`);
    if (typeof body === "string" && body.trim() !== "") lines.push(body.trim());
    lines.push("");
  }

  return {
    title: typeof doc.title === "string" && doc.title.trim() !== "" ? doc.title.trim() : "",
    pages: splitPages(lines.join("\n")),
  };
}

/**
 * 提取文本（不判无文本层，也不清洗 —— 那两步由调用方按流水线顺序做）。
 * `fallbackTitle` 是文件名去掉扩展名：JSON 自带 title 时以文件内为准。
 *
 * 这一支是**源无关**的：解析分支只看文件名，正文由调用方交进来（本地源读文件、MinIO 源取对象）。
 * `absPath` 只有 PDF 需要 —— `pdftotext` 只认真实文件。
 */
export interface ExtractInput {
  /** 文件名（含后缀），决定解析分支 */
  name: string;
  /** 原始字节；PDF 不需要（走 pdftotext 读文件） */
  bytes: Buffer | null;
  /** 本地绝对路径；只有 PDF 需要，对象存储源传 null */
  absPath: string | null;
}

export async function extractContent(input: ExtractInput, fallbackTitle: string): Promise<ExtractResult> {
  const ext = extname(input.name).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new IngestError("unsupported_type", `不支持的文件类型 ${ext}`);
  }

  if (ext === ".pdf") {
    if (input.absPath === null) {
      // 对象存储源不该把 PDF 列进来（storage 的白名单里没有 .pdf），走到这里是调用方的错
      throw new IngestError("unsupported_type", `PDF 只能从本地目录入库（pdftotext 要真实文件）：${input.name}`);
    }
    return { title: fallbackTitle, pages: splitPages(await extractPdf(input.absPath)) };
  }

  const raw = input.bytes?.toString("utf8");
  if (raw === undefined) throw new IngestError("extract_failed", `没有拿到正文：${input.name}`);

  if (ext === ".json") {
    const parsed = extractJson(parseJsonDoc(raw));
    return { title: parsed.title === "" ? fallbackTitle : parsed.title, pages: parsed.pages };
  }

  // `.txt` / `.md` 也认 `\f`：多页文本（含分页的 md）同样要保住页码
  return { title: fallbackTitle, pages: splitPages(raw) };
}

/** 本地文件版（原签名保留）：读字节后交给 `extractContent`。 */
export async function extractFile(absPath: string, fallbackTitle: string): Promise<ExtractResult> {
  const ext = extname(absPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new IngestError("unsupported_type", `不支持的文件类型 ${ext}`);
  }

  if (ext === ".pdf") return extractContent({ name: basename(absPath), bytes: null, absPath }, fallbackTitle);

  let bytes: Buffer;
  try {
    bytes = await readFile(absPath);
  } catch (err) {
    throw new IngestError("extract_failed", `读取失败：${String(err)}`);
  }
  return extractContent({ name: basename(absPath), bytes, absPath }, fallbackTitle);
}

/**
 * 文档语言：文件名优先，其次 `.json` 自带的 `lang`，都没有就是 null（→ lang_unknown 失败）。
 * 不要在这里加"看 CJK 占比猜语言"：猜错一次，整篇文档的目标块长就是错的，且不可复现。
 *
 * `bytes` 为 null 时只认文件名（对象存储源在取正文之前不需要为了语言多取一次）。
 */
export function resolveLangOf(name: string, bytes: Buffer | null): Lang | null {
  const fromName = langFromFilename(name);
  if (fromName !== null) return fromName;
  if (extname(name).toLowerCase() !== ".json" || bytes === null) return null;
  try {
    const doc = parseJsonDoc(bytes.toString("utf8"));
    return typeof doc.lang === "string" && isLang(doc.lang) ? doc.lang : null;
  } catch {
    return null; // 解析失败留给 extractContent 报 extract_failed，这里只关心语言
  }
}

/** 本地路径版（原签名保留）。 */
export async function resolveLang(absPath: string): Promise<Lang | null> {
  const fromName = langFromFilename(absPath);
  if (fromName !== null) return fromName;
  if (extname(absPath).toLowerCase() !== ".json") return null;
  try {
    return resolveLangOf(absPath, await readFile(absPath));
  } catch {
    return null;
  }
}

/** 文件名去掉扩展名，作为默认标题（引用抽屉里显示的就是它）。 */
export function titleFromPath(filePath: string): string {
  const name = basename(filePath);
  const ext = extname(name);
  return ext === "" ? name : name.slice(0, -ext.length);
}

// ─────────────────── 故障码：结构化语料改道 fault_codes 表 ───────────────────
//
// 为什么改道：故障码查的是"这个 code 对应什么现象、怎么处理"，一次主键命中就够；
// 放进 chunks 会让同一份内容在向量空间里和保修条款抢名额，而且五语描述会切成一堆碎片。
// 所以带这个文件名的 JSON 不产生 documents 行、不产生 chunks。
//
// 命名约定即路由：`fault_codes.json`、`fault_codes.de.json` 都算结构化语料。
// 想让它回片段表就改文件名 —— 这是刻意的显式开关，不做"看内容猜类型"的隐式判断。
const FAULT_CODE_FILE_RE = /^fault_codes(\.[a-z]{2})?\.json$/i;

const SEVERITIES = ["info", "warn", "fatal"] as const;
type Severity = (typeof SEVERITIES)[number];

interface FaultCodeEntry {
  code: string;
  productLine: string;
  severity: Severity;
  desc: Record<Lang, string>;
  act: Record<Lang, string>;
}

export function isFaultCodeFile(filePath: string): boolean {
  return FAULT_CODE_FILE_RE.test(basename(filePath));
}

function nonEmptyText(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new IngestError("extract_failed", `${where} 必须是非空字符串`);
  }
  return value.trim();
}

/** 五语描述/步骤必须齐：缺一门语言的故障码，在那一门语言里等于不存在。 */
function parseFaultCodeTexts(raw: unknown, where: string): Record<Lang, string> {
  if (raw === null || typeof raw !== "object") {
    throw new IngestError("extract_failed", `${where} 必须是对象`);
  }
  const texts = {} as Record<Lang, string>;
  for (const lang of LANGUAGES) {
    texts[lang] = nonEmptyText((raw as Record<string, unknown>)[lang], `${where}.${lang}`);
  }
  return texts;
}

/**
 * 解析故障码文件：`{title, fault_codes:[{code, product_line, severity, desc{}, act{}}]}`。
 * 校验在入库阶段做完 —— 让一条缺德语描述的行进库，等于让德语用户拿到半截答案。
 */
export function parseFaultCodes(raw: string): FaultCodeEntry[] {
  const doc = parseJsonDoc(raw) as JsonDoc & { fault_codes?: unknown };
  if (!Array.isArray(doc.fault_codes)) {
    throw new IngestError("extract_failed", "故障码文件缺少 fault_codes[]");
  }
  if (doc.fault_codes.length === 0) {
    throw new IngestError("extract_failed", "fault_codes[] 为空");
  }

  const seen = new Set<string>();
  return doc.fault_codes.map((item, index) => {
    const where = `fault_codes[${index}]`;
    if (item === null || typeof item !== "object") {
      throw new IngestError("extract_failed", `${where} 必须是对象`);
    }
    const entry = item as Record<string, unknown>;
    const code = nonEmptyText(entry.code, `${where}.code`);
    const productLine = nonEmptyText(entry.product_line, `${where}.product_line`);
    const severity = nonEmptyText(entry.severity, `${where}.severity`);
    if (!(SEVERITIES as readonly string[]).includes(severity)) {
      throw new IngestError("extract_failed", `${where}.severity 只能是 ${SEVERITIES.join("|")}`);
    }
    // 主键是 (code, product_line)：文件里重复的行会让 upsert 结果取决于顺序，直接判失败
    const key = `${code}\u0000${productLine}`;
    if (seen.has(key)) {
      throw new IngestError("extract_failed", `${where} 与前面的 (${code}, ${productLine}) 重复`);
    }
    seen.add(key);

    return {
      code,
      productLine,
      severity: severity as Severity,
      desc: parseFaultCodeTexts(entry.desc, `${where}.desc`),
      act: parseFaultCodeTexts(entry.act, `${where}.act`),
    };
  });
}

/**
 * 一条语句 upsert 全表：幂等靠主键 `(code, product_line)`，重跑只 update 不插新行。
 * 不删"文件里没有的"故障码：tickets / qa_gold 可能已经引用了某个 code，删除要人确认，
 * 自动删除会让"昨天还能查到的 E03"今天凭空消失。
 */
async function writeFaultCodes(entries: readonly FaultCodeEntry[]): Promise<void> {
  await tx(async (client) => {
    await client.query(
      // `do nothing`（09#02 / D13）：库是唯一真源，语料文件只作种子与快照。
      // 原来的 `do update` 会让管理端改完的码在下一次 ingest 被静默回滚（R21），
      // 也让归档失效 —— 归档靠 status 不靠删行，覆盖会把 status 之外的内容一起改回来（D25）。
      //
      // `status` 直接写 `published`（D15）：能进到这里的条目已经过 `parseFaultCodeTexts`
      // 的五语强制校验，属"审过的源稿"；管理端录入的才是 draft。
      // 冲突行一个字都不改，所以归档/草稿状态不会被文件抢回去。
      `insert into fault_codes
         (code, product_line, severity,
          desc_zh, desc_en, desc_de, desc_nl, desc_es,
          act_zh, act_en, act_de, act_nl, act_es,
          status)
       select *, 'published' from unnest($1::text[], $2::text[], $3::text[],
                            $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                            $9::text[], $10::text[], $11::text[], $12::text[], $13::text[])
       on conflict (code, product_line) do nothing`,
      [
        entries.map((entry) => entry.code),
        entries.map((entry) => entry.productLine),
        entries.map((entry) => entry.severity),
        entries.map((entry) => entry.desc.zh),
        entries.map((entry) => entry.desc.en),
        entries.map((entry) => entry.desc.de),
        entries.map((entry) => entry.desc.nl),
        entries.map((entry) => entry.desc.es),
        entries.map((entry) => entry.act.zh),
        entries.map((entry) => entry.act.en),
        entries.map((entry) => entry.act.de),
        entries.map((entry) => entry.act.nl),
        entries.map((entry) => entry.act.es),
      ],
    );
  });
}

/**
 * 结构化语料的入库：解析 → 校验 → upsert。
 * 既没有 documents 行也没有 chunks，所以也不存在"状态机"——要么整批写进去，要么报错退出。
 */
async function ingestFaultCodes(raw: string, name: string, rel: string): Promise<IngestOutcome> {
  const title = titleFromPath(name);
  const failed = (code: IngestErrorCode, message: string): IngestOutcome => {
    logger.error({ relPath: rel, code, message }, "故障码入库失败");
    return { relPath: rel, title, lang: null, docId: null, chunkCount: 0, ok: false, err: code };
  };

  let entries: FaultCodeEntry[];
  try {
    entries = parseFaultCodes(raw);
  } catch (err) {
    return failed(errorCodeOf(err), err instanceof Error ? err.message : String(err));
  }

  try {
    await writeFaultCodes(entries);
  } catch (err) {
    return failed("db_failed", err instanceof Error ? err.message : String(err));
  }

  logger.info({ relPath: rel, rows: entries.length }, "故障码已写入 fault_codes 表");
  return {
    relPath: rel,
    title,
    lang: null,
    docId: null,
    chunkCount: 0,
    faultCodes: entries.length,
    ok: true,
    err: null,
  };
}

async function upsertDocument(input: {
  title: string;
  lang: Lang;
  objectKey: string;
  sha256: string;
}): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into documents (title, lang, object_key, sha256, status)
     values ($1, $2, $3, $4, 'pending')
     on conflict (sha256) do update
       set title = excluded.title,
           lang = excluded.lang,
           object_key = excluded.object_key,
           status = 'pending',
           err = null
     returning id`,
    [input.title, input.lang, input.objectKey, input.sha256],
  );
  if (row === null) throw new IngestError("db_failed", "documents upsert 没有返回 id");
  // uuid 从 pg 里出来是字符串，别 Number()
  return row.id;
}

async function markFailed(docId: string, code: IngestErrorCode): Promise<void> {
  await query(`update documents set status = 'failed', err = $2 where id = $1`, [docId, code]);
}

/** 一份已提取正文的切块 + 嵌入结果；`pageCount` 是清洗后的页数（写进 `documents.pages`）。 */
export interface PageIndex {
  chunks: Chunk[];
  vectors: number[][];
  pageCount: number;
}

/**
 * 「已提取的正文 → 块 + 向量」—— 全仓唯一一处切块/嵌入口径（`09#05`）。
 *
 * 为什么单独抽出来：目录入库（`ingestEntry`）与管理端的重建索引（`core/kb-store.ts`）都要走
 * 清洗 → 分块 → embedding 这三步。两边各写一遍的那天，同一段正文会在两条路径上切出不同的块，
 * 而症状只是"检索质量莫名其妙地差一点"，谁也归因不到这里。
 *
 * 不碰数据库，也不做 `assertTextLayer`：无文本层判定是给**文件**用的（扫描版 PDF 抽不出字），
 * API 录入的正文不存在"没有文本层"这回事 —— 太短的问题由分块器的 `MIN_CHUNK_CHARS` 兜住，
 * 结果是 `empty_after_clean`（08 §6 的同一个错误码）。
 */
export async function indexPages(input: { pages: readonly string[]; lang: Lang }): Promise<PageIndex> {
  const pages = cleanPages(input.pages);
  const chunks = chunkPages(pages, input.lang);
  if (chunks.length === 0) {
    throw new IngestError("empty_after_clean", "清洗/切块后没有任何片段（正文太短或全是页眉页脚）");
  }
  // 入库一律 text_type=document；检索侧是 query，混用会掉召回（08 §5.2）
  const vectors = await embedBatch(
    chunks.map((chunk) => chunk.content),
    "document",
  );
  return { chunks, vectors, pageCount: pages.length };
}

/**
 * 事务写入：删旧片段 → 100 条一批插入 → 置 indexed。
 * 为什么先删：重索引必须幂等，否则同一文件跑两次片段翻倍，检索里同一个片段会占满名额。
 * 为什么整段在一个事务里：半批成功会让 `chunk_count` 与实际行数不符，质量检查就失去意义。
 * `tsv` 是生成列，不许出现在 INSERT 列表里；`embedding` 必须走 `$n::vector`。
 */
async function writeChunks(
  docId: string,
  input: {
    chunks: readonly Chunk[];
    vectors: readonly (readonly number[])[];
    lang: Lang;
    pageCount: number;
    title: string;
    objectKey: string;
  },
): Promise<void> {
  const { chunks, vectors, lang, pageCount, title, objectKey } = input;
  await tx(async (client) => {
    await client.query(`delete from chunks where doc_id = $1`, [docId]);

    for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + INSERT_BATCH_SIZE);
      const batchVectors = vectors.slice(offset, offset + INSERT_BATCH_SIZE);
      await client.query(
        `insert into chunks (doc_id, seq, lang, section, content, page, token_len, embedding)
         select * from unnest($1::uuid[], $2::int[], $3::char(2)[], $4::text[],
                              $5::text[], $6::int[], $7::int[], $8::vector[])`,
        [
          batch.map(() => docId),
          batch.map((chunk) => chunk.seq),
          batch.map(() => lang),
          batch.map((chunk) => chunk.section),
          batch.map((chunk) => chunk.content),
          batch.map((chunk) => chunk.page),
          // 08 §4.4：token_len 用 length/3 估算，不做 tokenizer（入库不引第三方分词）
          batch.map((chunk) => Math.ceil(chunk.content.length / 3)),
          batchVectors.map((vector) => toVectorLiteral(vector)),
        ],
      );
    }

    // 标题在这一步才最终确定：`.json` 的 title 是提取阶段才知道的（upsert 时只能先用文件名）
    await client.query(
      `update documents
          set title = $4, status = 'indexed', chunk_count = $2, pages = $3, err = null
        where id = $1`,
      [docId, chunks.length, pageCount, title],
    );

    // 同一 object_key 的旧版本退场（含上次失败留下的失败行）：chunks 由外键 cascade 带走。
    // 只在新版本写成功之后删 —— 新版本失败时旧版本还是最后一份好数据，与"失败不删已写入片段"一致。
    await client.query(`delete from documents where object_key = $1 and id <> $2`, [objectKey, docId]);
  });
}

/**
 * 一份待入库文件：把"从哪里读正文"与"怎么处理"分开，pipeline 因此只有一份。
 * `absPath` 只有本地源赋真值 —— PDF 抽取要真实文件，其余分支只用 `name` 与 `read()`。
 */
export interface CorpusFile {
  /** 语料相对路径，带正斜杠：`documents.object_key` 与命令行输出都用它（两种源同口径） */
  relPath: string;
  /** 文件名（含后缀）：解析分支、语言、默认标题都看它 */
  name: string;
  /** 本地绝对路径；对象存储源为 null */
  absPath: string | null;
  /** 取原始字节。失败抛错，由调用方把它变成"这一份失败"，不影响同批其余文件 */
  read(): Promise<Buffer>;
}

export interface CorpusSource {
  /** `local` = 宿主机目录（开发回落）；`minio` = 对象存储的语料前缀（部署态） */
  readonly kind: "local" | "minio";
  /** 列出待入库文件。顺序由源保证稳定（命令行逐行打印，顺序漂移就没法 diff） */
  list(): Promise<CorpusFile[]>;
}

/**
 * 单文件入库。失败一律返回 `{ok:false, err:<code>}` 并把 documents 置 failed ——
 * 不把异常丢给调用方决定：状态机只有三种，失败必须落库，否则命令行说失败、库里却还挂着 pending。
 */
export async function ingestFile(absPath: string, relPath: string): Promise<IngestOutcome> {
  return ingestEntry(localFile(absPath, relPath.split(sep).join("/")));
}

/** 本地单文件（原 `ingestFile` 的入参语义）：`relPath` 相对语料根，正斜杠。 */
export function localFile(absPath: string, relPath: string): CorpusFile {
  return {
    relPath: relPath.split(sep).join("/"),
    name: basename(absPath),
    absPath,
    read: () => readFile(absPath),
  };
}

async function ingestEntry(file: CorpusFile): Promise<IngestOutcome> {
  const rel = file.relPath.split(sep).join("/");
  const title = titleFromPath(file.name);

  let bytes: Buffer;
  try {
    bytes = await file.read();
  } catch (err) {
    // 读不到正文（对象被删、网络抖、本地文件没权限）只算这一份失败：一个坏 key 不许拖垮整批
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ relPath: rel, code: "extract_failed", message }, "入库失败");
    return {
      relPath: rel,
      title,
      lang: langFromFilename(file.name),
      docId: null,
      chunkCount: 0,
      ok: false,
      err: "extract_failed",
    };
  }

  // 结构化语料必须在这里分叉：fault_codes.json 没有语言字段、也不该有 documents 行，
  // 走下面的语言解析会以 lang_unknown 失败（那是个误导性的错误码）。
  if (isFaultCodeFile(file.name)) return ingestFaultCodes(bytes.toString("utf8"), file.name, rel);

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const lang = resolveLangOf(file.name, bytes);

  const failed = async (
    docId: string | null,
    code: IngestErrorCode,
    message?: string,
  ): Promise<IngestOutcome> => {
    logger.error({ relPath: rel, code, message }, "入库失败");
    // 已经写入的片段不删：现场排查要看"上次灌进去的是什么"，下次重索引会自己先删
    if (docId !== null) await markFailed(docId, code);
    return { relPath: rel, title, lang, docId, chunkCount: 0, ok: false, err: code };
  };

  // 语言是 documents.lang 的必填项（char(2) + check），拿不到就连行都插不进去。
  // 这种情况没有可标记的文档行，只能在结果里如实报 lang_unknown —— 不要偷偷默认成 en。
  if (lang === null) return failed(null, "lang_unknown");

  let docId: string;
  try {
    docId = await upsertDocument({ title, lang, objectKey: rel, sha256 });
  } catch (err) {
    // documents 都写不进去 = 数据库不可用，没有文档状态可标记，如实抛给调用方
    throw new IngestError("db_failed", `documents upsert 失败：${String(err)}`);
  }

  let extracted: ExtractResult;
  let docTitle = title;
  try {
    extracted = await extractContent({ name: file.name, bytes, absPath: file.absPath }, title);
    assertTextLayer(extracted.pages);
    // `.json` 自带 title（故障码表的正式名称），以文件内为准；其余类型 extractContent 原样返回文件名
    if (extracted.title.trim() !== "") docTitle = extracted.title.trim();
  } catch (err) {
    return failed(docId, errorCodeOf(err), err instanceof Error ? err.message : String(err));
  }

  // 清洗 → 分块 → 嵌入走 `indexPages`（与 `core/kb-store.ts` 的重建共用这一份口径）。
  // 失败码的映射照旧：`empty_after_clean` / `internal_error`（分块器抛的裸 Error）/
  // `embed_*`（`errorCodeOf` 的词表）—— 换实现不换错误码，排障脚本与规格仍然对得上。
  let indexed: PageIndex;
  try {
    indexed = await indexPages({ pages: extracted.pages, lang });
  } catch (err) {
    return failed(docId, errorCodeOf(err), err instanceof Error ? err.message : String(err));
  }

  try {
    await writeChunks(docId, {
      chunks: indexed.chunks,
      vectors: indexed.vectors,
      lang,
      pageCount: indexed.pageCount,
      title: docTitle,
      objectKey: rel,
    });
  } catch (err) {
    return failed(docId, "db_failed", err instanceof Error ? err.message : String(err));
  }

  return {
    relPath: rel,
    title: docTitle,
    lang,
    docId,
    chunkCount: indexed.chunks.length,
    ok: true,
    err: null,
  };
}

/** 以 `.` 开头的文件/目录跳过：`.fixtures/` 里是负例夹具（无文本层 PDF），不该在 `make ingest` 里失败。 */
function isIgnored(name: string): boolean {
  return name.startsWith(".");
}

async function collectFiles(target: string): Promise<string[]> {
  const entries = await readdir(target, { withFileTypes: true }).catch((err: unknown) => {
    throw new IngestError("extract_failed", `读取目录失败 ${target}：${String(err)}`);
  });

  const files: string[] = [];
  // 排序保证输出顺序稳定：命令行逐行打印，顺序漂移会让两次运行的输出没法 diff
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isIgnored(entry.name)) continue;
    const full = join(target, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else if (SUPPORTED_EXTENSIONS.includes(extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

/** 本地目录（或单文件）源：开发回落，也是 `make ingest` 走的那条。 */
export function localSource(target: string): CorpusSource {
  return {
    kind: "local",
    list: async () => {
      const isSingleFile = SUPPORTED_EXTENSIONS.includes(extname(target).toLowerCase());
      const files = isSingleFile ? [target] : await collectFiles(target);
      const baseDir = isSingleFile ? dirname(target) : target;
      return files.map((file) => localFile(file, relative(baseDir, file)));
    },
  };
}

/**
 * MinIO 源：`${S3_BUCKET}/corpus/` 前缀下的 `.md` / `.txt` / `.json`。
 *
 * 跳过规则与本地目录同一口径（`storage.corpusRelPathOf`）：任一路径段以 `.` 开头就跳过，
 * 所以 `corpus/.fixtures/` 里的夹具不会被当语料灌进去。PDF 不在这里列出来 ——
 * `pdftotext` 只认真实文件，对象存储里的字节没法直接抽文本（PDF 仍可走本地目录源）。
 *
 * 正文是**惰性**取的（`read()` 里才 `getObject`）：列出阶段不会因为某个对象读不动而整批中止，
 * 单个 key 取失败只让那一份失败。
 */
export function minioSource(prefix: string = CORPUS_PREFIX): CorpusSource {
  return {
    kind: "minio",
    list: async () => {
      const objects = await listCorpusObjects(prefix);
      return objects.map((object) => ({
        relPath: object.relPath,
        name: object.name,
        absPath: null,
        read: () => getObject(object.key),
      }));
    },
  };
}

/**
 * 按源入库。串行执行：嵌入本身是串行的，文档之间再并发只会互相抢限流额度，
 * 而且串行才能保证"前面成功的文档已落库、后面没跑"这一可解释的中间状态。
 */
export async function ingestSource(source: CorpusSource): Promise<IngestSummary> {
  const files = await source.list();

  const results: IngestOutcome[] = [];
  for (const file of files) {
    try {
      results.push(await ingestEntry(file));
    } catch (err) {
      // 一个文件炸掉不影响其余文件：这是"失败不阻塞"的实现点
      logger.error(
        { relPath: file.relPath, err: err instanceof Error ? err.message : err },
        "入库中止",
      );
      results.push({
        relPath: file.relPath,
        title: titleFromPath(file.name),
        lang: langFromFilename(file.name),
        docId: null,
        chunkCount: 0,
        ok: false,
        err: errorCodeOf(err),
      });
    }
  }

  const okCount = results.filter((result) => result.ok).length;
  return { results, okCount, failedCount: results.length - okCount };
}

/** 本地目录（或单文件）入库 —— `ingestSource(localSource(target))` 的等价简写。 */
export async function ingestPath(target: string): Promise<IngestSummary> {
  return ingestSource(localSource(target));
}
