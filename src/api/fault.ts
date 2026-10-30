/**
 * `GET /api/fault/:code`（05-api.md §3.3）：故障码页的结果卡数据源。
 *
 * 与 `/internal/fault`（05 §5.2）共用同一条主键查询（`core/fault-codes.ts`），差别只在
 * **面向谁**：这条是用户端页面直接调的，错误形态按用户端口径走（400 + 明确 message）；
 * 那条是 Agent 工具经回环 HTTP 调的，门禁失败一律伪装成 404。
 * 这一路**不设凭据门禁**（见 `registerFaultRoutes` 上方），所以 401 在这里根本不存在。
 *
 * 四处刻意选择：
 *   ① 这条路上**没有**模型、没有 embedding、没有 LIKE/trgm，只有一条主键等值查询 ——
 *      05 §3.3 的预算是 P95 < 20ms，任何一次外部往返都会破预算（10 §5「不调模型」）。
 *   ② 未命中是 **200 + `found:false`**，不是 404：对页面来说"没有这个码"是一种正常结果
 *      （10 §5 要渲染「没找到 E99」+「问 AI」按钮），把它变成错误会让前端只能靠猜状态码分支。
 *   ③ 响应体多了 `product_line`（05 §3.3 的示例里没有）。理由：05 §5.2 明确要求
 *      `/internal/fault` 返回**同** `GET /api/fault/:code` 的 `data`，而内部接口（04#02 已落地）
 *      已经带了这个字段；不带上就成了两套形状，§5.2 那句话立刻变成假话。而且 `product_line`
 *      是主键的一半（`F21` 只在 `residential` 存在），卡片去掉它就说不清"这是哪条产品线的码"。
 *   ④ **未命中会在响应之后异步记一条待审反馈**（`09#04` / D16 / D26）：这是整条反馈回路唯一的
 *      捕获点。它不改响应、不改延迟预算（`void` + 吞错，理由见处理器里那段注释），所以不进
 *      05 §3.3 的契约 —— 但"没有它，管理端的待审列表永远是空的"（R26 的反面教材 `v_no_hit`）。
 */
import type { FastifyInstance } from "fastify";
import { recordFaultReport } from "../core/admin-store.ts";
import type { Lang } from "../core/chunk.ts";
import {
  DEFAULT_PRODUCT_LINE,
  lookupFaultCode,
  type FaultCodeHit,
  type FaultCodeMiss,
} from "../core/fault-codes.ts";
import { FAULT_CODE_RE } from "../core/fastpath.ts";
import { isKnownLang } from "../core/retrieval.ts";
import { AppError } from "../errors.ts";
import { logger } from "../logger.ts";

const ROUTE = "/api/fault/:code";

/** 05 §3.3：`lang` 缺省 `en`。 */
const DEFAULT_LANG: Lang = "en";

/**
 * 产品线长度上限，与 `api/internal-fault.ts` 同一口径（表里最长是 `residential`，11 字符）。
 * 刻意不枚举产品线：加一条产品线不该要求同步改两处校验。
 */
const MAX_PRODUCT_LINE_CHARS = 32;

type FaultData = FaultCodeHit | FaultCodeMiss;

/** 05 §3.3 的响应体：`snake_case` 只出现在 HTTP 这一层，核心模块内部一律 camelCase。 */
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
 * 判形复用 `core/fastpath.ts` 的 `FAULT_CODE_RE`（05 §3.2 的判形 + 05 §3.3 的 path 约束是同一条
 * 正则）：同一条输入在"对话页走快路"与"故障码页直查"里必须得到同一个结论，两处各写一份正则
 * 迟早会一处放宽、另一处收紧，于是同一条 `E03` 在两个页面给出不同答案。
 *
 * 先卡格式再放行，别让 SQL 去看一条明显不是故障码的输入（`X1` / `E1234` 是 400，不是 miss）。
 */
function parseCode(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION", "code 必填（字母 + 2~3 位数字）");
  const code = raw.trim();
  if (!FAULT_CODE_RE.test(code)) {
    throw new AppError("VALIDATION", `code 必须是字母 + 2~3 位数字，收到 "${code}"`);
  }
  return code;
}

/**
 * `lang` 缺省 `en`；显式给了空串（`?lang=`）按非法处理，而不是静默回落默认值 ——
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

/**
 * 这一路**不加** `X-User-Session` 门禁：10 §5 明确「此页不建立会话、不调模型」，
 * 故障码页要在前端拿到令牌之前就能出结果（弱网下先出卡、后建会话），
 * 而这条查询的数据是五语公开的故障码表，没有"属于谁"的概念。
 * 因此也没有令牌相关的 401：坏输入只有一个出路 —— 400 `VALIDATION`。
 */
export async function registerFaultRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { code?: unknown }; Querystring: Record<string, unknown> }>(
    ROUTE,
    async (request, reply) => {
      const query = request.query ?? {};
      const code = parseCode(request.params.code);
      const lang = parseLang(query.lang);
      const productLine = parseProductLine(query.product_line);

      const data = await lookupFaultCode({ code, lang, productLine });

      // 反馈回路的第一环（`09#04` / D16 / D26）：查不到一个码，就是一条**码级反馈**。
      //
      // 三条约束都是刻意的：
      //   ① **不阻塞响应**：`void` + 自己吞错。05 §3.3 的预算是 P95 < 20ms，为了一条待审记录
      //      让用户多等一次写库是不划算的；写失败也只值得一条日志（反馈是"锦上添花"的数据，
      //      它坏了不该让故障码页变成 500）。
      //   ② **只收码级**：`code` 已经过 `parseCode` 判形（`E03` 这种），不做任何自然语言抽取 ——
      //      描述型故障要第二条模型路径，排 backlog（D26）。
      //   ③ **不存问题原文**：这里根本没有问题文本可存（`/api/fault` 只有一个码参数），
      //      也就没有 PII 面。将来若加上 `quote`，必须走 `recordFaultReport` 的 200 字截断。
      if (!data.found) {
        void recordFaultReport({ code: data.code, productLine, lang, source: "page" }).catch((err: unknown) => {
          logger.warn({ err, code: data.code, productLine }, "fault_report 写入失败（不影响出卡）");
        });
      }

      return reply.code(200).send({ ok: true, data: toBody(data) });
    },
  );
}
