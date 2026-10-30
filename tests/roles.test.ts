/**
 * 角色门与路由表的机械压条（`09#03` 第一段 / D12 / R23）。
 *
 * 三条断言，防的是三件不同的事：
 *   1. 路由跑出表外 —— 新加一条 `/api/console/*` 而忘了写最低角色，启动就该失败（漏一条 = 提权）；
 *   2. 表跑出路由外 —— 路由改名/删除后表里留死键，"表已过期"也该被看见；
 *   3. 等级比较本身 —— `requireRole` 是纯函数，等级、401/403、未知角色三条路径都在这里验，
 *      不靠"起一个真会话再试"来间接证明。
 *
 * 本文件**不用 skip**：缺 .env 时直接断言失败，因为"这一卡的关键门禁没跑"不该以绿色示人。
 * 读 .env 的做法与 `tests/console-api.test.ts` 一致（`npm test` 不带 `--env-file`）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { StaffRole } from "../src/auth.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与其它测试同一套 .env 解析：行内 `#` 之后是注释、成对引号去掉。 */
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

/** 本卡收口时的路由条数（不含 Fastify 自动派生的 HEAD）。新增路由要**主动**改这个数。 */
const EXPECTED_ROUTES = 53; // 48（09#01–09#05）+ 5 条（09#06：转 L2 / 草稿列表 / 通过 / 驳回 / 未命中池）

/**
 * 已注册路由 ↔ `ROUTE_MIN_ROLE` 双向一致。
 *
 * 走的是线上那一对函数（`collectRegisteredRoutes` + `registerRoutes`），不是测试自己再抄一份收集逻辑：
 * 一条"测试里收了、线上没收"的钩子会让这张门禁变成自证。
 *
 * 不用 `buildApp()`（它会挂错误处理器、not-found 处理器，与这张卡无关），但 `src/routes.ts`
 * 会拉起 redis / pg 的模块级客户端 —— 所以 `finally` 里必须 `redis.disconnect()`，
 * 否则 ioredis 挂住事件循环、`node --test` 永远不退出（`src/auth.ts` 注释里记过的坑）。
 */
test("已注册路由全部在 ROUTE_MIN_ROLE 表里，且表里没有多余项", async () => {
  assert.ok(hasRuntimeEnv, missingRuntimeEnvHint);

  const [{ default: Fastify }, roles, routes, { redis }, { pool }] = await Promise.all([
    import("fastify"),
    import("../src/api/roles.ts"),
    import("../src/routes.ts"),
    import("../src/redis.ts"),
    import("../src/db.ts"),
  ]);

  const app = Fastify({ logger: false });
  try {
    const registered = roles.collectRegisteredRoutes(app);
    await routes.registerRoutes(app);

    const audit = roles.auditRouteRoles(registered);
    assert.deepEqual(
      audit.missing,
      [],
      `这些已注册路由在 ROUTE_MIN_ROLE 里没有最低角色（漏一条 = 提权面）：${audit.missing.join("、")}`,
    );
    assert.deepEqual(
      audit.extra,
      [],
      `ROUTE_MIN_ROLE 里这些键已经不对应任何路由（路由改名或删除后表没跟上）：${audit.extra.join("、")}`,
    );
    assert.equal(
      audit.registered,
      EXPECTED_ROUTES,
      `路由条数变了（${audit.registered} ≠ ${EXPECTED_ROUTES}）：确认新路由的最低角色后再改这个常量`,
    );

    // 抽查四档：公开 / 用户端 / 坐席 / 内部。它们分别代表四种凭据口径，任何一档错位都是设计事故。
    assert.equal(roles.minRoleFor("GET", "/healthz"), null, "探活无身份");
    assert.equal(roles.minRoleFor("GET", "/api/ticket/:no"), null, "用户端凭 x-user-session，与坐席角色无关");
    assert.equal(roles.minRoleFor("POST", "/api/console/draft"), "agent", "预留端点也是坐席接口");
    assert.equal(roles.minRoleFor("POST", "/internal/search"), null, "内部接口的门是回环 + 内部令牌");
    assert.equal(roles.minRoleFor("GET", "/api/nope/:id"), undefined, "表里没有的路由必须回 undefined，不是 null");

    // 结构断言（比逐条列举更能压住"将来新增的坐席接口"）：`/api/console/*` 不许出现在公开档。
    for (const route of registered) {
      if (route.method === "HEAD" || !route.url.startsWith("/api/console")) continue;
      assert.notEqual(
        roles.minRoleFor(route.method, route.url),
        null,
        `坐席接口 ${route.method} ${route.url} 被写成了公开路由（null）`,
      );
    }
  } finally {
    await app.close();
    redis.disconnect();
    await pool.end();
  }
});

