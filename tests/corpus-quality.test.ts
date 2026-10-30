/**
 * 语料质量门槛（02-corpus-ingestion spec「数据质量」断言 / 08-ingestion.md §10）。
 *
 * 断言的都是**库里的产物**，不是函数被调了几次：五语片段规模、空向量、超长块、语种纯度、
 * 故障码表是否被结构化语料填满、以及"同一份语料连跑两遍行数不变"这条幂等契约。
 *
 * SQL 走 `bash data/scripts/db.sh psql`，与 tests/schema.test.ts 同一接缝：换掉 pg 驱动不影响本文件。
 * 每次 psql 启动要过一遍 docker（约 1.7s），所以一个快照用**一条** SQL 拼出全部计数，
 * 而不是十几个 -c。
 *
 * **为什么 `npm test` 必须串行（`node --test --test-concurrency=1`）**：本文件断言的是**全库**
 * 不变量（documents 里 status='failed' 的行数、chunks 总数、各语种片段数），而 tests/ingest-pure.test.ts
 * 也会往同一个 wt_dev 写一份 `status='failed'` 的夹具文档，只在自己 after() 里删。若文件级并发，
 * 快照正好落在它"已落库、未清理"的窗口里，failedDocs 就会是 1 —— 断言没错，是并发窗口错。
 * 共享一个 Postgres 的库级断言只能靠串行化保证确定；**不要**把 failedDocs===0 或片段数放宽来"修"，
 * 那是语料的健康门槛。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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

after(async () => {
  if (!hasRuntimeEnv) return;
  // 本文件只用 SQL 与子进程，进程内没有建池；但 import 过 src/core/chunk.ts 不建池，
  // 这里只是为了与其它文件保持同一收尾习惯（无池时 end 是 no-op）
  const { pool } = await import("../src/db.ts");
  await pool.end().catch(() => undefined);
});

async function psql(statement: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "bash",
    ["data/scripts/db.sh", "psql", "-q", "-tAc", statement],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return stdout.trim();
}

async function runIngest(): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--env-file-if-exists=.env", "scripts/ingest.ts", "corpus"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

interface Snapshot {
  totalChunks: number;
  perLang: Record<string, number>;
  indexedDocs: number;
  pendingDocs: number;
  failedDocs: number;
  emptyEmbeddings: number;
  oversizedChunks: number;
  cjkInLatin: number;
  /** 同一 object_key 有多个已索引版本的个数：改完文件重跑入库，旧版本必须退场 */
  duplicateDocs: number;
  faultCodeRows: number;
  faultCodeComplete: number;
  faultCodeChunks: number;
  /** 文档 id + sha256 + status + chunk_count 的摘要：两次入库之间任何一个变了都会换值 */
  docDigest: string;
  /** `E03:balcony:full,E07:balcony:full,F21:residential:full` 这种形状 */
  faultDetail: string;
}

const COMPLETE_FAULT_CODE_SQL = `(
  desc_zh <> '' and desc_en <> '' and desc_de <> '' and desc_nl <> '' and desc_es <> ''
  and act_zh <> '' and act_en <> '' and act_de <> '' and act_nl <> '' and act_es <> ''
)`;

/**
 * 一个快照 = 一条 SQL。字段用 `|` 分隔，行内第一段是 totalChunks…最后是文档摘要。
 * `~ '[一-龥]'` 是常用汉字区，de/nl/es 里出现任何一个都算漏译。
 */
