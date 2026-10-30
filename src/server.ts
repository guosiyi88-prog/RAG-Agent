import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { config } from "./config.ts";
import { pool, query } from "./db.ts";
import { AppError, toErrorBody } from "./errors.ts";
import { logger } from "./logger.ts";
import { redis } from "./redis.ts";
import { registerRoutes } from "./routes.ts";
import { ensureBucket } from "./storage.ts";

type ShutdownHook = () => Promise<void> | void;

const shutdownHooks: ShutdownHook[] = [];

/** 会话释放由 T05 的 core/agent.ts 注册：server.ts 不 import core（依赖方向见 02 §3）。 */
export function onShutdown(hook: ShutdownHook): void {
  shutdownHooks.push(hook);
}

export async function buildApp(options: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // 全进程共用一个 pino 实例：脱敏规则只写一次，request log 与业务 log 走同一管道。
    loggerInstance: logger,
    // 前端自带 X-Trace-Id 就沿用，没有则本地生成；日志与响应体共用同一个 id。
    genReqId: (req) => {
      const header = req.headers["x-trace-id"];
      return typeof header === "string" && header.length > 0 ? header : randomUUID();
    },
    bodyLimit: 1_000_000,
    ...options,
  });

  app.setErrorHandler((err, request, reply) => {
    const traceId = String(request.id);
    // 两类"请求本身的错"都不是 AppError，但语义就是 VALIDATION：
    //   - `err.validation` 有值 = Fastify schema 校验失败（required / type / 枚举）；
    //   - `err.statusCode` 落在 4xx = 解析层就挡住了（坏 JSON 400、body 超限 413、
    //     content-type 不认识 415），此时路由处理器**一次都没跑**。
    // 不映射的话它们会以 500 回给前端：① 前端把"我传错了"读成"服务崩了"；② 唯一该看告警的
    // 指标（5xx 率）被一次压测的垃圾 body 打红。状态码统一取 `ERROR_CODES.VALIDATION`（400）
    // 而不是原样的 413/415 —— 错误码表只有 `errors.ts` 一处来源，多一个 413 就要多一行。
    const status = (err as { statusCode?: unknown }).statusCode;
    const isClientError =
      (err as { validation?: unknown }).validation !== undefined ||
      (typeof status === "number" && status >= 400 && status < 500);
    const error = isClientError
      ? new AppError("VALIDATION", err instanceof Error ? err.message : "Invalid request")
      : err;
    const { status: httpStatus, body } = toErrorBody(error, traceId);
    if (httpStatus >= 500) {
      // 堆栈只进日志：客户端拿到堆栈等于拿到文件路径与依赖版本。
      logger.error({ err, traceId, url: request.url, method: request.method }, "unhandled error");
    } else {
      logger.warn({ code: body.error.code, traceId, url: request.url }, "request rejected");
    }
    return reply.code(httpStatus).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const traceId = String(request.id);
    return reply
      .code(404)
      .send({ ok: false, error: { code: "NOT_FOUND", message: "Not found", trace_id: traceId } });
  });

  await registerRoutes(app);
  return app;
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    logger.info({ step: name }, "startup step ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, step: name }, "startup step failed");
    // stderr 带步骤名与原因（不含连接串）：数据层缺席时容器要立刻退出而不是反复重启。
    process.stderr.write(`[startup] ${name} 失败：${message}\n`);
    process.exit(1);
  }
}

/**
 * 02-architecture.md §7 的固定七步。顺序不可调整：先证明依赖可用再 listen，
 * 才能保证"能接流量"等价于"依赖都在位"，而不是上线后才被第一条请求发现。
 */
export async function start(): Promise<FastifyInstance> {
  // 1. 配置校验：config.ts 在 import 阶段完成，缺项已 exit(1)
  logger.info({ port: config.port }, "config ok");

  // 2. PostgreSQL 探活
  await step("PostgreSQL 探活", async () => {
    const rows = await query<{ ok: number }>("select 1 as ok");
    if (rows[0]?.ok !== 1) throw new Error("select 1 返回异常");
  });

  // 3. Redis
  await step("Redis PING", async () => {
    const reply = await redis.ping();
    if (reply !== "PONG") throw new Error("PING 未返回 PONG");
  });

  // 4. MinIO 并确保桶
  await step("MinIO bucket", async () => {
    await ensureBucket();
  });

  // 5. 注册插件与路由
  const app = await buildApp();

  // 6. listen
  await step("listen", async () => {
    await app.listen({ port: config.port, host: "0.0.0.0" });
  });

  // 7. 信号处理器（放在 listen 之后：此时才有需要优雅关闭的连接）
  registerSignalHandlers(app);
  return app;
}

function registerSignalHandlers(app: FastifyInstance): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown: stop accepting new requests");

    const force = setTimeout(() => {
      logger.error({ signal }, "shutdown: 超时，强制退出");
      process.exit(1);
    }, config.gracefulShutdownMs);
    force.unref();

    try {
      // ① 停止收新请求，等在途请求（含 SSE）结束
      await app.close();
      // ② 释放进程内会话
      for (const hook of shutdownHooks) await hook();
      // ③ 关连接池
      await redis.quit();
      await pool.end();
      clearTimeout(force);
      logger.info({ signal }, "shutdown: done");
      process.exit(0);
    } catch (err) {
      logger.error({ err, signal }, "shutdown: 失败");
      process.exit(1);
    }
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isMain) {
  await start();
}
