/**
 * 管理端两条路由文件（`api/admin.ts` / `api/admin-kb.ts`）共用的守卫与入参小工具。
 *
 * **为什么单独一个文件**：`09#04` 与 `09#05` 并行落地时，两张卡在同一批函数上各写了一份
 * 副本（"先认证 401、后授权 403、两件事都在解析 body 之前"）。副本能跑，但那是**鉴权口径
 * 有两份**：改一处漏一处不会报错，漏的那份仍然照常放行。这里把口径收成一份，两个路由文件
 * 只保留"哪条路由叫什么、交给 core 做什么"。
 *
 * **顺序不许动**：先 `requireAdmin`（读会话票据 → 401）再 `requireRole`（等级不足 → 403）。
 * 反过来会出现"没登录却被告知权限不足"，前端的分流（401 回登录页 / 403 只提示不清票据，D31）
 * 就全错了。两者都在**解析 body 之前**：未授权的请求不该触发任何校验分支。
 */
import type { FastifyRequest } from "fastify";
import { requireAdmin, requireRole, type AdminPrincipal, type StaffRole } from "../auth.ts";
import type { AdminActor } from "../core/admin-store.ts";
import { AppError } from "../errors.ts";
import { minRoleFor } from "./roles.ts";

/** 审计要的人：角色不进 core（见 `core/admin-store.ts` 的 `AdminActor`）。 */
export function actorOf(principal: AdminPrincipal): AdminActor {
  return { staffId: principal.staffId, staffName: principal.staffName };
}

/**
 * 从表里取最低角色。`undefined`（路由没写进表）与 `null`（被写成公开）都**拒绝**：
 * 失败方向必须是"谁都进不来"。启动断言本应在更早的地方拦住这两种情况，这里再兜一次是因为
 * 这道兜底的代价只有一行，而漏过去的代价是一个没有任何门的写接口。
 */
export function minRoleOf(method: string, url: string): StaffRole {
  const min = minRoleFor(method, url);
  if (min === undefined) throw new Error(`ROUTE_MIN_ROLE 缺少 ${method} ${url}（管理端接口必须有最低角色）`);
  if (min === null) throw new Error(`${method} ${url} 被写成公开路由（null），管理端接口必须有最低角色`);
  return min;
}

/** 先认证（401）后授权（403）。两件事都在路由处理器的最前面，任何入参解析都不该更早发生。 */
export async function guard(request: FastifyRequest, method: string, url: string): Promise<AdminPrincipal> {
  const principal = await requireAdmin(request);
  requireRole(principal, minRoleOf(method, url));
  return principal;
}

export function requireBodyRecord(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("VALIDATION", "请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}
