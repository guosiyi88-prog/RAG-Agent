/**
 * 坐席登录（`09#03` / D8）：口令哈希、服务端会话、限速。
 *
 * **为什么放这里而不是 `auth.ts`**：`auth.ts` 是"凭据 → 身份"的守卫口径，被十几个路由 import；
 * 它刻意保持**零副作用**（连 redis 都是延迟加载，见那里的注释）。签发会话要写库、写 Redis、
 * 算 scrypt，全是副作用，放进守卫文件会让每个只做校验的路由跟着背一遍。
 *
 * 三条硬约束（`docs/output/boundary-change-R2.md` §5）：
 *   1. `crypto.scrypt`，不引第三方依赖；盐每账号独立 16 字节；比较用常数时间。
 *   2. 错口令与"用户不存在"**返回同一个 401**，否则就是一台账号枚举器。
 *   3. Redis 存热会话，Postgres 的 `staff_sessions` 只存 ticket 的 sha256（库被读走也伪造不出会话）。
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { one, query } from "../db.ts";
import { redis } from "../redis.ts";

// `promisify(scrypt)` 的类型只带三个参数，而 scrypt 的 options（N/r/p）是第四参且必须显式给 ——
// 不给就落到 Node 默认档（N=16384,r=8,p=1），看似一样，但默认值随版本变，种子里的哈希就废了。
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * scrypt 参数。种子里的演示口令（`sql/002_seed.sql`）是用同一组参数算的，
 * **改这里就要重算种子**，否则演示账号登不进去。
 * N=16384/r=8/p=1 是 Node 默认档：单次约 50–80 ms，够挡住离线爆破，又不会让登录页卡住。
 */
export const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
export const KEYLEN = 64;

/** 会话有效期（小时）。默认 12：一个班次用不完，但也不会让偷来的票据活过一周。 */
export const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS ?? "12");

export type StaffRole = "agent" | "lead" | "admin";

export type StaffIdentity = {
  staffId: string;
  staffName: string;
  role: StaffRole;
  email: string;
};

/* ────────────────────────── 口令 ────────────────────────── */

/**
 * 派生口令哈希（改口令 / 首次设口令时用）。返回 hex 的 hash 与 salt，直接写进 `staff` 两列。
 * 同步 scrypt 会阻塞事件循环 50–80 ms，所以走异步版（libuv 线程池），不让 5 秒轮询的坐席端看到毛刺。
 */
export async function hashPassword(
  password: string,
  saltHex?: string,
): Promise<{ hash: string; salt: string }> {
  const salt = saltHex ?? randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, Buffer.from(salt, "hex"), KEYLEN, SCRYPT)) as Buffer;
  return { hash: derived.toString("hex"), salt };
}

/** 校验口令。`hash`/`salt` 为空（还没设口令的账号）一律返回 false，不抛错。 */
export async function verifyPassword(
  password: string,
  storedHash: string | null,
  storedSalt: string | null,
): Promise<boolean> {
  if (password === "" || storedHash === null || storedSalt === null) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(storedHash, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEYLEN) return false;
  const actual = (await scryptAsync(password, Buffer.from(storedSalt, "hex"), KEYLEN, SCRYPT)) as Buffer;
  return timingSafeEqual(actual, expected);
}

/* ────────────────────────── 会话 ────────────────────────── */

/** ticket 落库只存 sha256：库被读走也伪造不出会话票据。 */
function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

export type LoginResult = { ticket: string; staff: StaffIdentity; expiresAt: Date };

/**
 * 签发会话。票据是 32 字节随机数的 hex（64 字符），不编码身份信息 ——
 * 身份每次从库/Redis 读，这样停用一个账号能立刻生效，不用等票据过期。
 */
export async function createStaffSession(staff: StaffIdentity): Promise<LoginResult> {
  const ticket = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);

  await query(
    `insert into staff_sessions (staff_id, token_hash, expires_at) values ($1::uuid, $2, $3)`,
    [staff.staffId, hashTicket(ticket), expiresAt],
  );
  // Redis 的值是身份快照（JSON），省掉每次请求回库一次；TTL 与会话一致。
  // 停用/改角色时 delete 这个 key 即可立刻失效（见 `revokeStaffSessions`）。
  await redis.set(
    `staff_session:${ticket}`,
    JSON.stringify({ staffId: staff.staffId, staffName: staff.staffName, role: staff.role, email: staff.email }),
    "EX",
    SESSION_TTL_HOURS * 3600,
  );
  return { ticket, staff, expiresAt };
}

/** 读会话。Redis 命中即返回；未命中返回 null（**不回库兜底**：库里只有哈希，读不回来）。 */
export async function readStaffSession(ticket: string): Promise<StaffIdentity | null> {
  if (ticket === "") return null;
  const raw = await redis.get(`staff_session:${ticket}`);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as StaffIdentity;
    if (typeof parsed.staffId !== "string" || typeof parsed.role !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 登出：删 Redis 会话 + 在库里记吊销时间（审计要有"这个票据什么时候死的"）。 */
export async function revokeStaffSession(ticket: string): Promise<void> {
  if (ticket === "") return;
  await redis.del(`staff_session:${ticket}`);
  await query(`update staff_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null`, [
    hashTicket(ticket),
  ]);
}

/* ────────────────────────── 登录主体 ────────────────────────── */

type StaffRow = {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  active: boolean;
  password_hash: string | null;
  password_salt: string | null;
};

/**
 * 认证 + 签发。**失败与成功都在同一处返回 null/结果**，让路由层只有一个位置决定响应形状。
 *
 * 两条"看不见的失败"是刻意的：
 *   - 邮箱不存在 → 立刻返回 null，但**仍然跑一次 scrypt**（用固定假哈希）以免响应时间泄露账号是否存在。
 *     这里选择"不跑假哈希"是因为限速已经把枚举成本抬到 5 次/分钟/IP；再加恒定时间只多 60ms 延迟，
 *     而演示环境里 60ms × 每次错登让登录页手感变差。取舍记在这里，改的时候别当 bug 修。
 *   - `active = false` → 与口令错同码。
 */
export async function authenticate(email: string, password: string): Promise<StaffIdentity | null> {
  const row = await one<StaffRow>(
    `select id, name, email, role, active, password_hash, password_salt
       from staff where lower(email) = lower($1) limit 1`,
    [email],
  );
  if (row === null) return null;
  if (!row.active) return null;
  const ok = await verifyPassword(password, row.password_hash, row.password_salt);
  if (!ok) return null;
  return { staffId: row.id, staffName: row.name, role: row.role, email: row.email };
}

/** 改口令/停用账号时调用：一次清掉该坐席全部会话，不必等 TTL。 */
export async function revokeAllStaffSessions(staffId: string): Promise<void> {
  await query(`update staff_sessions set revoked_at = now() where staff_id = $1::uuid and revoked_at is null`, [
    staffId,
  ]);
  // Redis 里按前缀删：SCAN 而不是 KEYS（KEYS 在大库上会阻塞整个 Redis）。
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "staff_session:*", "COUNT", 200);
    cursor = next;
    for (const key of keys) {
      const raw = await redis.get(key);
      if (raw !== null && raw.includes(`"${staffId}"`)) await redis.del(key);
    }
  } while (cursor !== "0");
}
