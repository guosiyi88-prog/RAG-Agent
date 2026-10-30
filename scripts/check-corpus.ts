/**
 * 语料质量自检（08-ingestion.md §10 / 02-corpus-ingestion spec「语料清单与规模」）。
 *
 * 一条命令回答一个问题：**现在库里这份语料，能不能拿去做评测？** 每项数字各带阈值，
 * 任一不达标就以退出码 1 结束，好让 CI 与演示脚本不必人去读日志。
 * 对应 08 §10 的五条查询（片段数 / 超长块 / 空块 / 空向量 / 文档状态），另加语种纯度与故障码表。
 *
 * 阈值刻意写成常量而不是命令行参数：能现场调阈值就等于没有阈值。
 *
 * 用法：node --env-file-if-exists=.env scripts/check-corpus.ts
 */
import { LANGUAGES, MAX_CHUNK_CHARS, MIN_CHUNK_CHARS } from "../src/core/chunk.ts";
import { pool, query } from "../src/db.ts";

/** 五语各 ≥8 块、合计 ≥40 块：低于这个量，五语评测里的 hit@5 只是抽样噪声。 */
export const MIN_CHUNKS_PER_LANG = 8;
export const MIN_CHUNKS_TOTAL = 40;
/** 空向量等于该块永远不会被向量召回；超长块说明切分失败 —— 两者都必须为 0。 */
export const MAX_EMPTY_EMBEDDINGS = 0;
export const MAX_OVERSIZED_CHUNKS = 0;
/** 08 §10 第 3 条：正文短于 MIN_CHUNK_CHARS 的块没有信息量，进向量库只会污染召回，必须为 0。 */
export const MAX_SHORT_CHUNKS = 0;
/** 已索引文档 ≥11（保修/安装各五语 + 产品参数三语 = 13 份；故障码是结构化语料，不产生 documents 行）；待处理与失败都必须为 0。 */
export const MIN_INDEXED_DOCS = 11;
export const MAX_PENDING_DOCS = 0;
export const MAX_FAILED_DOCS = 0;
/** 同一 object_key 多行 = 改完文件重跑入库后旧版本没退场：检索会引用到已经被改掉的段落。 */
export const MAX_DUPLICATE_DOCS = 0;
/** de/nl/es 里出现汉字说明机翻漏译或语料贴错文件，用户会直接看到。 */
export const MAX_CJK_IN_LATIN_CHUNKS = 0;
/** 故障码表的最小规模：少于 3 条说明结构化语料没灌进去。 */
export const MIN_FAULT_CODES = 3;

interface Line {
  ok: boolean;
  label: string;
  detail: string;
}

function line(ok: boolean, label: string, detail: string): Line {
  return { ok, label, detail };
}

async function checkLangCoverage(): Promise<{ line: Line; counts: Record<string, number> }> {
  const rows = await query<{ lang: string; n: number }>(
    `select lang, count(*)::int as n from chunks group by lang`,
  );
  const counts: Record<string, number> = {};
  for (const lang of LANGUAGES) counts[lang] = 0;
  for (const row of rows) counts[row.lang] = row.n;

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const short = LANGUAGES.filter((lang) => (counts[lang] ?? 0) < MIN_CHUNKS_PER_LANG);
  const ok = short.length === 0 && total >= MIN_CHUNKS_TOTAL;
  const detail = `${LANGUAGES.map((lang) => `${lang}=${counts[lang] ?? 0}`).join(" ")} 合计=${total}` +
    `（阈值 每语 ≥${MIN_CHUNKS_PER_LANG}、合计 ≥${MIN_CHUNKS_TOTAL}` +
    `${short.length > 0 ? `；不足：${short.join(",")}` : ""}）`;
  return { line: line(ok, "片段数", detail), counts };
}

async function checkChunkQuality(): Promise<Line> {
  const row = await query<{ empty: number; oversized: number; short: number }>(
    `select count(*) filter (where embedding is null)::int as empty,
            count(*) filter (where length(content) > $1)::int as oversized,
            count(*) filter (where length(trim(content)) < $2)::int as short
       from chunks`,
    [MAX_CHUNK_CHARS, MIN_CHUNK_CHARS],
  );
  const empty = row[0]?.empty ?? 0;
  const oversized = row[0]?.oversized ?? 0;
  const short = row[0]?.short ?? 0;
  const ok =
    empty <= MAX_EMPTY_EMBEDDINGS &&
    oversized <= MAX_OVERSIZED_CHUNKS &&
    short <= MAX_SHORT_CHUNKS;
  return line(ok, "块质量", `空向量=${empty}（阈值 ${MAX_EMPTY_EMBEDDINGS}）、` +
    `超长块=${oversized}（>${MAX_CHUNK_CHARS} 字符，阈值 ${MAX_OVERSIZED_CHUNKS}）、` +
    `过短块=${short}（<${MIN_CHUNK_CHARS} 字符，阈值 ${MAX_SHORT_CHUNKS}）`);
}

