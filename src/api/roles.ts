/**
 * 路由最低角色表 + 完整性断言（`09#03` / D12 / R23，`docs/output/boundary-change-R2.md` §3 B4）。
 *
 * **这张表要解决的问题**：坐席端与管理端共用一个入口 `/console`、一套 `/api/*` 前缀（D12），
 * 于是"这条路由谁能调"只由代码里那一行守卫决定。漏一行 = 一个提权面，而这种 bug
 * 不报错、不降级、不写日志 —— 它只是安静地发生。所以把"每条路由的最低角色"变成**数据**，
 * 让启动时能机械地核对：注册过的路由只要在表里找不到最低角色，进程就不许起来。
 *
 * **本文件零运行时依赖**：两个 import 都是 `type`（`fastify` 的实例类型、`auth.ts` 的角色类型），
 * 编译期擦除。单测因此可以在没有 .env、没有数据层的情况下直接 import 它。
 *
 * 现状（`09#03` 第一段）是**加法**：表已经写全，但路由仍在用 `requireAdmin`（共享令牌）。
 * 表里的角色是"现状等价"的取值 —— 共享令牌下没有角色区分，`agent` 是最低档，写它不改变任何行为。
 * 真正让每条路由按表守门是同一张卡的后半（子代理 B）：那时 `ROUTE_MIN_ROLE` 才是生效的口径。
 *
 * **`09#04` 起这张表第一次有了"非 agent"的取值**（`/api/admin/*`：`lead` 查看与编辑、
 * `admin` 发布/归档/字典/人员）。那些路由的守卫是 **`api/admin.ts` 的 `minRoleOf()` 现查这张表**
 * —— 路由里没有第二份 `"lead"` 字面量，改这里就改了线上行为，漏一条则 `assertRouteRoles` 让进程起不来。
 * 这也是这张表最想要的用法：权限只有一处可读、一处可改。
 *
 * 键的形状是 `"METHOD /原始路径"`：方法大写、路径用**注册时的原始形式**（含 `:id` 占位与
 * `*` 通配），不做规范化。理由与守卫的失败形状同源：核对必须落在字符串全等上，
 * 任何"差不多就算匹配"的比对都会在某个 `:id` 与 `:slug` 的差别上悄悄放行。
 */
import type { FastifyInstance } from "fastify";
import type { StaffRole } from "../auth.ts";

/**
 * 一条已注册路由的最小形状。只需要方法 + 路径这两样，所以在断言函数里不出现 `FastifyInstance`，
 * 单测可以用一个普通数组造出"漏了一条"的场景，不必为了造假路由去起一个真实例。
 */
export type RouteRef = { method: string; url: string };

/**
 * 全部已注册路由的最低角色。`null` = 不需要坐席身份（公开路由，或只认用户端 `x-user-session`
 * / 内部回环令牌的那几档 —— 它们各有各的门，与坐席角色无关）。
 *
 * 分组顺序与 `src/routes.ts` 的注册顺序一致：读表时能照着启动顺序对下来，漏了一条也容易看出是哪个模块。
 */
