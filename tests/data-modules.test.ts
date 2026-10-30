import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

const hasRuntimeEnv = Boolean(
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT,
);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

after(async () => {
  if (!hasRuntimeEnv) return;
  const { pool } = await import("../src/db.ts");
  const { redis } = await import("../src/redis.ts");
  await redis.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

test("db.query 能打到真库：select 1 返回一行", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { query, one } = await import("../src/db.ts");
  const rows = await query<{ "?column?": number }>("select 1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.["?column?"], 1);

  const row = await one<{ v: number }>("select $1::int as v", [42]);
  assert.deepEqual(row, { v: 42 });

  const missing = await one<{ v: number }>("select $1::int as v where false", [1]);
  assert.equal(missing, null);
});

test("db.tx 提交后可见，抛错则回滚", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { query, tx } = await import("../src/db.ts");
  const ok = await tx(async (client) => {
    const result = await client.query<{ v: number }>("select 7::int as v");
    return result.rows[0]?.v;
  });
  assert.equal(ok, 7);

  await assert.rejects(
    tx(async () => {
      throw new Error("rollback please");
    }),
    /rollback please/,
  );
  // 回滚路径不能把连接留在事务里：事务外的普通查询必须仍然可用。
  const rows = await query<{ "?column?": number }>("select 1");
  assert.equal(rows.length, 1);
});

test("redis.ping 返回 PONG，租约与限流可用", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { redis, rateLimit, setLease, hasLease } = await import("../src/redis.ts");
  assert.equal(await redis.ping(), "PONG");

  const convId = `test-${randomUUID()}`;
  assert.equal(await hasLease(convId), false);
  await setLease(convId, 5);
  assert.equal(await hasLease(convId), true);
  await redis.del(`conv:${convId}:lease`);

  const key = `rl:test:${randomUUID()}`;
  assert.equal(await rateLimit(key, 2, 60), true);
  assert.equal(await rateLimit(key, 2, 60), true);
  assert.equal(await rateLimit(key, 2, 60), false, "超过上限必须拒绝");
  const ttl = await redis.pttl(key);
  assert.ok(ttl > 0 && ttl <= 60_000, `窗口 TTL 应落在 (0, 60000]，实际 ${ttl}`);
  await redis.del(key);
});

test("storage.ensureBucket 幂等，put/get/预签名可用", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { ensureBucket, getObject, minioClient, presignedUrl, putObject } = await import(
    "../src/storage.ts"
  );
  const bucket = String(process.env.S3_BUCKET);

  await ensureBucket();
  await ensureBucket(); // 第二次必须仍然成功（幂等），不能抛 BucketAlreadyOwnedByYou
  assert.equal(await minioClient.bucketExists(bucket), true);

  const key = `__smoke/${randomUUID()}.txt`;
  const payload = Buffer.from("wt-agent storage smoke 中文", "utf8");
  try {
    await putObject(key, payload, "text/plain; charset=utf-8");
    const roundTrip = await getObject(key);
    assert.equal(roundTrip.equals(payload), true);

    const url = await presignedUrl(key, 60);
    assert.match(url, /^https?:\/\//);
    assert.equal(url.includes(key), true);
  } finally {
    await minioClient.removeObject(bucket, key).catch(() => undefined);
  }
});
