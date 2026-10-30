/**
 * `POST /api/chat` 的故障码快路与连发分支（`05-api.md` §3.2 · `04-agent-chat` #03）。
 *
 * 这里要钉住的是**分流**，不是故障码内容（那是 `tests/fault-lookup.test.ts` 的事）：
 *   ① `E03` 这种整条输入的答复是 `meta` → 一帧 `delta` → `done`，**没有** `tool`、
 *      也**没有** `citations`（故障码没有 chunk 可追溯，前端不该画角标），且 1 秒内出结果；
 *   ② 快路**不装配 Agent 会话** —— 用 `agentReady()` 从 false 到 false 来证明，而不是靠耗时猜；
 *   ③ 只有"整条输入"才是故障码：`E03 Fehlercode` / `E03?` 走正常对话；
 *   ④ 表里没有的码（`E99`）落回正常对话，不是错误；
 *   ⑤ 同一会话连发两条：都出完整事件流，**没有** `error` 帧（连发是"插入"，不是"发送"）。
 *
 * `LLM_PROVIDER=mock`（`06-agent.md` §8）：mock 路径照样真跑检索（dashscope embedding），
 * 所以"走模型路"这一侧的断言只依赖 `tool` 帧（mock 一定会发，空结果也发），不依赖检索命中。
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
// 本文件对 src 的引用一律走动态 import（每个用例内 `await import`），这里才来得及生效。
process.env.LLM_PROVIDER = "mock";
// 池上限抬到 8：本文件只造少量会话，抬高是为了与其余测试文件的池状态互不影响。
process.env.PARALLEL_LIMIT = "8";

const hasRuntimeEnv = Boolean(
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT,
);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

const LOCALES = ["zh", "en", "de", "nl", "es"] as const;
type Locale = (typeof LOCALES)[number];

/** 快路答复末行的**验收口径**：五语各一行（`12-i18n.md` §4 的 `fault.source`）。
 *
 *  这里写死五条字面量，而实现里只有一份真源（`src/static/i18n.json`）：测试钉的是**用户眼前那行字**，
 *  不是实现里那个符号（上一版测试钉的正是 `fastpath.ts` 自己写死的中文常量，于是缺陷被测试保护着）。
 *  改译文时要连着改这里，是刻意的摩擦 —— 用户可见的那行字变了，总该有人确认一次。 */
const SOURCE_LINES: Record<Locale, string> = {
  zh: "来源：故障码表",
  en: "Source: fault code table",
  de: "Quelle: Fehlercodetabelle",
  nl: "Bron: foutcodetabel",
  es: "Fuente: tabla de códigos",
};

/** 汉字范围（与 `tests/i18n-api.test.ts` 同一口径）：用户端答复里出现它，只有一种解释 —— 串了中文。 */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF]/u;

const createdTokens: string[] = [];
const createdConvs: string[] = [];

after(async () => {
  if (!hasRuntimeEnv) return;
  const { pool, query } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");
  const { shutdownSessions } = await import("../src/core/agent.ts");

  // messages / ai_runs / citations 都是 on delete cascade，删会话即可连带清空。
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
  await pool.end().catch(() => undefined);
});

/** 与 tests/chat-stream.test.ts 同一条装配路径：SSE 帧与信封信封都经过线上真实的处理器。 */
async function buildChatApp(): Promise<FastifyInstance> {
  const { buildApp } = await import("../src/server.ts");
  const { registerChatRoutes } = await import("../src/api/chat.ts");
  const app = await buildApp();
  if (!app.hasRoute({ method: "POST", url: "/api/chat" })) await registerChatRoutes(app);
  return app;
}

/** 直接写 Redis 造令牌（理由见 tests/chat-stream.test.ts：`/api/session` 的限流键按 IP 共享）。 */
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

type ChatCall = {
  token: string;
  body: Record<string, unknown>;
  acceptLanguage?: string;
};

async function postChat(app: FastifyInstance, call: ChatCall) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (call.token !== "") headers["x-user-session"] = call.token;
  if (call.acceptLanguage !== undefined) headers["accept-language"] = call.acceptLanguage;
  return app.inject({ method: "POST", url: "/api/chat", headers, payload: call.body });
}

