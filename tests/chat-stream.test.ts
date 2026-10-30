/**
 * `POST /api/chat` 的 SSE 接线验收（`05-api.md` §3.2 · `04-agent-chat` #01）。
 *
 * 这里要证明的是**接线**，不是模型的聪明程度：
 * 帧顺序（meta 一次 → delta ≥1 → done 最后）、`meta` 里的三个 id 都是真的（能回查到行）、
 * 建/复用会话、鉴权与入参的四道门、以及 `done` 里的账。
 *
 * `LLM_PROVIDER=mock`（`06-agent.md` §8）：mock 路径**照样真跑检索**（dashscope embedding），
 * 所以本文件与 `tests/retrieval-search.test.ts` 有同一个外部依赖 —— 网络不可用时
 * delta 会为 0，用例会红。这是有意的：把 embedding 也换成 hash 就等于用一个
 * 和语料不同源的向量去断言"检索命中"，那种绿是假的。
 *
 * 30s 超时**不在**这里测：真实超时无法在测试里制造，而 `TurnEvent` 的 error → SSE `error` 帧
 * 只是一个序列化动作，所以用 `serializeFrame` 直接钉住字节形状（见文件末尾两个用例）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 tests/data-modules.test.ts 同一套 .env 解析：行内 `#` 之后是注释、成对引号去掉。 */
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

// 必须在任何 src 模块被 import 之前改：`src/config.ts` 在 import 阶段就把 env 读成常量。
// 本文件对 src 的引用一律走动态 import（下面每个用例里 await import），这里才来得及生效。
process.env.LLM_PROVIDER = "mock";
// 池上限抬到 8：本文件会造 5 个会话，.env 的 5 正好卡在边界上，用例顺序一变就会撞 SESSION_BUSY。
// 这里不是为了测上限（那个由 `statusForTurnError` 单测钉住），只是让用例彼此独立。
process.env.PARALLEL_LIMIT = "8";

const hasRuntimeEnv = Boolean(
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT,
);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

/** uuid 形状（randomUUID 只会产出 v4）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createdTokens: string[] = [];
const createdConvs: string[] = [];

after(async () => {
  if (!hasRuntimeEnv) return;
  const { pool, query } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");
  const { shutdownSessions } = await import("../src/core/agent.ts");

  // 本文件造出来的行全部删掉：messages / ai_runs / citations 都是 on delete cascade，
  // 删会话即可连带清空；Redis 侧只剩令牌与租约键。
  if (createdConvs.length > 0) {
    await query("delete from conversations where id = any($1::uuid[])", [createdConvs]).catch(() => undefined);
  }
  const keys = [
    ...createdTokens.map((token) => `sess:${token}`),
    ...createdConvs.map((convId) => `conv:${convId}:lease`),
  ];
  if (keys.length > 0) await redis.del(...keys).catch(() => undefined);

  // 进程内会话池：不 dispose 会把这些 session 的定时器/SDK 资源带出测试进程。
  shutdownSessions();
  await redis.quit().catch(() => undefined);
  // `pool.end()` 必须调：pg 的空闲连接 idleTimeoutMillis = 30s，不关就是测试文件跑完后
  // 再白等 30 秒才退出（其余测试文件的 after 也是同一套）。
  await pool.end().catch(() => undefined);
});

/**
 * 直接拿 `buildApp()`：SSE 帧与 401/400 信封信封都经过线上真实的处理器。
 * 路由是否已由 `src/routes.ts` 注册本测试不假设（同理 `tests/session-token.test.ts`）：
 * 没注册就自己补，已注册就不重复注册（Fastify 重复注册会抛路由冲突）。
 */
async function buildChatApp(): Promise<FastifyInstance> {
  const { buildApp } = await import("../src/server.ts");
  const { registerChatRoutes } = await import("../src/api/chat.ts");
  const app = await buildApp();
  if (!app.hasRoute({ method: "POST", url: "/api/chat" })) await registerChatRoutes(app);
  return app;
}

/** 直接写 Redis 造令牌，不走 `/api/session`：那个端点的限流键是共享的（按 IP），
 *  和 `tests/session-token.test.ts` 并行/相邻跑时会互相抢那 10 次额度。 */
async function newSessionToken(): Promise<string> {
  const token = randomUUID();
  const { redis } = await import("../src/redis.ts");
  await redis.setex(`sess:${token}`, 600, "1");
  createdTokens.push(token);
  return token;
}

