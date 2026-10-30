/**
 * 收尾阶段的引用校验与快照落库（`05-refusal-and-tickets` #01 · 05 §3.2 规则 1–4、06 §5.1–§5.2）。
 *
 * 这里要证明的是**收尾顺序**和**只有被引用的才下发/落库**这两件事：
 *   - 帧顺序 `meta … (tool) … delta … citations … done`，`citations` 恰好一帧且在 `done` 之前；
 *   - `citations` 帧里的条目 = 正文里真的出现过的 `[n]`（**不是** `kb_search` 的候选全集）；
 *   - 快照落在**助手消息**上，`messages.citations_count` 与 `citations` 行数一致，
 *     用户消息行始终是 0（引用不属于"这一问"）；
 *   - 同一会话的第二轮不串：新助手消息 + 自己的引用，第一轮的计数不被改写。
 *
 * `LLM_PROVIDER=mock`（06 §8）：mock 路径照样真跑检索（dashscope embedding），
 * 正文是"首条候选的首句 + `[1]`"，所以本文件与 `tests/chat-stream.test.ts` 有同一个外部依赖
 * —— 网络/语料不可用时 delta 与 citations 都会为空，用例会红。这是有意的：
 * 用 hash 向量造一份"和语料不同源"的命中，那种绿是假的。
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
// 本文件对 src 的引用一律走动态 import（下面每个用例里 await import），这里才来得及生效。
process.env.LLM_PROVIDER = "mock";
// 池上限抬到 8：本文件会造多个会话，.env 的 5 正好卡在边界上，用例顺序一变就会撞 SESSION_BUSY。
process.env.PARALLEL_LIMIT = "8";

const hasRuntimeEnv = Boolean(
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT,
);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 06 §3.1：单片段正文上限 600 字符。`citations` 帧里的 snippet 不能超过它。 */
const SNIPPET_MAX_CHARS = 600;

const KNOWN_LANGS = ["zh", "en", "de", "nl", "es"];

const createdTokens: string[] = [];
const createdConvs: string[] = [];

