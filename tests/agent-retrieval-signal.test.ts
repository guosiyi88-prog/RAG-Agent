/**
 * 检索结论从"一轮对话"里带出来（`05-refusal-and-tickets` #02 · `06-agent.md` §5.1 判定 ①）。
 *
 * 要证明的是**这条数据通路**，不是模型聪明不聪明：
 *   ① `kb_search` 真的把 `{ topScore, fallback, chunkCount }` 写进本轮 buffer（工具路径与 mock 路径同一个落点）；
 *   ② `runTurn` 的 `TurnResult` 把这两个字段带出来（拒答层在 `chat.ts` 里只读它，不靠"候选是否为空"反推）；
 *   ③ 一轮里多次检索时按"最高分胜出 / 降级最轻胜出"合并（`mergeRetrievalSignal`，纯函数）；
 *   ④ 一次检索都没有 = 没证据（`0 / "empty"`），否则判定 ① 对这类轮次永远不触发。
 *
 * 依赖与 `tests/chat-stream.test.ts` 同一套：真实 Postgres + 真实 embedding。
 * **不用 `EMBED_BACKEND=hash`**：语料侧向量是 dashscope 产的，用 hash 查询向量去断言
 * "topScore > 0.30"，测的是两个不同向量空间的距离，绿了也没有意义。
 * 所以本文件在 `embedBackend() === "hash"` 时把**分数值**断言降级成结构性断言并显式 skip 说明；
 * 网络异常导致的 `fallback=fts_only` 会让 ①② 直接红——那是对的，不是抖。
 *
 * 30 秒超时、steer、池上限都不在这里（`tests/session-pool.test.ts` 已覆盖），本文件只测信号。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// 只取类型：顶层真 import 会让 `src/config.ts` 在本文件设置 env 之前就求值。
import type { TurnBuffer } from "../src/core/agent.ts";
import type { Lang } from "../src/core/chunk.ts";
import type { TurnCitation } from "../src/ext/support.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 tests/chat-stream.test.ts 同一套 .env 解析：行内 `#` 之后是注释、成对引号去掉。 */
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

// 必须在任何 src 模块被 import 之前落定（`src/config.ts` 在 import 阶段就把 env 读成常量）。
// 本文件对 src 的引用一律走动态 import，这里才来得及生效。
process.env.LLM_PROVIDER = "mock";
// 池上限抬到 8：本文件造 3 个会话，.env 的 5 够用，但别让用例顺序决定成败。
process.env.PARALLEL_LIMIT = "8";

const hasRuntimeEnv = Boolean(
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT,
);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

/**
 * 阈值取自**规格**（07 §8 的 `RETRIEVAL_MIN_SCORE=0.30`），刻意不 import 实现常量：
 * 用实现自己的阈值去证明实现的方向，等于自己证明自己。文件末尾有一条用例把两边对齐。
 */
const MIN_SCORE = 0.3;

/** 本文件造出来的 conv id：收尾要删租约键（runTurn 不落库，不会留 conversations 行）。 */
const createdConvs: string[] = [];

function newConvId(): string {
  const convId = randomUUID();
  createdConvs.push(convId);
  return convId;
}

after(async () => {
  if (!hasRuntimeEnv) return;
  const { redis } = await import("../src/redis.ts");
  const { pool } = await import("../src/db.ts");
  const { shutdownSessions } = await import("../src/core/agent.ts");

  // 租约（`conv:<id>:lease`）是本文件唯一的 Redis 残留。
  const keys = createdConvs.map((convId) => `conv:${convId}:lease`);
  if (keys.length > 0) await redis.del(...keys).catch(() => undefined);

  // 池里的 session 必须 dispose：不关会把 SDK 定时器带出测试进程。
  shutdownSessions();
  await redis.quit().catch(() => undefined);
  // pg 的空闲连接 idleTimeoutMillis = 30s，不 end 就是跑完再白等 30 秒才退出。
  await pool.end().catch(() => undefined);
});

/** 真跑一次 mock 轮（mock 路径**照样真检索**），返回 `TurnResult` 与本轮 buffer。 */
async function mockTurnOnce(text: string, lang: Lang) {
  const { runTurn } = await import("../src/core/agent.ts");
  const buffer: TurnBuffer = { citations: [] };
  const events: string[] = [];
  const result = await runTurn({
    convId: newConvId(),
    text,
    lang,
    buffer,
    onEvent: (event) => events.push(event.type),
  });
  return { result, buffer, events };
}

/* ────────────────────────── ③ 合并规则（纯函数） ────────────────────────── */