type Frame = { event: string; data: unknown };

/** Fastify 的 `inject()` 会把整个流缓冲进 body；按 SSE 的 `\n\n` 分帧还原。 */
function parseFrames(body: string): Frame[] {
  return body
    .split("\n\n")
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length) ?? "";
      return { event, data: JSON.parse(data) as unknown };
    });
}

type ChatCall = { token: string; body: Record<string, unknown>; acceptLanguage?: string };

async function postChat(app: FastifyInstance, call: ChatCall) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (call.token !== "") headers["x-user-session"] = call.token;
  if (call.acceptLanguage !== undefined) headers["accept-language"] = call.acceptLanguage;
  return app.inject({ method: "POST", url: "/api/chat", headers, payload: call.body });
}

async function traceConv(convId: string): Promise<void> {
  createdConvs.push(convId);
}

/* ────────────────────────── 主路径 ────────────────────────── */

test("POST /api/chat 出 SSE：meta 一次 → delta ≥1 → done 最后；meta 的三个 id 都能回查", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { query, one } = await import("../src/db.ts");
  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    const response = await postChat(app, {
      token,
      body: { text: "  Wie hoch ist die Garantie?  ", lang: "de" },
    });

    assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body}`);
    const contentType = String(response.headers["content-type"] ?? "");
    assert.ok(contentType.startsWith("text/event-stream"), `content-type 应为 text/event-stream，实际 "${contentType}"`);
    // 05 §8：这三件套一个都不能少，否则中间层会把流攒成一坨。
    assert.equal(response.headers["cache-control"], "no-cache, no-transform");
    assert.equal(response.headers["x-accel-buffering"], "no");

    const frames = parseFrames(response.body);
    const names = frames.map((frame) => frame.event);
    assert.equal(names.filter((name) => name === "meta").length, 1, `meta 必须恰好一次：${names.join(",")}`);
    assert.equal(names[0], "meta", `首帧必须是 meta：${names.join(",")}`);
    assert.ok(
      names.filter((name) => name === "delta").length >= 1,
      `至少一帧 delta（mock 路径会真跑检索，正文来自首条候选）：${names.join(",")}`,
    );
    assert.equal(names.at(-1), "done", `末帧必须是 done：${names.join(",")}`);

    const meta = frames[0]?.data as { conv_id: string; message_id: number; trace_id: string };
    assert.match(meta.conv_id, UUID_RE, `meta.conv_id 必须是 uuid，实际 "${meta.conv_id}"`);
    assert.equal(typeof meta.message_id, "number", `meta.message_id 必须是数字，实际 ${typeof meta.message_id}`);
    assert.equal(typeof meta.trace_id, "string");
    assert.ok(meta.trace_id.length > 0, "meta.trace_id 不能为空");

    const done = frames.at(-1)?.data as { latency_ms: number; tokens: number; cost_usd: number };
    assert.equal(typeof done.latency_ms, "number");
    assert.equal(typeof done.tokens, "number");
    assert.equal(typeof done.cost_usd, "number");
    assert.ok(done.latency_ms >= 0, `latency_ms 不能为负：${done.latency_ms}`);

    // meta 里的 id 必须指向真实的行，否则前端拿到的就是一个永远对不上的外键。
    const conv = await one<{ token_id: string; lang: string }>(
      "select token_id, lang from conversations where id = $1",
      [meta.conv_id],
    );
    assert.ok(conv !== null, "conversations 里应有 meta.conv_id 对应的行");
    assert.equal(conv.token_id, token, "会话必须绑定到签发它的令牌");
    assert.equal(conv.lang, "de");

    const message = await one<{ conv_id: string; role: string; content: string; lang: string }>(
      "select conv_id, role, content, lang from messages where id = $1",
      [meta.message_id],
    );
    assert.ok(message !== null, "messages 里应有 meta.message_id 对应的行");
    assert.equal(message.conv_id, meta.conv_id);
    assert.equal(message.role, "user");
    // 落库的是 trim 后的正文：前端首尾的空格不该进历史记录。
    assert.equal(message.content, "Wie hoch ist die Garantie?");
    assert.equal(message.lang, "de");

    // 05 §3.2 + 06 §9：`done` 之前已经记好账。
    const runs = await query<{ input_tokens: number; output_tokens: number; latency_ms: number }>(
      "select input_tokens, output_tokens, latency_ms from ai_runs where conv_id = $1",
      [meta.conv_id],
    );
    assert.equal(runs.length, 1, "一轮对话只应落一条 ai_runs");
    const run = runs[0];
    assert.ok(run !== undefined);
    // mock 模式：tokens 是"正文长度/3"，属于纯输出，输入记 0（见 chat.ts 的 splitTokens）。
    assert.equal(run.input_tokens, 0, "mock 模式输入 token 记 0");
    assert.equal(run.output_tokens, done.tokens, "mock 模式全部 token 记在输出侧");

    await traceConv(meta.conv_id);
  } finally {
    await app.close();
  }
});

test("同一 conv_id 的第二次调用复用会话（行数不变）并追加一条 user 消息", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { query, one } = await import("../src/db.ts");
  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    const first = await postChat(app, { token, body: { text: "Wie hoch ist die Garantie?", lang: "de" } });
    assert.equal(first.statusCode, 200, `首轮期望 200，实际 ${first.statusCode}：${first.body}`);
    const convId = (parseFrames(first.body)[0]?.data as { conv_id: string }).conv_id;
    await traceConv(convId);

    const second = await postChat(app, { token, body: { text: "Und die Anmeldung?", lang: "de", conv_id: convId } });
    assert.equal(second.statusCode, 200, `次轮期望 200，实际 ${second.statusCode}：${second.body}`);
    const frames = parseFrames(second.body);
    const meta = frames[0]?.data as { conv_id: string; message_id: number };
    assert.equal(meta.conv_id, convId, "次轮必须复用同一个会话 id");
    assert.equal(frames.at(-1)?.event, "done", `次轮也应以 done 收尾：${frames.map((f) => f.event).join(",")}`);

    const convCount = await query("select 1 from conversations where id = $1", [convId]);
    assert.equal(convCount.length, 1, "复用不得新建会话行");

    // 只看用户消息行：05#01 起每个模型路轮次还会落一条**助手**消息（引用快照挂在它上面，
    // 见 `insertAssistantMessage`），所以"两轮两条提问"必须按 role 定位。
    const messages = await query<{ role: string; content: string }>(
      "select role, content from messages where conv_id = $1 and role = 'user' order by id",
      [convId],
    );
    assert.equal(messages.length, 2, `两轮应落两条用户消息，实际 ${messages.length} 条`);
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages[0]?.content, "Wie hoch ist die Garantie?");
    assert.equal(messages[1]?.role, "user");
    assert.equal(messages[1]?.content, "Und die Anmeldung?");

    // 两条消息的 id 必须不同：前端靠 message_id 挂引用与反馈。
    const firstId = (parseFrames(first.body)[0]?.data as { message_id: number }).message_id;
    assert.notEqual(meta.message_id, firstId, "两轮的 meta.message_id 不能相同");

    // 第二个令牌碰别人的会话：一律 404（与"不存在"不可区分）。
    const intruder = await newSessionToken();
    const stolen = await postChat(app, { token: intruder, body: { text: "hallo", conv_id: convId } });
    assert.equal(stolen.statusCode, 404, `越权访问别人的会话应 404，实际 ${stolen.statusCode}：${stolen.body}`);
    const stolenBody = stolen.json() as { ok: boolean; error: { code: string } };
    assert.equal(stolenBody.error.code, "NOT_FOUND");

    const unknown = await postChat(app, { token, body: { text: "hallo", conv_id: randomUUID() } });
    assert.equal(unknown.statusCode, 404, `不存在的 conv_id 应 404，实际 ${unknown.statusCode}`);

    const rows = await query("select 1 from conversations where token_id = $1", [intruder]);
    assert.equal(rows.length, 0, "被拒的请求不得留下会话行");
    assert.ok(await one("select 1 from conversations where id = $1", [convId]) !== null);
  } finally {
    await app.close();
  }
});

/* ────────────────────────── 四道门 ────────────────────────── */

test("鉴权与入参：缺令牌 401、伪造令牌 401、空 text / 超长 text / 非法 lang 400", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const app = await buildChatApp();
  try {
    const token = await newSessionToken();

    const missing = await postChat(app, { token: "", body: { text: "hallo", lang: "de" } });
    assert.equal(missing.statusCode, 401, `缺 X-User-Session 应 401，实际 ${missing.statusCode}`);
    const missingBody = missing.json() as { ok: boolean; error: { code: string; trace_id: string } };
    assert.equal(missingBody.ok, false);
    assert.equal(missingBody.error.code, "AUTH_REQUIRED");
    assert.equal(typeof missingBody.error.trace_id, "string");

    // 形状合法但没签发过的令牌（Redis 里没有 sess:*）与"乱码令牌"是同一件事：过期。
    const forged = await postChat(app, { token: randomUUID(), body: { text: "hallo", lang: "de" } });
    assert.equal(forged.statusCode, 401, `未签发的令牌应 401，实际 ${forged.statusCode}`);
    assert.equal((forged.json() as { error: { code: string } }).error.code, "AUTH_INVALID");

    const garbage = await postChat(app, { token: "not-a-token", body: { text: "hallo", lang: "de" } });
    assert.equal(garbage.statusCode, 401, `乱码令牌应 401，实际 ${garbage.statusCode}`);
    assert.equal((garbage.json() as { error: { code: string } }).error.code, "AUTH_INVALID");

    for (const body of [
      { text: "", lang: "de" },
      { text: "   ", lang: "de" },
      { text: "a".repeat(2001), lang: "de" },
      { text: "hallo", lang: "fr" },
      { text: "hallo", lang: "de", conv_id: "not-a-uuid" },
    ]) {
      const response = await postChat(app, { token, body });
      assert.equal(response.statusCode, 400, `期望 400，实际 ${response.statusCode}：${JSON.stringify(body)}`);
      const envelope = response.json() as { ok: boolean; error: { code: string; trace_id: string } };
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error.code, "VALIDATION");
      assert.equal(typeof envelope.error.trace_id, "string");
    }

    // 2000 字符是上限本身（不是"小于 2000"），必须放行 —— 这是最常见的差一错误。
    const boundary = await postChat(app, { token, body: { text: "a".repeat(2000), lang: "de" } });
    assert.equal(boundary.statusCode, 200, `2000 字符应放行，实际 ${boundary.statusCode}：${boundary.body}`);
    await traceConv((parseFrames(boundary.body)[0]?.data as { conv_id: string }).conv_id);
  } finally {
    await app.close();
  }
});

test("lang 缺省按 Accept-Language 猜，猜不到回落 en", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { one } = await import("../src/db.ts");
  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    const german = await postChat(app, {
      token,
      body: { text: "Wie hoch ist die Garantie?" },
      acceptLanguage: "de-DE,de;q=0.9,en;q=0.8",
    });
    assert.equal(german.statusCode, 200, `期望 200，实际 ${german.statusCode}：${german.body}`);
    const germanConv = (parseFrames(german.body)[0]?.data as { conv_id: string }).conv_id;
    await traceConv(germanConv);
    const germanRow = await one<{ lang: string }>("select lang from conversations where id = $1", [germanConv]);
    assert.equal(germanRow?.lang, "de");

    const fallback = await postChat(app, {
      token,
      body: { text: "How long is the warranty?" },
      acceptLanguage: "fr-FR,fr;q=0.9",
    });
    assert.equal(fallback.statusCode, 200, `期望 200，实际 ${fallback.statusCode}：${fallback.body}`);
    const fallbackConv = (parseFrames(fallback.body)[0]?.data as { conv_id: string }).conv_id;
    await traceConv(fallbackConv);
    const fallbackRow = await one<{ lang: string }>("select lang from conversations where id = $1", [fallbackConv]);
    assert.equal(fallbackRow?.lang, "en", "猜不到就回落 en（05 §3.2）");
  } finally {
    await app.close();
  }
});

/* ────────────────────────── 并发与探活 ────────────────────────── */

test("两条不同会话同时在跑：都出完整事件流（互不阻塞）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    const [a, b] = await Promise.all([
      postChat(app, { token, body: { text: "Wie hoch ist die Garantie?", lang: "de" } }),
      postChat(app, { token, body: { text: "How long is the warranty?", lang: "en" } }),
    ]);

    for (const [name, response] of [
      ["de", a],
      ["en", b],
    ] as const) {
      assert.equal(response.statusCode, 200, `${name} 期望 200，实际 ${response.statusCode}：${response.body}`);
      const frames = parseFrames(response.body);
      const names = frames.map((frame) => frame.event);
      assert.equal(names[0], "meta", `${name} 首帧必须是 meta：${names.join(",")}`);
      assert.equal(names.at(-1), "done", `${name} 末帧必须是 done：${names.join(",")}`);
      await traceConv((frames[0]?.data as { conv_id: string }).conv_id);
    }

    const aConv = (parseFrames(a.body)[0]?.data as { conv_id: string }).conv_id;
    const bConv = (parseFrames(b.body)[0]?.data as { conv_id: string }).conv_id;
    assert.notEqual(aConv, bConv, "两条并发请求应各自建会话");
  } finally {
    await app.close();
  }
});

test("/healthz：跑过一轮对话后 pi 为 true，且 ok 依赖它（200）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { agentReady } = await import("../src/core/agent.ts");
  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    // 先证明"没装配过就没有 pi"这件事在别的进程里也成立是做不到的（本进程可能已有前序用例），
    // 所以这里只断言装配后的事实 + 与其余三项的合取关系。
    const chat = await postChat(app, { token, body: { text: "Wie hoch ist die Garantie?", lang: "de" } });
    assert.equal(chat.statusCode, 200, `期望 200，实际 ${chat.statusCode}：${chat.body}`);
    await traceConv((parseFrames(chat.body)[0]?.data as { conv_id: string }).conv_id);

    assert.equal(agentReady(), true, "跑过一轮对话后 core/agent.ts 应记下装配成功");

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const body = health.json() as { ok: boolean; checks: Record<string, boolean> };
    assert.equal(body.checks.pi, true, "04#01 之后 pi 必须为 true");
    assert.equal(health.statusCode, 200, `四项齐全时 /healthz 应 200，实际 ${health.statusCode}`);
    assert.equal(body.ok, true);
    assert.equal(
      body.ok,
      body.checks.pg && body.checks.redis && body.checks.minio && body.checks.pi,
      "ok 必须是四项的合取（pi 不再是例外）",
    );
  } finally {
    await app.close();
  }
});

/* ────────────────────────── 纯函数：错误帧与状态映射 ────────────────────────── */

test("serializeFrame 钉住 error 帧的字节形状（真实 30s 超时在测试里不可制造）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { serializeFrame } = await import("../src/api/chat.ts");
  const traceId = "11111111-2222-4333-8444-555555555555";

  // 这里喂的是 `core/agent.ts` 的 TurnEvent error 在 chat.ts 里被转发时的那份数据。
  assert.equal(
    serializeFrame("error", { code: "LLM_TIMEOUT", message: "响应超时，请稍后重试或转人工", trace_id: traceId }),
    `event: error\ndata: {"code":"LLM_TIMEOUT","message":"响应超时，请稍后重试或转人工","trace_id":"${traceId}"}\n\n`,
  );
  // 双帧拼接：SSE 的分帧靠空行，末尾少一个 \n 就会把两帧粘成一帧。
  assert.equal(
    serializeFrame("delta", { t: "x" }) + serializeFrame("done", { latency_ms: 1, tokens: 2, cost_usd: 0 }),
    'event: delta\ndata: {"t":"x"}\n\nevent: done\ndata: {"latency_ms":1,"tokens":2,"cost_usd":0}\n\n',
  );
  assert.equal(serializeFrame("meta", { conv_id: traceId }).endsWith("\n\n"), true);
});

test("statusForTurnError：SESSION_BUSY → 503，超时 → 504，未知 → 500", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { statusForTurnError } = await import("../src/api/chat.ts");

  // 池满 = 503：前端把它渲染成「前面还有几位」。这条映射是 05 §6 里唯一有真实流量的一条。
  assert.equal(statusForTurnError("SESSION_BUSY"), 503);
  assert.equal(statusForTurnError("LLM_TIMEOUT"), 504);
  assert.equal(statusForTurnError("LLM_ERROR"), 503, "LLM_ERROR 对外收窄成 LLM_UNAVAILABLE");
  assert.equal(statusForTurnError("LLM_UNAVAILABLE"), 503);
  assert.equal(statusForTurnError("EMBED_UNAVAILABLE"), 503);
  assert.equal(statusForTurnError("SOMETHING_ELSE"), 500, "未知码一律 500，不许猜成 4xx");
});
