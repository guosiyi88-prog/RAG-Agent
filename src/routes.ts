import type { FastifyInstance } from "fastify";
import { registerAdminRoutes } from "./api/admin.ts";
import { registerAdminKbRoutes } from "./api/admin-kb.ts";
import { registerAssetRoutes } from "./api/assets.ts";
import { registerAuthRoutes } from "./api/auth.ts";
import { registerChatRoutes } from "./api/chat.ts";
import { registerConsoleRoutes } from "./api/console.ts";
import { registerFaultRoutes } from "./api/fault.ts";
import { registerI18nRoutes } from "./api/i18n.ts";
import { registerInternalCitationRoutes } from "./api/internal-citations.ts";
import { registerInternalFaultRoutes } from "./api/internal-fault.ts";
import { registerInternalTicketRoutes } from "./api/internal-ticket.ts";
import { registerInternalRoutes } from "./api/internal.ts";
import { assertRouteRoles, collectRegisteredRoutes } from "./api/roles.ts";
import { registerSessionRoutes } from "./api/session.ts";
import { registerTicketRoutes } from "./api/ticket.ts";
import { config } from "./config.ts";
import { query } from "./db.ts";
import { redis } from "./redis.ts";
import { minioClient } from "./storage.ts";

// `pi` 探活的最新事实来源是"本进程至少成功装配过一次 AgentSession"。
// T05 的 src/core/agent.ts 拿到 session 后调用 markPiReady()，这里不需要 import 任何 core
// （反向依赖会形成环：core/agent → routes → api/chat → core/agent；函数声明有提升，运行时无碍）。
let piReady = false;

export function markPiReady(): void {
  piReady = true;
}

export function isPiReady(): boolean {
  return piReady;
}

/** 探活必须自带超时：依赖半死时 healthz 不能跟着挂住，否则探活本身成了故障点。 */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function probePg(): Promise<boolean> {
  // 一条查询同时证明两件事：`select 1` 能返回（连接可用）与 pgvector 有版本号（扩展在位）。
  // 拆成两条只是多一次往返，判定条件不变。
  const rows = await within(
    query<{ ok: number; extversion: string | null }>(
      "select (select 1) as ok, (select extversion from pg_extension where extname = 'vector') as extversion",
    ),
    config.healthCheckTimeoutMs,
  );
  const row = rows?.[0];
  const version = row?.extversion;
  return row?.ok === 1 && typeof version === "string" && version.length > 0;
}

async function probeRedis(): Promise<boolean> {
  const reply = await within(redis.ping(), config.healthCheckTimeoutMs);
  return reply === "PONG";
}

async function probeMinio(): Promise<boolean> {
  const exists = await within(minioClient.bucketExists(config.s3.bucket), config.healthCheckTimeoutMs);
  return exists === true;
}

