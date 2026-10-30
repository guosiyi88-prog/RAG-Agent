import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 只用 data/ 里现成的基础设施脚本，不引入 pg 驱动：断言的是"database 的外部行为"，
// 换连接实现不影响本文件。db.sh psql 走容器内 psql，所以 DDL 必须用标准输入喂
// （容器内没有宿主机路径，-f 会 No such file or directory）。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runPsql(args: string[], input?: string): RunResult {
  // -q 必须带：否则 INSERT 0 1 / UPDATE 1 这类命令标签会混进 stdout，把断言读到的值弄脏
  const result = spawnSync(
    'bash',
    ['data/scripts/db.sh', 'psql', '-q', '-v', 'ON_ERROR_STOP=1', ...args],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      input,
    },
  );
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 执行单条 SQL，要求成功，返回整段输出（去首尾空白）。 */
function sql(statement: string): string {
  const out = runPsql(['-tA', '-c', statement]);
  assert.equal(out.status, 0, `SQL 失败: ${statement}\n${out.stderr}`);
  return out.stdout.trim();
}

/** 执行单条 SQL，要求失败，返回 stderr 便于断言原因。 */
function sqlMustFail(statement: string): string {
  const out = runPsql(['-tA', '-c', statement]);
  assert.notEqual(out.status, 0, `本该被数据库拒绝，但成功了: ${statement}`);
  return out.stderr;
}

/** 重放 sql/ 下的脚本（走标准输入）。 */
function replay(file: string): RunResult {
  return runPsql([], readFileSync(path.join(repoRoot, 'sql', file), 'utf8'));
}

const EXPECTED_TABLES = [
  'documents', 'chunks', 'fault_codes', 'product_lines', 'conversations', 'messages', 'citations',
  'staff', 'staff_sessions', 'org_units', 'tickets', 'feedback', 'kb_drafts', 'attachments', 'qa_gold',
  'eval_runs', 'ai_runs', 'skills', 'settings', 'audit_log', 'exports', 'fault_reports',
  // `09#05` 知识库：一版索引的快照（两份表一起才还原得了一版）+ 重建作业。
  'document_versions', 'document_version_chunks', 'document_rebuild_jobs',
];

const EXPECTED_VIEWS = ['v_health', 'v_no_hit'];

function rows(statement: string): string[][] {
  const out = sql(statement);
  if (out === '') return [];
  return out.split('\n').map((line) => line.split('|'));
}

test('结构数量：25 张表 + 2 个视图', () => {
  const [counts] = rows(`
    select
      (select count(*) from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'),
      (select count(*) from pg_views where schemaname = 'public')
  `);

  // 用清单长度而不是写死的数字：这张表每加一张卡就改一次数字，改漏了就是一条假绿。
  // 真正的断言在下面「表与视图清单与规格一致」，这里只是让数字与清单不可能对不上。
  assert.equal(Number(counts[0]), EXPECTED_TABLES.length, '业务表数量必须与 EXPECTED_TABLES 清单一致');
  assert.equal(Number(counts[1]), 2, '视图应为 2 个');
});

test('表与视图清单与规格一致', () => {
  // 排序交给 JS：库的 en_US.utf8 排序规则对下划线是"可变字符"，跨环境不保证稳定
  const tables = rows(`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  `).map(([name]) => name).sort();
  const views = rows(`
    select viewname from pg_views where schemaname = 'public'
  `).map(([name]) => name).sort();

  assert.deepEqual(tables, [...EXPECTED_TABLES].sort());
  assert.deepEqual(views, EXPECTED_VIEWS);
});

