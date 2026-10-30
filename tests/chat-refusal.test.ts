/**
 * 拒答收尾（`05-refusal-and-tickets` #02 · 06 §5.1、05 §3.2 的 `refusal` 帧）。
 *
 * 这里要证明的是**"答不了"是一条确定性路径**，不是模型自觉：
 *   - 超纲问题（德语"能打八折吗"）：事件流出现 `refusal` + 合法单号，**没有** `citations`；
 *     话术是后端常量（不经模型），所以模型已经流出的草稿不会被当成答案留档；
 *   - 落库口径：助手消息 `refused = true`、`citations_count = 0`、正文是**话术**；
 *     一条 `reason ∈ {no_citation, low_conf}`、`status = 'open'`、挂着会话与用户原问题的工单；
 *     `ai_runs.refused = true`；这条消息一条引用行都没有（`refused` 的一轮不许留角标）；
 *   - 额外延迟 < 1 秒：与同一份 mock 跑出来的正常一轮相比（话术是常量，唯一 I/O 是一次建单）；
 *   - 正常问题不回归：仍然 `citations` + `done`，`refused = false`。
 *
 * 与 `tests/chat-citations.test.ts` 同一个外部依赖：`LLM_PROVIDER=mock` 照样真跑检索
 * （dashscope embedding + 语料），所以"折扣问题落在阈值下"这件事依赖真实打分。
 * 刻意的取舍：用 hash 向量伪造一份"必然低分"的检索，那种绿是假的。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

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

// 必须在任何 src 模块被 import 之前改：`src/config.ts` 在 import 阶段就把 env 读成常量。
// 本文件对 src 的引用一律走动态 import（用例里 await import），这里才来得及生效。
process.env.LLM_PROVIDER = "mock";
// 池上限抬到 8：本文件会造多个会话，.env 的 5 正好卡在边界上，用例顺序一变就会撞 SESSION_BUSY。
process.env.PARALLEL_LIMIT = "8";

const hasRuntimeEnv = Boolean(
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT,
);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

/** 06 §5.1 的 ①–④ 只产出这两个原因（`tickets.reason` 的另外两个值属于转人工/越界）。 */
const REFUSAL_REASONS = ["no_citation", "low_conf"];

/** 05 §3.2 的 `refusal` 帧：`{"ticket_no":"WT-2026-0031"}`。 */
const TICKET_NO_RE = /^WT-\d{4}-\d{4}$/;

const createdTokens: string[] = [];
const createdConvs: string[] = [];

after(async () => {
  if (!hasRuntimeEnv) return;
  const { pool, query } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");
  const { shutdownSessions } = await import("../src/core/agent.ts");

  // 工单必须**先于**会话删除：`tickets.conv_id` 是 `on delete set null`，会话删完就找不到这些单了，
  // 用例跑几十次就会在坐席队列里堆一串测试单。
  if (createdConvs.length > 0) {
    await query("delete from tickets where conv_id = any($1::uuid[])", [createdConvs]).catch(() => undefined);
    // messages / citations / ai_runs 都是 on delete cascade，删会话即可连带清空。
    await query("delete from conversations where id = any($1::uuid[])", [createdConvs]).catch(() => undefined);
  }
  const keys = [
    ...createdTokens.map((token) => `sess:${token}`),
    ...createdConvs.map((convId) => `conv:${convId}:lease`),
  ];
  if (keys.length > 0) await redis.del(...keys).catch(() => undefined);

  shutdownSessions();
  await redis.quit().catch(() => undefined);
  // `pool.end()` 必须调：pg 的空闲连接 idleTimeoutMillis = 30s，不关就是测试文件跑完后
  // 再白等 30 秒才退出。
  await pool.end().catch(() => undefined);
});

/** 直接拿 `buildApp()`：SSE 帧经过线上真实的处理器（路由未注册时自己补，见 chat-stream）。 */
async function buildChatApp(): Promise<FastifyInstance> {
  const { buildApp } = await import("../src/server.ts");
  const { registerChatRoutes } = await import("../src/api/chat.ts");
  const app = await buildApp();
  if (!app.hasRoute({ method: "POST", url: "/api/chat" })) await registerChatRoutes(app);
  return app;
}

