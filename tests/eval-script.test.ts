/**
 * `scripts/eval.ts` 的交付验收（`08-i18n-eval-handoff` spec T10 · `14 §4/§7`）。
 *
 * 接缝刻意选在**用户会怎么跑**上：子进程 + 真实参数 + 退出码 + SQL 断言。
 * 评测脚本本身是交付物的一部分，用 `import()` 调它的内部函数就是在测另一套东西。
 *
 * 两个刻意的选择：
 *   1. 每个跑分都带 `LLM_PROVIDER=mock` + `EMBED_BACKEND=hash`：前者让拒答由
 *      `src/core/refusal.ts` 决定（不经模型），后者让两次跑分的命中集合可比较。
 *   2. 断言的是**指标之间的关系**（反例题全拒、引用 id ∈ 期望集合的比例 = hit_rate），
 *      不钉具体小数 —— 除了兜底向量模式下才断言确定性。
 *
 * 本文件会真的往库里写 `eval_runs` 与评测会话/工单，`after` 里按 id 精确删除，
 * 不清空整张表（同一数据库上还有别的测试与别的任务在跑）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 `tests/chat-stream.test.ts` 同一套 .env 解析：行内 `#` 之后是注释、成对引号去掉。 */
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

const hasRuntimeEnv = Boolean(
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT,
);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

/** 子进程统一的运行环境：mock + hash 是本文件全部跑分的固定前提（见文件头）。 */
const EVAL_ENV = { LLM_PROVIDER: "mock", EMBED_BACKEND: "hash" } as const;

type RunResult = { code: number | null; stdout: string; stderr: string; output: string };

function runEval(args: string[], env: Record<string, string> = EVAL_ENV): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--env-file-if-exists=.env", "scripts/eval.ts", ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
  });
}

/* ────────────────────────── 结果解析 ────────────────────────── */

/** 与 `eval_runs.detail` 的 items 同形（只声明本文件断言用到的字段）。 */
type DetailItem = {
  n: number;
  lang: string;
  question: string;
  expect_hint: string | null;
  expect_doc_ids: string[];
  cited_doc_ids: string[];
  cite_legal: boolean[];
  hit: boolean;
  refused: boolean;
  ticket_created: boolean;
  fault_lookup: boolean;
  conv_id: string;
};

type LoadedRun = {
  runId: string;
  reportPath: string;
  /** 子进程原始输出（含 pino 日志与 `[eval]` 行），断言指标行用。 */
  stdout: string;
  row: {
    total: number;
    hit: number;
    cite_ok: number;
    refuse_ok: number;
    hit_rate: string;
    cite_rate: string;
    refuse_rate: string;
    detail: { items: DetailItem[] };
  };
};

const createdRunIds: string[] = [];
const createdConvIds = new Set<string>();
/** 子进程生成的报告文件：测试跑完删掉，免得 docs/output/ 里堆一串评测报告。 */
const createdReportPaths: string[] = [];

async function loadRun(result: RunResult): Promise<LoadedRun> {
  assert.equal(result.code, 0, `评测脚本应退出码 0：\n${result.output.slice(-4000)}`);

  const runId = /\[eval\] eval_runs: id=([0-9a-f-]{36})/.exec(result.stdout)?.[1];
  assert.ok(runId, `输出里应有 eval_runs id：\n${result.stdout.slice(-2000)}`);
  assert.ok(runId !== undefined);
  createdRunIds.push(runId);

  const reportPath = /\[eval\] 报告：(.+)/.exec(result.stdout)?.[1]?.trim();
  assert.ok(reportPath, `输出里应有报告路径：\n${result.stdout.slice(-2000)}`);
  assert.ok(reportPath !== undefined);
  createdReportPaths.push(reportPath);
  assert.ok(
    resolve(reportPath).startsWith(resolve(repoRoot, "docs", "output")),
    `报告必须落在 docs/output/，实际 ${reportPath}`,
  );

  const { one } = await import("../src/db.ts");
  const row = await one<LoadedRun["row"]>(
    `select total, hit, cite_ok, refuse_ok, hit_rate, cite_rate, refuse_rate, detail
       from eval_runs where id = $1`,
    [runId],
  );
  assert.ok(row !== null, "eval_runs 里应有本次跑分的行");

  for (const item of row.detail.items) createdConvIds.add(item.conv_id);
  return { runId, reportPath, stdout: result.stdout, row };
}