after(async () => {
  if (!hasRuntimeEnv) return;
  const { pool, query } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");
  const { shutdownSessions } = await import("../src/core/agent.ts");

  // 本文件造出来的行全部删掉：messages / ai_runs / citations 都是 on delete cascade，
  // 删会话即可连带清空（citations 经 messages 级联）。Redis 侧只剩令牌与租约键。
  if (createdConvs.length > 0) {
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
  return app.inject({
    method: "POST",
    url: "/api/chat",
    headers: { "content-type": "application/json", "x-user-session": token },
    payload: body,
  });
}

/** `citations` 帧的一条（05 §3.2：前端只认这五个字段）。 */
type CitationEntry = { idx: number; doc_title: string; page: number | null; snippet: string; doc_lang: string };

function citationEntriesOf(frames: Frame[]): CitationEntry[] {
  const framesOfName = frames.filter((frame) => frame.event === "citations");
  assert.equal(framesOfName.length, 1, `citations 必须恰好一帧：${frames.map((f) => f.event).join(",")}`);
  const data = framesOfName[0]?.data;
  assert.ok(Array.isArray(data), `citations 的 data 必须是数组（05 §3.2 的形状），实际 ${typeof data}`);
  return data as CitationEntry[];
}

/** delta 帧拼回正文：这是"模型到底引用了什么"的唯一证据。 */
function answerTextOf(frames: Frame[]): string {
  return frames
    .filter((frame) => frame.event === "delta")
    .map((frame) => String((frame.data as { t: string }).t))
    .join("");
}

/** 正文里的角标编号集合（05 §3.2 规则 1 的字面口径）。 */
function marksOf(text: string): number[] {
  return [...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
}

/** 助手消息行：按会话 + role 定位（**不**用 meta.message_id —— 那是用户消息）。 */
async function assistantRowsOf(convId: string): Promise<
  { id: number; content: string; citations_count: number; refused: boolean; tool_names: string[] }[]
> {
  const { query } = await import("../src/db.ts");
  const rows = await query<{
    id: string;
    content: string;
    citations_count: number;
    refused: boolean;
    tool_names: string[];
  }>(
    `select id, content, citations_count, refused, tool_names
       from messages
      where conv_id = $1 and role = 'assistant'
      order by id`,
    [convId],
  );
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

async function citationRowsOf(messageId: number): Promise<
  { idx: number; doc_title: string; doc_lang: string; page: number | null; snippet: string; score: number | null }[]
> {
  const { query } = await import("../src/db.ts");
  return query(
    `select idx, doc_title, doc_lang, page, snippet, score
       from citations
      where message_id = $1
      order by idx`,
    [messageId],
  );
}

/* ────────────────────────── 主路径：一帧 citations，落库一致 ────────────────────────── */

test("正常一轮：delta 之后 citations 之前无别帧，citations 按 idx 升序且只含被引用片段", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { one } = await import("../src/db.ts");
  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    const response = await postChat(app, token, { text: "Wie hoch ist die Garantie?", lang: "de" });
    assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body}`);

    const frames = parseFrames(response.body);
    const names = frames.map((frame) => frame.event);

    // 帧顺序（05 §3.2）：meta 首次出现、delta ≥1、citations 在 done 之前、done 最后一帧。
    assert.equal(names[0], "meta", `首帧必须是 meta：${names.join(",")}`);
    assert.equal(names.filter((name) => name === "meta").length, 1);
    assert.equal(names.at(-1), "done", `末帧必须是 done：${names.join(",")}`);
    assert.ok(names.filter((name) => name === "delta").length >= 1, `至少一帧 delta：${names.join(",")}`);

    const citationsAtIndex = names.indexOf("citations");
    assert.ok(citationsAtIndex > 0, `必须有 citations 帧：${names.join(",")}`);
    assert.equal(citationsAtIndex, names.length - 2, `citations 必须紧邻 done 之前：${names.join(",")}`);
    assert.ok(
      names.slice(0, citationsAtIndex).every((name) => name === "meta" || name === "tool" || name === "delta"),
      `citations 之前只允许 meta/tool/delta：${names.join(",")}`,
    );

    const meta = frames[0]?.data as { conv_id: string; message_id: number; trace_id: string };
    createdConvs.push(meta.conv_id);

    // ── 帧内容：形状 + 升序 + 只含被引用的 ───────────────────────────────
    const entries = citationEntriesOf(frames);
    const answer = answerTextOf(frames);
    assert.ok(answer.length > 0, "mock 路径正文不应为空（检索没命中时整条用例失去意义）");

    assert.ok(entries.length >= 1, "被引用过的回答必须有至少一条 citations");
    for (const entry of entries) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ["doc_lang", "doc_title", "idx", "page", "snippet"],
        "帧条目只带 05 §3.2 的五个字段（chunk_id / score 属于后端，不许下发）",
      );
      assert.equal(typeof entry.idx, "number");
      assert.ok(Number.isInteger(entry.idx) && entry.idx >= 1, `idx 必须是正整数：${entry.idx}`);
      assert.equal(typeof entry.doc_title, "string");
      assert.ok(entry.doc_title.length > 0, "doc_title 不能为空（否则角标点开是一行空白）");
      assert.ok(
        entry.page === null || typeof entry.page === "number",
        `page 必须是 null 或数字，实际 ${JSON.stringify(entry.page)}`,
      );
      assert.equal(typeof entry.snippet, "string");
      assert.ok(entry.snippet.length > 0, "snippet 不能为空");
      assert.ok(
        entry.snippet.length <= SNIPPET_MAX_CHARS,
        `snippet 超过 ${SNIPPET_MAX_CHARS} 字符：${entry.snippet.length}`,
      );
      assert.ok(KNOWN_LANGS.includes(entry.doc_lang), `doc_lang 必须是五语之一，实际 "${entry.doc_lang}"`);
    }

    // 规则 4：按 idx 升序，与正文首次出现顺序无关。
    const idxs = entries.map((entry) => entry.idx);
    assert.deepEqual(idxs, [...idxs].sort((a, b) => a - b), `citations 必须按 idx 升序：${idxs.join(",")}`);
    assert.equal(new Set(idxs).size, idxs.length, `citations 的 idx 不许重复：${idxs.join(",")}`);

    // 规则 1 + 规则 2 的反面：帧里的编号集合 == 正文里的角标集合。
    // 少一个 = 正文有角标却没得点；多一个 = 把候选全集发出去了（客户点开"这段不支持那句话"）。
    const answerMarks = [...new Set(marksOf(answer))].sort((a, b) => a - b);
    assert.deepEqual(idxs, answerMarks, `citations 的编号必须与正文角标一一对应：正文 ${answerMarks.join(",")}`);
    assert.equal(entries.length, answerMarks.length, "citations 里不许出现正文没引用过的候选");

    // ── 落库：快照挂在助手消息上，用户消息行保持 0 ──────────────────────
    const userRow = await one<{ role: string; citations_count: number }>(
      "select role, citations_count from messages where id = $1",
      [meta.message_id],
    );
    assert.ok(userRow !== null, "meta.message_id 必须仍指向用户消息行");
    assert.equal(userRow.role, "user", "meta.message_id 保持是用户消息 id（引用不许挂在它身上）");
    assert.equal(userRow.citations_count, 0, "用户消息行不带引用计数");

    const assistants = await assistantRowsOf(meta.conv_id);
    assert.equal(assistants.length, 1, `一轮对话只应落一条助手消息，实际 ${assistants.length} 条`);
    const assistant = assistants[0];
    assert.ok(assistant !== undefined);
    assert.notEqual(assistant.id, meta.message_id, "助手消息与用户消息必须是两行");
    assert.equal(assistant.content, answer, "落库的助手正文必须是这一轮真正发出去的那段");
    assert.equal(assistant.refused, false, "05#02 之前 refused 恒为 false");
    assert.equal(assistant.citations_count, entries.length, "citations_count 必须等于下发的引用条数");
    assert.ok(assistant.tool_names.includes("kb_search"), `tool_names 应记录本轮工具：${assistant.tool_names.join(",")}`);

    const rows = await citationRowsOf(assistant.id);
    assert.equal(rows.length, entries.length, `citations 表行数应等于 ${entries.length}，实际 ${rows.length}`);
    assert.equal(
      assistant.citations_count,
      rows.length,
      "messages.citations_count 必须与 citations 表对应行数一致（按会话定位，不用全局计数）",
    );
    for (const [i, row] of rows.entries()) {
      const entry = entries[i];
      assert.ok(entry !== undefined);
      assert.equal(row.idx, entry.idx, "快照的 idx 与下发的一致");
      assert.equal(row.doc_title, entry.doc_title);
      assert.equal(row.doc_lang, entry.doc_lang);
      assert.equal(row.page, entry.page);
      assert.equal(row.snippet, entry.snippet);
    }

    // citations 行只挂在助手消息上：按会话反查，用户消息行一条都不许有。
    const { query } = await import("../src/db.ts");
    const misattached = await query(
      `select 1 from citations c join messages m on m.id = c.message_id
        where m.conv_id = $1 and m.role <> 'assistant'`,
      [meta.conv_id],
    );
    assert.equal(misattached.length, 0, "引用不许挂在非助手消息上");
  } finally {
    await app.close();
  }
});

/* ────────────────────────── 第二轮：不串（各自的助手消息、各自的引用） ────────────────────────── */

test("同一会话第二轮：新建助手消息与自己的引用，第一轮的计数不被改写", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    const first = await postChat(app, token, { text: "Wie hoch ist die Garantie?", lang: "de" });
    assert.equal(first.statusCode, 200, `首轮期望 200，实际 ${first.statusCode}：${first.body}`);
    const firstFrames = parseFrames(first.body);
    const convId = (firstFrames[0]?.data as { conv_id: string }).conv_id;
    createdConvs.push(convId);
    const firstEntries = citationEntriesOf(firstFrames);
    assert.ok(firstEntries.length >= 1, "首轮必须带引用");

    const assistantsAfterFirst = await assistantRowsOf(convId);
    assert.equal(assistantsAfterFirst.length, 1);
    const firstAssistantId = assistantsAfterFirst[0]?.id;
    assert.ok(firstAssistantId !== undefined);

    const second = await postChat(app, token, {
      text: "Wie lange dauert die Installation?",
      lang: "de",
      conv_id: convId,
    });
    assert.equal(second.statusCode, 200, `次轮期望 200，实际 ${second.statusCode}：${second.body}`);
    const secondFrames = parseFrames(second.body);
    const secondMeta = secondFrames[0]?.data as { conv_id: string; message_id: number };
    assert.equal(secondMeta.conv_id, convId, "次轮必须复用同一个会话 id");
    const secondEntries = citationEntriesOf(secondFrames);
    assert.ok(secondEntries.length >= 1, "次轮也必须带引用");

    const assistants = await assistantRowsOf(convId);
    assert.equal(assistants.length, 2, `两轮应有两条助手消息，实际 ${assistants.length} 条`);
    const secondAssistant = assistants[1];
    assert.ok(secondAssistant !== undefined);
    assert.notEqual(secondAssistant.id, firstAssistantId, "次轮必须落一条新的助手消息（不覆盖上一轮）");
    assert.equal(secondAssistant.content, answerTextOf(secondFrames));

    // 次轮的引用只挂在次轮的助手消息上。
    const secondRows = await citationRowsOf(secondAssistant.id);
    assert.equal(secondRows.length, secondEntries.length, "次轮 citations 行数应等于次轮下发的条数");
    assert.equal(secondAssistant.citations_count, secondRows.length);

    // 首轮的口径不被第二轮改写（buffer 每轮新建，引用不跨轮累积）。
    const firstAfterSecond = assistants[0];
    assert.ok(firstAfterSecond !== undefined);
    assert.equal(
      firstAfterSecond.citations_count,
      firstEntries.length,
      "第二轮不得改写第一轮的 citations_count",
    );
    const firstRows = await citationRowsOf(firstAssistantId);
    assert.equal(firstRows.length, firstEntries.length, "第一轮的引用行数不变（没有重复插入）");
    assert.deepEqual(
      firstRows.map((row) => row.idx),
      firstEntries.map((entry) => entry.idx),
      "第一轮的引用集合不变（没有串进第二轮的候选）",
    );

    // 两轮的引用行加起来等于各自条数之和：没有漏写，也没有重复写。
    const { query } = await import("../src/db.ts");
    const total = await query<{ n: string }>(
      `select count(*) as n from citations c join messages m on m.id = c.message_id where m.conv_id = $1`,
      [convId],
    );
    assert.equal(
      Number(total[0]?.n ?? -1),
      firstEntries.length + secondEntries.length,
      "会话内引用行数 = 两轮各自条数之和",
    );
  } finally {
    await app.close();
  }
});