/** 直接写 Redis 造令牌，不走 `/api/session`：那个端点的限流键按 IP 共享，会与别的用例抢额度。 */
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

async function postChat(app: FastifyInstance, token: string, body: Record<string, unknown>) {
  const startedAt = performance.now();
  const response = await app.inject({
    method: "POST",
    url: "/api/chat",
    headers: { "content-type": "application/json", "x-user-session": token },
    payload: body,
  });
  return { response, ms: performance.now() - startedAt };
}

/** delta 帧拼回正文：正常一轮是模型正文，拒答一轮是"草稿 + 固定话术"。 */
function answerTextOf(frames: Frame[]): string {
  return frames
    .filter((frame) => frame.event === "delta")
    .map((frame) => String((frame.data as { t: string }).t))
    .join("");
}

function frameNames(frames: Frame[]): string[] {
  return frames.map((frame) => frame.event);
}

/** 助手消息行：按会话 + role 定位（**不**用 meta.message_id —— 那是用户消息）。 */
async function assistantRowsOf(convId: string): Promise<
  { id: number; content: string; citations_count: number; refused: boolean }[]
> {
  const { query } = await import("../src/db.ts");
  const rows = await query<{
    id: string;
    content: string;
    citations_count: number;
    refused: boolean;
  }>(
    `select id, content, citations_count, refused
       from messages
      where conv_id = $1 and role = 'assistant'
      order by id`,
    [convId],
  );
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

/* ────────────────────────── 正常一轮：不回归 ────────────────────────── */

test("正常问题仍出 citations + done，且 refused = false（拒答不误伤）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    const { response } = await postChat(app, token, { text: "Wie hoch ist die Garantie?", lang: "de" });
    assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body}`);

    const frames = parseFrames(response.body);
    const names = frameNames(frames);
    const meta = frames[0]?.data as { conv_id: string };
    createdConvs.push(meta.conv_id);

    assert.equal(names.filter((name) => name === "citations").length, 1, `必须恰好一帧 citations：${names.join(",")}`);
    assert.equal(names.filter((name) => name === "refusal").length, 0, `正常一轮不许有 refusal 帧：${names.join(",")}`);
    assert.equal(names.at(-1), "done", `末帧必须是 done：${names.join(",")}`);

    const assistants = await assistantRowsOf(meta.conv_id);
    assert.equal(assistants.length, 1, `一轮只应落一条助手消息，实际 ${assistants.length} 条`);
    const assistant = assistants[0];
    assert.ok(assistant !== undefined);
    assert.equal(assistant.refused, false, "正常回答的 refused 必须是 false");
    assert.ok(assistant.citations_count >= 1, "正常回答必须有引用计数");
    assert.equal(assistant.content, answerTextOf(frames), "落库正文必须与下发的一致");

    const { query } = await import("../src/db.ts");
    const runs = await query<{ refused: boolean }>("select refused from ai_runs where conv_id = $1", [meta.conv_id]);
    assert.equal(runs.length, 1, "一轮对话记一条 ai_runs");
    assert.equal(runs[0]?.refused, false, "正常回答的 ai_runs.refused 必须是 false");
  } finally {
    await app.close();
  }
});

/* ────────────────────────── 超纲问题：拒答四步 ────────────────────────── */

test("超纲问题：refusal 帧带合法单号、没有 citations 帧，落库为话术 + 工单 + refused", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const app = await buildChatApp();
  try {
    // 基线：同一份 mock 夹具的正常一轮。拒答的"额外延迟"只能相对它来说 ——
    // 两者都真跑检索（embedding + 语料），差别只有"建一张单"这一条 I/O。
    const baselineToken = await newSessionToken();
    const baseline = await postChat(app, baselineToken, { text: "Wie lange dauert die Installation?", lang: "de" });
    assert.equal(baseline.response.statusCode, 200, `基线轮期望 200：${baseline.response.body}`);
    const baselineFrames = parseFrames(baseline.response.body);
    createdConvs.push((baselineFrames[0]?.data as { conv_id: string }).conv_id);

    // 超纲问题（德语）：语料里没有折扣政策，检索分落在 0.30 阈值之下 → 06 §5.1 ①b 拒答。
    const question = "Kann ich 20% Rabatt bekommen?";
    const token = await newSessionToken();
    const { response, ms } = await postChat(app, token, { text: question, lang: "de" });
    assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body}`);

    const frames = parseFrames(response.body);
    const names = frameNames(frames);
    const meta = frames[0]?.data as { conv_id: string; message_id: number };
    createdConvs.push(meta.conv_id);

    // ── 帧序列（05 §3.2）：meta 首帧、末帧 done，`refusal` 恰好一帧，**没有** `citations` ──
    assert.equal(names[0], "meta", `首帧必须是 meta：${names.join(",")}`);
    assert.equal(names.at(-1), "done", `末帧必须是 done：${names.join(",")}`);
    assert.equal(names.filter((name) => name === "citations").length, 0, `拒答时不许发 citations：${names.join(",")}`);

    const refusalFrames = frames.filter((frame) => frame.event === "refusal");
    assert.equal(refusalFrames.length, 1, `拒答必须恰好一帧 refusal：${names.join(",")}`);
    const ticketNo = (refusalFrames[0]?.data as { ticket_no: string }).ticket_no;
    assert.match(ticketNo, TICKET_NO_RE, `单号格式必须是 WT-YYYY-NNNN，实际 "${ticketNo}"`);

    // ── 话术：后端常量直发，且**在**单号帧之前（06 §5.1 的四个动作顺序）──
    const { refusalText } = await import("../src/core/refusal.ts");
    const copy = refusalText("de");
    const answer = answerTextOf(frames);
    assert.ok(answer.endsWith(copy), `拒答话术必须由后端常量下发（不经模型），实际 delta 拼接：${answer}`);
    const copyIndex = names.lastIndexOf("delta");
    assert.ok(copyIndex < names.indexOf("refusal"), `话术必须在单号之前下发：${names.join(",")}`);

    // ── 落库：助手消息 = 话术、refused、零引用 ──────────────────────────────
    const assistants = await assistantRowsOf(meta.conv_id);
    assert.equal(assistants.length, 1, `拒答一轮也只落一条助手消息，实际 ${assistants.length} 条`);
    const assistant = assistants[0];
    assert.ok(assistant !== undefined);
    assert.equal(assistant.content, copy, "拒答行的正文必须是固定话术（模型草稿一个字节都不许落库）");
    assert.equal(assistant.refused, true, "拒答行的 refused 必须是 true");
    assert.equal(assistant.citations_count, 0, "拒答行不许有引用计数");

    const { query } = await import("../src/db.ts");
    const citationRows = await query<{ n: string }>(
      `select count(*) as n from citations c join messages m on m.id = c.message_id where m.conv_id = $1`,
      [meta.conv_id],
    );
    assert.equal(Number(citationRows[0]?.n ?? -1), 0, "拒答的一轮一条引用行都不许有");

    // ── 工单：一条、原因属于无引用/低置信、状态待处理、挂着会话与用户原问题 ──
    const tickets = await query<{
      no: string;
      reason: string;
      status: string;
      conv_id: string | null;
      question: string;
    }>("select no, reason, status, conv_id, question from tickets where conv_id = $1 order by id", [meta.conv_id]);
    assert.equal(tickets.length, 1, `拒答必须建**一条**工单，实际 ${tickets.length} 条`);
    const ticket = tickets[0];
    assert.ok(ticket !== undefined);
    assert.equal(ticket.no, ticketNo, "落库的单号必须与 refusal 帧下发的一致（前端拿它查进度）");
    assert.ok(
      REFUSAL_REASONS.includes(ticket.reason),
      `拒答原因必须是 ${REFUSAL_REASONS.join("/")}，实际 "${ticket.reason}"`,
    );
    assert.equal(ticket.status, "open", "新工单必须是待处理（open）");
    assert.equal(ticket.conv_id, meta.conv_id, "工单必须挂在这次会话上（坐席要能回看对话）");
    assert.equal(ticket.question, question, "工单的 question 必须是用户原话（不做摘要）");

    // ── 记账：ai_runs.refused = true ──────────────────────────────────────
    const runs = await query<{ refused: boolean }>(
      "select refused from ai_runs where conv_id = $1 order by id",
      [meta.conv_id],
    );
    assert.equal(runs.length, 1, `拒答一轮也记一条 ai_runs，实际 ${runs.length} 条`);
    assert.equal(runs[0]?.refused, true, "ai_runs.refused 必须是 true（拒答率统计的口径）");

    // ── 额外延迟 < 1 秒（话术是常量，唯一 I/O 是一次建单）───────────────────
    assert.ok(
      ms - baseline.ms < 1_000,
      `拒答额外延迟必须 < 1000ms：拒答 ${Math.round(ms)}ms vs 基线 ${Math.round(baseline.ms)}ms`,
    );
  } finally {
    await app.close();
  }
});

