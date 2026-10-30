/**
 * 引用快照落库的黑盒验收（`05-refusal-and-tickets` #01 · 05 §4 / §5.5）。
 *
 * 这一层要证明的是三件"接错线也不报错、只会在历史回放里出怪事"的性质：
 *   1. **快照是真的落下来了**（序号 / 文档名 / 语言 / 页码 / 原文 / 分数逐列对得上），
 *      且 `messages.citations_count` 与引用表行数一致 —— 前端按计数画角标，两个数不一致
 *      就是"角标有、点开是空的"或者"引用在、没人看得见"；
 *   2. **可重复执行**（先删后插 + 同一事务）：收尾步骤会被 SSE 重连重放，
 *      追加写会让同一条消息攒出两份快照、角标列表重复一遍；
 *   3. **写错的 id 是 400 不是 500**：调用方是本进程，id 错是 bug，400 在日志里一眼认得出。
 *
 * 只注册本卡这一条路由，不 import `src/routes.ts`：本文件要能在别的路由半成品时独立变绿或变红。
 * 会话与消息由本文件自己造、自己删（`citations` 随消息级联删除）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Citation } from "../src/core/citations.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 tests/ticket-internal.test.ts 同一套 .env 解析：`node --test` 不带 --env-file，得自己补。 */
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
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT && process.env.INTERNAL_TOKEN,
);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串 / INTERNAL_TOKEN）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

const internalToken = String(process.env.INTERNAL_TOKEN ?? "").trim();

const CITATIONS_URL = "/internal/citations";

/** 本文件造出来的父行：清理只删自己建的，绝不按 role/时间批量删（那是删别人数据）。 */
const createdConvIds: string[] = [];
const createdMessageIds: number[] = [];

let app: FastifyInstance;

before(async () => {
  if (!hasRuntimeEnv) return;
  const [{ default: Fastify }, { registerInternalCitationRoutes }, { toErrorBody }] = await Promise.all([
    import("fastify"),
    import("../src/api/internal-citations.ts"),
    import("../src/errors.ts"),
  ]);

  // 与 `src/server.ts` 同两段处理器：错误体形状与 404 文案必须一致，否则"错令牌 → 404 与
  // 路径不存在不可区分"这条安全性质在本文件里就成了自说自话。
  app = Fastify({ logger: false });
  app.setErrorHandler((err, request, reply) => {
    const { status, body } = toErrorBody(err, String(request.id));
    return reply.code(status).send(body);
  });
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ ok: false, error: { code: "NOT_FOUND", message: "Not found", trace_id: String(request.id) } }),
  );
  await registerInternalCitationRoutes(app);
  await app.ready();
});

