/**
 * 五语文案表（`src/static/i18n.json`）的**唯一读取点**（`12-i18n.md` §1–§2、§4.10）。
 *
 * 为什么读取点在 `core/`、文件仍留在 `src/static/` —— 这是两件独立的事：
 *   ① **读取点在 core** 是依赖方向的要求（`02-architecture.md` §3：core 不 import api）。
 *      `fault.source` 这一格既是界面上的一行文案（`src/static/views.js` 的故障码专页在用），
 *      也是故障码快路答复的末行（`core/fastpath.ts`）。两侧只要各自拿一份字面量，就必然分叉 ——
 *      §4.10 明令禁止的正是这种形态：`core/fastpath.ts` 曾把 `来源：故障码表` 写成模块常量，
 *      于是德语/英语/荷兰语/西班牙语用户的答复末行都是汉字。把"读表 + 回落链"放进 core，
 *      下发（`api/i18n.ts`）与拼答复（`core/fastpath.ts`）才共用同一份真源。
 *   ② **文件留在 static** 是因为本仓没有构建链（node 直接跑 `.ts`，`src/static/` 由 `api/assets.ts`
 *      原样 serve，前端 `lib/i18n-*.js` 也从那里取）。`src/static/` 就是文案的**发布位置**，
 *      `scripts/check-i18n.ts` 也按这个路径数 127 条。挪进 core 要么多一份拷贝，要么让 `GET /assets/*`
 *      与浏览器缓存路径断掉 —— 读取点搬过来就够了，文件不必跟着搬。
 *
 * 读一次的时机是**模块 import 期**（同步 `readFileSync`），比原来"注册路由时 await 读"更早一格：
 * 坏文件让进程起不来，而不是让第一条请求 500（原 `api/i18n.ts` 注释①的取舍，这里只是提前了时点）。
 * 同步读也是接口决定：`t()` 必须同步，`formatFaultReply` 这种纯函数才能留在 SSE 分流的热路径上
 * 不引入 await（它被单测直接调用，也必须是同一个形状）。代价是启动时一次几 KB 的磁盘读。
 *
 * 不复用 `core/retrieval.ts` 的 `isKnownLang`：那个模块 import 了 `db.ts` → `config.ts`，
 * 只为查一份文案就要连数据库、就要 `.env` 在场；这里用 `core/chunk.ts` 的 `LANGUAGES`（纯常量、零 import）。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGUAGES, type Lang } from "./chunk.ts";

/** `src/core/` → 兄弟 `src/static/i18n.json`（`12-i18n.md` §1 的真表位置）。 */
const TABLE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "static", "i18n.json");

/** §2 的中间一格：请求语言缺这条就用英文。 */
const FALLBACK_LANG: Lang = "en";

export type Messages = Record<string, string>;
export type Table = Partial<Record<Lang, Messages>>;

function isMessages(value: unknown): value is Messages {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

/**
 * 形状校验只卡"一层 key → 字符串"与两根基石（主源 zh、回落语 en）。
 * 条数、占位符、CJK 残留交给 `scripts/check-i18n.ts` 在提交前拦 —— 那是它的职责，
 * 也是唯一需要守着 127 的地方；服务端只保证"不会把坏文件当表用"。
 */
function parseTable(parsed: unknown): Table {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${TABLE_FILE} 顶层必须是对象`);
  }
  const table: Table = {};
  for (const lang of LANGUAGES) {
    const messages = (parsed as Record<string, unknown>)[lang];
    if (messages === undefined) continue;
    if (!isMessages(messages)) throw new Error(`${TABLE_FILE} 的 "${lang}" 必须是 key → 字符串`);
    table[lang] = messages;
  }
  // 主源与回落语言是合并算法的两根基石，缺一根就算"表坏了"（其余语种缺了只是那门语言少几行）。
  if (table.zh === undefined) throw new Error(`${TABLE_FILE} 缺主源 zh`);
  if (table[FALLBACK_LANG] === undefined) throw new Error(`${TABLE_FILE} 缺回落语 ${FALLBACK_LANG}`);
  return table;
}

/** 读表；读不到或解析不了都带上路径再抛 —— 报错里没有路径的那种 500 最难查。 */
function readTable(): Table {
  let raw: string;
  try {
    raw = readFileSync(TABLE_FILE, "utf8");
  } catch (err) {
    throw new Error(`读不到文案表 ${TABLE_FILE}：${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${TABLE_FILE} 不是合法 JSON：${(err as Error).message}`);
  }
  return parseTable(parsed);
}

/** 进程内唯一的一份表（import 期读入，之后只读；运行期改文件要重启才生效，这是刻意的）。 */
const TABLE: Table = readTable();

/**
 * 回落链合并（§2）：`请求 lang → en → 原始 key`。以 **zh 的 key 集合**为基准 —— 主源是 zh（§1），
 * zh 里没有的 key 不下发给前端（多发的 key 只会让"表里有、页面没有"这种问题变成噪音）。
 *
 * 纯函数（表从参数进），导出是为了让测试能喂一张最小表把"缺一条回落 en、en 也缺回落 key 原文"
 * 这两格钉死 —— 改真表去造这两种场景是不可接受的。
 *
 * 注意最后一格是 **key 原文**：这是 §2 允许的"开发期可见"行为，只用于**下发给前端**的表
 * （浏览器里能看出是没翻译，而不是空白）。要直接拼给用户看的文本请走 `t()`。
 */
export function mergeMessages(table: Table, lang: Lang): Messages {
  const master = table.zh ?? {};
  const own = table[lang] ?? {};
  const fallback = table[FALLBACK_LANG] ?? {};
  const merged: Messages = {};
  for (const key of Object.keys(master)) {
    merged[key] = own[key] ?? fallback[key] ?? key;
  }
  return merged;
}

/** 真表 + 回落链：`api/i18n.ts` 下发用（路由行为与响应形状都是这一份）。 */
export function messagesFor(lang: Lang): Messages {
  return mergeMessages(TABLE, lang);
}

/**
 * 取**一条**文案，服务端要把它拼进给用户看的文本时用（故障码快路的末行）。
 *
 * 缺 key 时返回 `null`，**不**像 `mergeMessages` 那样回落成 key 原文：给前端的表里出现
 * `fault.source` 是"开发期可见的未翻译标记"，而拼进答复正文里的 `fault.source` 是**用户面前的故障**。
 * 宁可让调用方少一行，也不要在德语答复里露出一串英文 key —— 这个取舍写在调用方（`core/fastpath.ts`）。
 */
export function t(lang: Lang, key: string): string | null {
  return TABLE[lang]?.[key] ?? TABLE[FALLBACK_LANG]?.[key] ?? null;
}
