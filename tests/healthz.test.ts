import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 按 Node 自己那套 --env-file 语义解析：行内 `#` 之后是注释、成对引号去掉。
 * 规则一致，测试里传给子进程的环境才和 `node --env-file=.env` 等价。
 */
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

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function spawnServer(env: NodeJS.ProcessEnv): { child: ChildProcess; stderr: () => string } {
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout?.resume();
  return { child, stderr: () => stderr };
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("子进程未在限定时间内退出")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealthz(port: number, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`/healthz 在 ${timeoutMs}ms 内不可达：${String(lastError)}`);
}

after(async () => {
  if (!hasRuntimeEnv) return;
  const { pool } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");
  await redis.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

test("缺关键 env 时进程退出码 1，stderr 指名缺的那一项", async (t) => {
  // 每次只删一项：断言的是"指名"，一次删多项时无法归因是哪个原因带出来的。
  // `ADMIN_TOKEN` 不在这张清单里（`09#03` 已退场，见下一条用例）。
  for (const name of ["INTERNAL_TOKEN", "DATABASE_URL", "REDIS_URL", "S3_ACCESS_KEY", "S3_BUCKET"]) {
    await t.test(`缺 ${name}`, async () => {
      const { child, stderr } = spawnServer(baseEnv({ [name]: undefined }));
      const code = await waitExit(child, 15_000);
      assert.equal(code, 1, `期望退出码 1，实际 ${code}；stderr=${stderr()}`);
      assert.match(stderr(), new RegExp(name), `stderr 应指名 ${name}，实际：${stderr()}`);
    });
  }
});

/**
 * `ADMIN_TOKEN` 退场的可执行证据（`09#03` / boundary-change-R2 §3 B5）。
 *
 * 只加载 `config.ts`（零副作用的唯一读 env 文件），不真起服务：这条断言要证明的是
 * "缺 `ADMIN_TOKEN` 不再挡启动"，而不是"服务能跑"（后者由本文件其余用例覆盖）。
 * 起真进程的话，`PORT` 冲突与 3 秒装配会让一条本该毫秒级的环境断言变成慢且脆的用例。
 */
test("ADMIN_TOKEN 已退场：缺它时 config 照常加载（不再是必需项）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const configUrl = pathToFileURL(join(repoRoot, "src/config.ts")).href;
  const script =
    `import(${JSON.stringify(configUrl)}).then(() => process.exit(0), (err) => { console.error(err); process.exit(3); });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: baseEnv({ ADMIN_TOKEN: undefined }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout?.resume();
  const code = await waitExit(child, 20_000);
  assert.equal(code, 0, `缺 ADMIN_TOKEN 时 config 仍应加载成功，实际退出码 ${code}；stderr=${stderr}`);
});

test("DATABASE_URL 连不上时启动被挡住：退出码 1，不进入 listen", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const port = await freePort();
  const { child, stderr } = spawnServer(
    baseEnv({ DATABASE_URL: "postgresql://wt:wrong@127.0.0.1:1/wt_dev", PORT: String(port) }),
  );
  const code = await waitExit(child, 20_000);
  assert.equal(code, 1, `期望退出码 1，实际 ${code}；stderr=${stderr()}`);
  assert.match(stderr(), /PostgreSQL 探活/, `stderr 应指出失败的启动步骤，实际：${stderr()}`);
});

test("REDIS_URL 缺密码（NOAUTH）时启动被挡住：退出码 1", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const port = await freePort();
  // 数据层的 Redis 有密码，少写 :pwd@ 就是 NOAUTH —— 这是 13-ops.md §7 里最高频的启动故障。
  const noPassword = String(process.env.REDIS_URL).replace(/:\/\/[^@]*@/, "://");
  const { child, stderr } = spawnServer(baseEnv({ REDIS_URL: noPassword, PORT: String(port) }));
  const code = await waitExit(child, 25_000);
  assert.equal(code, 1, `期望退出码 1，实际 ${code}；stderr=${stderr()}`);
  assert.match(stderr(), /Redis PING/, `stderr 应指出失败的启动步骤，实际：${stderr()}`);
});

test("DATABASE_URL 指到没有 pgvector 的库时：能起来，但 /healthz 503 且 checks.pg 为 false", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  // 用"指错库"制造故障，而不是"没建表"：另一个 agent 正在建表，表的存在性有竞态；
  // 扩展装没装是稳定事实，而且这正是 /healthz 的 pg 判定条件。
  const port = await freePort();
  const wrongDatabase = String(process.env.DATABASE_URL).replace(/\/[^/]*$/, "/postgres");
  const { child, stderr } = spawnServer(
    baseEnv({ DATABASE_URL: wrongDatabase, PORT: String(port) }),
  );
  try {
    const response = await waitForHealthz(port, 20_000);
    const body = (await response.json()) as { ok: boolean; checks: Record<string, boolean> };
    assert.equal(response.status, 503, `期望 503，实际 ${response.status}；stderr=${stderr()}`);
    assert.equal(body.ok, false);
    assert.equal(body.checks.pg, false);
  } finally {
    child.kill();
    await waitExit(child, 10_000).catch(() => undefined);
  }
});

test("/healthz 四键齐全；装配前 pi 为 false，ok 因此为 false（503）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  // 本进程此时还没装配过任何 AgentSession（本文件前面的用例都跑在子进程里），
  // 所以这条断言能证明 `ok` **确实**把 pi 算进去了 —— 这正是 04#01 删掉的那个例外。
  const { buildApp } = await import("../src/server.ts");
  const app = await buildApp();
  try {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    const body = response.json() as { ok: boolean; checks: Record<string, boolean>; version: string };

    assert.equal(response.statusCode, 503, `pi=false 时应 503，实际 ${response.statusCode}`);
    assert.equal(body.ok, false, "四项里有一项为 false，ok 必须为 false");
    assert.deepEqual(Object.keys(body.checks).sort(), ["minio", "pg", "pi", "redis"]);
    assert.equal(body.checks.pg, true);
    assert.equal(body.checks.redis, true);
    assert.equal(body.checks.minio, true);
    assert.equal(body.checks.pi, false, "进程内还没装配过 AgentSession");
    assert.equal(typeof body.version, "string");
  } finally {
    await app.close();
  }
});

test("装配过一次 AgentSession 后 pi 转 true，/healthz 恢复 200 ok（01-foundation 的例外已删）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { randomUUID } = await import("node:crypto");
  const { redis } = await import("../src/redis.ts");
  const { acquireSession, agentReady, shutdownSessions } = await import("../src/core/agent.ts");
  const { buildApp } = await import("../src/server.ts");

  const convId = randomUUID();
  const app = await buildApp();
  try {
    // 一次真实装配（模型解析 + 资源加载 + AgentSession），不是把标志位直接掰成 true。
    const acquired = await acquireSession(convId, "de");
    assert.equal(acquired.reused, false, "全新会话不应是复用");
    assert.equal(agentReady(), true);

    const response = await app.inject({ method: "GET", url: "/healthz" });
    const body = response.json() as { ok: boolean; checks: Record<string, boolean> };
    assert.equal(body.checks.pi, true, "04#01 之后 pi 必须为 true");
    assert.equal(response.statusCode, 200, `四项齐全时应 200，实际 ${response.statusCode}`);
    assert.equal(body.ok, true);
    // ok 的口径：四项的合取（pi 不再排除在外）。
    assert.equal(body.ok, body.checks.pg && body.checks.redis && body.checks.minio && body.checks.pi);
  } finally {
    await app.close();
    // 装配会顺手写一条 Redis 租约（best-effort），别留给下一个测试文件。
    await redis.del(`conv:${convId}:lease`).catch(() => undefined);
    shutdownSessions();
  }
});

test("/healthz 不泄露连接串与口令", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { buildApp } = await import("../src/server.ts");
  const app = await buildApp();
  try {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    const raw = response.body;
    assert.equal(raw.includes("://"), false, `响应体出现 URL：${raw}`);
    assert.equal(/password/i.test(raw), false, `响应体出现 password：${raw}`);
    const secret = process.env.S3_SECRET_KEY;
    if (secret) assert.equal(raw.includes(secret), false, "响应体出现 MinIO 口令");
  } finally {
    await app.close();
  }
});

test("未捕获异常只回通用内部错误 + trace id，且不带堆栈", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { AppError } = await import("../src/errors.ts");
  const { buildApp } = await import("../src/server.ts");
  const app = await buildApp();
  app.get("/__test/boom", async () => {
    throw new Error("boom at C:\\secret\\path\\db.ts:42");
  });
  app.get("/__test/app-error", async () => {
    throw new AppError("VALIDATION", "text 不能为空");
  });
  try {
    const boom = await app.inject({ method: "GET", url: "/__test/boom" });
    const boomBody = boom.json() as {
      ok: boolean;
      error: { code: string; message: string; trace_id: string };
    };
    assert.equal(boom.statusCode, 500);
    assert.equal(boomBody.error.code, "INTERNAL");
    assert.equal(boomBody.error.message, "Internal server error");
    assert.equal(typeof boomBody.error.trace_id, "string");
    assert.equal(boom.body.includes("secret"), false, "堆栈不得进响应体");
    assert.equal(boom.body.includes("db.ts"), false, "堆栈不得进响应体");

    const traceId = "11111111-2222-3333-4444-555555555555";
    const appError = await app.inject({
      method: "GET",
      url: "/__test/app-error",
      headers: { "x-trace-id": traceId },
    });
    const appErrorBody = appError.json() as {
      ok: boolean;
      error: { code: string; message: string; trace_id: string };
    };
    assert.equal(appError.statusCode, 400);
    assert.equal(appErrorBody.error.code, "VALIDATION");
    assert.equal(appErrorBody.error.message, "text 不能为空");
    assert.equal(appErrorBody.error.trace_id, traceId, "应沿用前端传来的 X-Trace-Id");

    const notFound = await app.inject({ method: "GET", url: "/nope" });
    const notFoundBody = notFound.json() as { ok: boolean; error: { code: string; trace_id: string } };
    assert.equal(notFound.statusCode, 404);
    assert.equal(notFoundBody.error.code, "NOT_FOUND");
    assert.equal(typeof notFoundBody.error.trace_id, "string");
  } finally {
    await app.close();
  }
});