test("mergeRetrievalSignal：最高分胜出、降级最轻胜出、chunkCount 跟着胜出的那次走", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { mergeRetrievalSignal } = await import("../src/ext/support.ts");

  // 第一次检索就是结果本身（不复制、不改写）。
  const only = { topScore: 0.42, fallback: "none" as const, chunkCount: 5 };
  assert.deepEqual(mergeRetrievalSignal(undefined, only), only);

  // 模型先搜宽泛词（高分），再补一条更精确的（低分）：答案由高分那次支撑，不能被第二次拉低。
  assert.deepEqual(
    mergeRetrievalSignal({ topScore: 0.42, fallback: "none", chunkCount: 5 }, { topScore: 0.18, fallback: "none", chunkCount: 3 }),
    { topScore: 0.42, fallback: "none", chunkCount: 5 },
    "低分的后一次不得覆盖高分的前一次",
  );

  // 反向：后一次更高就取后一次。
  assert.deepEqual(
    mergeRetrievalSignal({ topScore: 0.18, fallback: "none", chunkCount: 3 }, { topScore: 0.47, fallback: "none", chunkCount: 4 }),
    { topScore: 0.47, fallback: "none", chunkCount: 4 },
  );

  // 一次"两路都空"（fallback=empty, topScore=0）不能抹掉同一轮里另一次正常完成的检索。
  assert.deepEqual(
    mergeRetrievalSignal({ topScore: 0.42, fallback: "none", chunkCount: 5 }, { topScore: 0, fallback: "empty", chunkCount: 0 }),
    { topScore: 0.42, fallback: "none", chunkCount: 5 },
    "空结果的后一次不得把本轮判成 empty（否则判定 ①a 会误触发）",
  );

  // 降级取**最轻**的：同一轮里有过一次正常检索，本轮就不算降级（`none` < `fts_only` < `empty`）。
  assert.equal(
    mergeRetrievalSignal({ topScore: 0.4, fallback: "fts_only", chunkCount: 4 }, { topScore: 0.1, fallback: "none", chunkCount: 1 }).fallback,
    "none",
    "none 比 fts_only 轻：有过一次正常检索，本轮就不算降级",
  );
  // 反向也一样（合并与入参顺序无关）。
  assert.equal(
    mergeRetrievalSignal({ topScore: 0.1, fallback: "none", chunkCount: 1 }, { topScore: 0.4, fallback: "fts_only", chunkCount: 4 }).fallback,
    "none",
  );
  // 全轮只有降级检索时，标签必须留下（降级可见性，07 §9）。
  assert.equal(
    mergeRetrievalSignal({ topScore: 0.1, fallback: "fts_only", chunkCount: 1 }, { topScore: 0, fallback: "empty", chunkCount: 0 }).fallback,
    "fts_only",
    "empty 比 fts_only 更差，取最轻的那个",
  );
  assert.equal(
    mergeRetrievalSignal({ topScore: 0, fallback: "empty", chunkCount: 0 }, { topScore: 0, fallback: "empty", chunkCount: 0 }).fallback,
    "empty",
  );

  // 同分：chunkCount 取片段更多的那次（避免"分来自 A、片段数来自 B"的拼接数据），且与入参顺序无关。
  const tie = (a: { topScore: number; fallback: "none" | "fts_only" | "empty"; chunkCount: number }, b: typeof a) => [
    mergeRetrievalSignal(a, b),
    mergeRetrievalSignal(b, a),
  ];
  for (const merged of tie({ topScore: 0.3, fallback: "none", chunkCount: 2 }, { topScore: 0.3, fallback: "none", chunkCount: 5 })) {
    assert.deepEqual(merged, { topScore: 0.3, fallback: "none", chunkCount: 5 }, "同分时应取片段更多的那次");
  }
});

/* ────────────────────────── ④ 没有检索 == 没有证据 ────────────────────────── */

test("retrievalVerdict：没有检索信号一律是 0 / \"empty\"，不看候选缓冲", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { retrievalVerdict } = await import("../src/core/agent.ts");
  const fakeCitation: TurnCitation = {
    idx: 1,
    chunk_id: 1,
    doc_id: "warranty.de",
    doc_title: "Garantie",
    doc_lang: "de",
    page: 1,
    section: null,
    snippet: "Die Garantie beträgt 10 Jahre.",
    score: 0.42,
  };

  assert.deepEqual(retrievalVerdict({ citations: [] }), { topScore: 0, fallback: "empty" }, "一次没检索 = 没证据");
  // 这条是本用例的重点：**候选非空也不改结论**。若用"候选是否为空"反推，这一轮会被当成"检索正常"，
  // 于是判定 ① 静默失效（模型可以完全不调 kb_search、直接凭记忆答）。
  assert.deepEqual(
    retrievalVerdict({ citations: [fakeCitation] }),
    { topScore: 0, fallback: "empty" },
    "没有 retrieval 信号时，候选再多也不能推断出置信度",
  );

  // 有信号就原样透出（不在这一层重算、不改写）。
  assert.deepEqual(
    retrievalVerdict({ citations: [], retrieval: { topScore: 0.18, fallback: "none", chunkCount: 5 } }),
    { topScore: 0.18, fallback: "none" },
  );
  assert.deepEqual(
    retrievalVerdict({ citations: [], retrieval: { topScore: 0, fallback: "empty", chunkCount: 0 } }),
    { topScore: 0, fallback: "empty" },
  );
});