/* ────────────────────── 放行门：拒答不许先吐模型正文（R1-2） ────────────────────── */

/**
 * 这条钉的是一个**用户能看见**的缺陷：拒答判定要等生成结束才知道，而 delta 是边生成边发的，
 * 于是"答不了"的一轮会先把模型草稿送到浏览器、再补一条固定话术，用户看到自相矛盾的两段
 * （实测：打招呼与超纲题都这样，见 `reviews.md` §2.1）。
 *
 * 现在的口径：**只放行"检索结果够用之后"产生的文字**。检索不足时模型写什么都被扣住，
 * 收尾判拒答后直接下发话术 —— 所以 delta 拼起来必须**逐字节等于**话术，一个字都不能多。
 */
test("放行门：检索不足的一轮，delta 只等于拒答话术（模型草稿一个字都不下发）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const app = await buildChatApp();
  try {
    const { refusalText } = await import("../src/core/refusal.ts");
    const token = await newSessionToken();
    // 语料里没有折扣政策：检索必然低于阈值（①b），这一轮注定拒答。
    const question = "Kann ich 30% Rabatt auf zwei Wechselrichter bekommen?";
    const { response } = await postChat(app, token, { text: question, lang: "de" });
    assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body}`);
    const frames = parseFrames(response.body);
    createdConvs.push((frames[0]?.data as { conv_id: string }).conv_id);

    const names = frameNames(frames);
    assert.equal(names.filter((name) => name === "refusal").length, 1, `必须恰好一帧 refusal：${names.join(",")}`);
    assert.equal(answerTextOf(frames), refusalText("de"), "拒答轮的 delta 必须**只有**话术，不许夹模型草稿");
    // 顺序：话术的 delta 在 refusal 帧之前（前端先显示文案，再补工单卡）。
    assert.ok(names.lastIndexOf("delta") < names.indexOf("refusal"), `话术必须先于单号：${names.join(",")}`);
  } finally {
    await app.close();
  }
});

test("放行门：检索够用的一轮照常逐字出现（门在 kb_search 返回后打开）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const app = await buildChatApp();
  try {
    const token = await newSessionToken();
    const { response } = await postChat(app, token, { text: "Wie hoch ist die Garantie?", lang: "de" });
    assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body}`);
    const frames = parseFrames(response.body);
    const names = frameNames(frames);
    createdConvs.push((frames[0]?.data as { conv_id: string }).conv_id);

    // 正常一轮：有 tool（kb_search）→ 有 delta → done；正文必须非空且不被吞掉。
    assert.ok(names.includes("tool"), `正常一轮必须有 tool 帧：${names.join(",")}`);
    assert.ok(answerTextOf(frames).trim() !== "", "正常一轮的正文不能被放行门吞掉");
    assert.equal(names.filter((name) => name === "refusal").length, 0, "正常一轮不许出现 refusal 帧");
  } finally {
    await app.close();
  }
});
