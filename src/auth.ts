/**
 * 三档鉴权的**唯一口径**（`05-api.md` §1、`07-console-and-security` spec §Implementation Decisions）。
 *
 * 三档的保护对象与对手不同，所以失败形状**刻意不一致** —— 这不是不一致，是三种语义：
 *
 *   - **用户端**（`X-User-Session` 命中 Redis `sess:{uuid}`）→ 401 `AUTH_REQUIRED` / `AUTH_INVALID`。
 *     对手是"过期标签页"而不是扫描器：前端必须能区分"会话过期（重新 POST /api/session 换令牌）"
 *     与"服务出错"，否则一个过期的页面只会一直转圈。前端文案 key 都是 `chat.err.auth`（05 §6）。
 *   - **坐席端**（`X-Staff-Session` 命中 Redis `staff_session:{ticket}`）→ 401 `AUTH_REQUIRED`。
 *     对手是"能打开页面的人"：它守的是客户对话与邮箱，失败必须让人一眼看出是"还没登录 /
 *     会话过期了"，而不是"服务坏了"。身份不再是客户端自称的（共享令牌 + 头部自称坐席的
 *     `X-Admin-Staff` 已退场，见 `docs/output/boundary-change-R2.md` §3 B5）：一个请求能做什么，
 *     由服务端在会话里记着的角色决定（`requireRole`）。
 *     这里用 401 而不是 404 不泄露任何东西：坐席接口的路径本身写在 PRD 与前端代码里，
 *     藏它是自欺；要藏的是**内容**，而内容由会话票据守。
 *   - **内部接口**（`X-Internal-Token` 全等 **且** 来源回环）→ **404**，且与"路径根本不存在"
 *     逐字同形。对手是公网扫描器：401 等于告诉它"这个端点存在，只缺凭据"，换来的是持续爆破。
 *
 * **为什么必须收敛成一个文件**：收敛前 `api/chat.ts` 与 `api/ticket.ts` 各自抄了一份 12 行的
 * 用户令牌校验、`api/internal.ts` 里有第三份（两道门）。三份实现里改一份漏一份的症状是
 * "某个入口悄悄放行"——这种 bug 不报错、不降级，只是发生。现在 G5 只需读这一个文件。
 *
 * 规格内部有一处自相矛盾，已裁定（见 `sendNotFound` 上方的说明）：内部接口失败一律 404。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";
// **类型专用**（`09#03`）：角色类型的唯一来源是 `core/auth-login.ts`，这里只转发不另立定义。
// 用 `import type` 所以它在编译期就被擦除 —— 本文件不会因此把 scrypt / 写库 / ioredis
// 拖进 import 者的运行时依赖图（"守卫模块零副作用"那条长注释见下方 Redis 延迟加载处）。
import type { StaffRole } from "./core/auth-login.ts";
import { AppError } from "./errors.ts";
import { logger } from "./logger.ts";

/* ────────────────────────── 三个凭据头 ────────────────────────── */

/**
 * Redis 客户端**延迟加载**，不在模块顶层 `import`。
 *
 * 这一行是本卡踩出来的：`api/internal-*.ts` 只为了拿内部两道门而 import 本文件，一旦这里
 * 顺手把 `redis.ts` 拉起来，ioredis 就会在 import 期建立连接并挂住事件循环 —— 于是一个
 * **从不做用户鉴权**的路由（`/internal/fault`）会让进程永远退不出去：`node:test` 的
 * `tests/fault-lookup.test.ts` 八个断言全绿，文件级结果却是 `not ok`（超时被杀），全量
 * `npm test` 卡在那里不动。守卫模块被谁 import，谁就继承它的副作用；能没有副作用就不要有。
 *
 * 缓存 Promise 而不是客户端：并发请求同时到达时只 import 一次，不会各自建一条连接。
 */
let redisPromise: Promise<typeof import("./redis.ts")> | undefined;
function redisClient(): Promise<import("ioredis").Redis> {
  redisPromise ??= import("./redis.ts");
  return redisPromise.then((mod) => mod.redis);
}

/**
 * 会话读取器**同样延迟加载**（`09#03` 第二段）。理由与上面的 Redis 完全相同，但更尖锐：
 * `core/auth-login.ts` 在模块顶层 `import { redis }` 与 `import { one, query } from db.ts`，
 * 一旦本文件静态 import 它，所有只是"想拿一个守卫"的路由都会在 import 期拉起 ioredis +
 * 建 pg 池 —— `tests/roles.test.ts`（纯函数、无 .env、无数据层）也会跟着挂住。
 *
 * 缓存 Promise 而不是函数：并发首请求只 import 一次。
 */
