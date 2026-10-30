/**
 * 内部工单接口（`05-api.md` §5.3–§5.4）—— 工具侧唯一的建单 / 查单入口。
 *
 *   POST /internal/ticket        建单（转人工）→ `{ no, due_at, status }`
 *   POST /internal/ticket/lookup 按单号查状态（05 §5.4 的规范形态）→ `{ found, … }`
 *   GET  /internal/ticket/:no    同上，同一个查询的别名
 *
 * 为什么和 `/internal/search` 一样是"内部"的：调用方是本进程的工具实现，走回环地址 +
 * `X-Internal-Token` 两道门。这两道门的实现**只有一处**（`src/auth.ts` 的
 * `internalAuthorized` / `sendNotFound`，07#01 把三份并成了一份），这里只调用不复刻 —— 安全判定出现第二个版本，
 * 迟早有一个版本被改漏。
 *
 * 为什么查单有两个入口：05 §5.4 写的是 POST + body `{ no }`，而单号本身是资源标识，
 * GET + 路径参数更自然（可缓存、可复制进日志）。两个都留着指向**同一个** `lookupTicket`，
 * 是因为删掉任何一个都会让另一份文档或另一个调用方突然拿到 404，
 * 而这两条路由的语义完全相同，维持两份的成本只是两行。
 *
 * 与 05 §5.3 的差异：规格的 body 里有 `reason`，这里**不接受**（见下方 `reason` 处理）。
 */
import type { FastifyInstance } from "fastify";
import {
  TICKET_QUESTION_MAX,
  TICKET_QUESTION_MIN,
  TICKET_REASON_USER_REQUEST,
  createInternalTicket,
  isUuid,
  lookupTicket,
  type TicketLookup,
} from "../core/ticket-store.ts";
import { AppError } from "../errors.ts";
import { logger } from "../logger.ts";
import { internalAuthorized, sendNotFound } from "../auth.ts";

/**
 * `requester` 的长度上限。规格没规定（内部建单不需要邮箱，这一列多半是姓名或邮箱串），
 * 但它最终会显示在坐席队列里，而请求体上限是 1MB —— 不设上限等于允许把一整份文件
 * 塞进一列 text，把坐席端的列表页撑爆。
 */
const REQUESTER_MAX_CHARS = 200;

type CreateBody = {
  question?: unknown;
  conv_id?: unknown;
  requester?: unknown;
  reason?: unknown;
};

/**
 * 建单入参校验。刻意不静默修正任何一项：这个端点的调用方是模型工具，
 * 参数不合契约时回 400 让工具看到"我传错了"，比悄悄改成合法值更能自我纠正。
 */
function parseCreateBody(body: unknown): {
  question: string;
  convId: string | null;
  requester: string | null;
} {
  // content-type 不是 JSON 时 Fastify 会把 body 留成字符串/undefined，先挡住形状。
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("VALIDATION", "body 必须是 JSON 对象");
  }
  const payload = body as CreateBody;

  if (typeof payload.question !== "string") {
    throw new AppError("VALIDATION", "question 必填且必须是字符串");
  }
  const question = payload.question.trim();
  // 长度按 **trim 后** 计算（05 §3.4 的 4–500）：全空格的 `"    "` 不是 4 个字符的问题。
  if (question.length < TICKET_QUESTION_MIN || question.length > TICKET_QUESTION_MAX) {
    throw new AppError(
      "VALIDATION",
      `question 必须是 ${TICKET_QUESTION_MIN}–${TICKET_QUESTION_MAX} 字符（trim 后 ${question.length}）`,
    );
  }

  let convId: string | null = null;
  if (payload.conv_id !== undefined && payload.conv_id !== null) {
    // 形状不合法是参数问题（400），不是"会话不存在"：`conversations.id` 是 uuid 列，
    // 放非 uuid 进去会变成 500，而那是调用方最看不懂的一种错误。
    if (typeof payload.conv_id !== "string" || !isUuid(payload.conv_id)) {
      throw new AppError("VALIDATION", "conv_id 必须是 uuid");
    }
    convId = payload.conv_id;
  }

  let requester: string | null = null;
  if (payload.requester !== undefined && payload.requester !== null) {
    if (typeof payload.requester !== "string") {
      throw new AppError("VALIDATION", "requester 必须是字符串");
    }
    const trimmed = payload.requester.trim();
    if (trimmed.length > REQUESTER_MAX_CHARS) {
      throw new AppError("VALIDATION", `requester 超过 ${REQUESTER_MAX_CHARS} 字符`);
    }
    // 空串等价于没给：`''` 与 null 都会被坐席看成"没留联系方式"，存成两种值只让查询更麻烦。
    requester = trimmed === "" ? null : trimmed;
  }

  return { question, convId, requester };
}

