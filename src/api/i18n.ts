/**
 * `GET /api/i18n/:lang`（`12-i18n.md` §1–§2 · 08-i18n-eval-handoff 的 T09）：用户端文案的唯一来源。
 *
 * 本文件只是**路由**：读表与回落链都在 `core/i18n-table.ts`。为什么读表下沉到 core、而表文件仍留在
 * `src/static/`，那段理由写在 `core/i18n-table.ts` 的头注释里（一句话版：core 不能 import api，
 * 而故障码快路的答复末行也是同一格文案；没有构建链，`src/static/` 就是文案的发布位置）。
 * 这里保留原样的三处刻意选择：
 *   ① **启动时读一次、之后只读内存**。表在 `core/i18n-table.ts` 的 import 期读入，比"注册路由时读"
 *      更早一格：坏文件让进程起不来，而不是让第一条请求 500 —— 进程起不来比"页面全是 key 原文"好查。
 *   ② **回落链在服务端做**（§2：请求语言 → en → 原始 key）。前端只拿合并结果：三行 JS 里做三级回落，
 *      五种语言就是十五条分支；服务端做一次，五个端点都是同一份形状，`t()` 退化成一次查表。
 *      原始 key 只在开发期可见（没有翻译也没英文时），这是规格允许的最后一格。
 *   ③ **未知语种是 400 而不是静默回落 en**。§2 的回落链说的是**key**，不是**语种**：`/api/i18n/de-DE`
 *      若悄悄给一份英文，"五语"这条验收就永远无法证伪。客户端负责归一化（`src/static/lib/lang.js`
 *      的 `normalizeLang`：`de-DE` → `de`），服务端负责说"这不是我要的值"。
 */
import type { FastifyInstance } from "fastify";
import { LANGUAGES, type Lang } from "../core/chunk.ts";
import { messagesFor } from "../core/i18n-table.ts";
import { AppError } from "../errors.ts";

const ROUTE = "/api/i18n/:lang";

/**
 * 回落链合并（§2）在 `core/i18n-table.ts`：core（拼答复）与本文件（下发）必须用同一份算法，
 * 在两侧各写一遍就是两份真源 —— 而那份算法的最后一个兜底（key 原文 vs 不输出）正是本次缺陷的现场。
 *
 * 仍在 api 侧导出的理由：`tests/i18n-api.test.ts` 拿它喂最小表钉回落链，那是路由契约的一部分。
 */
export { mergeMessages } from "../core/i18n-table.ts";

/**
 * `lang` 必须是五语之一。大小写不敏感（客户端可能发 `DE`），但**不做**前缀截断：
 * `de-DE` / `zh-Hans-CN` 这类标签由 `src/static/lib/lang.js` 的 `normalizeLang` 在浏览器里先归一到两位，
 * 服务端只认两位 —— 两处都做归一化等于两套规则，早晚一处改一处忘。
 */
function parseLang(raw: unknown): Lang {
  if (typeof raw !== "string") throw new AppError("VALIDATION", "lang 必须是字符串");
  const lang = raw.trim().toLowerCase();
  if (lang === "") throw new AppError("VALIDATION", "lang 不能为空");
  const hit = LANGUAGES.find((candidate) => candidate === lang);
  if (hit === undefined) {
    throw new AppError("VALIDATION", `lang 必须是 ${LANGUAGES.join("|")}，收到 "${raw}"`);
  }
  return hit;
}

/**
 * 这一路**不加** `X-User-Session` 门禁：文案是公开的五语界面文本，没有"属于谁"的概念，
 * 而且弱网下页面要在拿到令牌之前就能把界面点亮（10 §8 的 boot 顺序：先文案后令牌）。
 */
export async function registerI18nRoutes(app: FastifyInstance): Promise<void> {
  // 表已在 `core/i18n-table.ts` 的 import 期读入并校验过：坏文件在上面那行 import 就抛了，
  // 走到这里一定是一份能用的表（所以这里不用再 await 一次 IO）。
  app.get<{ Params: { lang?: unknown } }>(ROUTE, async (request, reply) => {
    const lang = parseLang(request.params.lang);
    return reply.code(200).send({ ok: true, data: { lang, messages: messagesFor(lang) } });
  });
}