/* ────────────────────────── ① 正例：能答 ────────────────────────── */

test("mock 一轮（Garantie Batterie / de）：TurnResult.topScore > 0 且 fallback=none（判定 ① 不触发）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { embedBackend } = await import("../src/core/embed.ts");
  if (embedBackend() === "hash") {
    t.skip("EMBED_BACKEND=hash：语料向量来自 dashscope，hash 查询向量与其不同源，分数值断言无意义");
    return;
  }

  const { result, buffer } = await mockTurnOnce("Garantie Batterie", "de");

  assert.equal(result.fallback, "none", `正例不该降级，实际 fallback=${result.fallback}（topScore=${result.topScore}）`);
  assert.ok(
    result.topScore > 0,
    `正例的 topScore 必须 > 0，实际 ${result.topScore}（mock 路径没跑检索或信号没写进 buffer）`,
  );

  // buffer 与 TurnResult 必须是同一份数据：两边不一致说明有人在中途另算了一个分数。
  assert.ok(buffer.retrieval !== undefined, "kbSearch 必须把 retrieval 信号写进本轮 buffer");
  assert.equal(buffer.retrieval.topScore, result.topScore, "TurnResult.topScore 必须来自 buffer.retrieval");
  assert.equal(buffer.retrieval.fallback, result.fallback, "TurnResult.fallback 必须来自 buffer.retrieval");
  assert.ok(buffer.citations.length > 0, "正例应有候选（拒答判定 ②③ 才不会误命中）");
  assert.equal(
    buffer.retrieval.chunkCount,
    buffer.citations.length,
    "单次检索时 chunkCount 必须等于本轮候选数",
  );

  t.diagnostic(`正例实测：topScore=${result.topScore.toFixed(4)} fallback=${result.fallback} chunkCount=${buffer.retrieval.chunkCount}`);
});

/* ────────────────────────── ② 反例：有候选但低置信（判定 ①b） ────────────────────────── */

test("mock 一轮（zzzz qqqq 乱码 / de）：fallback 仍是 none，但 topScore < 0.30（判定 ①b 的输入）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { embedBackend } = await import("../src/core/embed.ts");
  if (embedBackend() === "hash") {
    t.skip("EMBED_BACKEND=hash：语料向量来自 dashscope，hash 查询向量与其不同源，分数值断言无意义");
    return;
  }

  const { result, buffer } = await mockTurnOnce("zzzz qqqq", "de");

  // 这一条是判定 ①b 的全部意义所在：**有候选**（向量路总会返回 top20），所以
  // "候选缓冲为空"这条反推在这里不成立；只有 topScore 能把它拦下来。
  assert.equal(
    result.fallback,
    "none",
    `乱码查询的检索本身是成功的（不是降级），fallback 应为 none，实际 ${result.fallback}（网络异常？）`,
  );
  assert.ok(
    (buffer.retrieval?.chunkCount ?? 0) > 0,
    "向量路应返回候选（这正是 ①b 存在的原因：有候选 ≠ 能答）",
  );
  assert.ok(
    result.topScore < MIN_SCORE,
    `乱码查询的 topScore 必须 < ${MIN_SCORE}（判定 ①b 会拒答），实际 ${result.topScore}`,
  );
  assert.ok(result.topScore >= 0, `topScore 是归一化分，不该为负：${result.topScore}`);

  t.diagnostic(`反例实测：topScore=${result.topScore.toFixed(4)} fallback=${result.fallback} chunkCount=${buffer.retrieval?.chunkCount}`);
});

/* ────────────────────────── ① 工具路径 + 多次检索的合并 ────────────────────────── */

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
};

type HookHandler = (event: Record<string, unknown>) => Promise<unknown>;

/**
 * 真模型路径上，信号是 `kb_search` 的 `execute` 经 `slot.buffer` 写进去的 ——
 * 这条接线不能靠 mock 路径代证（mock 是直接调 `kbSearch()`，绕过了 slot）。
 * 这里用最小假 `pi` 拿到注册项与 hook（同 `tests/tool-registry.test.ts` 的做法），
 * 直接把工具跑两次，再把 `tool_result` hook 也走一遍（候选由 hook 落进 buffer，05#01 的口径）。
 */
