import assert from "node:assert/strict";
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

const hasRuntimeEnv = Boolean(
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT,
);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

/** uuid v4 的形状（randomUUID 只会产出 v4）。用正则而不是"长度 36"，是为了拒掉自增 id 之类。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 限流键与 `src/api/session.ts` 里的 `RATE_KEY_PREFIX` 逐字对应。
 * 之所以在测试里重写一遍而不是 import 常量：这个前缀是**对外可观测的事实**
 * （运维会用 `redis-cli keys 'rl:session:*'` 排查刷量），改它就该让这里失败一次。
 */
const RATE_KEY = "rl:session:127.0.0.1"; // app.inject 的来源固定是回环地址

const createdTokens: string[] = [];

after(async () => {
  if (!hasRuntimeEnv) return;
  const { redis } = await import("../src/redis.ts");
  const { pool } = await import("../src/db.ts");
  // 只删本文件造出来的键：`sess:*` 是真实凭据，`rl:session:*` 是限流窗口，两者都不能留给下一次跑。
  if (createdTokens.length > 0) await redis.del(...createdTokens.map((t) => `sess:${t}`));
  await redis.del(RATE_KEY);
  await redis.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

/**
 * 直接拿 `buildApp()`：这样 429 的信封由 `src/server.ts` 的统一错误处理器产出，
 * 断言到的是线上真实形状，而不是测试里另写一份 setErrorHandler 的自证。
 * 会话路由是否已由 `src/routes.ts` 注册，本测试不假设（另一个 agent 正在改那个文件）：
 * 没注册就自己补，已注册就不重复注册（重复注册 Fastify 会抛路由冲突）。
 */
async function buildSessionApp(): Promise<FastifyInstance> {
  const { buildApp } = await import("../src/server.ts");
  const { registerSessionRoutes } = await import("../src/api/session.ts");
  const app = await buildApp();
  if (!app.hasRoute({ method: "POST", url: "/api/session" })) {
    await registerSessionRoutes(app);
  }
  return app;
}

test("POST /api/session 签发 uuid 令牌、写 Redis sess:{token}、TTL 7 天", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { redis } = await import("../src/redis.ts");
  await redis.del(RATE_KEY); // 别的用例可能刚把这个 IP 的额度用光

  const app = await buildSessionApp();
  try {
    const response = await app.inject({ method: "POST", url: "/api/session" });
    assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body}`);

    const body = response.json() as {
      ok: boolean;
      data: { token: string; expires_at: string };
    };
    assert.equal(body.ok, true);
    assert.match(body.data.token, UUID_RE, `令牌必须是 uuid，实际 "${body.data.token}"`);
    createdTokens.push(body.data.token);

    // expires_at：ISO 8601、在未来、且不超过 7 天（+5s 容差）。
    const expiresAt = Date.parse(body.data.expires_at);
    assert.equal(Number.isNaN(expiresAt), false, `expires_at 不是可解析的 ISO 时间：${body.data.expires_at}`);
    const now = Date.now();
    assert.ok(expiresAt > now, `expires_at 必须在将来，实际 ${body.data.expires_at}`);
    assert.ok(
      expiresAt <= now + 604_800_000 + 5_000,
      `expires_at 不能超过 7 天，实际 ${body.data.expires_at}`,
    );

    // 令牌必须真的落到 Redis：/api/chat 的鉴权就是查这个键（05 §1）。
    assert.equal(await redis.exists(`sess:${body.data.token}`), 1, "sess:{token} 未写入 Redis");
    const ttl = await redis.ttl(`sess:${body.data.token}`);
    assert.ok(ttl > 600 && ttl <= 604_800, `TTL 应落在 (600, 604800]，实际 ${ttl}`);
  } finally {
    await app.close();
  }
});

test("同一 IP 每分钟第 11 次签发请求回 429 RATE_LIMITED（信封与其它错误码一致）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { redis } = await import("../src/redis.ts");
  await redis.del(RATE_KEY);

  const app = await buildSessionApp();
  try {
    for (let i = 1; i <= 10; i += 1) {
      const ok = await app.inject({ method: "POST", url: "/api/session" });
      assert.equal(ok.statusCode, 200, `第 ${i} 次应放行，实际 ${ok.statusCode}：${ok.body}`);
      const token = (ok.json() as { data: { token: string } }).data.token;
      createdTokens.push(token);
    }

    // 计数器必须是 Redis 里的键且带 TTL：进程内 Map 在多实例/重启后都失效（见 session.ts 文件头）。
    const counterTtl = await redis.ttl(RATE_KEY);
    assert.ok(counterTtl > 0 && counterTtl <= 60, `限流窗口 TTL 应落在 (0, 60]，实际 ${counterTtl}`);

    const blocked = await app.inject({ method: "POST", url: "/api/session" });
    assert.equal(blocked.statusCode, 429, `第 11 次应 429，实际 ${blocked.statusCode}：${blocked.body}`);
    const body = blocked.json() as {
      ok: boolean;
      error: { code: string; message: string; trace_id: string };
    };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "RATE_LIMITED");
    assert.equal(typeof body.error.message, "string");
    assert.equal(typeof body.error.trace_id, "string");
    // 被拒的请求不能留下任何凭据：否则限流只是拖慢攻击者，没有减少产出。
    const payload = body as unknown as { data?: unknown };
    assert.equal(payload.data, undefined, "429 响应不应携带签发结果");
    assert.equal(blocked.body.includes("token"), false, `429 响应体不应出现 token：${blocked.body}`);
  } finally {
    await redis.del(RATE_KEY);
    await app.close();
  }
});
