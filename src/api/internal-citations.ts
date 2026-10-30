/**
 * 内部引用接口（`05-api.md` §5.5）—— 收尾阶段唯一的引用快照写入口。
 *
 *   POST /internal/citations  body `{ message_id, citations[] }` → `{ ok, data: { inserted } }`
 *
 * **只写不校验**：哪些片段算引用（角标是否落在本轮候选序号集合内、编号是否升序）在收尾流程里
 * 判定，判完才调到这个端点。为什么不在这里复核一遍：这里拿不到"本轮候选集合"，
 * 只有 `citations` 数组本身 —— 复核只能复核形状，而形状对了不代表内容合法
 * （一个凭空编出来的 `doc_title` 在这里无法与真实片段区分）。真正的门槛必须建在有候选的地方，
 * 在这里再造一个"看起来在把关"的检查，只会让人误以为校验在这边。
 *
 * 与 `/internal/search`、`/internal/ticket` 同一套两道门（回环来源 + `X-Internal-Token`），
 * 实现只有一处（`src/auth.ts`，07#01 收敛），失败一律回与"路径不存在"逐字一致的 404。
 */
import type { FastifyInstance } from "fastify";
import type { Citation } from "../core/citations.ts";
import { saveCitations } from "../core/citation-store.ts";
import { AppError } from "../errors.ts";
import { internalAuthorized, sendNotFound } from "../auth.ts";

/** 一轮最多 5 条候选（`07-retrieval.md`），引用不可能比候选多；20 是留出余量的硬上界。 */
const MAX_CITATIONS = 20;

/**
 * `citations.doc_lang` 是 `char(2) check (doc_lang in (…))`。这里挡的是**列域**而不是引用
 * 正确性：越域的值会让 insert 抛 23514 变成 500，而它其实是调用方传错了参数。
 * 引用正确性（该不该引用、角标对不对号）不在这里判，见文件头。
 */
const CITE_LANGS = new Set(["zh", "en", "de", "nl", "es"]);

type CitationsBody = { message_id?: unknown; citations?: unknown };

/** 取一个整数参数字段：类型、整数性、下界一次判完，错误文案带上字段名与实收值。 */
function requireInt(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AppError("VALIDATION", `${field} 必须是整数`);
  }
  if (value < min) {
    throw new AppError("VALIDATION", `${field} 必须 ≥ ${min}，收到 ${value}`);
  }
  return value;
}

/** 可空整数（`page` / `chunk_id`）：`null` 放行，其余与 `requireInt` 同口径。 */
function requireNullableInt(value: unknown, field: string, min: number): number | null {
  if (value === null) return null;
  if (value === undefined) throw new AppError("VALIDATION", `${field} 必须给出（没有就传 null）`);
  return requireInt(value, field, min);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AppError("VALIDATION", `${field} 必须是字符串`);
  return value;
}

/**
 * 单条引用的形状校验。
 *
 * `page` / `chunk_id` / `score` 的 `null` 在这里有明确区分：缺字段（`undefined`）回 400，
 * 显式 `null` 放行。理由是这两列在 `citations` 表里可空（片段没有页码、或检索时就没有 chunk），
 * 而"字段该有却漏了"是调用方构造对象时的 bug，静默按 null 存下去会让快照少一半信息却没人知道。
 */
function parseCitation(value: unknown, index: number): Citation {
  const at = `citations[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("VALIDATION", `${at} 必须是对象`);
  }
  const entry = value as Record<string, unknown>;

  // 角标从 1 起（正文里写的是 `[1]`…`[5]`）：0 或负数在渲染层是"无编号"，
  // 放行等于允许一条永远点不开的引用。
  const idx = requireInt(entry.idx, `${at}.idx`, 1);
  const score = entry.score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new AppError("VALIDATION", `${at}.score 必须是有限数字`);
  }
  const docLang = requireString(entry.doc_lang, `${at}.doc_lang`);
  if (!CITE_LANGS.has(docLang)) {
    throw new AppError("VALIDATION", `${at}.doc_lang 必须是 zh|en|de|nl|es，收到 "${docLang}"`);
  }

  return {
    idx,
    chunk_id: requireNullableInt(entry.chunk_id, `${at}.chunk_id`, 1),
    doc_title: requireString(entry.doc_title, `${at}.doc_title`),
    doc_lang: docLang,
    page: requireNullableInt(entry.page, `${at}.page`, 0),
    snippet: requireString(entry.snippet, `${at}.snippet`),
    score,
  };
}

function parseBody(body: unknown): { messageId: number; citations: Citation[] } {
  // content-type 不是 JSON 时 Fastify 会把 body 留成字符串/undefined，先挡住形状。
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("VALIDATION", "body 必须是 JSON 对象");
  }
  const payload = body as CitationsBody;

  const messageId = requireInt(payload.message_id, "message_id", 1);

  if (!Array.isArray(payload.citations)) {
    throw new AppError("VALIDATION", "citations 必须是数组（没有引用就传 []）");
  }
  // 超出上限不截断：截断会静默丢掉角标，而角标丢了前端就渲染出"引用了但点不开"。
  if (payload.citations.length > MAX_CITATIONS) {
    throw new AppError(
      "VALIDATION",
      `citations 最多 ${MAX_CITATIONS} 条，收到 ${payload.citations.length}`,
    );
  }

  return { messageId, citations: payload.citations.map(parseCitation) };
}

export async function registerInternalCitationRoutes(app: FastifyInstance): Promise<void> {
  app.post("/internal/citations", async (request, reply) => {
    // 两道门。失败与"路径不存在"逐字一致（见 `src/auth.ts` 的 `sendNotFound`）。
    if (!internalAuthorized(request)) return sendNotFound(request, reply);

    const input = parseBody(request.body);
    const { inserted } = await saveCitations(input);

    // `inserted` 恒等于 `input.citations.length`（空数组时为 0）。把它回给调用方，
    // 是为了让收尾流程能断言"写进去的条数 == 校验通过的条数"，而不必再查一次库。
    return reply.code(200).send({ ok: true, data: { inserted } });
  });
}
