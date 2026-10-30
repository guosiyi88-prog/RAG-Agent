/**
 * 坐席登录内核（`09#03` / D8）：口令派生、会话签发与吊销。
 *
 * 断言的是**可观察行为**，不是"函数被调了几次"：
 *   - 同一口令 + 同一盐 → 同一个哈希（否则种子里的演示口令会随重启失效）；
 *   - 不同盐 → 不同哈希（盐真的在起作用，不是装饰）；
 *   - 校验必须挡住：错口令、空口令、没设口令的账号（三者在登录页都是"登不进去"）；
 *   - 会话票据：签发后可读回身份、吊销后读不回、库里存的是 sha256 而不是明文。
 *
 * 不起 HTTP：`/api/auth/login` 的限速与统一 401 属于传输层，等 `09#03` 切鉴权时
 * 与 `tests/auth-boundaries.test.ts` 一起改（那里已有 11 条断言要重写）。
 *
 * env 由本文件自己补：`npm test` 是 `node --test --test-concurrency=1`，**不带** `--env-file`。
 * 所以下面的 src 模块必须**动态 import** —— 顶层 import 会在 env 就位前求值 `src/config.ts`，
 * 于是"缺少 DATABASE_URL"直接把整个文件判红（踩过一次）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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

const { createStaffSession, hashPassword, readStaffSession, revokeStaffSession, verifyPassword } =
  await import("../src/core/auth-login.ts");
const { one, pool, query } = await import("../src/db.ts");
// ioredis 的懒连接在 `auth-login.ts` 里被打开，它**不会**自己退出事件循环 ——
// 不显式断开，`node --test` 会一直等这个文件，看起来像超时死锁（`src/auth.ts` 的注释里
// 记过同一个坑）。所以这里把客户端一并取出来，收尾时 disconnect。
const { redis } = await import("../src/redis.ts");

const hasRuntimeEnv = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const missingRuntimeEnvHint = "缺少 .env 里的 DATABASE_URL / REDIS_URL：先跑 ./data/scripts/db.sh env";

after(async () => {
  redis.disconnect();
  await pool.end();
});

test("口令派生：同盐同口令 → 同哈希；换盐 → 换哈希", async () => {
  const first = await hashPassword("wt-demo-2026", "00112233445566778899aabbccddeeff");
  const again = await hashPassword("wt-demo-2026", "00112233445566778899aabbccddeeff");
  const other = await hashPassword("wt-demo-2026");

  assert.equal(first.hash, again.hash, "同一盐必须派生同一哈希，否则种子里的演示口令重启就废");
  assert.equal(first.salt, "00112233445566778899aabbccddeeff");
  assert.notEqual(first.hash, other.hash, "换了盐还是同一个哈希 —— 盐没生效");
  assert.equal(first.hash.length, 128, "keylen=64 字节 → hex 128 字符");
  assert.notEqual(first.hash, "wt-demo-2026", "哈希不能等于明文");
});

test("口令校验：错口令 / 空口令 / 没设口令一律 false", async () => {
  const { hash, salt } = await hashPassword("正确口令-2026");

  assert.equal(await verifyPassword("正确口令-2026", hash, salt), true);
  assert.equal(await verifyPassword("错误口令-2026", hash, salt), false);
  assert.equal(await verifyPassword("", hash, salt), false, "空口令必须直接 false，不能去算派生");
  assert.equal(await verifyPassword("正确口令-2026", null, salt), false, "没设口令的账号登不进去");
  assert.equal(await verifyPassword("正确口令-2026", hash, null), false);
  assert.equal(await verifyPassword("正确口令-2026", "not-hex-but-long-enough", salt), false, "坏哈希不许抛错，只判失败");
});

test("会话：签发 → 读回身份 → 吊销后读不回，库里只有 sha256", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }

  const staff = await one<{ id: string; name: string; email: string; role: "agent" | "lead" | "admin" }>(
    `select id, name, email, role from staff order by created_at, id limit 1`,
  );
  assert.ok(staff !== null, "staff 表为空：先跑 sql/002_seed.sql");

  const identity = { staffId: staff.id, staffName: staff.name, email: staff.email, role: staff.role };

  const session = await createStaffSession(identity);
  assert.equal(session.ticket.length, 64, "票据是 32 字节随机数的 hex，长度固定 64");

  const restored = await readStaffSession(session.ticket);
  assert.deepEqual(restored, identity, "读回的身份必须与签发时一致（含 role，导航据此渲染）");

  const expected = createHash("sha256").update(session.ticket, "utf8").digest("hex");
  const stored = await one<{ token_hash: string }>(
    `select token_hash from staff_sessions where token_hash = $1`,
    [expected],
  );
  assert.equal(stored?.token_hash, expected, "库里存的必须是票据的 sha256");
  assert.notEqual(stored?.token_hash, session.ticket, "明文票据不许进库");

  await revokeStaffSession(session.ticket);
  assert.equal(await readStaffSession(session.ticket), null, "登出后票据必须立刻读不回");
  const revoked = await one<{ revoked_at: Date | null }>(
    `select revoked_at from staff_sessions where token_hash = $1`,
    [expected],
  );
  assert.ok(revoked?.revoked_at instanceof Date, "吊销要留时间戳，审计要能回答「这个票据什么时候死的」");

  // 收尾：删掉本用例产生的会话行，别把库留给下一个用例
  await query(`delete from staff_sessions where token_hash = $1`, [expected]);
});