/** 快路帧形状的唯一合法序列：正好三帧，且顺序固定（05 §3.2）。末行文案按语种断言。 */
function assertFastPathFrames(frames: Frame[], label: string, expectedSource: string): string {
  const names = frames.map((frame) => frame.event);
  assert.deepEqual(names, ["meta", "delta", "done"], `${label} 的帧序列必须正好是 meta,delta,done：${names.join(",")}`);
  assert.equal(names.includes("tool"), false, `${label} 不该有 tool 帧（快路没有任何工具调用）`);
  assert.equal(names.includes("citations"), false, `${label} 不该有 citations 帧（故障码没有 chunk）`);

  const delta = frames[1]?.data as { t: string };
  assert.equal(typeof delta.t, "string", `${label} 的 delta.t 必须是字符串`);
  const lines = delta.t.split("\n");
  assert.equal(lines.at(-1), expectedSource, `${label} 的答复末行必须是「${expectedSource}」，实际「${lines.at(-1) ?? ""}」`);
  return delta.t;
}

/* ────────────────────────── 快路主路径 ────────────────────────── */

// 本用例故意排在文件最前：`agentReady()` 只能从"没装配过"开始验证，
// 一旦前面的用例跑过模型路，那个 false 就拿不到了。
test("E03（de）走快路：meta → 一帧 delta → done，末行取 de 的 fault.source，1 秒内，且不装配会话", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { query, one } = await import("../src/db.ts");
  const { agentReady } = await import("../src/core/agent.ts");
  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    // 期望正文从库里按列取，而不是抄 corpus/fault_codes.json：语料改了这里照样对。
    const row = await one<{ desc_de: string }>(
      "select desc_de from fault_codes where code = 'E03' and product_line = 'balcony'",
      [],
    );
    assert.ok(row !== null, "库里必须有 E03/balcony（002_seed.sql 与 ingest 都写过它）");
    const meaning = (row as { desc_de: string }).desc_de.trim();

    const before = agentReady();
    assert.equal(before, false, "本用例必须是本进程里第一个跑对话的用例（否则证明不了「没装配」）");

    const startedAt = performance.now();
    const response = await postChat(app, { token, body: { text: "E03", lang: "de" } });
    const wallMs = performance.now() - startedAt;

    assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body}`);
    const contentType = String(response.headers["content-type"] ?? "");
    assert.ok(contentType.startsWith("text/event-stream"), `content-type 应为 text/event-stream，实际 "${contentType}"`);
    // 05 §8 的三件套：快路与模型路共用同一个开流函数，这里一并钉住。
    assert.equal(response.headers["cache-control"], "no-cache, no-transform");
    assert.equal(response.headers["connection"], "keep-alive");
    assert.equal(response.headers["x-accel-buffering"], "no");

    const frames = parseFrames(response.body);
    const answer = assertFastPathFrames(frames, "E03", SOURCE_LINES.de);
    assert.ok(answer.startsWith(meaning), `答复必须以 desc_de 开头：\n${answer}`);
    assert.ok(answer.split("\n").length >= 2, `答复应有"含义 + 步骤 + 来源行"，实际：\n${answer}`);
    // 这条断言就是缺陷的原始现场：德语页面的结果卡末行曾经是汉字（`docs/output/user-390x844-03-fault-e03.png`）。
    // 它比"末行等于某个常量"更强 —— 它限定的是**整条答复里一个汉字都不能有**。
    assert.equal(CJK_RE.test(answer), false, `德语答复里不该出现汉字：\n${answer}`);

    // 05 §3.2：1 秒内出结果卡。这里量的是整条 HTTP 往返（含鉴权、落库、主键查询）。
    assert.ok(wallMs < 1000, `快路整条请求应在 1000ms 内，实际 ${Math.round(wallMs)}ms`);

    // ④"不建 Agent 会话"：装配是唯一会翻转这个标志的地方（core/agent.ts 的 `createSupportSession`）。
    assert.equal(agentReady(), false, "快路不得装配 AgentSession");

    const meta = frames[0]?.data as { conv_id: string; message_id: number; trace_id: string };
    assert.equal(typeof meta.message_id, "number");
    assert.equal(typeof meta.trace_id, "string");

    // 提问必须留痕（快路跳过的是"答案怎么产生"，不是"提问要记录"）。
    const message = await one<{ conv_id: string; role: string; content: string; lang: string }>(
      "select conv_id, role, content, lang from messages where id = $1",
      [meta.message_id],
    );
    assert.ok(message !== null, "messages 里应有 meta.message_id 对应的行");
    assert.equal(message.role, "user");
    assert.equal(message.content, "E03", "落库的是用户敲的那一行，不是答复");
    assert.equal(message.lang, "de");
    assert.equal(message.conv_id, meta.conv_id);

    // 本实现**不**为快路记 `ai_runs`：那张表记的是"模型花了多少"，快路一次模型调用都没有；
    // 记一条 model=cost 非零的账会让成本报表从此对不上。
    const runs = await query("select 1 from ai_runs where conv_id = $1", [meta.conv_id]);
    assert.equal(runs.length, 0, "快路不得写 ai_runs（没有模型调用就没有账）");

    const done = frames[2]?.data as { latency_ms: number; tokens: number; cost_usd: number };
    assert.equal(done.tokens, 0, "快路 tokens 记 0");
    assert.equal(done.cost_usd, 0, "快路 cost_usd 记 0");
    assert.ok(done.latency_ms >= 0, `latency_ms 不能为负：${done.latency_ms}`);
    assert.ok(done.latency_ms < 1000, `done.latency_ms 也应在 1000ms 内，实际 ${done.latency_ms}`);

    t.diagnostic(
      `E03 帧序列：${frames.map((frame) => frame.event).join(" → ")}；` +
        `整条 HTTP 请求 ${Math.round(wallMs)}ms；主键查询 ${done.latency_ms}ms；答复 ${answer.length} 字符`,
    );

    createdConvs.push(meta.conv_id);
  } finally {
    await app.close();
  }
});

test("小写 e03 也命中（码归一化成大写），并复用已有会话", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { query } = await import("../src/db.ts");
  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    const first = await postChat(app, { token, body: { text: "E03", lang: "de" } });
    assert.equal(first.statusCode, 200, `期望 200，实际 ${first.statusCode}：${first.body}`);
    const convId = (parseFrames(first.body)[0]?.data as { conv_id: string }).conv_id;
    createdConvs.push(convId);

    const second = await postChat(app, { token, body: { text: "e03", lang: "de", conv_id: convId } });
    assert.equal(second.statusCode, 200, `期望 200，实际 ${second.statusCode}：${second.body}`);
    const frames = parseFrames(second.body);
    assertFastPathFrames(frames, "e03", SOURCE_LINES.de);
    const meta = frames[0]?.data as { conv_id: string };
    assert.equal(meta.conv_id, convId, "快路也要复用传进来的 conv_id");

    const messages = await query<{ content: string }>(
      "select content from messages where conv_id = $1 order by id",
      [convId],
    );
    assert.deepEqual(
      messages.map((row) => row.content),
      ["E03", "e03"],
      "两轮提问都要留痕（原文大小写不变）",
    );
  } finally {
    await app.close();
  }
});

/* ────────────────────────── 五语末行（fault.source 那一格） ────────────────────────── */

/**
 * 五语矩阵：同一道 `E03`，五个语种的答复末行各取自己那一格 `fault.source`。
 *
 * 走 `answerFaultCode` 而不是 HTTP：这一格要钉的是"答复文本怎么拼"，帧序列上面已经钉过了；
 * 五条 SSE 会让这个用例慢好几倍，而慢的测试没人愿意跑。数据取自真库（`desc_*` / `act_*` 各列），
 * 所以这条也顺带覆盖"含义与步骤的语言跟着 lang 走"。
 */
test("五语矩阵：末行按语种出，non-zh 的整条答复里没有汉字", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { answerFaultCode } = await import("../src/core/fastpath.ts");
  const lastLines = new Map<Locale, string>();
  for (const lang of LOCALES) {
    const answer = await answerFaultCode({ code: "E03", lang });
    assert.ok(answer !== null, `E03 必须命中（lang=${lang}）`);
    const text = answer.text;
    const last = text.split("\n").at(-1) ?? "";
    assert.equal(last, SOURCE_LINES[lang], `${lang} 的答复末行必须是「${SOURCE_LINES[lang]}」，实际「${last}」`);
    assert.equal(text.includes("fault.source"), false, `${lang} 的答复里露出了 key 原文：\n${text}`);
    if (lang !== "zh") {
      // 缺陷现场：德语页面的末行曾经是「来源：故障码表」。这里限定的是整条答复，不只是末行。
      assert.equal(CJK_RE.test(text), false, `${lang} 的整条答复里不该有汉字：\n${text}`);
    }
    lastLines.set(lang, last);
  }
  // 五条末行必须互不相同：如果实现又退回一个写死的常量，这条会最先红（比逐语断言更早暴露"没读表"）。
  assert.equal(
    new Set(lastLines.values()).size,
    LOCALES.length,
    `五语末行必须各不相同，实际：${[...lastLines.values()].join(" | ")}`,
  );
});

/** 构造一条最小命中：下面两格要钉的是"拼答复"，不该依赖库里的语料内容。 */
const MINIMAL_HIT = {
  found: true as const,
  code: "E03",
  severity: "error",
  meaning: "Bedeutung",
  actions: ["1. Schritt"],
  docLang: "de",
  productLine: "balcony",
};

test("缺 key 的兜底：不输出空行，也不输出 fault.source 原文（宁可少一行）", async () => {
  const { formatFaultReply, FAULT_REPLY_SOURCE_KEY } = await import("../src/core/fastpath.ts");
  const { mergeMessages, t } = await import("../src/core/i18n-table.ts");

  // ① 注入一张"什么都没有"的表（等价于真表里连 en 都缺这一格）：末行整行消失，
  //    答复只剩含义 + 步骤，且**不以空行收尾**（空行会让用户以为答复被截断了）。
  const bare = formatFaultReply(MINIMAL_HIT, "de", () => null);
  assert.equal(bare, "Bedeutung\n1. Schritt", `缺 key 时不该多出任何一行，实际：${JSON.stringify(bare)}`);

  // ② 末行取的必须是 `fault.source` 这一格，并且带回请求的语种（取错 key 就是取了别的说明文字）。
  const asked: string[] = [];
  formatFaultReply(MINIMAL_HIT, "nl", (lang, key) => {
    asked.push(`${lang}:${key}`);
    return null;
  });
  assert.deepEqual(asked, [`nl:${FAULT_REPLY_SOURCE_KEY}`], "末行只能取 fault.source 这一格");

  // ③ 真表里没有的 key：`t()` 给 null，不像下发那样回落成 key 原文。
  assert.equal(t("de", "fault.source.does-not-exist"), null);
  assert.equal(t("de", FAULT_REPLY_SOURCE_KEY), SOURCE_LINES.de, "真表里 de 的那一格就是德语");

  // ④ 对照：下发给前端的表**仍然**以 key 原文兜底（12-i18n.md §2 允许"开发期可见"）。
  //    两条兜底策略不同是刻意的 —— 这一行把差别钉住，免得以后有人把 t() 改成同一套。
  const minimal = { zh: { "fault.source": "来源：故障码表" }, en: {} };
  assert.equal(mergeMessages(minimal, "de")["fault.source"], "fault.source");
});

test("真源只有一份：fastpath 的代码里没有中文字符串（注释不算）", async () => {
  // 全文件唯一一条源码断言（其余都是行为断言）：它守的就是"别再长出一份硬编码中文"这件事本身，
  // 而行为断言抓不到"在别处又抄一份"的情形。注释必须先剥掉 —— 本仓注释是中文写的，
  // 直接搜汉字会把整份文件都算命中。
  const raw = await readFile(join(repoRoot, "src", "core", "fastpath.ts"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const cjkLiterals = code.match(/"[^"\n]*[\u4e00-\u9fff][^"\n]*"/g) ?? [];
  assert.deepEqual(
    cjkLiterals,
    [],
    `fastpath 的字符串里还有硬编码中文：${cjkLiterals.join(", ")}（真源是 src/static/i18n.json）`,
  );
});

test("E123（3 位数字）判形命中；表里没有这个码时落回正常对话", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { matchFaultCode } = await import("../src/core/fastpath.ts");
  const { one } = await import("../src/db.ts");

  // 判形：`^[A-Za-z]\d{2,3}$` —— 3 位数字必须放行（05 §3.2 的写法就是 2~3 位）。
  assert.equal(matchFaultCode("E123"), "E123");
  assert.equal(matchFaultCode(" e123 "), "E123", "首尾空白要被 trim 掉");

  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    // 语料里 6 条故障码全是 1 字母 + 2 位数字，E123 **不在**表里 ——
    // 所以 HTTP 层能证明的是"判形命中但查表未命中 → 落回模型"，而不是"3 位码也能查到"。
    // 不为了造这一条命中往 fault_codes 里插临时行：`tests/schema.test.ts` 断言的是表的精确行数，
    // 插一行就可能让另一个文件红（而且那条断言本身是合理的）。
    assert.equal(await one("select 1 from fault_codes where code = 'E123'"), null, "前提：E123 不在表里");

    const response = await postChat(app, { token, body: { text: "E123", lang: "de" } });
    assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body}`);
    const frames = parseFrames(response.body);
    const names = frames.map((frame) => frame.event);
    assert.equal(names[0], "meta", `首帧必须是 meta：${names.join(",")}`);
    assert.equal(names.at(-1), "done", `末帧必须是 done：${names.join(",")}`);
    assert.equal(names.includes("error"), false, `未命中不是错误：${names.join(",")}`);
    assert.ok(
      frames.some((frame) => frame.event === "tool" && (frame.data as { name: string }).name === "kb_search"),
      `落回模型路会跑 kb_search（mock 也跑）：${names.join(",")}`,
    );
    createdConvs.push((frames[0]?.data as { conv_id: string }).conv_id);
  } finally {
    await app.close();
  }
});

