/**
 * 匿名会话令牌签发（`05-api.md` §3.1）。
 *
 * 这是整套对外 API 里**唯一不需要凭据**的写入口，因此它天然是滥用入口：
 * 谁都能在这里无限铸造 `sess:{uuid}`，一张表就能把 Redis 灌满，并让后续 `/api/chat`
 * 的鉴权成本降到零。所以按来源 IP 限流。
 *
 * 为什么计数器必须放 Redis，而不是进程内 Map：
 *   1. 多实例时每个进程各算各的 —— 3 个实例意味着实际额度是 3 × 10/分钟，限流等于没做；
 *   2. 这个服务重启很频繁（每次部署 / 崩溃拉起），进程内计数一重启就清零，
 *      攻击者只要等到一次重启就白拿一整份额度。Redis 的 TTL 让窗口在跨进程、跨重启后依然连续。
 * 令牌本身也存在 Redis（`sess:{token}`），所以 Redis 不可用时这个端点没有"降级放行"这个选项：
 * 签发出去的令牌校验不了，让异常走统一错误处理器（INTERNAL），不假装成功。
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AppError } from "../errors.ts";
import { logger } from "../logger.ts";
import { rateLimit, redis } from "../redis.ts";

/** 05 §3.1：令牌 7 天。没有续期接口，过期即匿名会话结束。 */
const SESSION_TTL_SEC = 604_800;

/** 05 §3.1：同一 IP 每分钟最多 10 次（第 11 次即 429）。 */
const SESSION_RATE_LIMIT = 10;
const SESSION_RATE_WINDOW_SEC = 60;

/**
 * 限流键前缀。复用 `src/redis.ts` 的 `rateLimit()`（ZSET + 窗口 TTL），
 * 不自己写 INCR/EXPIRE：固定窗口在窗口边界会放行 2×limit，突发限流形同虚设。
 * 键名与仓库既有约定一致（`rl:{场景}:{维度}`）。
 */
const RATE_KEY_PREFIX = "rl:session:";

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  // 无 body、无鉴权：前端首屏第一件事就是拿这个令牌，任何额外门槛都会挡在"开始提问"之前。
  app.post("/api/session", async (request, reply) => {
    // 来源 IP 取 socket 的 remoteAddress（由内核给出，不能被 `X-Forwarded-For` 伪造成
    // 无限多个"不同 IP"来绕过限流）。本项目服务在容器内直连，没有需要信任的反向代理。
    const ip = request.ip;
    const allowed = await rateLimit(
      `${RATE_KEY_PREFIX}${ip}`,
      SESSION_RATE_LIMIT,
      SESSION_RATE_WINDOW_SEC,
    );
    if (!allowed) {
      // 只记 IP 与命中的事实，不记令牌：日志会进评审记录，令牌等价于凭据。
      logger.warn({ ip }, "session: 签发限流命中");
      throw new AppError("RATE_LIMITED", "请求过于频繁，请稍后再试");
    }

    const token = randomUUID();
    // SETEX 而不是 SET + EXPIRE：两条命令之间进程挂掉会留下一个永不过期的令牌，
    // 那是永久有效的匿名凭据。TTL 与响应里的 expires_at 必须同源（都用 SESSION_TTL_SEC）。
    await redis.setex(`sess:${token}`, SESSION_TTL_SEC, "1");

    return reply.code(200).send({
      ok: true,
      data: {
        token,
        // ISO 8601。按常量算而不是读 Redis 的剩余 TTL：刚写完的 TTL 就是 7 天，
        // 多一次往返换不来精度，只会多一个失败点。
        expires_at: new Date(Date.now() + SESSION_TTL_SEC * 1_000).toISOString(),
      },
    });
  });
}