async function safe(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    // 失败原因只进日志/启动输出，绝不进响应体（05-api.md §7）。
    return false;
  }
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // 角色表核对的第一半（`09#03` / R23）：**先挂收集器，再注册路由**。
  // `onRoute` 只在注册那一刻触发一次，晚挂一条都收不到，于是断言会"全绿但漏了一条"。
  const registeredRoutes = collectRegisteredRoutes(app);

  app.get("/healthz", async (_request, reply) => {
    const [pg, redisOk, minioOk] = await Promise.all([safe(probePg), safe(probeRedis), safe(probeMinio)]);
    const checks = { pg, redis: redisOk, minio: minioOk, pi: isPiReady() };

    // 05 §7：四项全为 true 才 ok。`pi` 不再是有边界的例外 —— Agent 已装配（04#01），
    // 一个"装不出会话"的进程等于这个产品什么都答不了，503 才是诚实的探活结论。
    const ok = checks.pg && checks.redis && checks.minio && checks.pi;

    return reply.code(ok ? 200 : 503).send({ ok, checks, version: config.version });
  });

  // 静态资源（`GET /` 与 `GET /assets/*`，02 §5）：无构建链，浏览器直接跑 ES module。
  await registerAssetRoutes(app);

  // 五语文案（12-i18n.md §2，08#01）：服务端启动读表、请求时把「lang → en → key」合并好再下发。
  // 无令牌门禁（弱网下要先点亮界面、后拿令牌），未知语种 400 VALIDATION。
  await registerI18nRoutes(app);

  // 用户端：匿名令牌签发（05 §3.1）+ 对话流（05 §3.2）。
  await registerSessionRoutes(app);
  // 坐席登录与身份（09#03 / D8）：`/api/auth/login|logout`、`/api/console/me`。
  // 与用户端匿名令牌、内部回环令牌并列的第四类凭据，头是 `x-staff-session`。
  await registerAuthRoutes(app);
  await registerChatRoutes(app);
  // 用户端工单（05 §3.4–§3.5，05#02）：建单要邮箱 + 配额 + 幂等；查询用"单号 + 邮箱"，
  // 单号不存在与邮箱不匹配返回同一个 404（避免枚举）。
  await registerTicketRoutes(app);
  // 故障码直查（05 §3.3）：主键命中，不建会话、不调模型。当前**不设令牌门禁** ——
  // 10 §5 要求故障码页在拿到令牌之前就能出卡；这一点与 05 §2 端点表的「User」栏冲突，
  // 已在 `04#03` 的工单注释里记明，若产品要求收紧就在 `06#03` 一并加 401。
  await registerFaultRoutes(app);

  // 坐席端（05 §4.1–§4.3，07#02）：队列 / 详情 / 认领关单 / 统计 + 三个 501 预留端点。
  // 全部走 `requireAdmin`（`src/auth.ts`）：令牌缺失/不匹配一律 401，解析 body 之前就挡住。
  // 放在用户端路由之后、内部路由之前：它是"对外 API"里的最后一档，内部接口的门禁与它无关。
  await registerConsoleRoutes(app);

  // 管理端（`09#04` / S4）：故障卡全状态读写 + 产品线字典 + 人员列表。
  // 放在坐席端之后、内部路由之前：它同样是"对外 API"，门是坐席会话票据 + 最低角色。
  await registerAdminRoutes(app);

  // 知识库（`09#05` / S5）：文档列表/新建/编辑 + 重建索引（异步）+ 回滚 + 停用。
  // 与上一行同一个门（票据 + 最低角色），每条路由的最低角色在 `ROUTE_MIN_ROLE` 里。
  await registerAdminKbRoutes(app);

  // 内部检索调试接口：自带两道门（回环来源 + X-Internal-Token），路由前缀不进对外 API 文档。
  await registerInternalRoutes(app);
  // 业务工具的后端（04#02）：故障码主键命中（05 §5.2）与建单/查单（05 §5.3–§5.4）。
  // 同一套门禁：非回环或错令牌一律 404，与"路径不存在"不可区分。
  await registerInternalFaultRoutes(app);
  await registerInternalTicketRoutes(app);
  // 引用快照落库（05 §5.5，05#01）：只写不校验 —— 校验在对话收尾流程里，顺序不能反过来。
  await registerInternalCitationRoutes(app);

  // 角色表核对（`09#03` / R23）：任何一条注册过的路由在 `ROUTE_MIN_ROLE` 里找不到最低角色，
  // 就抛错让进程起不来。这是本卡最值钱的一行 —— "漏一条 role 检查 = 提权"靠人记不住，
  // 只能靠一条每次启动都跑、跑不过就死的断言压住。
  //
  // 注意它核对的是**注册结果**而不是源码：新增路由的人只要忘了写表，`buildApp()` 立刻失败，
  // 连测试都跑不起来（所有走 `buildApp()` 的用例一起变红），不可能被忽略。
  assertRouteRoles(registeredRoutes);
}