/* ────────────────────────── 判形的边界 ────────────────────────── */

test("E03 Fehlercode 与 E03? **不**走快路：整条输入才算故障码", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    for (const text of ["E03 Fehlercode", "E03?"]) {
      const response = await postChat(app, { token, body: { text, lang: "de" } });
      assert.equal(response.statusCode, 200, `「${text}」期望 200，实际 ${response.statusCode}：${response.body}`);
      const frames = parseFrames(response.body);
      const names = frames.map((frame) => frame.event);
      assert.equal(names[0], "meta", `「${text}」首帧必须是 meta：${names.join(",")}`);
      assert.equal(names.at(-1), "done", `「${text}」末帧必须是 done：${names.join(",")}`);
      // 05#01 之后模型路会发 citations（引用校验在收尾流程里），所以这里**不再**断言它的缺席；
      // 快路与模型路的判据仍然是下一行那个 kb_search 工具帧。
      // 判据是"跑过工具"：快路**永远**不发 tool 帧，模型路**一定**发 kb_search（mock 空结果也发）。
      assert.ok(
        frames.some((frame) => frame.event === "tool" && (frame.data as { name: string }).name === "kb_search"),
        `「${text}」应落回模型路（有 kb_search 的 tool 帧）：${names.join(",")}`,
      );
      createdConvs.push((frames[0]?.data as { conv_id: string }).conv_id);
    }
  } finally {
    await app.close();
  }
});