/** 首次跑分只跑一次，多个用例共享它的结果（子进程很贵）。 */
let firstRun: Promise<LoadedRun> | null = null;
function firstRunOnce(): Promise<LoadedRun> {
  firstRun ??= runEval([]).then(loadRun);
  return firstRun;
}

/* ────────────────────────── 清理 ────────────────────────── */

after(async () => {
  if (!hasRuntimeEnv) return;
  const { query, pool } = await import("../src/db.ts");

  // 先删工单再删会话：`tickets.conv_id` 是 on delete set null，顺序反了会留下
  // 一堆没有会话的孤儿单，把坐席队列污染成"永远查不到对话"的脏数据。
  if (createdRunIds.length > 0) {
    await query("delete from eval_runs where id = any($1::uuid[])", [createdRunIds]).catch(() => undefined);
  }
  const convIds = [...createdConvIds];
  if (convIds.length > 0) {
    await query("delete from tickets where conv_id = any($1::uuid[])", [convIds]).catch(() => undefined);
    await query("delete from conversations where id = any($1::uuid[])", [convIds]).catch(() => undefined);
  }
  // 报告文件也删掉：跑一次测试就在 docs/output 里堆一份评测报告，评审目录会被测试产物淹没。
  for (const reportPath of createdReportPaths) await rm(reportPath, { force: true }).catch(() => undefined);
  await pool.end().catch(() => undefined);
});

/* ────────────────────────── 用例 ────────────────────────── */

test("30 题跑分：退出码 0、四个指标行、eval_runs 一行、报告含题号级明细", { timeout: 240_000 }, async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const run = await firstRunOnce();

  // 08 spec 的"三行指标" + 工单要求的第四行（误拒率）。
  for (const label of ["hit@5", "引用合法率", "拒答准确率", "误拒率"]) {
    assert.match(run.stdout, new RegExp(`\\[eval\\] ${label}\\s`), `输出缺指标行：${label}`);
  }

  assert.equal(run.row.total, 30, "eval_runs.total 必须是 30 题");
  for (const field of ["hit", "cite_ok", "refuse_ok"] as const) {
    assert.equal(typeof run.row[field], "number", `${field} 必须是非空整数`);
    assert.ok(run.row[field] >= 0, `${field} 不能为负`);
  }
  for (const field of ["hit_rate", "cite_rate", "refuse_rate"] as const) {
    assert.ok(run.row[field] !== null, `${field} 不能为空`);
    const value = Number(run.row[field]);
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${field} 必须是 0..1 的数，实际 ${run.row[field]}`);
  }
  assert.equal(run.row.detail.items.length, 30, "detail 必须带 30 条题号级明细");

  const report = await readFile(run.reportPath, "utf8");
  assert.match(report, /题号级明细/, "报告必须有题号级明细小节");
  assert.match(report, /\| 题号 \|/, "报告明细表必须有题号列");
  assert.match(report, /\| 1 \|/, "报告明细表必须含第 1 题");
  assert.match(report, /\| 30 \|/, "报告明细表必须含第 30 题");
  assert.match(report, /hit@5/, "报告必须写 hit@5");
});

test("反例题：全部产生拒答事件、没有引用事件、且建单", { timeout: 60_000 }, async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { row } = await firstRunOnce();
  const negatives = row.detail.items.filter((item) => item.expect_hint === null);
  assert.equal(negatives.length, 10, "题集里有 10 道反例题（14 §4.2）");
  for (const item of negatives) {
    const where = `#${item.n}（${item.lang} ${item.question}）`;
    assert.equal(item.refused, true, `${where} 必须拒答`);
    assert.equal(item.cite_legal.length, 0, `${where} 拒答时不得有引用事件`);
    assert.equal(item.cited_doc_ids.length, 0, `${where} 拒答时不得引用任何文档`);
    assert.equal(item.ticket_created, true, `${where} 拒答必须建单（工单数 +1）`);
  }
});