function snapshotSql(): string {
  return `select
  (select count(*)::int from chunks) || '|' ||
  (select count(*)::int from chunks where lang = 'zh') || '|' ||
  (select count(*)::int from chunks where lang = 'en') || '|' ||
  (select count(*)::int from chunks where lang = 'de') || '|' ||
  (select count(*)::int from chunks where lang = 'nl') || '|' ||
  (select count(*)::int from chunks where lang = 'es') || '|' ||
  (select count(*)::int from documents where status = 'indexed') || '|' ||
  (select count(*)::int from documents where status = 'pending') || '|' ||
  (select count(*)::int from documents where status = 'failed') || '|' ||
  (select count(*)::int from chunks where embedding is null) || '|' ||
  (select count(*)::int from chunks where length(content) > 2000) || '|' ||
  (select count(*)::int from chunks where lang in ('de','nl','es') and content ~ '[一-龥]') || '|' ||
  (select count(*)::int from (
     select object_key from documents group by object_key having count(*) > 1
   ) dup) || '|' ||
  (select count(*)::int from fault_codes where status = 'published') || '|' ||
  (select count(*)::int from fault_codes
    where status = 'published' and ${COMPLETE_FAULT_CODE_SQL}) || '|' ||
  (select count(*)::int from chunks c join documents d on d.id = c.doc_id
    where d.object_key ilike '%fault_code%') || '|' ||
  (select md5(string_agg(id::text || ':' || sha256 || ':' || status || ':' || chunk_count,
                         ',' order by id)) from documents) || '|' ||
  coalesce((select string_agg(code || ':' || product_line || ':'
                              || case when ${COMPLETE_FAULT_CODE_SQL} then 'full' else 'gap' end,
                              ',' order by code)
              from fault_codes where code in ('E03','E07','F21')), '')`;
}

async function snapshot(): Promise<Snapshot> {
  const raw = await psql(snapshotSql());
  const parts = raw.split("|");
  const num = (index: number): number => Number(parts[index] ?? "0");
  return {
    totalChunks: num(0),
    perLang: { zh: num(1), en: num(2), de: num(3), nl: num(4), es: num(5) },
    indexedDocs: num(6),
    pendingDocs: num(7),
    failedDocs: num(8),
    emptyEmbeddings: num(9),
    oversizedChunks: num(10),
    cjkInLatin: num(11),
    duplicateDocs: num(12),
    faultCodeRows: num(13),
    faultCodeComplete: num(14),
    faultCodeChunks: num(15),
    docDigest: parts[16] ?? "",
    faultDetail: parts[17] ?? "",
  };
}

/**
 * 入库两遍 + 每遍之后各拍一个快照。做成 memoized promise，好让每个 test 独立 await 而不重复跑。
 * 第一遍的"之前"快照不必取：要证明的是两次运行之间**不变**，而不是"库里原本是空的"。
 */
let snapshotsPromise: Promise<{ first: Snapshot; second: Snapshot }> | null = null;

function loadSnapshots(): Promise<{ first: Snapshot; second: Snapshot }> {
  snapshotsPromise ??= (async () => {
    const firstRun = await runIngest();
    assert.equal(firstRun.code, 0, `第一次入库必须退出码 0：\n${firstRun.output}`);
    assert.match(firstRun.output, /failed=0/, `第一次入库不该有失败文件：\n${firstRun.output}`);

    const first = await snapshot();

    const secondRun = await runIngest();
    assert.equal(secondRun.code, 0, `第二次入库必须退出码 0：\n${secondRun.output}`);
    assert.match(secondRun.output, /failed=0/, `第二次入库不该有失败文件：\n${secondRun.output}`);

    const second = await snapshot();
    return { first, second };
  })();
  return snapshotsPromise;
}

test("五语片段各 ≥8、合计 ≥40；已索引文档 ≥11", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { first } = await loadSnapshots();

  for (const [lang, count] of Object.entries(first.perLang)) {
    assert.ok(count >= 8, `${lang} 只有 ${count} 块，达不到每语 ≥8`);
  }
  assert.ok(
    first.totalChunks >= 40,
    `片段合计 ${first.totalChunks}，达不到 ≥40（各语：${JSON.stringify(first.perLang)}）`,
  );
  assert.ok(first.indexedDocs >= 11, `已索引文档只有 ${first.indexedDocs} 份，达不到 ≥11`);
  assert.equal(first.pendingDocs, 0, "入库跑完之后不该有 pending 文档");
  assert.equal(first.failedDocs, 0, "语料目录里不该有失败文档（失败会让 make ingest 退出 1）");
});