test("表里没有的 E99 落回正常对话：不是 error，且以 done 收尾", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { one } = await import("../src/db.ts");
  assert.equal(await one("select 1 from fault_codes where code = 'E99'"), null, "前提：E99 不在表里");

  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    const response = await postChat(app, { token, body: { text: "E99", lang: "en" } });
    assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body}`);
    const frames = parseFrames(response.body);
    const names = frames.map((frame) => frame.event);
    assert.equal(names[0], "meta", `首帧必须是 meta：${names.join(",")}`);
    assert.equal(names.at(-1), "done", `末帧必须是 done：${names.join(",")}`);
    assert.equal(names.includes("error"), false, `未命中不是错误：${names.join(",")}`);
    assert.ok(
      frames.some((frame) => frame.event === "tool"),
      `落回模型路会跑工具：${names.join(",")}`,
    );
    // delta 的条数取决于检索是否过 0.30 阈值（mock 正文来自首条候选），
    // 所以这里只断言"不是快路那三帧"，不断言 delta 数量 —— 那会变成对 embedding 服务的断言。
    const isFastPathShape = names.length === 3 && names[1] === "delta";
    assert.equal(isFastPathShape, false, `E99 不该走快路：${names.join(",")}`);
    createdConvs.push((frames[0]?.data as { conv_id: string }).conv_id);
  } finally {
    await app.close();
  }
});

/* ────────────────────────── 连发（插入而不是发送） ────────────────────────── */

test("同一会话连发两条：都拿到完整事件流，且都没有 error 帧", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { query } = await import("../src/db.ts");
  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    const first = await postChat(app, { token, body: { text: "Wie hoch ist die Garantie?", lang: "de" } });
    assert.equal(first.statusCode, 200, `首轮期望 200，实际 ${first.statusCode}：${first.body}`);
    const convId = (parseFrames(first.body)[0]?.data as { conv_id: string }).conv_id;
    createdConvs.push(convId);

    // 同时在途的两条：第二条落在**已有**会话上，正是"流式过程中又发一条"的那条路。
    // mock 模式跑得太快，两条未必真的重叠；但断言与重叠无关 —— 契约是"同会话的第二条
    // 由 `runTurn` 的轮次闸门排队，永远不产生 error 帧"，而这个断言对重叠/串行都成立。
    const [a, b] = await Promise.all([
      postChat(app, { token, body: { text: "Und die Anmeldung?", lang: "de", conv_id: convId } }),
      postChat(app, { token, body: { text: "Wie lange dauert die Lieferung?", lang: "de", conv_id: convId } }),
    ]);

    for (const [label, response] of [
      ["A", a],
      ["B", b],
    ] as const) {
      assert.equal(response.statusCode, 200, `连发 ${label} 期望 200，实际 ${response.statusCode}：${response.body}`);
      const names = parseFrames(response.body).map((frame) => frame.event);
      assert.equal(names[0], "meta", `连发 ${label} 首帧必须是 meta：${names.join(",")}`);
      assert.equal(names.at(-1), "done", `连发 ${label} 末帧必须是 done：${names.join(",")}`);
      assert.equal(
        names.includes("error"),
        false,
        `连发 ${label} 不得出现 error 帧（"插入"不是"发送"）：${names.join(",")}`,
      );
      assert.equal(
        (parseFrames(response.body)[0]?.data as { conv_id: string }).conv_id,
        convId,
        `连发 ${label} 应落在同一个会话上`,
      );
    }

    // 只看用户消息行：05#01 之后每个模型路轮次都会再落一条助手消息（引用挂在它上面），
    // 所以"提问都要留痕"必须按 role 定位，不能数整个会话的消息行。
    const messages = await query<{ content: string }>(
      "select content from messages where conv_id = $1 and role = 'user' order by id",
      [convId],
    );
    assert.equal(messages.length, 3, `三条提问都要留痕，实际 ${messages.length} 条`);
  } finally {
    await app.close();
  }
});

test("shouldEmitErrorFrame：同会话的 SESSION_BUSY 只是排队，其余错误照发", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { shouldEmitErrorFrame } = await import("../src/api/chat.ts");

  // 同会话（用户在流式过程中又发了一条）：忙 = 排队，绝不能画成红字。
  assert.equal(shouldEmitErrorFrame("SESSION_BUSY", true), false);
  // 不同会话：真的容量不足。开流前那条路已经是 503（`statusForTurnError`），
  // 开流后还遇到就说明是事故，照发。
  assert.equal(shouldEmitErrorFrame("SESSION_BUSY", false), true);
  // 其余错误码与"同不同会话"无关，一律发。
  for (const code of ["LLM_TIMEOUT", "LLM_ERROR", "LLM_UNAVAILABLE", "EMBED_UNAVAILABLE", "INTERNAL"]) {
    assert.equal(shouldEmitErrorFrame(code, true), true, `${code} 必须发 error 帧`);
    assert.equal(shouldEmitErrorFrame(code, false), true, `${code} 必须发 error 帧`);
  }
});

test("正常对话响应也带禁缓存 / keep-alive / 关缓冲三件套", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const token = await newSessionToken();
  const app = await buildChatApp();
  try {
    const response = await postChat(app, { token, body: { text: "Wie hoch ist die Garantie?", lang: "de" } });
    assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body}`);
    assert.equal(response.headers["cache-control"], "no-cache, no-transform");
    assert.equal(response.headers["connection"], "keep-alive");
    assert.equal(response.headers["x-accel-buffering"], "no");
    createdConvs.push((parseFrames(response.body)[0]?.data as { conv_id: string }).conv_id);
  } finally {
    await app.close();
  }
});