after(async () => {
  if (!hasRuntimeEnv) return;
  const { pool, query } = await import("../src/db.ts");
  if (app !== undefined) await app.close();
  if (createdMessageIds.length > 0) {
    // 引用行随消息级联删除（`citations.message_id references messages(id) on delete cascade`），
    // 但真删一次也不亏：级联若被将来改坏，这里能顺手暴露出来。
    await query("delete from messages where id = any($1::bigint[])", [createdMessageIds]);
  }
  if (createdConvIds.length > 0) {
    await query("delete from conversations where id = any($1::uuid[])", [createdConvIds]);
  }
  const { redis } = await import("../src/redis.ts");
  await redis.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

/* ─────────────────────────── 造数据 ─────────────────────────── */

/** 造一条 assistant 消息（引用只挂在 assistant 消息上，05 §2），并登记到清理名单。 */
async function createAssistantMessage(): Promise<{ convId: string; messageId: number }> {
  const { one } = await import("../src/db.ts");
  const convId = randomUUID();
  const conv = await one<{ id: string }>(
    "insert into conversations (id, channel, lang) values ($1::uuid, 'web', 'de') returning id",
    [convId],
  );
  assert.ok(conv !== null, "会话没建出来");
  createdConvIds.push(convId);

  const row = await one<{ id: string }>(
    `insert into messages (conv_id, role, content, lang)
     values ($1::uuid, 'assistant', 'Laut Anleitung [1] und [2].', 'de')
     returning id`,
    [convId],
  );
  assert.ok(row !== null, "消息没建出来");
  const messageId = Number(row.id);
  createdMessageIds.push(messageId);
  return { convId, messageId };
}

/** 一条形状合法的引用快照；只覆盖需要变化的部分。 */
function citation(overrides: Partial<Citation> = {}): Citation {
  return {
    idx: 1,
    chunk_id: null,
    doc_title: "Montageanleitung WT-6000",
    doc_lang: "de",
    page: 12,
    snippet: "Der Wechselrichter muss geerdet werden.",
    score: 0.83,
    ...overrides,
  };
}

/* ─────────────────────────── HTTP 助手 ─────────────────────────── */

type SuccessBody<T> = { ok: true; data: T };
type ErrorBody = { ok: false; error: { code: string; message: string; trace_id?: string } };

type InjectOptions = {
  /** `null` = 不带该请求头；省略 = 带正确令牌。 */
  token?: string | null;
  /** light-my-request 的假 socket 地址；省略即 127.0.0.1。 */
  remoteAddress?: string;
};

async function post(
  url: string,
  payload: unknown,
  options: InjectOptions = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (options.token !== null) headers["x-internal-token"] = options.token ?? internalToken;
  const response = await app.inject({
    method: "POST",
    url,
    payload: payload as Record<string, unknown>,
    headers,
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
  });
  return { status: response.statusCode, body: response.json() };
}

/** 走 HTTP 写快照并断言 200，返回 `inserted`（路由层的唯一成功形状）。 */
async function save(messageId: number, citations: Citation[]): Promise<number> {
  const { status, body } = await post(CITATIONS_URL, { message_id: messageId, citations });
  assert.equal(status, 200, `期望 200，实际 ${status}：${JSON.stringify(body)}`);
  const ok = body as SuccessBody<{ inserted: number }>;
  assert.equal(ok.ok, true, "响应体缺少 ok:true");
  return ok.data.inserted;
}

type CitationRow = {
  idx: number;
  chunk_id: string | null;
  doc_title: string | null;
  doc_lang: string | null;
  page: number | null;
  snippet: string | null;
  score: number | null;
};

async function rowsOf(messageId: number): Promise<CitationRow[]> {
  const { query } = await import("../src/db.ts");
  return query<CitationRow>(
    `select idx, chunk_id, doc_title, doc_lang, page, snippet, score
       from citations
      where message_id = $1::bigint
      order by idx`,
    [messageId],
  );
}

async function countOf(messageId: number): Promise<number> {
  const { one } = await import("../src/db.ts");
  const row = await one<{ citations_count: number }>(
    "select citations_count from messages where id = $1::bigint",
    [messageId],
  );
  assert.ok(row !== null, `消息 ${messageId} 不见了`);
  return Number(row.citations_count);
}

/* ─────────────────────────── 落库 ─────────────────────────── */

test("落库 3 条：inserted=3、六列快照逐列对得上、messages.citations_count 回填为 3", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { one } = await import("../src/db.ts");
  const { messageId } = await createAssistantMessage();

  // 真片段（语料已灌入时才有）：用来证明 chunk_id 不是被无脑写成 null。
  // 没有语料时退化为 null，本文件不该因为"没灌语料"变红 —— 那是另一张卡的门槛。
  const chunk = await one<{ id: string }>("select id from chunks order by id limit 1");
  const chunkId = chunk === null ? null : Number(chunk.id);

  const payload: Citation[] = [
    citation({ idx: 1, chunk_id: chunkId, page: 12, score: 0.83 }),
    citation({ idx: 2, doc_title: "Garantiebedingungen", doc_lang: "de", page: 4, score: 0.61 }),
    citation({ idx: 3, doc_title: "Installation Guide", doc_lang: "en", page: null, score: 0.5 }),
  ];

  assert.equal(await save(messageId, payload), 3, "inserted 必须等于写入条数");

  const rows = await rowsOf(messageId);
  assert.equal(rows.length, 3, `引用表应有 3 行，实际 ${rows.length}`);
  assert.deepEqual(
    rows.map((row) => row.idx),
    [1, 2, 3],
    "idx 必须原样落库（5.5 的入参就是这么给的）",
  );

  const [first, second, third] = rows as [CitationRow, CitationRow, CitationRow];
  assert.equal(first.doc_title, "Montageanleitung WT-6000");
  assert.equal(first.doc_lang, "de");
  assert.equal(first.page, 12);
  assert.equal(first.snippet, "Der Wechselrichter muss geerdet werden.");
  // `score` 是 `real`（单精度）：JS 的 0.83 存进去再读出来不会逐位相同，只能按容差比。
  assert.ok(Math.abs(Number(first.score) - 0.83) < 1e-4, `score 落库值不对：${first.score}`);
  if (chunkId !== null) {
    assert.equal(Number(first.chunk_id), chunkId, "chunk_id 应原样落库");
  }

  assert.equal(second.doc_title, "Garantiebedingungen");
  assert.equal(second.page, 4);
  assert.equal(third.doc_lang, "en");
  assert.equal(third.page, null, "page 传 null 就该落 null（不是 0）");

  // 计数与行数一致：前端按计数画角标，两个数不一致就是这一卡要防的 bug（05 §4）。
  assert.equal(await countOf(messageId), 3, "citations_count 应回填为 3");
});

test("可重复执行：同一条消息再写 1 条 → 只剩 1 行、计数回到 1（不追加、不翻倍）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { messageId } = await createAssistantMessage();

  assert.equal(await save(messageId, [citation({ idx: 1 }), citation({ idx: 2 }), citation({ idx: 3 })]), 3);
  assert.equal(await countOf(messageId), 3);

  // 收尾步骤被 SSE 重连重放时的真实形状：同一条消息、更少的引用（模型重新生成过回答）。
  // 只追加的话这里会剩 4 行、计数 4、角标列表重复一遍 —— 快照变成了两份。
  assert.equal(await save(messageId, [citation({ idx: 1, doc_title: "Ersatzteilliste", page: 7 })]), 1);

  const rows = await rowsOf(messageId);
  assert.equal(rows.length, 1, `重写后应只剩 1 行，实际 ${rows.length} 行`);
  assert.equal(rows[0]?.idx, 1);
  assert.equal(rows[0]?.doc_title, "Ersatzteilliste", "留下的必须是新快照，不是旧的");
  assert.equal(rows[0]?.page, 7);
  assert.equal(await countOf(messageId), 1, "计数必须跟着新快照回到 1");

  // 再重放一次同样的内容：幂等（行数不变、计数不变）。
  assert.equal(await save(messageId, [citation({ idx: 1, doc_title: "Ersatzteilliste", page: 7 })]), 1);
  assert.equal((await rowsOf(messageId)).length, 1, "同一份快照重放两次仍应只有 1 行");
  assert.equal(await countOf(messageId), 1);
});