async function checkDocuments(): Promise<Line> {
  const rows = await query<{ status: string; n: number }>(
    `select status, count(*)::int as n from documents group by status`,
  );
  const byStatus: Record<string, number> = { pending: 0, indexed: 0, failed: 0 };
  for (const row of rows) byStatus[row.status] = row.n;

  // 同一 object_key 多行 = 改完文件重跑入库后旧版本还在：与"失败/待处理"一样是脏状态，
  // 只是它不自报，只能靠这条分组计数抓出来（片段会一并检索到，引用指向旧段落）
  const dup = await query<{ dup: number; keys: string | null }>(
    `select count(*)::int as dup, string_agg(object_key, ',') as keys
       from (select object_key from documents group by object_key having count(*) > 1) grouped`,
  );
  const duplicate = dup[0]?.dup ?? 0;
  const offenders = dup[0]?.keys ?? "";

  const ok =
    (byStatus.indexed ?? 0) >= MIN_INDEXED_DOCS &&
    (byStatus.pending ?? 0) <= MAX_PENDING_DOCS &&
    (byStatus.failed ?? 0) <= MAX_FAILED_DOCS &&
    duplicate <= MAX_DUPLICATE_DOCS;
  return line(
    ok,
    "文档状态",
    `indexed=${byStatus.indexed} pending=${byStatus.pending} failed=${byStatus.failed}` +
      ` 多版本=${duplicate}${offenders === "" ? "" : `（${offenders}）`}` +
      `（阈值 indexed ≥${MIN_INDEXED_DOCS}、pending ${MAX_PENDING_DOCS}、failed ${MAX_FAILED_DOCS}、` +
      `多版本 ${MAX_DUPLICATE_DOCS}）`,
  );
}

async function checkLatinPurity(): Promise<Line> {
  // `[一-龥]` 覆盖常用汉字区：de/nl/es 片段里出现任何一个，都是漏译或文件贴错
  const row = await query<{ lang: string; n: number }>(
    `select lang, count(*)::int as n
       from chunks
      where lang in ('de','nl','es') and content ~ '[一-龥]'
      group by lang
      order by lang`,
  );
  const total = row.reduce((sum, item) => sum + item.n, 0);
  const detail =
    total === 0
      ? `0 条（阈值 ${MAX_CJK_IN_LATIN_CHUNKS}）`
      : `${row.map((item) => `${item.lang}=${item.n}`).join(" ")}（阈值 ${MAX_CJK_IN_LATIN_CHUNKS}）`;
  return line(total <= MAX_CJK_IN_LATIN_CHUNKS, "语种纯度", `de/nl/es 含 CJK 的片段 ${detail}`);
}

async function checkFaultCodes(): Promise<Line> {
  // 五语齐全 = 十列描述与步骤全部非空；缺一门语言在那一门语言里等于查不到这个故障码
  // 只统计 `published`（09#02 / D24）：门禁守的是"对外承诺"，一条只填了中英的草稿不该把
  // 全绿变成红；反过来，published 行缺任何一语都必须红（下面的 `complete === total`）。
  const row = await query<{ total: number; complete: number }>(
    `select count(*)::int as total,
            count(*) filter (
              where desc_zh <> '' and desc_en <> '' and desc_de <> '' and desc_nl <> '' and desc_es <> ''
                and act_zh <> '' and act_en <> '' and act_de <> '' and act_nl <> '' and act_es <> ''
            )::int as complete
       from fault_codes
      where status = 'published'`,
  );
  const total = row[0]?.total ?? 0;
  const complete = row[0]?.complete ?? 0;
  const ok = complete >= MIN_FAULT_CODES && complete === total;
  return line(
    ok,
    "故障码",
    `已发布 ${total} 条，五语齐全 ${complete}/${total}（阈值 ≥${MIN_FAULT_CODES} 且无缺语；draft 不计入门禁）`,
  );
}

async function main(): Promise<void> {
  process.stdout.write(
    `语料质量自检：每语片段 ≥${MIN_CHUNKS_PER_LANG}、合计 ≥${MIN_CHUNKS_TOTAL}、` +
      `空向量 ${MAX_EMPTY_EMBEDDINGS}、超长块 ${MAX_OVERSIZED_CHUNKS}、` +
      `过短块 ${MAX_SHORT_CHUNKS}（<${MIN_CHUNK_CHARS} 字符）、` +
      `已索引文档 ≥${MIN_INDEXED_DOCS}、失败文档 ${MAX_FAILED_DOCS}、多版本 ${MAX_DUPLICATE_DOCS}\n`,
  );

  const coverage = await checkLangCoverage();
  const lines = [
    coverage.line,
    await checkChunkQuality(),
    await checkDocuments(),
    await checkLatinPurity(),
    await checkFaultCodes(),
  ];

  for (const item of lines) {
    process.stdout.write(`[${item.ok ? "ok  " : "fail"}] ${item.label.padEnd(12)}${item.detail}\n`);
  }

  const failed = lines.filter((item) => !item.ok);
  process.stdout.write(
    failed.length === 0
      ? "结论：语料健康，可用于评测。\n"
      : `结论：${failed.length} 项不达标（${failed.map((item) => item.label).join("、")}），先修语料再评测。\n`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`自检失败：${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  // 连接池不收，进程会被空闲计时器拖住 30s 才退出，看起来像卡死（同 scripts/ingest.ts）
  .finally(() => pool.end().catch(() => undefined));