test("正例题：引用文档 id ∈ 期望集合的比例 == 报告里的 hit@5", { timeout: 60_000 }, async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { row } = await firstRunOnce();
  const positives = row.detail.items.filter((item) => item.expect_doc_ids.length > 0);
  assert.ok(positives.length > 0, "题集里必须有带文档期望的正例题");

  const hits = positives.filter((item) =>
    item.cited_doc_ids.some((docId) => item.expect_doc_ids.includes(docId)),
  );
  assert.equal(hits.length, row.hit, "eval_runs.hit 必须等于'引用命中期望文档'的题数");
  assert.equal(
    hits.length / positives.length,
    Number(Number(row.hit_rate).toFixed(4)),
    "hit@5 的分母必须是'有文档期望的正例题'，与明细里的引用命中比例一致",
  );

  // 不变量：引用合法率 = 1（非法角标会整条降级为拒答，过期说明校验失效）。
  for (const item of row.detail.items) {
    assert.ok(item.cite_legal.every(Boolean), `#${item.n} 出现了非法引用：${JSON.stringify(item.cite_legal)}`);
  }
  assert.equal(Number(row.cite_rate), 1, "引用合法率必须是 1.00");
});

test("未灌语料：明确报错 + 退出码 1，不输出任何指标行", { timeout: 120_000 }, async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  // 真实空库不可造（会毁掉共享数据），所以用脚本自己的预检门槛模拟：
  // `--min-docs 999999` 让"库里的文档数不够"这条分支可测。
  const result = await runEval(["--min-docs", "999999"]);
  assert.equal(result.code, 1, `预检失败必须退出码 1：\n${result.output.slice(-2000)}`);
  assert.match(result.stderr, /评测无法开始/, "必须打印明确的错误");
  assert.match(result.stderr, /documents=/, "错误里要带上实际计数");
  assert.match(result.stderr, /scripts\/ingest\.ts/, "错误里要给出补救命令");
  assert.doesNotMatch(result.stdout, /hit@5|引用合法率|拒答准确率|误拒率/, "不得输出指标行（0% 会被误读）");
  assert.doesNotMatch(result.stdout, /0\.0/, "不得输出 0.0 这类会被误读成 0% 的数字");
});

test("确定性：兜底向量模式下连跑两次，命中集合完全一致", { timeout: 240_000 }, async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const first = await firstRunOnce();
  const second = await loadRun(await runEval([]));

  const hitSet = (run: LoadedRun): string =>
    run.row.detail.items
      .filter((item) => item.hit)
      .map((item) => item.n)
      .join(",");
  assert.equal(hitSet(second), hitSet(first), "两次跑分的命中集合必须一致（hash 兜底向量是确定性的）");

  // 命中集合在"库内向量不是 hash 产物"时会是空集，光比空集没有说服力；
  // 再把每题的三元签名（拒答 / 引用 id 列表 / 建单）也比一遍，才真正钉住"同一输入同一结果"。
  const signature = (run: LoadedRun): string =>
    run.row.detail.items
      .map((item) => `${item.n}:${item.refused ? 1 : 0}:${item.cited_doc_ids.join("+")}:${item.ticket_created ? 1 : 0}`)
      .join("|");
  assert.equal(signature(second), signature(first), "两次跑分的逐题结果签名必须一致");
});
