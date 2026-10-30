/**
 * 坐席登录与身份（`09#03` / D8，`docs/output/boundary-change-R2.md` §3 B3）。
 *
 *   POST /api/auth/login    邮箱 + 口令 → 会话票据（`x-staff-session`）
 *   POST /api/auth/logout   吊销当前票据
 *   GET  /api/console/me    当前身份（前端登录后第一件事，导航据此渲染）
 *
 * 三条刻意的口径：
 *
 * 1. **登录失败只有一种回答**：`401 AUTH_INVALID`，文案固定"邮箱或口令不正确"。
 *    邮箱不存在 / 口令错 / 账号停用 / 还没设口令，四者在响应体与状态码上完全一致 ——
 *    任何区分都是一台账号枚举器。差异只进日志（且只记邮箱域名之外的事实，不记口令）。
 * 2. **限速先于校验**：同 IP 每分钟 5 次，超了直接 429，不去算 scrypt。先校验再限速等于
 *    把 CPU 交给攻击者（一次 scrypt 60 ms，10 个并发就能占满线程池）。
 * 3. **票据走请求头不走 Cookie**：没有 Cookie 就没有 CSRF 面，也不需要 SameSite 的取舍。
 *    代价是前端要自己存（坐席端存 `localStorage`，与现有做法一致）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
// 票据头的常量定义在**零副作用**的 `auth.ts` 一侧（守卫与登录两边都要读它，而本文件会拉起
// redis），这里只 import 再转发，不另立第二个字符串。
import { STAFF_SESSION_HEADER } from "../auth.ts";
import {
  authenticate,
  createStaffSession,
  readStaffSession,
  revokeStaffSession,
  type StaffIdentity,
} from "../core/auth-login.ts";
import { AppError } from "../errors.ts";
import { logger } from "../logger.ts";
import { rateLimit } from "../redis.ts";

/** `05-api.md` §1：坐席会话票据头（定义见 `src/auth.ts`）。与用户端 `x-user-session` 分开，两种身份不共用一个头。 */
export { STAFF_SESSION_HEADER };

/** 同 IP 每分钟 5 次（`boundary-change-R2.md` §5 第 2 条）。 */
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_SEC = 60;

const EMAIL_MAX = 254;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

function headerValue(request: FastifyRequest, name: string): string {
  const raw = request.headers[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/** 从请求头读会话。`null` 表示没登录或票据已失效 —— 路由自己决定 401 还是 403。 */
export async function currentStaff(request: FastifyRequest): Promise<StaffIdentity | null> {
  return readStaffSession(headerValue(request, STAFF_SESSION_HEADER));
}

function requireBodyRecord(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("VALIDATION", "请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

function readString(body: Record<string, unknown>, key: string, max: number): string {
  const raw = body[key];
  if (typeof raw !== "string") throw new AppError("VALIDATION", `${key} 必须是字符串`);
  const value = raw.trim();
  if (value === "") throw new AppError("VALIDATION", `${key} 不能为空`);
  if (value.length > max) throw new AppError("VALIDATION", `${key} 过长`);
  return value;
}

/**
 * 统一的登录失败响应。**不要**在这里加"账号不存在"之类的细分：那正是文档 §5 明令禁止的。
 * 也不要在 message 里回显邮箱（回显等于把输入反射进日志与页面）。
 */
function sendLoginFailure(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  return reply.code(401).send({
    ok: false,
    error: { code: "AUTH_INVALID", message: "邮箱或口令不正确", trace_id: String(request.id) },
  });
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 登录。限速 → 入参形状 → 认证 → 签发。
   *
   * 限速键带 `login:` 前缀：与用户端工单配额（`quota:ticket:*`）共用 Redis 但不同命名空间，
   * 免得两类计数互相吃掉对方的额度。
   */
  app.post("/api/auth/login", async (request, reply) => {
    const allowed = await rateLimit(`login:${request.ip}`, LOGIN_LIMIT, LOGIN_WINDOW_SEC);
    if (!allowed) throw new AppError("RATE_LIMITED", "尝试过于频繁，请一分钟后再试");

    const body = requireBodyRecord(request);
    const email = readString(body, "email", EMAIL_MAX);
    const password = readString(body, "password", PASSWORD_MAX);
    if (password.length < PASSWORD_MIN) {
      // 口令太短属于"明显发错的请求"，回 400 而不是 401：它不是一次认证尝试，
      // 不该消耗限速额度之外的东西，也不该让用户以为是口令记错了。
      throw new AppError("VALIDATION", `password 至少 ${PASSWORD_MIN} 位`);
    }

    const staff = await authenticate(email, password);
    if (staff === null) {
      logger.warn({ ip: request.ip }, "auth: 坐席登录失败");
      return sendLoginFailure(reply, request);
    }

    const session = await createStaffSession(staff);
    logger.info({ staffId: staff.staffId, role: staff.role }, "auth: 坐席登录成功");
    return reply.send({
      ok: true,
      data: {
        ticket: session.ticket,
        expires_at: session.expiresAt.toISOString(),
        staff: {
          staff_id: staff.staffId,
          name: staff.staffName,
          email: staff.email,
          role: staff.role,
        },
      },
    });
  });

  /** 登出。票据不存在也算成功（幂等）：前端登出后重试不该看到错误。 */
  app.post("/api/auth/logout", async (request, reply) => {
    await revokeStaffSession(headerValue(request, STAFF_SESSION_HEADER));
    return reply.send({ ok: true, data: { logged_out: true } });
  });

  /**
   * 当前身份。前端登录后的第一个请求（D31）：
   *   - 没票据 / 票据失效 → 401，前端回登录页；
   *   - 网络错或 5xx → 前端只读降级 + toast，**不**清本地票据（那会把"临时抖动"变成"重新登录"）。
   */
  app.get("/api/console/me", async (request, reply) => {
    const staff = await currentStaff(request);
    if (staff === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: "AUTH_REQUIRED", message: "未登录或会话已过期", trace_id: String(request.id) },
      });
    }
    return reply.send({
      ok: true,
      data: {
        staff_id: staff.staffId,
        name: staff.staffName,
        email: staff.email,
        role: staff.role,
      },
    });
  });
}
