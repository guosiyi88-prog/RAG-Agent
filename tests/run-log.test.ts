import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 tests/data-modules.test.ts 同一套 .env 解析（行内 `#` 之后是注释、成对引号去掉）。 */
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

/**
 * numeric(10,6) 与 JS double 之间只有 6 位精度是共同事实，所以成本一律按字符串比。
 * 直接比 double 会因 `1200/1e6*0.3` 的下溢尾数（0.0007199999999999…）假失败。
 */
const money = (value: unknown): string => Number(value).toFixed(6);

after(async () => {
  if (!hasRuntimeEnv) return;
  const { pool } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");
  await redis.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

test("estimateCostUsd 按 Flash 单价换算；estimateTokens 按 chars/3 向上取整", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { estimateCostUsd, estimateTokens } = await import("../src/core/run-log.ts");

  // 06 §9：输入 0.3 美元/百万 token、输出 1.2 美元/百万 token。
  assert.equal(estimateCostUsd(1_000_000, 1_000_000), 1.5);
  assert.equal(estimateCostUsd(1_000_000, 0), 0.3);
  assert.equal(estimateCostUsd(0, 1_000_000), 1.2);
  assert.equal(estimateCostUsd(0, 0), 0);

  assert.equal(estimateTokens("a".repeat(300)), 100);
  assert.equal(estimateTokens(""), 0, "空串不记 token");
  // 1–2 个字符也要算 1：四舍五入会把极短回答记成 0，累计出"这轮没花钱"的假象。
  assert.equal(estimateTokens("a"), 1);
  assert.equal(estimateTokens("ab"), 1);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("abcd"), 2);
});

test("recordRun 同事务落 ai_runs 并累加 conversations（token / 成本 / last_active_at）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { query, one } = await import("../src/db.ts");
  const { recordRun, estimateCostUsd } = await import("../src/core/run-log.ts");

  const convId = randomUUID();
  // last_active_at 往回拨 1 小时：这样"前进了"断言不可能被同一毫秒的巧合满足
  // （`now()` 是事务开始时间，两笔紧邻的事务完全可能落在同一毫秒的边界上）。
  await query(
    `insert into conversations (id, token_id, lang, channel, last_active_at)
     values ($1, null, 'de', 'web', now() - interval '1 hour')`,
    [convId],
  );

  try {
    const before = await one<{ total_tokens: number; total_cost_usd: string; last_active_at: Date }>(
      "select total_tokens, total_cost_usd, last_active_at from conversations where id = $1",
      [convId],
    );
    assert.ok(before !== null, "会话行应存在");

    const inputTokens = 1_200;
    const outputTokens = 300;
    const costUsd = estimateCostUsd(inputTokens, outputTokens);
    await recordRun({
      convId,
      model: "deepseek-flash",
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs: 3_120,
      refused: false,
      // toolCalls 有列可落：`ai_runs.tool_calls jsonb`（001_init.sql:266），按 jsonb 数组存。
      toolCalls: [{ name: "kb_search", ms: 420 }],
    });

    const runs = await query<{
      model: string;
      tool_calls: { name: string; ms: number }[];
      input_tokens: number;
      output_tokens: number;
      cost_usd: string;
      latency_ms: number;
      refused: boolean;
    }>(
      `select model, tool_calls, input_tokens, output_tokens, cost_usd, latency_ms, refused
         from ai_runs where conv_id = $1`,
      [convId],
    );
    assert.equal(runs.length, 1, "一轮只应落一条 ai_runs");
    const run = runs[0];
    assert.ok(run !== undefined);
    assert.equal(run.model, "deepseek-flash");
    assert.equal(run.input_tokens, inputTokens);
    assert.equal(run.output_tokens, outputTokens);
    assert.equal(money(run.cost_usd), money(costUsd));
    assert.equal(run.latency_ms, 3_120);
    assert.equal(run.refused, false);
    assert.deepEqual(run.tool_calls, [{ name: "kb_search", ms: 420 }], "工具轨迹应原样落 jsonb");

    const afterRow = await one<{
      total_tokens: number;
      total_cost_usd: string;
      last_active_at: Date;
    }>(
      "select total_tokens, total_cost_usd, last_active_at from conversations where id = $1",
      [convId],
    );
    assert.ok(afterRow !== null);
    assert.ok(before !== null);
    assert.equal(
      afterRow.total_tokens,
      before.total_tokens + inputTokens + outputTokens,
      "会话累计 token 应恰好增加 输入+输出",
    );
    assert.equal(
      money(afterRow.total_cost_usd),
      money(Number(before.total_cost_usd) + costUsd),
      "会话累计成本应恰好增加本轮成本",
    );
    assert.ok(
      afterRow.last_active_at.getTime() > before.last_active_at.getTime(),
      `last_active_at 必须前进：${String(before.last_active_at)} → ${String(afterRow.last_active_at)}`,
    );
  } finally {
    // ai_runs.conv_id 是 on delete cascade，删会话即可连带清掉运行记录。
    await query("delete from conversations where id = $1", [convId]);
  }

  const leftovers = await query("select 1 from ai_runs where conv_id = $1", [convId]);
  assert.equal(leftovers.length, 0, "清理后不应残留 ai_runs");
});

test("recordRun 记账失败只进日志，不把异常抛给 SSE 收尾流程", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { query } = await import("../src/db.ts");
  const { recordRun } = await import("../src/core/run-log.ts");

  // 不存在的会话 id → ai_runs 的外键失败。这条路径就是"回答已生成、但记账炸了"的现场：
  // 用户该拿到答案，账该在日志里留下痕迹，所以这里断言的是**不抛**。
  const ghostConvId = randomUUID();
  await assert.doesNotReject(
    recordRun({
      convId: ghostConvId,
      model: "deepseek-flash",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.000_006,
      latencyMs: 1,
      refused: true,
    }),
    "记账失败不得冒泡到调用方",
  );

  const rows = await query("select 1 from ai_runs where conv_id = $1", [ghostConvId]);
  assert.equal(rows.length, 0, "失败的事务必须整体回滚，不留半条运行记录");
});