/**
 * 启动断言本身：表里漏一条 → 抛错，且**点出缺的是哪条**。
 *
 * 这里用一个最小实例 + 一份故意缺项的表，不碰真表：真表永远是全的（上一条用例守着它），
 * 所以"漏了会怎样"只能在这条里验。同时验证 HEAD 的规则 —— Fastify 的 `exposeHeadRoutes`
 * 会给每条 GET 派生一条 HEAD，处理器是同一个函数，所以它不单独占一行。
 */
test("故意漏一条 → 启动断言失败，并在错误信息里点出缺的那条", async () => {
  const [{ default: Fastify }, roles] = await Promise.all([
    import("fastify"),
    import("../src/api/roles.ts"),
  ]);

  const probe = Fastify({ logger: false });
  const registered = roles.collectRegisteredRoutes(probe);
  probe.get("/__probe/public", async () => "ok");
  probe.post("/__probe/gated", async () => "ok");
  await probe.ready();

  try {
    // 控制组：表全 → 不抛；自动派生的 `HEAD /__probe/public` 不该要求单独一行。
    const audit = roles.assertRouteRoles(registered, {
      "GET /__probe/public": null,
      "POST /__probe/gated": "agent",
    });
    assert.equal(audit.missing.length, 0);
    assert.equal(audit.registered, 2, "HEAD 不进核对集合");

    // 漏一条 → 抛，且错误信息里出现具体路由（不点出来人就会先注释掉跑起来）
    assert.throws(
      () => roles.assertRouteRoles(registered, { "GET /__probe/public": null }),
      /POST \/__probe\/gated/,
      "缺项必须让启动失败，并指出缺的是哪条",
    );

    // 反向：多一条不拦启动（表过期是卫生问题），但审计要能报出来
    const stale = roles.auditRouteRoles(registered, {
      "GET /__probe/public": null,
      "POST /__probe/gated": "agent",
      "DELETE /__probe/gone": "admin",
    });
    assert.deepEqual(stale.extra, ["DELETE /__probe/gone"]);

    // 方法大小写不该影响核对：表键是 `METHOD path`，方法一律大写（`minRoleFor`/审计共用这一个拼法）
    assert.equal(roles.routeKey("get", "/__probe/public"), "GET /__probe/public");
  } finally {
    await probe.close();
  }
});

/**
 * 等级比较。`agent < lead < admin`，两条失败语义分开：没登录 401、权限不足 403。
 *
 * `src/auth.ts` 在运行时 import 了 `config.ts`（它要求 .env 齐全），所以这条也断言 env。
 */
test("requireRole：agent<lead<admin；未登录 401，等级不足 403，未知角色一律拒绝", async () => {
  assert.ok(hasRuntimeEnv, missingRuntimeEnvHint);
  const [{ requireRole }, { AppError, ERROR_CODES }] = await Promise.all([
    import("../src/auth.ts"),
    import("../src/errors.ts"),
  ]);

  const forbidden = (err: unknown): boolean =>
    err instanceof AppError && err.code === "FORBIDDEN" && err.status === 403;
  const authRequired = (err: unknown): boolean =>
    err instanceof AppError && err.code === "AUTH_REQUIRED" && err.status === 401;

  // agent：过 agent 门，被 lead/admin 拦
  assert.doesNotThrow(() => requireRole({ role: "agent" }, "agent"));
  assert.throws(() => requireRole({ role: "agent" }, "lead"), forbidden);
  assert.throws(() => requireRole({ role: "agent" }, "admin"), forbidden);

  // lead：过 agent/lead，被 admin 拦
  assert.doesNotThrow(() => requireRole({ role: "lead" }, "agent"));
  assert.doesNotThrow(() => requireRole({ role: "lead" }, "lead"));
  assert.throws(() => requireRole({ role: "lead" }, "admin"), forbidden);

  // admin：全过
  assert.doesNotThrow(() => requireRole({ role: "admin" }, "agent"));
  assert.doesNotThrow(() => requireRole({ role: "admin" }, "lead"));
  assert.doesNotThrow(() => requireRole({ role: "admin" }, "admin"));

  // 没登录：401 AUTH_REQUIRED（前端据此回登录页），不是 403
  assert.throws(() => requireRole(null, "agent"), authRequired);
  assert.throws(() => requireRole(null, "admin"), authRequired);

  // Redis 快照里的 role 是数据、不是类型：认不出来的一律按最低处理（否则就是一条提权后门）
  const tampered = { role: "root" as unknown as StaffRole };
  assert.throws(() => requireRole(tampered, "agent"), forbidden);

  // 403 这个码是本卡新增的，语义不能与两条 401 混
  assert.equal(ERROR_CODES.FORBIDDEN, 403);
  assert.equal(ERROR_CODES.AUTH_REQUIRED, 401);
  assert.equal(ERROR_CODES.AUTH_INVALID, 401);
});
