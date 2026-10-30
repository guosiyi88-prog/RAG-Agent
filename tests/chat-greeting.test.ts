/**
 * 寒暄前置的端到端断言（R1-1）：一句招呼不该检索、不该调模型、更不该建单。
 *
 * 为什么值得一个文件：这是开工前实测到的第一条真问题 —— 检索阈值 0.30 对"你好"必然打不中，
 * 于是走拒答四步，**每句招呼 +1 张工单**（当时库里 138 张工单、22 张是这类）。
 * 所以这里钉的不是"答得好看"，而是三件可观测的事：
 *   ① 帧序列 = `meta` → **一帧** `delta` → `done`（没有 `tool`、没有 `citations`、没有 `refusal`）；
 *   ② 工单数**不变**（`tickets` 计数前后一致）；
 *   ③ 不走模型（`agentReady()` 保持 false 就是证据，不靠耗时猜）。
 *
 * `LLM_PROVIDER=mock`（`06-agent.md` §8）：对照组（"你好，请问保修多久？"）要走模型路，
 * mock 路径照样真跑检索，所以对照组只断言"不是寒暄话术"。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 tests/chat-fastpath.test.ts 同一套 .env 解析（行内 `#` 之后是注释、成对引号去掉）。 */
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
process.env.LLM_PROVIDER = "mock";
process.env.PARALLEL_LIMIT = "8";

const hasRuntimeEnv = Boolean(
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT,
);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

const createdTokens: string[] = [];
const createdConvs: string[] = [];

after(async () => {
  if (!hasRuntimeEnv) return;
  const { pool, query } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");
  const { shutdownSessions } = await import("../src/core/agent.ts");
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

async function buildChatApp(): Promise<FastifyInstance> {
  const { buildApp } = await import("../src/server.ts");
  const { registerChatRoutes } = await import("../src/api/chat.ts");
  const app = await buildApp();
  if (!app.hasRoute({ method: "POST", url: "/api/chat" })) await registerChatRoutes(app);
  return app;
}

async function newSessionToken(): Promise<string> {
  const token = randomUUID();
  const { redis } = await import("../src/redis.ts");
  await redis.setex(`sess:${token}`, 600, "1");
  createdTokens.push(token);
  return token;
}

type Frame = { event: string; data: unknown };

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

/** `delta` 拼起来就是用户读到的正文（寒暄路径只有一帧，允许点号拼接）。 */
function textOf(frames: Frame[]): string {
  return frames
    .filter((frame) => frame.event === "delta")
    .map((frame) => (frame.data as { t?: string }).t ?? "")
    .join("");
}

test("寒暄：五语招呼都是一帧 delta，不建单、不走模型、不发 refusal/citations", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { one } = await import("../src/db.ts");
  const { agentReady } = await import("../src/core/agent.ts");
  const app = await buildChatApp();
  try {
    const before = await one<{ n: number }>("select count(*)::int as n from tickets");
    // 五语各来一句，顺带覆盖"界面语言与招呼语言不一致"的情况（`lang` 只是兜底）。
    const cases: { text: string; lang: string; mustInclude: RegExp }[] = [
      { text: "你好", lang: "zh", mustInclude: /转人工/ },
      { text: "Hello", lang: "en", mustInclude: /fault code/i },
      { text: "Hallo", lang: "de", mustInclude: /Fehlercode/ },
      { text: "Goedendag", lang: "nl", mustInclude: /foutcode/ },
      { text: "Hola", lang: "es", mustInclude: /código de fallo/i },
    ];

    for (const item of cases) {
      const token = await newSessionToken();
      const response = await postChat(app, token, { text: item.text, lang: item.lang });
      assert.equal(response.statusCode, 200, `"${item.text}" 期望 200：${response.body.slice(0, 200)}`);
      const frames = parseFrames(response.body);
      const names = frames.map((frame) => frame.event);
      createdConvs.push((frames[0]?.data as { conv_id: string }).conv_id);

      assert.deepEqual(names, ["meta", "delta", "done"], `"${item.text}" 的帧序列必须正好三帧，实际 ${names.join(",")}`);
      assert.ok(item.mustInclude.test(textOf(frames)), `"${item.text}" 的话术应包含 ${item.mustInclude}`);
      // 话术是常量表：五语之间不同，同一语稳定。
      assert.ok(!/NO_ANSWER/.test(textOf(frames)), "寒暄不该出现 NO_ANSWER");
    }

    const afterCount = await one<{ n: number }>("select count(*)::int as n from tickets");
    assert.equal(afterCount?.n, before?.n, `寒暄不许建单：${before?.n} → ${afterCount?.n}`);
    // 快路/寒暄都不装配会话：`agentReady()` 只认"本进程至少成功装配过一次 AgentSession"。
    assert.equal(agentReady(), false, "寒暄路径不该装配 Agent 会话");
  } finally {
    await app.close();
  }
});

test("寒暄只认整句：带实体的问句落回模型路（拿到 tool 帧），不被话术吃掉", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const app = await buildChatApp();
  try {
    const token = await newSessionToken();
    const response = await postChat(app, token, { text: "你好，请问保修多久？", lang: "zh" });
    assert.equal(response.statusCode, 200, `期望 200：${response.body.slice(0, 200)}`);
    const frames = parseFrames(response.body);
    const names = frames.map((frame) => frame.event);
    createdConvs.push((frames[0]?.data as { conv_id: string }).conv_id);

    assert.ok(names.includes("tool"), `带实体的问句必须走模型路（有 tool 帧），实际帧：${names.join(",")}`);
    // 反向断言：这一轮**不能**是寒暄话术（否则用户的问题被"我能做三件事"吃掉）。
    assert.ok(!/转人工|fault code|Fehlercode|foutcode|código de fallo/i.test(textOf(frames)), "带实体的问句不该收到寒暄话术");
  } finally {
    await app.close();
  }
});