let staffReaderPromise: Promise<typeof import("./core/auth-login.ts")> | undefined;
function staffReader(): Promise<typeof import("./core/auth-login.ts")> {
  staffReaderPromise ??= import("./core/auth-login.ts");
  return staffReaderPromise;
}

/** 05 §1：用户端匿名令牌。 */
export const USER_SESSION_HEADER = "x-user-session";
/**
 * 05 §1 / `09#03`：坐席端**会话票据**（登录后由 `POST /api/auth/login` 签发）。
 *
 * 常量定义在这里而不是 `api/auth.ts`：两个文件都要读它，而 `api/auth.ts` 会拉起 redis
 * （限速与登录都要用），守卫文件不能反向依赖它。定义在零副作用的一侧，谁都能 import。
 */
export const STAFF_SESSION_HEADER = "x-staff-session";
/** 05 §1：内部接口令牌。 */
export const INTERNAL_TOKEN_HEADER = "x-internal-token";

/**
 * uuid 形状。三档里有一档的凭据是 uuid（用户令牌），一个正则只写一次。
 *
 * 为什么必须**先判形状再看库**：`conversations.token_id` 是 uuid 列，拿
 * `"not-a-token"` 去查会变成 500（22P02）—— 而"这串东西根本不是我们签发的"与"这个 id 不存在"
 * 对调用方是同一件事，应当是 401 而不是服务端错误。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 取一个请求头的值。重复的同名头在 Node 里会变成数组，这种请求不是任何正常客户端发的，
 * 一律当作"没给"（= 401 AUTH_REQUIRED）：它能达成的唯一效果是自己被挡在门外。
 * 首尾空白一并去掉 —— 头部值里的 OWS 不是凭据的一部分（`config` 读 env 时也 trim）。
 */