export const ROUTE_MIN_ROLE: Readonly<Record<string, StaffRole | null>> = {
  // 探活（05 §7）：给负载均衡器与运维用，没有身份可谈。
  "GET /healthz": null,

  // 静态资源（02 §8：静态资源公开）：两个入口页 + 发布清单。
  // 入口页公开是**刻意**的 —— 页面本身不含数据，数据全在令牌后面；把它藏起来只会让
  // "坐席从哪进"变成口口相传，藏不住任何东西。
  "GET /": null,
  "GET /console": null,
  "GET /assets/*": null,

  // 五语文案（12 §2）：弱网下要先点亮界面、后拿令牌，所以无令牌门禁。
  "GET /api/i18n/:lang": null,

  // 用户端（05 §3）：凭据是匿名令牌 `x-user-session`，与坐席角色正交。
  "POST /api/session": null,
  "POST /api/chat": null,
  "POST /api/ticket": null,
  "GET /api/ticket/:no": null,
  // 故障码直查刻意不设令牌（10 §5：故障码页在拿到令牌前就要能出卡）。
  "GET /api/fault/:code": null,

  // 坐席登录（`09#03` / D8）：登录与登出本身就是"还没有身份 / 要丢掉身份"时用的入口，
  // 给它们设最低角色等于要求先登录才能登录。
  "POST /api/auth/login": null,
  "POST /api/auth/logout": null,

  // 坐席端（05 §4）：现状等价取值 —— 共享令牌下没有角色区分，一律最低档 `agent`。
  // 按角色收紧（如 stats 只给 lead、预留端点只给 admin）是 `09#03` 后半与 09#04/09#05 的活，
  // 那个时候改的就是这张表，而不是再往路由里塞一行 if。
  "GET /api/console/me": "agent",
  "GET /api/console/tickets": "agent",
  "GET /api/console/tickets/:id": "agent",
  "PATCH /api/console/tickets/:id": "agent",
  "GET /api/console/stats": "agent",
  // 转 L2（`09#06`）：一线坐席发现"我搞不定"就该能升级，写 `agent`。
  // 单独的端点而不是 PATCH `{status:"escalated"}`：它还要写 `tags` 且必须幂等（见 core 的 `escalateTicket`）。
  "POST /api/console/tickets/:id/escalate": "agent",

  // FAQ 草稿（`09#06` / A5：未命中池 → 草稿 → 审批 → 入索引）：
  //   - 起稿是**一线坐席**的日常（他是那个刚把问题答出来的人）→ `agent`；
  //   - 列表也归 `agent`：起稿的人要能看见自己那份现在是什么状态；
  //   - **通过 = `admin`**：它把答案切块写进 `chunks`，直接改变用户拿到的回答，
  //     与「发布故障卡」「改知识库正文」同一档签字动作（`09#04`/`09#05` 的分工）；
  //   - **驳回 = `lead`**：不改索引、不删行，只是"这条不进知识库"的判断，与查看/编辑同档；
  //   - **未命中池 = `lead`**：`v_no_hit` 按问题聚合、不带可见性过滤，放开给 `agent` 会把
  //     同事工单的问题原文一并端出来（`09#06` 的取舍，写在 `api/console.ts` 那个处理器上）。
  "POST /api/console/draft": "agent",
  "GET /api/console/drafts": "agent",
  "POST /api/console/drafts/:id/approve": "admin",
  "POST /api/console/drafts/:id/reject": "lead",
  "GET /api/console/no-hit": "lead",

  // 两个预留端点（固定 501）。写在 `agent` 而不是 `admin`：它们今天没有行为，
  // 收紧只会在功能上线那天多一处"明明做完却点不动"的坑。
  "POST /api/console/translate": "agent",
  "POST /api/console/export": "agent",

  // 管理端（`09#04` / S4，`boundary-change-R2.md` §7 第 2 格）：故障卡查看与编辑 `lead` 起，
  // 发布 / 归档 / 字典 CRUD `admin`。
  //
  // 三处刻意的分档，别"顺手统一成 admin"：
  //   - **查看与编辑 draft 归 `lead`**：这是客服主管日常在干的活（补语、改措辞），
  //     要求 admin 才能改一个错字，等于让一个人变成瓶颈。
  //   - **发布 / 归档归 `admin`**：发布是"这条答复可以给用户了"的签字动作。若与编辑同权，
  //     "谁改的"与"谁批的"是同一个人，那这道门就没有意义（D15 的整个理由）。
  //   - **人员列表归 `lead`**（`09#04` 时是 `admin`，`09#05` 放开）：它是派发下拉的数据源，
  //     而派发权限本来就是 `lead`/`admin` 的（`09#03`）。`admin` 专属会让 lead 在界面上
  //     有派单权却读不到人员清单 —— 一条"权限表说能做、数据接口不给读"的自相矛盾。
  "GET /api/admin/faults": "lead",
  "GET /api/admin/faults/:code": "lead",
  "POST /api/admin/faults": "lead",
  "PATCH /api/admin/faults/:code": "lead",
  "POST /api/admin/faults/:code/publish": "admin",
  "POST /api/admin/faults/:code/archive": "admin",
  "GET /api/admin/product-lines": "lead",
  "POST /api/admin/product-lines": "admin",
  "PATCH /api/admin/product-lines/:code": "admin",
  "GET /api/admin/staff": "lead",

  // 知识库（`09#05` / S5，工单 `.scratch/09-admin-console/issues/05-kb-crud.md`）：
  // **读归 `lead`、写归 `admin`**。与故障卡同一档分工，理由也一样：
  //   - 看列表/详情/重建状态（"这篇为什么还是 failed"）是主管要判断的事；
  //   - 改正文、重建索引（会直接改变用户拿到的答案）、回滚、停用是签字动作，归 `admin`。
  // 重建的状态查询与发起分开两档是刻意的：发起是写（改线上索引），查询是读。
  "GET /api/admin/documents": "lead",
  "GET /api/admin/documents/:id": "lead",
  "GET /api/admin/documents/:id/rebuild": "lead",
  "POST /api/admin/documents": "admin",
  "PATCH /api/admin/documents/:id": "admin",
  "POST /api/admin/documents/:id/rebuild": "admin",
  "POST /api/admin/documents/:id/rollback": "admin",
  "POST /api/admin/documents/:id/archive": "admin",

  // 待审反馈（`09#04` 反馈闭环 / D16 / R26）：查看与处置都归 `lead` ——
  // "这批用户的扑空看过了没"是客服主管的日常判断，与故障卡的查看/编辑同档。
  // 真正对外生效的那两步仍分在 `lead`（建 draft）与 `admin`（发布）后面，见上一组。
  "GET /api/admin/fault-reports": "lead",
  "PATCH /api/admin/fault-reports/:id": "lead",

  // 内部接口（05 §5）：门是"来源回环 + `x-internal-token`"两道（见 `auth.ts` 的
  // `internalAuthorized`），失败一律 404。它们不是"某个坐席"能调的接口，写 `null` 才对 ——
  // 写成 `agent` 会暗示"带坐席票据就能进"，那是错的。
  "GET /internal/retrieval/recall": null,
  "POST /internal/search": null,
  "GET /internal/fault": null,
  "POST /internal/fault": null,
  "POST /internal/ticket": null,
  "POST /internal/ticket/lookup": null,
  "GET /internal/ticket/:no": null,
  "POST /internal/citations": null,
};

