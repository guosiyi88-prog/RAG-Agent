import { Redis } from "ioredis";
import { config } from "./config.ts";
import { logger } from "./logger.ts";

// Redis 有密码，URL 里必须带 :pwd@（13-ops.md §2.3）；这里不做任何拼接或兜底。
// maxRetriesPerRequest 设小值：限流/租约路径不能把请求拖到 30s 才失败。
export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 2,
  connectTimeout: 3_000,
  retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
});

redis.on("error", (err) => {
  logger.warn({ err: { message: err.message } }, "redis error");
});

/**
 * 滑动窗口限流，返回 true 表示放行。
 * 用 ZSET 而不是 INCR+EXPIRE：固定窗口在窗口边界会放行 2×limit，秒级突发下形同虚设。
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Date.now();
  const windowMs = windowSec * 1_000;
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  const result = await redis
    .multi()
    .zremrangebyscore(key, 0, now - windowMs)
    .zadd(key, now, member)
    .zcard(key)
    .pexpire(key, windowMs)
    .exec();
  if (!result) return true;
  const countEntry = result[2];
  const count = countEntry && !countEntry[0] ? Number(countEntry[1]) : 0;
  return count <= limit;
}

/** 会话租约：跨请求判断 AgentSession 是否还有效（02-architecture.md §4）。 */
export async function setLease(convId: string, ttlSec: number): Promise<void> {
  await redis.setex(`conv:${convId}:lease`, ttlSec, "1");
}

export async function hasLease(convId: string): Promise<boolean> {
  return (await redis.exists(`conv:${convId}:lease`)) === 1;
}
