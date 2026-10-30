// 错误码是唯一来源：路由只能从这里取，不得散落字符串（02-architecture.md §2.1）。
// 与 05-api.md §6 的表一致，HTTP 状态码内联在这里，避免两处维护。
export const ERROR_CODES = {
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  // 403 与两条 401 的语义分工（`09#03` 起）：401 = "我还没认出你是谁"（没登录 / 票据失效），
  // 403 = "我知道你是谁，但这件事不是你能做的"。前端据此分流：401 回登录页换票据，
  // 403 只降级 + 提示，**不**清登录态（D31）—— 把权限不足当成会话过期会让人白登一遍。
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  QUOTA_TICKET: 429,
  VALIDATION: 400,
  NOT_FOUND: 404,
  NOT_IMPLEMENTED: 501,
  SESSION_BUSY: 503,
  LLM_TIMEOUT: 504,
  LLM_UNAVAILABLE: 503,
  EMBED_UNAVAILABLE: 503,
  STORAGE_UNAVAILABLE: 503,
  TICKET_IMMUTABLE: 409,
  // 通用的 "这条数据当前的状态不允许这个动作"（`09#04`）：请求形状没问题、资源也在，
  // 只是状态不对 —— 发布一条缺语的故障码就是这一格。与 `TICKET_IMMUTABLE` 分开是为了让
  // 日志与前端能分辨"工单已关闭"与"管理端动作被状态拒绝"，两者文案与处理都不同。
  CONFLICT: 409,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorBody {
  ok: false;
  error: { code: ErrorCode; message: string; trace_id: string };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** 给日志用的上下文；**不得**进响应体（可能含 SQL 片段或参数）。 */
  readonly context: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message?: string, context?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_CODES[code];
    this.context = context;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * 未捕获异常一律回 INTERNAL + 通用文案：堆栈只进日志。
 * 客户端拿到堆栈等于拿到文件路径与依赖版本，是白送的信息泄露面。
 */
export function toErrorBody(err: unknown, traceId: string): { status: number; body: ErrorBody } {
  if (isAppError(err)) {
    return {
      status: err.status,
      body: { ok: false, error: { code: err.code, message: err.message, trace_id: traceId } },
    };
  }
  return {
    status: ERROR_CODES.INTERNAL,
    body: {
      ok: false,
      error: { code: "INTERNAL", message: "Internal server error", trace_id: traceId },
    },
  };
}