test("同一文件只有一个版本：object_key 不重复（改完文件重新入库，旧版本退场）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { first } = await loadSnapshots();
  if (first.duplicateDocs > 0) {
    const offenders = await psql(
      `select string_agg(object_key, ',') from (
         select object_key from documents group by object_key having count(*) > 1
       ) dup`,
    );
    assert.fail(`这些文件在库里有多份版本（改完文件重跑入库后旧版本没退场）：${offenders}`);
  }
});

test("空向量 0、超长块（>2000 字符）0", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { first } = await loadSnapshots();
  assert.equal(first.emptyEmbeddings, 0, "空向量意味着这个块永远不会被向量召回");
  assert.equal(first.oversizedChunks, 0, "超过 2000 字符的块说明切分失败");
});

test("de/nl/es 的 chunks.content 里没有 CJK", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { first } = await loadSnapshots();
  if (first.cjkInLatin > 0) {
    const offenders = await psql(
      `select string_agg(distinct lang, ',') from chunks
        where lang in ('de','nl','es') and content ~ '[一-龥]'`,
    );
    assert.fail(`de/nl/es 里有 ${first.cjkInLatin} 条片段含汉字（语种：${offenders}）`);
  }
  assert.equal(first.cjkInLatin, 0);
});

test("故障码表有 E03/E07/F21 且五语描述与步骤齐全；chunks 里没有故障码文档", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { first } = await loadSnapshots();

  assert.ok(first.faultCodeRows >= 3, `故障码表只有 ${first.faultCodeRows} 行`);
  assert.equal(
    first.faultCodeComplete,
    first.faultCodeRows,
    `有 ${first.faultCodeRows - first.faultCodeComplete} 行故障码缺语种（描述/步骤必须五语齐全）`,
  );

  const detail = `E03:balcony:full,E07:balcony:full,F21:residential:full`;
  assert.equal(first.faultDetail, detail, "E03/E07/F21 必须各有一行且五语齐全");

  // 结构化语料不进片段表：报了故障码就不该同时有一条可被语义命中的同内容文档
  assert.equal(first.faultCodeChunks, 0, "故障码语料不该出现在 chunks 里（快路是主键命中）");
});

test("D24：draft 不影响门禁，published 缺语必红", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  // 门禁的判据是"对外承诺"：一条只填中英的草稿是管理端的常态，必须视而不见；
  // 同一行一旦抬成 published，缺语就是对用户承诺的破裂，必须红。
  const runGate = async (): Promise<{ code: number; output: string }> => {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["--env-file-if-exists=.env", "scripts/check-corpus.ts"],
        { cwd: repoRoot, encoding: "utf8" },
      );
      return { code: 0, output: stdout + stderr };
    } catch (err) {
      const failure = err as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  };

  await psql(`delete from fault_codes where code = 'X99' and product_line = 'balcony'`);
  await psql(`insert into fault_codes
                (code, product_line, severity, desc_zh, desc_en, act_zh, act_en, status)
              values ('X99', 'balcony', 'warn', '测试草稿', 'test draft', '步骤', 'step', 'draft')`);
  try {
    const green = await runGate();
    assert.equal(green.code, 0, `存在 draft 行时门禁变红了（D24）\n${green.output}`);

    await psql(`update fault_codes set status = 'published'
                 where code = 'X99' and product_line = 'balcony'`);
    const red = await runGate();
    assert.notEqual(red.code, 0, "published 缺语居然通过了门禁 —— D24 的另一半没落地");
  } finally {
    await psql(`delete from fault_codes where code = 'X99' and product_line = 'balcony'`);
  }
});

test("连续入库两次幂等：文档数、片段数、文档 id 都不变", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { first, second } = await loadSnapshots();

  assert.equal(second.indexedDocs, first.indexedDocs, "两次入库后已索引文档数必须一致");
  assert.equal(second.totalChunks, first.totalChunks, "两次入库后片段数必须一致");
  assert.deepEqual(second.perLang, first.perLang, "两次入库后各语种片段数必须一致");
  assert.equal(second.faultCodeRows, first.faultCodeRows, "故障码重复入库不该插新行");
  // 摘要覆盖 id / sha256 / status / chunk_count：任何一个漂移都会换值
  assert.equal(second.docDigest, first.docDigest, "文档 id 或状态在两次入库之间变了");
});