test("空数组：删掉旧快照、计数归零、inserted=0 且不报错", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { messageId } = await createAssistantMessage();

  assert.equal(await save(messageId, [citation({ idx: 1 }), citation({ idx: 2 })]), 2);
  assert.equal(await save(messageId, []), 0, "空数组是合法输入，inserted 为 0 而不是报错");

  assert.equal((await rowsOf(messageId)).length, 0, "旧的引用行必须被删掉（计数归零不能只改数）");
  assert.equal(await countOf(messageId), 0, "citations_count 必须归零");
});

test("chunk_id 指向已不存在的片段：快照照写，chunk_id 落成 null（快照不依赖片段存活）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { messageId } = await createAssistantMessage();

  // 灌语料是"先删后建"，检索之后、收尾之前撞上重索引就会是这个形状。
  // 若放任外键抛 23503，整批快照会变成 500，用户看到一条本该有角标的回答没有引用。
  const inserted = await save(messageId, [citation({ idx: 1, chunk_id: 9_999_999_999, page: 3 })]);
  assert.equal(inserted, 1, "片段没了也要把快照写下来");

  const rows = await rowsOf(messageId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.chunk_id, null, "对不上的 chunk_id 必须落成 null，其余快照字段保留");
  assert.equal(rows[0]?.page, 3);
  assert.equal(await countOf(messageId), 1);
});

/* ─────────────────────────── 校验 ─────────────────────────── */

test("校验：citations 最多 20 条（20 放行，21 回 400）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { messageId } = await createAssistantMessage();

  const twenty = Array.from({ length: 20 }, (_, index) => citation({ idx: index + 1 }));
  assert.equal(await save(messageId, twenty), 20, "上界 20 必须放行（门槛写成 > 还是 >= 只有这条能发现）");

  const twentyOne = Array.from({ length: 21 }, (_, index) => citation({ idx: index + 1 }));
  const { status, body } = await post(CITATIONS_URL, { message_id: messageId, citations: twentyOne });
  assert.equal(status, 400, `21 条期望 400，实际 ${status}：${JSON.stringify(body)}`);
  assert.equal((body as ErrorBody).error.code, "VALIDATION");
});