test("工具路径：kb_search 两次 → buffer.retrieval 取最高分那次，候选是两次的并集", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { embedBackend } = await import("../src/core/embed.ts");
  const realBackend = embedBackend() === "dashscope";
  const { supportExtension } = await import("../src/ext/support.ts");

  const tools = new Map<string, RegisteredTool>();
  const hooks = new Map<string, HookHandler>();
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(name: string, handler: HookHandler) {
      hooks.set(name, handler);
    },
  } as unknown as ExtensionAPI;

  const buffer: TurnBuffer = { citations: [] };
  const slot = { buffer, lang: "de", convId: newConvId() };
  supportExtension(pi, slot);

  const kbSearch = tools.get("kb_search");
  assert.ok(kbSearch !== undefined, "kb_search 必须注册");
  const onToolResult = hooks.get("tool_result");
  assert.ok(onToolResult !== undefined, "tool_result hook 必须注册");

  const runSearch = async (query: string): Promise<TurnCitation[]> => {
    const result = await kbSearch.execute("call-1", { query }, undefined, undefined, undefined);
    const citations = result.details.citations as TurnCitation[];
    // 真实 SDK 会给每个工具结果发一次 tool_result：候选由 hook 落进 buffer。
    await onToolResult({ toolName: "kb_search", details: { citations } });
    return citations;
  };

  // 第一次：正例（高分）；第二次：乱码（低分）。顺序刻意"先高后低"——
  // 后写覆盖先写（不合并）时，合并结果会等于乱码那次，断言立刻红。
  const first = await runSearch("Garantie Batterie");
  const firstSignal = buffer.retrieval;
  assert.ok(firstSignal !== undefined, "第一次检索后 buffer.retrieval 必须存在（slot.buffer 接线断了？）");
  const second = await runSearch("zzzz qqqq");

  assert.ok(buffer.retrieval !== undefined, "工具执行后 buffer.retrieval 必须存在（slot.buffer 接线断了？）");
  assert.ok(firstSignal.chunkCount > 0, "第一次检索应返回候选");
  assert.equal(
    buffer.citations.length,
    first.length + second.length,
    "候选是两次检索的并集（合并信号不影响候选累积）",
  );

  if (realBackend) {
    // fallback 结构性断言总能做；分数值与"最高分胜出"依赖真后端。
    assert.equal(buffer.retrieval.fallback, "none", `两次检索都没降级，本轮 fallback 应为 none，实际 ${buffer.retrieval.fallback}`);
    assert.equal(
      buffer.retrieval.topScore,
      firstSignal.topScore,
      `先高后低：本轮 topScore 必须保留高分那次（${firstSignal.topScore}），实际 ${buffer.retrieval.topScore}`,
    );
    assert.ok(
      buffer.retrieval.topScore > MIN_SCORE,
      `正例那次必须过阈值 ${MIN_SCORE}，实际 ${buffer.retrieval.topScore}`,
    );
    assert.equal(
      buffer.retrieval.chunkCount,
      firstSignal.chunkCount,
      "chunkCount 跟分数最高的那次走，不与另一次的候选数拼接",
    );
    t.diagnostic(
      `工具路径实测：第一次 topScore=${firstSignal.topScore.toFixed(4)}/${firstSignal.chunkCount} 条，` +
        `第二次（乱码）合并后本轮仍为 topScore=${buffer.retrieval.topScore.toFixed(4)}/${buffer.retrieval.chunkCount} 条，` +
        `候选并集 ${buffer.citations.length} 条`,
    );
  } else {
    // hash 后端下不给分数值下结论（不同源的向量距离没有意义），但要证明信号确实被写进来了。
    assert.equal(typeof buffer.retrieval.topScore, "number");
    assert.ok(buffer.retrieval.topScore >= 0 && buffer.retrieval.topScore <= 1, "topScore 必须落在 0..1");
    assert.equal(buffer.retrieval.fallback, "none", "hash 后端不碰网络，检索不会降级");
    t.diagnostic(
      `EMBED_BACKEND=hash：只断言结构（topScore=${buffer.retrieval.topScore}，chunkCount=${buffer.retrieval.chunkCount}）`,
    );
  }
});

/* ────────────────────────── 阈值口径对齐（防止两处各写一份） ────────────────────────── */

test("阈值口径：config.retrievalMinScore 与规格的 0.30 一致", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { config } = await import("../src/config.ts");
  // 本文件用的是字面量 0.30（避免"用实现证明实现"），这条负责在口径漂移时先红。
  assert.equal(
    config.retrievalMinScore,
    MIN_SCORE,
    `config.retrievalMinScore=${config.retrievalMinScore} 与规格 ${MIN_SCORE} 不一致（07 §8）`,
  );
});
