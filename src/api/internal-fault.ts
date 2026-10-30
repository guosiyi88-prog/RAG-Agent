/**
 * 内部故障码查询（05-api.md §3.3、§5.2；06-agent.md §3.2 `fault_code_lookup`）。
 *
 * 工具侧只经内部 HTTP 回主进程（06 §1.1 C3），所以这一层就是"故障码工具"的全部后端：
 * 校验参数 → 主键直查 → 回 `data`。业务逻辑全在 `core/fault-codes.ts`，这里只负责
 * HTTP 面：两道门、入参校验、字段命名（camelCase → snake_case）。
 *
 * 两个方法指向同一个处理函数：
 *   GET  /internal/fault?code=E03&lang=de&product_line=balcony   —— 工具当前订阅的形态
 *   POST /internal/fault  {"code":"E03","lang":"de"}             —— 05 §5.2 文档里写的形态
 * 两种都留是刻意的：PRD 是"唯一真源"，而工具已经按 GET 写了；两个入口共用同一段校验与
 * 同一条 SQL，不存在两条实现漂移的可能。若只保留一种，删掉另一个注册即可。
 *
 * 安全模型与 `/internal/*` 其余端点完全一致：回环来源 + `X-Internal-Token`，任一不满足都回
 * **与普通 404 逐字同形**的 404（不是 401/403 —— 端点存在性不外泄）。
 */
import type { FastifyInstance } from "fastify";
import { DEFAULT_PRODUCT_LINE, lookupFaultCode, type FaultCodeHit, type FaultCodeMiss } from "../core/fault-codes.ts";
import type { Lang } from "../core/chunk.ts";
import { isKnownLang } from "../core/retrieval.ts";
import { AppError } from "../errors.ts";
import { internalAuthorized, sendNotFound } from "../auth.ts";

/** 05 §3.3：`^[A-Za-z]\d{2,3}$`。先卡格式再放行，别让 SQL 去看一条明显不是故障码的输入。 */
const FAULT_CODE_PATTERN = /^[A-Za-z]\d{2,3}$/;

const DEFAULT_LANG = "en";

/**
 * 产品线长度上限。表里最长的现有值是 `residential`（11 字符），32 给后续产品线留余量；
 * 再长就不可能是产品线，而是调用方 bug 或注入探针。
 * 刻意**不枚举** `balcony|residential|cni`：加一条产品线不该要求同步改接口校验。
 */
const MAX_PRODUCT_LINE_CHARS = 32;

const ROUTE = "/internal/fault";

type FaultData = FaultCodeHit | FaultCodeMiss;

/** 05 §3.3 的响应体：`snake_case` 只在这一层出现，核心模块内部一律 camelCase。 */
function toBody(data: FaultData): Record<string, unknown> {
  if (!data.found) return { found: false, code: data.code };
  return {
    found: true,
    code: data.code,
    severity: data.severity,
    meaning: data.meaning,
    actions: data.actions,
    doc_lang: data.docLang,
    product_line: data.productLine,
  };
}

/**
 * `code` 必填。缺省、非字符串（重复 query 参数会变成数组）、格式不符都是 400：
 * 这三种在调用方看来都是"传错了"，用同一类错误码回，日志里再区分。
 */
function parseCode(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION", "code 必填（字母 + 2~3 位数字）");
  const code = raw.trim();
  if (!FAULT_CODE_PATTERN.test(code)) {
    throw new AppError("VALIDATION", `code 必须是字母 + 2~3 位数字，收到 "${code}"`);
  }
  return code;
}

/**
 * `lang` 缺省 `en`；显式给了空串（`?lang=`）按非法处理而不是静默取默认值 ——
 * 调用方写了这个参数就说明它以为自己传了东西，静默兜底会把 bug 藏进响应体里。
 */
function parseLang(raw: unknown): Lang {
  if (raw === undefined) return DEFAULT_LANG;
  if (typeof raw !== "string") throw new AppError("VALIDATION", "lang 必须是字符串");
  const lang = raw.trim().toLowerCase();
  if (!isKnownLang(lang)) {
    throw new AppError("VALIDATION", `lang 必须是 zh|en|de|nl|es，收到 "${raw}"`);
  }
  return lang;
}

/** `product_line` 缺省 `balcony`（05 §3.3），但必须是非空短字符串。 */
function parseProductLine(raw: unknown): string {
  if (raw === undefined) return DEFAULT_PRODUCT_LINE;
  if (typeof raw !== "string") throw new AppError("VALIDATION", "product_line 必须是字符串");
  const productLine = raw.trim();
  if (productLine === "") throw new AppError("VALIDATION", "product_line 不能为空");
  if (productLine.length > MAX_PRODUCT_LINE_CHARS) {
    throw new AppError("VALIDATION", `product_line 超过 ${MAX_PRODUCT_LINE_CHARS} 字符`);
  }
  return productLine;
}

/** 校验 → 查表 → 组响应。GET（query）与 POST（body）共用这一段，避免两条实现漂移。 */
async function resolveFault(fields: {
  code: unknown;
  lang: unknown;
  productLine: unknown;
}): Promise<Record<string, unknown>> {
  const code = parseCode(fields.code);
  const lang = parseLang(fields.lang);
  const productLine = parseProductLine(fields.productLine);
  const data = await lookupFaultCode({ code, lang, productLine });
  return { ok: true, data: toBody(data) };
}

function queryFields(raw: unknown): { code: unknown; lang: unknown; productLine: unknown } {
  const params = (raw ?? {}) as Record<string, unknown>;
  return { code: params.code, lang: params.lang, productLine: params.product_line };
}

export async function registerInternalFaultRoutes(app: FastifyInstance): Promise<void> {
  app.get(ROUTE, async (request, reply) => {
    // 门禁必须是第一行：参数校验的报错差异本身就是可观测的信息泄露面。
    if (!internalAuthorized(request)) return sendNotFound(request, reply);
    return reply.code(200).send(await resolveFault(queryFields(request.query)));
  });

  app.post(ROUTE, async (request, reply) => {
    if (!internalAuthorized(request)) return sendNotFound(request, reply);
    const body = request.body;
    // content-type 不是 JSON 时 Fastify 会把 body 留成字符串/undefined：先挡住形状，
    // 否则 undefined 会被读成"字段缺省"，静默按默认值查一条别人没要的查询。
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError("VALIDATION", "body 必须是 JSON 对象");
    }
    return reply.code(200).send(await resolveFault(queryFields(body)));
  });
}
