/**
 * 入库流水线的断言（08-ingestion.md / 02-corpus-ingestion spec §Testing Decisions）。
 *
 * 两层接缝：
 *   1. 纯函数直接测（清洗、分块、兜底向量）—— 不碰数据库，不读环境变量；
 *   2. CLI 子进程 + SQL 断言 —— 入库真连库、真写向量，这部分没有进程内假对象的替代品。
 *      数据库不可用时第 2 层跳过（和 tests/data-modules.test.ts 的约定一致）。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { cleanPages, cleanText, toHalfwidthDigitsAndParens } from "../src/core/clean.ts";
import {
  chunkPages,
  MIN_CHUNK_CHARS,
  OVERLAP_CHARS,
  TARGET_CHARS_LATIN,
  TARGET_CHARS_ZH,
  targetChars,
} from "../src/core/chunk.ts";
import { hashEmbed, HASH_DIM, tokenize } from "../src/core/hash-embed.ts";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(repoRoot, "corpus", ".fixtures");

// ─────────────────────────── 纯函数 ───────────────────────────

test("兜底向量：同文本逐分量相等，不同文本不等，维度 1024 且已 L2 归一化", () => {
  const text = "储能系统必须由持证安装商完成并网调试 warranty scope";
  const a = hashEmbed(text);
  const b = hashEmbed(text);
  const c = hashEmbed("完全不同的另一段文本，讲的是故障码与备件更换");

  assert.equal(a.length, HASH_DIM);
  assert.equal(a.length, 1024);
  assert.deepEqual(a, b, "同一文本两次生成必须逐分量相等（评测要可复现）");

  const differing = a.reduce((count, value, index) => (value === c[index] ? count : count + 1), 0);
  assert.ok(differing > 0, "不同文本必须产生不同向量");

  const norm = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-12, `向量必须 L2 归一化，实际范数 ${norm}`);

  // 空文本没有 token：全零向量（调用方保证不会把空串送进库）
  assert.deepEqual(hashEmbed("  "), new Array<number>(HASH_DIM).fill(0));
});

test("兜底向量切词：中文按字、西文按词，大小写归一", () => {
  assert.deepEqual(tokenize("保修 期限"), ["保", "修", "期", "限"]);
  assert.deepEqual(tokenize("Warranty, SCOPE!"), ["warranty", "scope"]);
});

test("清洗：连续三页的页眉页脚不出现在任何片段里", () => {
  const header = "沃泰能源 WT-ESS-5K 安装手册 · 第 3 版";
  const footer = "沃泰能源能源科技有限公司 版权所有";
  // 每页正文都不同：判页眉的规则是"同一行连续三页出现"，重复的正文行会被一并去掉，
  // 所以样例里只有页眉页脚是重复的（真实手册也是这样）
  const bodyOf = (pageNo: number): string[] => [
    `第${pageNo}页正文：储能系统必须由持证安装商完成并网调试，不得由终端业主自行接线或改动并网参数。`,
    `第${pageNo}页续：安装前请确认墙面承重不低于八十公斤，并在设备四周预留十厘米以上的散热空间。`,
  ];
  const pages = [1, 2, 3].map((pageNo) => {
    const [first, second] = bodyOf(pageNo);
    return [`${header}\n${first ?? ""}`, `${second ?? ""}\n${pageNo}\n${footer}`].join("\n\n");
  });

  const cleaned = cleanPages(pages);
  assert.equal(cleaned.length, 3, "清洗不得改变页数与页序（页码直接吃这个下标）");

  const chunks = chunkPages(cleaned, "zh");
  assert.ok(chunks.length > 0);
  for (const chunk of chunks) {
    assert.equal(chunk.content.includes(header), false, `页眉漏进了片段：${chunk.content.slice(0, 40)}`);
    assert.equal(chunk.content.includes(footer), false, "页脚漏进了片段");
    assert.equal(/^\s*\d{1,3}\s*$/m.test(chunk.content), false, "孤立页码行漏进了片段");
  }
  // 正文必须还在（不是"全删了所以干净"）
  assert.ok(chunks.some((chunk) => chunk.content.includes("不得由终端业主自行接线")));
});

test("清洗：全角转半角只动数字与英文括号，大小写与标点原样保留", () => {
  assert.equal(toHalfwidthDigitsAndParens("（１２３）"), "(123)");
  assert.equal(
    cleanText("型号 WT-ESS-５Ｋ（额定 ５.１２ kWh），CASE 保留！"),
    // 全角字母 `Ｋ` 不在"仅数字与英文括号"的范围内，必须原样留着
    "型号 WT-ESS-5Ｋ(额定 5.12 kWh)，CASE 保留！",
  );
  // 全角中文括号以外的全角符号不动：过度转换会破坏原文
  assert.equal(cleanText("请注意：额定功率 ５ kW；"), "请注意：额定功率 5 kW；");
});

test("清洗：折叠连续空行与行尾空格", () => {
  const cleaned = cleanText("第一段内容足够长用来占位。   \n\n\n\n第二段内容也足够长。\t\n");
  assert.equal(cleaned.includes("   \n"), false, "行尾空格必须删掉");
  assert.equal(/\n{3,}/.test(cleaned), false, "连续空行必须折叠成一段空行");
});

test("分块：中文样例的块长区间与重叠对齐", () => {
  const sentence = "储能系统必须由持证安装商完成并网调试，不得由终端业主自行接线。";
  const body = Array.from({ length: 40 }, () => sentence).join("");
  const chunks = chunkPages([`## 1 安全须知\n\n${body}`], "zh");

  assert.ok(chunks.length >= 3, `1240 字的中文正文按 500 切应该不止两块，实际 ${chunks.length}`);
  assert.deepEqual(
    chunks.map((chunk) => chunk.seq),
    chunks.map((_, index) => index + 1),
    "seq 必须从 1 连续递增",
  );

  for (const chunk of chunks) {
    // 上界 = 目标长度 + 重叠 + 过短块并入带来的余量（≤ MIN_CHUNK_CHARS）
    assert.ok(
      chunk.content.length >= MIN_CHUNK_CHARS &&
        chunk.content.length <= TARGET_CHARS_ZH + OVERLAP_CHARS + MIN_CHUNK_CHARS,
      `第 ${chunk.seq} 块长度 ${chunk.content.length} 超出 [${MIN_CHUNK_CHARS}, ${TARGET_CHARS_ZH + OVERLAP_CHARS + MIN_CHUNK_CHARS}]`,
    );
    assert.ok(chunk.content.length <= 2000, "块长不得超过 2000（08 §10 的质量检查口径）");
    assert.equal(chunk.section, "1 安全须知");
    assert.equal(chunk.page, 1);
  }

  // 相邻块重叠：后块的开头必须能在前块的结尾里找到（句首对齐）
  for (let i = 1; i < chunks.length; i += 1) {
    const previous = chunks[i - 1]?.content ?? "";
    const current = chunks[i]?.content ?? "";
    let overlap = 0;
    for (let k = Math.min(previous.length, OVERLAP_CHARS + 40); k > 0; k -= 1) {
      if (previous.endsWith(current.slice(0, k))) {
        overlap = k;
        break;
      }
    }
    assert.ok(overlap > 0, `第 ${i} 块与第 ${i + 1} 块没有重叠`);
    assert.ok(overlap <= OVERLAP_CHARS, `重叠长度 ${overlap} 超过 ${OVERLAP_CHARS}`);
  }
});

test("分块：三页样例里第二页开头的块 page = 2", async () => {
  const raw = await readFile(join(fixtures, "paged.zh.txt"), "utf8");
  const pages = raw.split("\f");
  assert.equal(pages.length, 3, "夹具必须是三页");

  const chunks = chunkPages(cleanPages(pages), "zh");
  assert.deepEqual(chunks.map((chunk) => chunk.page), [1, 2, 3]);
  assert.deepEqual(chunks.map((chunk) => chunk.section), ["1 保修范围", "2 保修期限", "3 报修流程"]);
  // 第二页的块内容来自第二页正文：重叠前缀不算页码
  assert.ok(chunks[1]?.content.includes("整机保修期为十年"));
});

test("分块：目标长度按文档语言取，不按字符类型猜", () => {
  assert.equal(targetChars("zh"), TARGET_CHARS_ZH);
  assert.equal(targetChars("de"), TARGET_CHARS_LATIN);

  const sentence = "The installer must complete commissioning before the system is energised. ";
  const body = sentence.repeat(11).trim(); // ≈ 800 字符：中文目标会切两块，西文目标一块装得下
  const asChinese = chunkPages([`## 1 Scope\n\n${body}`], "zh");
  const asGerman = chunkPages([`## 1 Scope\n\n${body}`], "de");

  assert.ok(asChinese.length >= 2, `按 zh 目标应该切块，实际 ${asChinese.length} 块`);
  assert.equal(asGerman.length, 1, `按西文目标 800 字符应该是一块，实际 ${asGerman.length} 块`);
  assert.ok((asGerman[0]?.content.length ?? 0) > TARGET_CHARS_ZH, "西文块长可以超过中文目标长度");
});

test("分块：表格独立成块且块首重复表头", () => {
  const table = [
    "| 故障码 | 含义 | 处理 |",
    "| E01 | 电池过压 | 断开并网开关 |",
    "| E02 | 绝缘阻抗低 | 检查接地 |",
  ].join("\n");
  const chunks = chunkPages([`## 1 故障码\n\n${table}\n\n现场排查请先确认故障码含义。`], "zh");

  const tableChunk = chunks.find((chunk) => chunk.content.includes("E01"));
  assert.ok(tableChunk, "表格必须成为独立的块");
  assert.ok(tableChunk.content.startsWith("| 故障码 | 含义 | 处理 |"), "表格块必须以表头开头");
});

test("分块：过短块并入上一块，没有上一块则丢弃", () => {
  const long = "储能系统必须由持证安装商完成并网调试，不得由终端业主自行接线。".repeat(20);
  const chunks = chunkPages([`## 1 正文\n\n${long}\n\n短。`], "zh");
  for (const chunk of chunks) {
    assert.ok(chunk.content.length >= MIN_CHUNK_CHARS, `块长 ${chunk.content.length} 低于下限`);
  }

  const dropped = chunkPages(["短。"], "zh");
  assert.deepEqual(dropped, [], "没有上一块时，过短内容必须丢弃而不是入库");
});

// ─────────────────── CLI 子进程 + SQL 断言（需要真库） ───────────────────

async function loadDotEnv(): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, ".env"), "utf8");
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1] as string;
    const value = (match[2] as string).replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "") env[key] = value;
  }
  return env;
}

const dotenv = await loadDotEnv();
for (const [key, value] of Object.entries(dotenv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}
const hasRuntimeEnv = Boolean(process.env.DATABASE_URL);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有 DATABASE_URL）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

const createdShas: string[] = [];

after(async () => {
  if (!hasRuntimeEnv) return;
  if (createdShas.length > 0) {
    // 测试写进去的文档要收干净（chunks 由外键 cascade 带走），否则污染质量检查的计数
    const list = createdShas.map((sha) => `'${sha}'`).join(",");
    await psql(`delete from documents where sha256 in (${list})`).catch(() => undefined);
  }
  // 本文件只做 SQL 断言，不发起进程内查询；但 ingest.ts 会连带 import db.ts 建池，收一下更干净
  const { pool } = await import("../src/db.ts");
  await pool.end().catch(() => undefined);
});

async function psql(sql: string): Promise<string> {
  const { stdout } = await execFileAsync("bash", ["data/scripts/db.sh", "psql", "-tAc", sql], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function runCli(target: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--env-file-if-exists=.env", "scripts/ingest.ts", target],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

/**
 * 钉住本地兜底向量的那一版：断言"旧版本退场"是库内行为，与嵌入服务无关，
 * 让外部 API 的抖动（限流、15s 超时）不要被读成"入库失败"——那是另一种失败，已经另有断言。
 */