/** 表键的唯一拼法。方法大写是唯一的规范化 —— 路径一个字符都不动（见文件头）。 */
export function routeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

/**
 * 查一条路由的最低角色。三种返回值是三个不同的意思，不能合并：
 *   - `null`      = 表里写了"不需要坐席身份"；
 *   - `"agent" | "lead" | "admin"` = 表里写了最低角色；
 *   - `undefined` = **表里没有这条路由**（键写错、路由新增但表没跟上）。
 *
 * `undefined` 必须与 `null` 分开：把"没写"当成"公开"就是一张自动生成的放行条。
 */
export function minRoleFor(method: string, url: string): StaffRole | null | undefined {
  const key = routeKey(method, url);
  return Object.hasOwn(ROUTE_MIN_ROLE, key) ? ROUTE_MIN_ROLE[key] : undefined;
}

/**
 * 挂上路由收集器。必须在**注册任何路由之前**调用：`onRoute` 是注册那一刻触发一次的钩子，
 * 晚挂一条都收不到。
 *
 * 返回的数组是活的（钩子往里 push），注册完成后交给 `assertRouteRoles` 即可。
 * `FastifyInstance` 只作为 `import type` 出现，本模块在运行时依然不依赖 fastify。
 */
export function collectRegisteredRoutes(app: FastifyInstance): RouteRef[] {
  const routes: RouteRef[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      // 用 `route.url` 而不是 `route.routePath`：前者带上注册前缀，是客户端真正请求的那个路径。
      routes.push({ method: method.toUpperCase(), url: route.url });
    }
  });
  return routes;
}

export type RouteRoleAudit = {
  /** 参与核对的路由条数（自动派生的 HEAD 不计，见 `auditRouteRoles`）。 */
  registered: number;
  /** 注册了、表里却没有最低角色（或写了 `undefined`）的路由键。**必须为空**。 */
  missing: string[];
  /** 表里有、实际却没注册的键。不影响安全，但说明表已过期（路由改名/删除了）。 */
  extra: string[];
};

/**
 * 双向核对：注册的路由是否每一条都在表里，表里是否每一条都还在用。
 *
 * **HEAD 的处理**：Fastify 的 `exposeHeadRoutes`（默认开启）会为每条 `GET` 自动派生一条 HEAD，
 * 处理器与 GET 是同一个函数 —— 门禁跟着 GET 走，所以它不单独占一行，否则表里会有一半是噪音。
 * 显式在表里写了 `HEAD /x` 时仍按表核对（万一将来真有人手写 `app.head`）。
 *
 * 只做核对、不抛错：抛错在 `assertRouteRoles`。分开是因为"多出来的表项"不该让进程起不来
 * （表过期是卫生问题），而"漏了一条"必须让进程起不来（漏一条就是提权）。
 */
export function auditRouteRoles(
  routes: readonly RouteRef[],
  table: Readonly<Record<string, StaffRole | null>> = ROUTE_MIN_ROLE,
): RouteRoleAudit {
  const keys = new Set<string>();
  for (const route of routes) {
    const key = routeKey(route.method, route.url);
    if (route.method === "HEAD" && !Object.hasOwn(table, key)) continue;
    keys.add(key);
  }

  const missing: string[] = [];
  for (const key of keys) {
    const min = Object.hasOwn(table, key) ? table[key] : undefined;
    if (min === undefined) missing.push(key);
  }

  const extra = Object.keys(table).filter((key) => !keys.has(key));
  return { registered: keys.size, missing, extra };
}

/**
 * 启动断言（R23）：表里缺任何一条注册过的路由 → **抛错，进程起不来**。
 *
 * 错误信息必须点出缺的是哪条：这条断言的价值全在"看到就改"，一条只说"表不完整"的
 * 报错会让人先去翻日志、再翻代码，最后往往被"先注释掉跑起来"绕过。
 *
 * 不写日志、不调 `process.exit`：这里是纯函数，由 `registerRoutes` 抛出去，
 * 让 `server.ts` 的启动流程决定怎么退出（进程怎么死归它管，这里只管"必须死"）。
 */
export function assertRouteRoles(
  routes: readonly RouteRef[],
  table: Readonly<Record<string, StaffRole | null>> = ROUTE_MIN_ROLE,
): RouteRoleAudit {
  const audit = auditRouteRoles(routes, table);
  if (audit.missing.length > 0) {
    throw new Error(
      `ROUTE_MIN_ROLE 不完整：${audit.missing.length} 条已注册路由没有最低角色 —— ` +
        `${audit.missing.join("、")}。` +
        `漏一条角色检查就是一个提权面（R23），进程拒绝启动。` +
        `在 src/api/roles.ts 的 ROUTE_MIN_ROLE 里补上（公开/用户端/内部接口写 null，坐席接口写最低角色）。`,
    );
  }
  return audit;
}