function headerValue(request: FastifyRequest, name: string): string {
  const raw = request.headers[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * 全等比较，但**不做短路**：先各自 sha256 再 `timingSafeEqual`。
 *
 * 直接写 `a === b` 有两个可指摘之处：比较在第一个不同字节就返回（远端可以按响应时间猜前缀），
 * 以及长度不同立刻返回（泄露"令牌多长"）。这两点在局域网演示里都不足以被真利用，但内部令牌是
 * 现在唯一一条**从网络可达**的静态凭据（坐席端的静态令牌已退场），把它做成常数时间只多一次
 * 哈希，没有理由不做。
 *
 * 哈希而不是直接 `timingSafeEqual(provided, expected)`：后者要求两个 Buffer 等长，
 * 而"长度不等就先补齐"的写法会引入新的长度分支，等于没修。
 */
function tokenEquals(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/* ────────────────────────── 用户端 ────────────────────────── */

/**
 * 用户端令牌校验（05 §1）：`X-User-Session` 必须命中 Redis `sess:{uuid}` 且未过期。
 *
 * 返回令牌本身而不是 boolean：调用方（`/api/chat`、`/api/ticket`）还要拿它做会话归属
 * （`conversations.token_id`）与配额维度（`quota:ticket:{token}`）。让校验把令牌"消耗掉"、
 * 调用方再从请求头里读一遍，就是第二个读取点 —— 两处 trim 规则不一样的那天，配额就会记到
 * 另一个键上。
 *
 * 两种失败给两个码，是因为前端行为不同：`AUTH_REQUIRED` = 我们这个页面自己没带令牌（前端 bug），
 * `AUTH_INVALID` = 令牌过期（重新签发即可，`06` 的"会话过期自动续"就靠它）。
 */
export async function requireUser(request: FastifyRequest): Promise<string> {
  const token = headerValue(request, USER_SESSION_HEADER);
  if (token === "") throw new AppError("AUTH_REQUIRED", "缺少会话令牌");

  // 非 uuid 形状直接判过期：它不可能是我们签发的令牌（`/api/session` 只发 v4）。
  if (!UUID_RE.test(token)) throw new AppError("AUTH_INVALID", "会话已过期，请刷新页面");
  // 只查存在性不读值：Redis 里那个值是 "1"，它不是会话内容，会话内容在 Postgres。
  const exists = await (await redisClient()).exists(`sess:${token}`);
  if (exists !== 1) throw new AppError("AUTH_INVALID", "会话已过期，请刷新页面");
  return token;
}

/* ────────────────────────── 坐席端 ────────────────────────── */

/**
 * 坐席端身份。`staffId` 是认领时要写进 `tickets.assignee` 的那一列，`role` 是角色门的输入。
 *
 * 四个字段都来自**服务端会话**（Redis 里那段由 `POST /api/auth/login` 写入的身份快照），
 * 不是客户端在请求头里自称的 —— 这是 `09#03` 全部意义所在（R20：身份可自称时
 * "谁认领的 / 谁关的"两个审计字段没有意义）。
 */
export type AdminPrincipal = { staffId: string; staffName: string; role: StaffRole; email: string };

/**
 * 坐席端守卫：`X-Staff-Session` → Redis 会话 → 身份。这是**坐席路由唯一该调的守卫**。
 *
 * 为什么不再查库核对坐席是否存在 / 是否停用：会话是登录时创出来的，登录时已经校验过
 * `active`，而"停用一个账号要立刻生效"的路径是 `revokeAllStaffSessions()`（删 Redis 键），
 * 不是每次请求回库一次。票据本身只有 64 个 hex 字符、库里只存 sha256，不可能是我们没签发的东西。
 *
 * 两条失败语义：
 *   - 没有票据 → 401 `AUTH_REQUIRED`（前端该回登录页）；
 *   - 票据在 Redis 里不存在（过期 / 已登出 / 已吊销）→ **也是 401 `AUTH_REQUIRED`**。
 *     两种失败对调用方的行动完全一致（重新登录），分成两个码只会让前端多一个分支；
 *     而且"这个票据是不是真的存在过"不该由响应体回答（那是一条会话存在性预言机）。
 *     差异只进日志：`AUTH_REQUIRED` 的 message 与前者不同，但两者都是中文提示、都不带票据。
 *
 * `X-Admin-Staff`（客户端自称坐席、缺省取 `staff` 表第一条）已退场，见
 * `docs/output/boundary-change-R2.md` §3 B5、§6「不做双轨」。
 */
export async function requireAdmin(request: FastifyRequest): Promise<AdminPrincipal> {
  const ticket = headerValue(request, STAFF_SESSION_HEADER);
  if (ticket === "") throw new AppError("AUTH_REQUIRED", "缺少坐席会话票据");

  const { readStaffSession } = await staffReader();
  const staff = await readStaffSession(ticket);
  if (staff === null) {
    // 只记来源 IP：这条日志的用途是"有人在撞坐席票据"，而票据本身等价于凭据，一个字都不能进日志。
    logger.warn({ ip: request.ip }, "auth: 坐席会话票据无效或已过期");
    throw new AppError("AUTH_REQUIRED", "未登录或会话已过期");
  }
  return { staffId: staff.staffId, staffName: staff.staffName, role: staff.role, email: staff.email };
}

/* ────────────────────────── 角色门 ────────────────────────── */

/** 角色类型对外从本文件转发（定义在 `core/auth-login.ts`，见文件头 import 处的说明）。 */
export type { StaffRole };

/**
 * 等级。数字只在本文件里用来比较，不进响应、不进库、不进日志。
 * 这是**唯一**一处等级定义：加角色就加在这里（漏加的话 `requireRole` 会把它当"未知角色"
 * 一律拒绝 —— 失败方向是安全的，但功能是坏的，所以宁可让它显眼）。
 */
const ROLE_RANK: Readonly<Record<StaffRole, number>> = { agent: 0, lead: 1, admin: 2 };

/**
 * 角色门（`09#03` / D12 / R23）：**纯函数** —— 不读 Redis、不查库、不 import 登录模块。
 *
 * 调用方先拿身份（`src/api/auth.ts` 的 `currentStaff(request)`），再调这里：
 *
 * ```ts
 * requireRole(await currentStaff(request), ROUTE_MIN_ROLE["GET /api/console/tickets"] ?? "agent");
 * ```
 *
 * 为什么分成两步而不是 `requireRole(request, "lead")`：守卫要能被单测直接调用。
 * 一个"必须先有一条 Redis 会话才能测"的守卫，测出来的永远是"拒绝路径"，等级比较本身没人验。
 *
 * 两条失败语义：
 *   - 身份为 `null`（没登录 / 票据过期）→ 401 `AUTH_REQUIRED`，前端回登录页换票据；
 *   - 等级不足 → 403 `FORBIDDEN`，前端**不清**登录态（D31），只提示。
 *
 * `role` 在运行时可能是任意字符串（Redis 里那段 JSON 是数据，不是类型）：
 * 认不出来的角色一律按**最低**处理（`-1`），也就是全部拒绝。方向不能反 ——
 * 一个手改 `staff.role` 写成 `root` 的账号，如果按"未知即通过"处理，那就是一条提权后门。
 */
export function requireRole(principal: { role: StaffRole } | null, min: StaffRole): void {
  if (principal === null) throw new AppError("AUTH_REQUIRED", "未登录或会话已过期");
  const actual = rankOf(principal.role);
  const required = rankOf(min);
  // `required === -1`（表里写了不存在的角色）同样落到这里：要求的东西都不存在，就别放行。
  if (required === -1 || actual < required) {
    throw new AppError("FORBIDDEN", `权限不足：需要 ${min} 及以上角色`);
  }
}

function rankOf(role: string): number {
  return Object.hasOwn(ROLE_RANK, role) ? ROLE_RANK[role as StaffRole] : -1;
}

/* ────────────────────────── 内部接口 ────────────────────────── */

/**
 * 回环判定。`request.socket.remoteAddress` 由内核给出，**不可由客户端伪造** ——
 * `X-Forwarded-For` / `X-Real-IP` 一律不认（认了就等于把这道门交给请求方自己声明）。
 * 将来真上反向代理时，正确做法是 `trustProxy` + 限制来源代理网段，而不是在这里读头。
 *
 * 三种形态都要认（`18-human-gates.md` §8 只写了 127.0.0.1，那不够）：
 *   - `127.0.0.0/8` 整段都是回环，不局限于 `.0.1`；
 *   - `::1` 是 IPv6 的回环；
 *   - `::ffff:127.x.x.x` 是 Node 在 dual-stack 监听下最常见的 IPv4-mapped 形态 —— 漏了它，
 *     本地工具会在"服务明明起在 127.0.0.1 上"的情况下全部拿到 404。
 *
 * 为什么是正则而不是 `startsWith("127.")`（G5 黑线）：`'127.evil.com'` 之类的串前缀相同，
 * 判断必须落在每一个字节上。
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address === "") return false;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (normalized === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * 内部接口的两道门：来源回环 **且** `X-Internal-Token` 与 `config.internalToken` 全等。
 *
 * 两道缺一不可，而且**顺序无关但都要过**：只靠令牌，一次配置泄漏就把检索接口变成公网免费
 * 搜索引擎；只靠回环，一台被反代暴露的容器会把"内网就安全"变成事故。
 *
 * 返回 boolean 而不是直接抛错，是为了让调用方**必须**自己决定失败形状 —— 四个内部端点
 * 的失败必须是同一个 404（见 `sendNotFound`），如果这里抛 `AppError`，形状就由 `errors.ts`
 * 决定，401 会从某个端点漏出去。
 */
export function internalAuthorized(request: FastifyRequest): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
  const provided = headerValue(request, INTERNAL_TOKEN_HEADER);
  if (provided === "") return false;
  // 常数时间比较（与用户端/坐席端的 Redis 查表无关，那两个不是静态比对）。回环来源的计时
  // 侧信道本不成立（前提是远端能无限次测量），但"凭据用两种比较方式"是审查时要逐个确认的差异，
  // 不如只有一种。
  return tokenEquals(provided, config.internalToken);
}

/**
 * 内部接口的失败响应：**与"路径根本不存在"逐字同形**的 404（只差每次请求各自的 `trace_id`）。
 *
 * **规格自相矛盾，这里取 404（已裁定，不要再改成 401）**：
 *   - `07` spec §Testing Decisions 与 `18-human-gates.md` §8 红线 ① 的示例写"回环 + 错令牌 → 401"；
 *   - 同一份 spec 的 §Implementation Decisions、工单 01 的 What-to-build、以及 `05-api.md` §2
 *     的端点表（内部端点不对外）写的是"任一不满足返回 404（不泄露端点存在性）"。
 * 取 404 的理由更硬：401 与 403 都是**承认端点存在**的响应，扫描器拿到它就会持续爆破；
 * 而 404 与"随便打一个不存在的路径"在响应体、状态码、耗时上都不可区分。现有实现与
 * `tests/retrieval-recall.test.ts` / `tests/ticket-internal.test.ts` 断言的也正是 404，
 * 改造成 401 会让这两条既有断言变成"证明了一个错误的设计"。
 *
 * 文案固定英文 `Not found` 而不是走 `AppError("NOT_FOUND")`：这里要的是**与真 404 逐字一致**，
 * 而真 404 由 `server.ts` 的 `setNotFoundHandler` 产出，任何一处改动都会让两者分叉。
 */
export function sendNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(404).send({
    ok: false,
    error: { code: "NOT_FOUND", message: "Not found", trace_id: String(request.id) },
  });
}