test('chunks 同时具备 1024 维向量列与 simple 全文列，两套索引都在', () => {
  const [cols] = rows(`
    select
      (select format_type(atttypid, atttypmod) from pg_attribute
        where attrelid = 'chunks'::regclass and attname = 'embedding'),
      (select attgenerated from pg_attribute
        where attrelid = 'chunks'::regclass and attname = 'tsv'),
      (select pg_get_expr(adbin, adrelid) from pg_attrdef
        where adrelid = 'chunks'::regclass
          and adnum = (select attnum from pg_attribute
                        where attrelid = 'chunks'::regclass and attname = 'tsv'))
  `);
  assert.equal(cols[0], 'vector(1024)');
  assert.equal(cols[1], 's', 'tsv 必须是 generated always ... stored 的生成列');
  assert.match(cols[2], /to_tsvector\('simple'/);

  const indexes = rows(`
    select indexname || ' ' || indexdef from pg_indexes
     where schemaname = 'public' and tablename = 'chunks'
  `).map(([def]) => def);

  const emb = indexes.find((def) => def.startsWith('chunks_emb_idx '));
  const tsv = indexes.find((def) => def.startsWith('chunks_tsv_idx '));
  assert.ok(emb, '缺少向量索引 chunks_emb_idx');
  assert.match(emb, /USING hnsw/);
  assert.match(emb, /vector_cosine_ops/);
  assert.ok(tsv, '缺少全文索引 chunks_tsv_idx');
  assert.match(tsv, /USING gin/);
  assert.ok(
    indexes.some((def) => def.startsWith('chunks_lang_idx ')),
    '缺少语言过滤索引 chunks_lang_idx（省了它检索会全表扫）',
  );
});

test('方言：时间列一律 timestamptz、无 varchar、语言列是 char(2)', () => {
  const wrongTimes = rows(`
    select table_name || '.' || column_name from information_schema.columns
     where table_schema = 'public'
       and data_type like 'timestamp%' and data_type <> 'timestamp with time zone'
  `);
  assert.deepEqual(wrongTimes, [], '存在非 timestamptz 的时间列');

  const varchars = rows(`
    select table_name || '.' || column_name from information_schema.columns
     where table_schema = 'public' and data_type = 'character varying'
  `);
  assert.deepEqual(varchars, [], '文本列必须是 text，不用 varchar(n)');

  const langCols = rows(`
    select table_name || '.' || column_name || ':' || data_type || '('
           || coalesce(character_maximum_length::text, '?') || ')'
      from information_schema.columns
     where table_schema = 'public'
       and column_name in ('lang', 'doc_lang')
     order by table_name
  `).map(([c]) => c);
  assert.ok(langCols.length >= 6, `语言列数量异常: ${langCols.join(', ')}`);
  for (const col of langCols) {
    assert.match(col, /:character\(2\)$/, `语言列必须是 char(2): ${col}`);
  }
});

test('seed 幂等：连跑两次，坐席 3 行、故障码不新增、参数表无重复键', () => {
  // 故障码种子从 09#02 起搬进 `sql/003_faults_seed.sql`（D13：库是唯一真源，语料文件降级为
  // `.fixtures/` 里的快照），`002_seed.sql` 只管坐席 / 参数 / 产品线字典。所以两份都要重放。
  const [before] = rows(`select count(*) from fault_codes`);
  const faultRowsBefore = Number(before[0]);

  for (const file of ['002_seed.sql', '003_faults_seed.sql']) {
    const first = replay(file);
    assert.equal(first.status, 0, `${file} 第一次执行失败\n${first.stderr}`);
    // 第二次是幂等的判据：`make reset` 与容器初始化都会重复执行这几份文件
    const second = replay(file);
    assert.equal(second.status, 0, `${file} 重复执行失败（幂等要求可反复执行）\n${second.stderr}`);
  }

  const [counts] = rows(`
    select (select count(*) from staff),
           (select count(*) from fault_codes),
           (select count(*) from settings),
           (select count(distinct key) from settings),
           (select count(*) from product_lines),
           (select count(distinct code) from product_lines)
  `);
  // `09#04` 起是 3 行：agent / lead / **admin**（发布与字典要有角色能验，见 002_seed.sql）。
  // 这个数变了就是 seed 变了 —— 不是"顺手改绿"，是真的多了一个演示账号。
  assert.equal(Number(counts[0]), 3, '坐席应稳定为 3 行（agent / lead / admin）');
  assert.equal(Number(counts[1]), faultRowsBefore, '重放 seed 不该新增或删除故障码行');
  assert.equal(Number(counts[2]), Number(counts[3]), 'settings 出现重复键');
  assert.equal(Number(counts[4]), Number(counts[5]), 'product_lines 出现重复 code');

  // 唯一约束 (code, product_line) 的实际效果：全表不允许同组合出现两次
  const dupes = rows(`
    select code || ':' || product_line from fault_codes
     group by code, product_line having count(*) > 1
  `).map(([pair]) => pair);
  assert.deepEqual(dupes, [], '故障码出现重复的 code + product_line');

  // seed 归属：这几行由 seed 自己插，重放后必须仍然各存在且只有一行
  const seedRows: [string, string][] = [
    ['E03', 'balcony'],
    ['E07', 'balcony'],
    ['F21', 'residential'],
  ];
  for (const [code, productLine] of seedRows) {
    const [owned] = rows(`
      select count(*) from fault_codes where code = '${code}' and product_line = '${productLine}'
    `);
    assert.equal(Number(owned[0]), 1, `seed 行 ${code}/${productLine} 必须存在且只有一行`);
  }
});

test('归档态不被 seed 重放复活（D25）', () => {
  // 归档只走 `status`、不删行。`003_faults_seed.sql` 是 `do nothing`，所以重放时
  // 已存在的行一个字都不改 —— 这条断言就是钉住这一点：谁把 `do nothing` 改回 `do update`，
  // 归档的码会连同内容一起被文件抢回去。
  sql(`update fault_codes set status = 'archived' where code = 'F21' and product_line = 'residential'`);
  const replayResult = replay('003_faults_seed.sql');
  assert.equal(replayResult.status, 0, `重放 003 失败\n${replayResult.stderr}`);

  const [after] = rows(`select status from fault_codes where code = 'F21' and product_line = 'residential'`);
  assert.equal(after[0], 'archived', '归档的码被 seed 重放复活了（D25：归档只能靠 status，不能删行）');

  // 收尾：后续用例（快路 / 公开故障码接口）要能查到它
  sql(`update fault_codes set status = 'published' where code = 'F21' and product_line = 'residential'`);
});

test('故障码 E03 / E07 / F21 带五语描述与有序处理步骤', () => {
  const [counts] = rows(`
    select count(*) from fault_codes
     where code in ('E03', 'E07', 'F21')
       and desc_zh is not null and desc_en is not null and desc_de is not null
       and desc_nl is not null and desc_es is not null
       and act_zh is not null and act_en is not null and act_de is not null
       and act_nl is not null and act_es is not null
       and act_zh like '1.%2.%3.%' and act_en like '1.%2.%3.%'
       and act_de like '1.%2.%3.%' and act_nl like '1.%2.%3.%'
       and act_es like '1.%2.%3.%'
  `);
  assert.equal(Number(counts[0]), 3, 'E03/E07/F21 的五语描述与三步处理步骤必须齐全');
});

test('工单号由序列生成，格式 WT-YYYY-NNNN', () => {
  const [row] = rows(`
    insert into tickets (reason, question) values ('no_citation', '__schema_test_ticket_no__')
    returning no, status
  `);
  try {
    assert.match(row[0], /^WT-\d{4}-\d{4}$/);
    assert.equal(row[1], 'open', '新工单默认应为 open');
  } finally {
    sql(`delete from tickets where question = '__schema_test_ticket_no__'`);
  }
});

test('closed 工单不可逆：任何字段变更都失败', () => {
  const marker = '__schema_test_closed_guard__';
  const [row] = rows(`
    insert into tickets (reason, question) values ('user_request', '${marker}') returning no
  `);
  const no = row[0];

  const closedAt = sql(`
    update tickets set status = 'closed' where no = '${no}' returning closed_at is not null
  `);
  assert.equal(closedAt, 't', '关单时应由触发器写入 closed_at');

  try {
    const reopen = sqlMustFail(`update tickets set status = 'open' where no = '${no}'`);
    assert.match(reopen, /closed ticket is immutable/);

    // 不是只有状态字段不能改：闭单后回写 tags / resolution 同样是篡改历史
    const touch = sqlMustFail(`update tickets set tags = array['tamper'], resolution = 'x' where no = '${no}'`);
    assert.match(touch, /closed ticket is immutable/);

    assert.equal(
      sql(`select status from tickets where no = '${no}'`),
      'closed',
      '被拒绝的更新不得留下副作用',
    );
  } finally {
    sql(`delete from tickets where no = '${no}'`);
  }
});

test('语言码取值受限：zh/en/de/nl/es 之外被拒', () => {
  const err = sqlMustFail(`
    insert into documents (title, lang, object_key, sha256)
    values ('x', 'xx', 'k', '__schema_test_lang__')
  `);
  assert.match(err, /violates check constraint/);

  // 合法值必须能写进来（同一条语句里删掉，不留残留数据）
  const ok = sql(`
    insert into documents (title, lang, object_key, sha256)
    values ('x', 'de', 'k', '__schema_test_lang_ok__');
    delete from documents where sha256 = '__schema_test_lang_ok__';
  `);
  assert.equal(ok, '');
});
