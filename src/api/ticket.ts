/**
 * 用户端工单接口（`05-api.md` §3.4 / §3.5）—— 浏览器的「转人工」按钮与「我的工单」页。
 *
 *   POST /api/ticket        建单（转人工）→ `{ no, due_at, status, idempotent }`
 *   GET  /api/ticket/:no    用单号 + 邮箱查状态 → `{ found, no, status, created_at }`
 *
 * 本文件只做**传输层**：鉴权 → 入参形状 → 调 `core/ticket-public.ts` → 套统一信封。
 * 配额、幂等、会话归属、原因固定值、404 不可区分这五条性质都在 core 里，
 * 因为它们都是"两个入口共用一套判断"的东西；放在路由层，将来加一个入口就会漏一条。
 *
 * 鉴权在 `src/auth.ts` 的 `requireUser`（07#01 收敛）：本文件此前照 `api/chat.ts` 复写了一份
 * 12 行的令牌校验，两份实现"必须逐字一致"这件事靠拷贝保不住 —— 现在两处入口调的是同一个函数，
 * 断言也就能证明"只有一份实现"。
 */
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.ts";
import { createPublicTicket, isValidEmail, lookupPublicTicket } from "../core/ticket-public.ts";
import { TICKET_REASON_USER_REQUEST, isUuid } from "../core/ticket-store.ts";
import { AppError } from "../errors.ts";
import { logger } from "../logger.ts";

type ParsedCreate = { convId: string | null; email: string; question: string | undefined };

/**
 * 建单入参校验（05 §3.4）。
 *
 * `reason` **不解析、不采信**：05 §3.4「原因由后端按触发路径写入，前端不得传」。
 * 这个入口永远是"用户主动点了转人工"，所以原因恒为 `user_request`（在 core 里由常量写入）。
 * 传了也不报错，只留一条 warn —— 报错会让一个已经过时的前端版本整体哑掉，而真正要守住的
 * 性质（前端选不了原因）已经由"入参里没有这一项"守住了；warn 是为了知道还有谁在传。
 */
function parseCreateBody(body: unknown): ParsedCreate {
  // content-type 不是 JSON 时 Fastify 会把 body 留成字符串/undefined，先挡形状。
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("VALIDATION", "body 必须是 JSON 对象");
  }
  const payload = body as { conv_id?: unknown; email?: unknown; question?: unknown; reason?: unknown };

  // `conv_id` 允许缺省：用户可能打开工单页就转人工（一次都没聊过 → 没有会话）。
  // 给了就必须是合法 uuid，且必须在 core 里校验归属（别人的会话 = 404）。
  // 形状不合法是参数问题（400），不是"会话不存在"（404）：前者是前端传错了字段，
  // 后者是"这个 id 不属于你"。混成一个，前端就分不清该修代码还是该刷新页面。
  let convId: string | null = null;
  if (payload.conv_id !== undefined && payload.conv_id !== null) {
    if (typeof payload.conv_id !== "string") throw new AppError("VALIDATION", "conv_id 必须是字符串");
    if (!isUuid(payload.conv_id)) throw new AppError("VALIDATION", "conv_id 必须是 uuid");
    convId = payload.conv_id;
  }

  if (typeof payload.email !== "string") throw new AppError("VALIDATION", "email 必填且必须是字符串");
  // 邮箱是这张单唯一的联系方式与查单凭据（05 §3.5），校验不通过就不建单：
  // 建一张收不到回访的单，比让用户在表单上多改一次糟得多。
  const email = payload.email.trim();
  if (!isValidEmail(email)) throw new AppError("VALIDATION", "email 格式不正确");

  let question: string | undefined;
  if (payload.question !== undefined && payload.question !== null) {
    if (typeof payload.question !== "string") throw new AppError("VALIDATION", "question 必须是字符串");
    // 长度门槛（4–500）在 core 里判：`question` 缺省时要回落到会话历史，
    // 两者的取舍必须在同一个地方（见 `resolveQuestion`）。
    question = payload.question;
  }

  if (payload.reason !== undefined && payload.reason !== null && payload.reason !== TICKET_REASON_USER_REQUEST) {
    logger.warn(
      { reason: String(payload.reason).slice(0, 64) },
      "api/ticket 收到前端 reason，已忽略并固定为 user_request",
    );
  }

  return { convId, email, question };
}

export async function registerTicketRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/ticket", async (request, reply) => {
    // 先鉴权再碰 body：未登录的请求不该有机会触发任何校验分支（那也是一次信息泄露面）。
    const token = await requireUser(request);
    const { convId, email, question } = parseCreateBody(request.body);

    const created = await createPublicTicket({ convId, token, email, question });

    return reply.code(200).send({
      ok: true,
      data: {
        no: created.no,
        due_at: created.dueAt,
        // 规格 §3.4 的响应只画了 `no` / `due_at`，另给两个字段：
        // `status` 让前端不必立刻再发一次查询就能显示"待处理"，`idempotent` 让前端知道
        // 这一次是重试合并（可以把"已提交"改成"已提交过，单号不变"）。
        status: created.status,
        idempotent: created.idempotent,
      },
    });
  });

  app.get("/api/ticket/:no", async (request, reply) => {
    await requireUser(request);

    const params = request.params as { no?: unknown };
    const no = typeof params.no === "string" ? params.no : "";

    const query = request.query as { email?: unknown };
    if (typeof query.email !== "string") throw new AppError("VALIDATION", "email 必填");
    const email = query.email.trim();
    if (!isValidEmail(email)) throw new AppError("VALIDATION", "email 格式不正确");

    const found = await lookupPublicTicket({ no, email });
    // 单号不存在与邮箱不匹配回**同一个** 404（05 §3.5「不区分，避免枚举」）：
    // 工单号是序列号，能被从 0001 顺序撞上来；任何"号存在但邮箱不对"的信号
    // 都等于把整张工单列表的存在性交出去。core 已经用一个联合查询把两种情况合成
    // `found:false`，这里也只有一条发送路径 —— 两条路径的文案迟早会漂。
    //
    // （`no` 不做形状校验：它是 text 列，任何串都能安全查一遍；先判形状反而会
    // 给出"这个号格式对所以可能存在"的额外信号。）
    if (!found.found) throw new AppError("NOT_FOUND", "未找到该工单");

    return reply.code(200).send({
      ok: true,
      data: {
        found: true,
        no: found.no,
        status: found.status,
        created_at: found.createdAt,
      },
    });
  });
}
