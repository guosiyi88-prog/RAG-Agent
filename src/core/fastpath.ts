/**
 * 故障码快路（05-api.md §3.2「故障码快路」/ 04-agent-chat #03）。
 *
 * 纯逻辑：判形 + 拼答复文本。**不建 Agent 会话、不调模型、不调嵌入、不查 chunks** ——
 * 故障码只存在 `fault_codes` 表里（`03#02` 实测：`chunks` 里 `E03` 零命中，语义检索那条路
 * 根本召不回来），所以这条路径必须是主键命中，才能做到"1 秒内出结果卡、完全不烧 token"。
 *
 * 判形用整串锚定（`^…$`），不是 `includes`：`E03 Fehlercode` 这种提问要走正常对话，
 * 否则用户问"E03 是什么意思，顺便保修多久"会被快路截断成一个只剩故障码的答复。
 */
import { LANGUAGES, type Lang } from "./chunk.ts";
import { lookupFaultCode, type FaultCodeHit } from "./fault-codes.ts";
import { t } from "./i18n-table.ts";

/** 05 §3.2 的判形：一个字母 + 2~3 位数字，且必须是**整条输入**。 */
export const FAULT_CODE_RE = /^[A-Za-z]\d{2,3}$/;

/**
 * 快路答复末行的文案 key（`12-i18n.md` §4 的 `fault.source`）。
 *
 * 这里**只有 key，没有兜底字面量**：真源是 `src/static/i18n.json` 一份。上一版在这个位置写死了
 * `来源：故障码表`（`FAULT_REPLY_SOURCE`），于是德语 / 英语 / 荷兰语 / 西班牙语用户的答复末行
 * 全是汉字 —— 那正是 §4.10 禁止的"同一个字符串两份真源"，也是本次修掉的缺陷。
 */
export const FAULT_REPLY_SOURCE_KEY = "fault.source";

/** 用户只输入了一个故障码时返回规范化后的大写码，否则 null（走正常对话）。 */
export function matchFaultCode(text: string): string | null {
  const trimmed = text.trim();
  return FAULT_CODE_RE.test(trimmed) ? trimmed.toUpperCase() : null;
}

/**
 * 非五语的 `lang` 一律按 `en` 处理（与 `core/fault-codes.ts` 的 `orderedLangs` 同一口径）：
 * 快路是核心层的纯函数，被直接调用时不该因为一个没归一的语种标签就抛 —— 路由侧
 * （`api/chat.ts` 的 `parseChat`）已经保证下发的是五语之一，这里只是兜住核心层的直接调用。
 */
function knownLang(lang: string): Lang {
  const normalized = lang.trim().toLowerCase() as Lang;
  return LANGUAGES.includes(normalized) ? normalized : "en";
}

/** `t` 的形状。抽成参数是为了让测试能注入一张"缺 key 的表"，而不必去改真表造缺 key。 */
type TextResolver = (lang: Lang, key: string) => string | null;

/**
 * 拼快路答复：含义 → 有序步骤 → 来源行（末行文案按语种取）。
 *
 * 步骤如果语料里本来就带 `1.` 前缀就原样保留；不重新编号 —— 重新编号会让后端与语料
 * 出现两套步骤号，坐席按工单里的步骤号对不上原文时最费时间。
 *
 * 末行缺失（表里连 en 都没有这个 key）时**整行不输出**，而不是输出空行或 `fault.source`：
 * 用户面前出现一串英文 key 是故障，少一行来源说明只是少一句解释 —— 前者会被当成产品坏了。
 * 这个取舍正是 `t()` 与 `mergeMessages()` 兜底策略不同的原因（见 `core/i18n-table.ts`）。
 *
 * `resolveText` 默认就是真表的 `t`，注入只是为了测试能构造"缺 key"这一格。
 */
export function formatFaultReply(
  hit: FaultCodeHit,
  lang: Lang,
  resolveText: TextResolver = t,
): string {
  const lines: string[] = [];
  if (hit.meaning.trim() !== "") lines.push(hit.meaning.trim());
  const actions = hit.actions.map((action) => action.trim()).filter((action) => action !== "");
  if (actions.length > 0) lines.push(actions.join("\n"));
  const source = resolveText(lang, FAULT_REPLY_SOURCE_KEY)?.trim() ?? "";
  if (source !== "") lines.push(source);
  return lines.join("\n");
}

/**
 * 快路总入口：命中返回答复文本，未命中返回 null。
 * 数据库异常向上抛（快路失败不该伪装成"未命中"再走模型去编一段）——由调用方决定 500 还是降级。
 */
export async function answerFaultCode(input: {
  code: string;
  lang: string;
}): Promise<{ hit: FaultCodeHit; text: string } | null> {
  const result = await lookupFaultCode({ code: input.code, lang: input.lang });
  if (!result.found) return null;
  // 答复文本的语言与"查表用的语言"是同一个 `lang`：含义/步骤来自 `fault_codes` 的对应列，
  // 末行来源说明来自文案表的同一门语言 —— 两侧各取一次别的语种，就会拼出中德混排的答复。
  return { hit: result, text: formatFaultReply(result, knownLang(input.lang)) };
}