/**
 * 查单响应体的唯一构造点。两个入口（POST …/lookup、GET …/:no）共用它，
 * 免得"换个动词就少一个字段"这种漂移：工具侧解析的是同一份形状，
 * 两个入口给出不同字段就是最难查的那种 bug。
 */
function lookupPayload(found: TicketLookup): {
  ok: true;
  data:
    | { found: false; no: string }
    | { found: true; no: string; status: string; reason: string; created_at: string };
} {
  if (!found.found) return { ok: true, data: { found: false, no: found.no } };
  return {
    ok: true,
    data: {
      found: true,
      no: found.no,
      status: found.status,
      // `reason` 与 `created_at` 是规格之外多给的字段：回答"我的单怎么样了"时，
      // "为什么转人工"和"什么时候建的"是用户最常追问的两句，多一次往返不值当。
      reason: found.reason,
      created_at: found.createdAt,
    },
  };
}

export async function registerInternalTicketRoutes(app: FastifyInstance): Promise<void> {
  app.post("/internal/ticket", async (request, reply) => {
    // 两道门。失败与"路径不存在"逐字一致（见 `src/auth.ts` 的 `sendNotFound`）。
    if (!internalAuthorized(request)) return sendNotFound(request, reply);

    const input = parseCreateBody(request.body);

    // `reason` 无论传什么都不采信，由 store 里的常量写成 `user_request`（05 §2、§3.4：
    // 原因由后端按触发路径写入，前端与模型都不得选）。这里**不报错**：`06 §3.3` 的工具
    // schema 里还带着 `reason` 参数，报错会让每一次建单工具调用都失败，而真正要守住的性质
    // （模型选不了原因）已经由常量守住了。留一条 warn 是因为这值本身说明调用方以为可以选。
    const attempted = (request.body as CreateBody).reason;
    if (attempted !== undefined && attempted !== null && attempted !== TICKET_REASON_USER_REQUEST) {
      logger.warn(
        { reason: String(attempted).slice(0, 64) },
        "internal/ticket 收到调用方 reason，已忽略并固定为 user_request",
      );
    }

    const created = await createInternalTicket(input);
    return reply.code(200).send({
      ok: true,
      data: { no: created.no, due_at: created.dueAt, status: created.status },
    });
  });

  // 05 §5.4 的规范形态。body 里缺 `no` 或类型不对回 400：那是调用方的 bug；
  // 而"号对但查不到"走 `found:false` —— 两者混成一个响应，工具就永远学不会把参数传对。
  app.post("/internal/ticket/lookup", async (request, reply) => {
    if (!internalAuthorized(request)) return sendNotFound(request, reply);

    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError("VALIDATION", "body 必须是 JSON 对象");
    }
    const no = (body as { no?: unknown }).no;
    if (typeof no !== "string") throw new AppError("VALIDATION", "no 必填且必须是字符串");

    return reply.code(200).send(lookupPayload(await lookupTicket(no)));
  });

  // 同一个查询的别名，见文件头"为什么查单有两个入口"。
  app.get("/internal/ticket/:no", async (request, reply) => {
    if (!internalAuthorized(request)) return sendNotFound(request, reply);

    const params = request.params as { no?: string };
    const found = await lookupTicket(typeof params.no === "string" ? params.no : "");
    return reply.code(200).send(lookupPayload(found));
  });
}