test("校验：形状不合法的 body 一律 400 VALIDATION（不是 500，也不是静默修正）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { messageId } = await createAssistantMessage();
  const good = citation();

  const cases: { name: string; payload: unknown }[] = [
    { name: "citations 不是数组", payload: { message_id: messageId, citations: "x" } },
    { name: "citations 缺失", payload: { message_id: messageId } },
    { name: "idx=0（角标从 1 起）", payload: { message_id: messageId, citations: [{ ...good, idx: 0 }] } },
    { name: "idx 是字符串", payload: { message_id: messageId, citations: [{ ...good, idx: "1" }] } },
    { name: "缺 doc_lang", payload: { message_id: messageId, citations: [{ ...omit(good, "doc_lang") }] } },
    { name: "doc_lang 越域", payload: { message_id: messageId, citations: [{ ...good, doc_lang: "fr" }] } },
    { name: "snippet 不是字符串", payload: { message_id: messageId, citations: [{ ...good, snippet: 42 }] } },
    { name: "score 是字符串", payload: { message_id: messageId, citations: [{ ...good, score: "0.8" }] } },
    { name: "score 是 NaN（JSON 里只能是字符串/null）", payload: { message_id: messageId, citations: [{ ...good, score: null }] } },
    { name: "page 缺失（没有就给 null）", payload: { message_id: messageId, citations: [{ ...omit(good, "page") }] } },
    { name: "chunk_id 是 0", payload: { message_id: messageId, citations: [{ ...good, chunk_id: 0 }] } },
    { name: "message_id 缺失", payload: { citations: [good] } },
    { name: "message_id=0", payload: { message_id: 0, citations: [good] } },
    { name: "message_id 是字符串", payload: { message_id: String(messageId), citations: [good] } },
    { name: "body 是数组", payload: [] },
  ];

  for (const item of cases) {
    const { status, body } = await post(CITATIONS_URL, item.payload);
    assert.equal(status, 400, `${item.name} 期望 400，实际 ${status}：${JSON.stringify(body)}`);
    assert.equal((body as ErrorBody).error.code, "VALIDATION", `${item.name} 的错误码不对：${JSON.stringify(body)}`);
  }

  // 全部被拦下：库里不能留下任何引用行，计数也不能被改。
  assert.equal((await rowsOf(messageId)).length, 0, "被 400 拦下的请求不应写入任何引用行");
  assert.equal(await countOf(messageId), 0, "被 400 拦下的请求不应改动计数");
});

test("message_id 不存在：400 VALIDATION，不是外键翻出来的 500", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  // 序列远够不到的大数：形状合法、库里没有。调用方是本进程，给错 id 是 bug，
  // 400 在日志里一眼认得出；500 只会被当成数据库故障。
  const { status, body } = await post(CITATIONS_URL, {
    message_id: 9_000_000_000_000,
    citations: [citation({ idx: 1 })],
  });
  assert.equal(status, 400, `不存在的 message_id 期望 400，实际 ${status}：${JSON.stringify(body)}`);
  assert.equal((body as ErrorBody).error.code, "VALIDATION");
});

/* ─────────────────────────── 两道门 ─────────────────────────── */

/** 404 只允许 trace_id 不同：去掉它再逐字比较。 */
function withoutTraceId(body: unknown): unknown {
  const parsed = body as ErrorBody;
  return { ok: parsed.ok, error: { code: parsed.error.code, message: parsed.error.message } };
}

test("错令牌 / 非回环来源：与「路径不存在」逐字一致的通用 404，且不写库", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { messageId } = await createAssistantMessage();
  const payload = { message_id: messageId, citations: [citation({ idx: 1 })] };

  // 基准：真实不存在的路径。两道门失败必须与它不可区分（401 等于承认端点存在）。
  const baseline = await post("/internal/does-not-exist", {});
  assert.equal(baseline.status, 404);
  const baselineShape = withoutTraceId(baseline.body);
  assert.deepEqual(baselineShape, {
    ok: false,
    error: { code: "NOT_FOUND", message: "Not found" },
  });

  const attempts = [
    await post(CITATIONS_URL, payload, { token: "wrong-token" }),
    await post(CITATIONS_URL, payload, { token: null }),
    await post(CITATIONS_URL, payload, { remoteAddress: "10.1.2.3" }),
  ];
  for (const [index, attempt] of attempts.entries()) {
    assert.equal(attempt.status, 404, `第 ${index} 个越门请求期望 404，实际 ${attempt.status}`);
    assert.deepEqual(
      withoutTraceId(attempt.body),
      baselineShape,
      `第 ${index} 个越门请求的响应体与「路径不存在」不一致：${JSON.stringify(attempt.body)}`,
    );
  }

  // 门没开成功的请求不能写进任何东西。
  assert.equal((await rowsOf(messageId)).length, 0, "被 404 拦下的请求不应写入引用行");
  assert.equal(await countOf(messageId), 0, "被 404 拦下的请求不应改动计数");
});

/** 去掉某个字段（模拟"忘了带"），用于校验用例。 */
function omit(source: Citation, key: keyof Citation): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  delete copy[key];
  return copy;
}