async function runCliHash(target: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--env-file-if-exists=.env", "scripts/ingest.ts", target],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, EMBED_BACKEND: "hash" } },
    );
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

async function sha256Of(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * 一次查询把文档行、片段数、页码序列、坏片段数全取回来：
 * `db.sh psql` 每次启动要 ~1.7s（要过一遍 docker），断言拆成十几个调用会让测试慢到没人愿意跑。
 */
function documentSnapshotSql(sha: string): string {
  return `select d.id || '|' || d.status || '|' || coalesce(d.err, '') || '|'
                 || d.chunk_count || '|'
                 || (select count(*) from chunks c where c.doc_id = d.id) || '|'
                 || coalesce((select string_agg(c.page::text, ',' order by c.seq)
                              from chunks c where c.doc_id = d.id), '') || '|'
                 || (select count(*) from chunks c where c.doc_id = d.id
                      and (c.embedding is null or c.section is null or c.page is null or c.token_len is null)) || '|'
                 || (select count(*) from chunks c where c.doc_id = d.id
                      and (length(c.content) > 2000 or length(trim(c.content)) < 60))
          from documents d where d.sha256 = '${sha}'`;
}

function parseSnapshot(row: string): {
  id: string;
  status: string;
  err: string;
  chunkCount: number;
  actualChunks: number;
  pages: string;
  badChunks: number;
  badLengths: number;
} {
  const [id, status, err, chunkCount, actualChunks, pages, badChunks, badLengths] = row.split("|");
  return {
    id: id ?? "",
    status: status ?? "",
    err: err ?? "",
    chunkCount: Number(chunkCount ?? "0"),
    actualChunks: Number(actualChunks ?? "0"),
    pages: pages ?? "",
    badChunks: Number(badChunks ?? "0"),
    badLengths: Number(badLengths ?? "0"),
  };
}

test("无文本层：落 failed + err=no_text_layer，其余文件仍成功，退出码 1，已写入片段不被回滚删除", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { assertTextLayer, errorCodeOf, IngestError } = await import("../src/core/ingest.ts");
  const { EmbedError } = await import("../src/core/embed.ts");

  // 空文本直接命中失败分支（不依赖宿主机能抽出中文 PDF）
  assert.throws(
    () => assertTextLayer([""]),
    (err: unknown) => err instanceof IngestError && err.code === "no_text_layer",
  );

  // 状态机只有三种，失败必须带字符串错误码：嵌入错误要映射成 documents.err 的词表
  assert.equal(errorCodeOf(new EmbedError("EMBED_DIM_MISMATCH")), "embed_dim_mismatch");
  assert.equal(errorCodeOf(new EmbedError("EMBED_TIMEOUT")), "embed_timeout");
  assert.equal(errorCodeOf(new EmbedError("EMBED_UNAVAILABLE")), "embed_unavailable");
  assert.equal(errorCodeOf(new IngestError("no_text_layer")), "no_text_layer");
  assert.equal(errorCodeOf(new Error("未归类的异常")), "internal_error");

  const dir = await mkdtemp(join(tmpdir(), "wt-ingest-scan-"));
  try {
    await copyFile(join(fixtures, "paged.zh.txt"), join(dir, "good.zh.txt"));
    await copyFile(join(fixtures, "scan-sample.en.pdf"), join(dir, "scan.en.pdf"));
    const goodSha = await sha256Of(join(dir, "good.zh.txt"));
    const scanSha = await sha256Of(join(dir, "scan.en.pdf"));
    createdShas.push(goodSha, scanSha);

    const first = await runCli(dir);
    assert.equal(first.code, 1, "有文件失败时退出码必须是 1");
    assert.match(first.output, /scan\.en\.pdf\s+en\s+chunks=0\s+failed: no_text_layer/);
    assert.match(first.output, /good\.zh\.txt\s+zh\s+chunks=[1-9]\d*\s+ok/);

    const scan = parseSnapshot(await psql(documentSnapshotSql(scanSha)));
    assert.equal(scan.status, "failed", "扫描版 PDF 必须落 failed");
    assert.equal(scan.err, "no_text_layer", "失败必须带错误码字符串");
    assert.equal(scan.actualChunks, 0, "失败文档不该留下空片段");

    const good = parseSnapshot(await psql(documentSnapshotSql(goodSha)));
    assert.equal(good.status, "indexed", "其余文件必须照常入库成功");
    assert.equal(good.err, "");
    assert.ok(good.actualChunks >= 3, `三页样例至少三块，实际 ${good.actualChunks}`);

    // 失败路径不允许回滚删除已写入的片段：预置一条片段，再失败一次，它必须还在
    // （CTE 里同一语句看不到自己刚插入的行，所以从 probe 里数，而不是再查一次 chunks）
    const probeCount = await psql(
      `with probe as (
         insert into chunks (doc_id, seq, lang, section, content, page, token_len)
         values ('${scan.id}', 1, 'en', 'probe',
                 '占位片段：验证失败路径不会回滚删除已写入的片段。', 1, 20)
         returning 1
       )
       select count(*) from probe`,
    );
    assert.equal(probeCount, "1");

    const second = await runCli(dir);
    assert.equal(second.code, 1, "失败文件必须让退出码保持 1");
    const after2 = parseSnapshot(await psql(documentSnapshotSql(scanSha)));
    assert.equal(after2.status, "failed");
    assert.equal(after2.actualChunks, 1, "失败时已写入的片段必须保留（下次重索引才删）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("幂等：同一文件连续入库两次，文档数/片段数/doc_id 都不变，页码落库", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "wt-ingest-idem-"));
  try {
    await copyFile(join(fixtures, "paged.zh.txt"), join(dir, "paged.zh.txt"));
    const sha = await sha256Of(join(dir, "paged.zh.txt"));
    createdShas.push(sha);

    const first = await runCli(dir);
    assert.equal(first.code, 0, first.output);
    const before = parseSnapshot(await psql(documentSnapshotSql(sha)));
    assert.equal(before.status, "indexed");
    assert.ok(before.actualChunks >= 3, `三页样例至少三块，实际 ${before.actualChunks}`);
    assert.equal(before.chunkCount, before.actualChunks, "chunk_count 必须与实际片段数一致");
    assert.equal(before.pages, "1,2,3", "每块的起始页码必须落库，第二页开头的块 page=2");
    assert.equal(before.badChunks, 0, "片段必须带向量、章节名与起始页码");
    assert.equal(before.badLengths, 0, "不得有空块或超长块");

    const second = await runCli(dir);
    assert.equal(second.code, 0, second.output);
    const docCount = await psql(`select count(*) from documents where sha256 = '${sha}'`);
    const after2 = parseSnapshot(await psql(documentSnapshotSql(sha)));
    assert.equal(docCount, "1", "sha256 是幂等键：同一内容只能有一行 documents");
    assert.equal(after2.id, before.id, "重跑必须复用同一个 doc_id");
    assert.equal(after2.actualChunks, before.actualChunks, "重跑必须复用同一批片段行数（先删后插）");
    assert.equal(after2.pages, "1,2,3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("改完文件再入库：旧版本退场，同一 object_key 只剩一行 documents", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "wt-ingest-edit-"));
  try {
    const file = join(dir, "edited.zh.txt");
    await copyFile(join(fixtures, "paged.zh.txt"), file);
    // 先加一行本用例独有的内容：否则与"幂等"用例共用同一份夹具，两条用例会在库里操作同一行
    await appendFile(file, "\n\n## 初版\n\n改版前的版本，仅供本用例使用。\n");
    const oldSha = await sha256Of(file);
    createdShas.push(oldSha);

    const first = await runCliHash(dir);
    assert.equal(first.code, 0, first.output);
    const before = parseSnapshot(await psql(documentSnapshotSql(oldSha)));
    assert.equal(before.status, "indexed");
    assert.ok(before.actualChunks >= 3, `三页样例至少三块，实际 ${before.actualChunks}`);

    // 内容维护者的日常动作：改文件（这里是追加一段），再跑一遍入库
    await appendFile(
      file,
      "\n\n## 补充说明\n\n改完文件后重新入库，库里应当只留下这一版内容；改之前的旧版本必须退场，" +
        "否则检索会引用到已经被改掉的段落。\n",
    );
    const newSha = await sha256Of(file);
    createdShas.push(newSha);
    assert.notEqual(newSha, oldSha, "追加内容后 sha256 必须变化");

    const second = await runCliHash(dir);
    assert.equal(second.code, 0, second.output);

    const docCount = await psql(
      `select count(*) from documents where object_key = 'edited.zh.txt'`,
    );
    assert.equal(docCount, "1", "同一 object_key 只能有一行 documents（新版本替换旧版本）");
    const oldDoc = await psql(`select count(*) from documents where sha256 = '${oldSha}'`);
    assert.equal(oldDoc, "0", "旧版本的 documents 行必须被删掉");
    const oldChunks = await psql(
      `select count(*) from chunks where doc_id = '${before.id}'`,
    );
    assert.equal(oldChunks, "0", "旧版本的片段必须被外键 cascade 一起删掉");

    const after = parseSnapshot(await psql(documentSnapshotSql(newSha)));
    assert.equal(after.status, "indexed");
    assert.ok(after.actualChunks >= 3, `新版本至少三块，实际 ${after.actualChunks}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
