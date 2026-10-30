/**
 * 寒暄前置（R1-1）：一句"你好"不该走检索、不该走模型、更不该建一张工单。
 *
 * 为什么需要这条：检索阈值 0.30 对"你好"这种没有实体的输入必然打不中，于是走拒答四步 ——
 * 用户看到的是"这个问题我需要工程师确认，已为你创建工单"。实测每句招呼 +1 张工单，
 * 队列与"未命中池"因此被灌满噪声（这是开工前实测到的第一条真问题）。
 *
 * 三条刻意的边界：
 *   1. **只认"整句都是招呼"**：`你好，请问保修多久` 必须落回正常对话 —— 它带实体（保修），
 *      用寒暄话术回答等于把真问题吃掉。所以判据是"每个词都在招呼词表里"，不是"包含招呼词"。
 *   2. **不认数字**：含数字的输入一律不判寒暄（`E03`、`2026`、`2032` 都可能长得像短句）。
 *   3. **不调模型**：话术是常量表（五语），与拒答话术同性质（ADR-0004 的"固定文案不经模型"）。
 *      因此这条路径同样不记账（`ai_runs` 只记模型轮次），也不创建工单。
 */
import type { Lang } from "./chunk.ts";

/** 一句话最多几个词：超过就不像招呼了（"hello hello hello hello hello hello hello"）。 */
const MAX_WORDS = 6;
/** 字符上限（去空白后）：中文一句话很短，留一点余量给"早上好，谢谢"。 */
const MAX_CHARS = 40;

/**
 * 招呼词表：只收**纯招呼/致谢**，不收任何带实体的词。
 * 五语混在一张表里是刻意的：客户在德语界面打 `hello` 是常见事，而这里不需要判断"这是哪门语言"。
 */
const GREETINGS: readonly string[] = [
  // 中文（中文不分词，另有整串匹配）
  "你好", "您好", "嗨", "哈喽", "哈罗", "早上好", "早安", "上午好", "下午好", "晚上好",
  "在吗", "在么", "谢谢", "多谢", "感谢", "辛苦了", "谢谢你", "谢谢您",
  // 英文
  "hello", "hi", "hey", "heya", "good", "morning", "afternoon", "evening", "thanks", "thank", "you", "thx",
  // 德文
  "hallo", "servus", "moin", "guten", "tag", "morgen", "abend", "grüß", "gott", "danke", "vielen", "dank",
  // 荷兰文
  "hoi", "goedemorgen", "goedemiddag", "goedendag", "goedenavond", "bedankt", "alsjeblieft",
  // 西班牙文
  "hola", "buenos", "buenas", "días", "tardes", "noches", "gracias", "favor",
];

/**
 * 允许出现但**不构成**招呼的填充词：`Danke schön`、`thanks a lot`、`por favor` 里的副词/冠词。
 * 与 GREETINGS 的区别是"必须至少有一个真招呼词"——只由填充词组成的输入（"very"）不算招呼。
 */
const FILLERS: readonly string[] = [
  "schön", "sehr", "viel", "vielen", // de（vielen 也在招呼表里，重复无妨）
  "a", "lot", "so", "much", "very", "kind", "regards", // en
  "heel", "erg", "veel", // nl
  "por", "muy", "mucho", "muchas", // es
];

const GREETING_SET: ReadonlySet<string> = new Set(GREETINGS);
const FILLER_SET: ReadonlySet<string> = new Set(FILLERS);
/** 无空格语言（中文）用整串匹配：`你好` 分词后不会变成多个词。 */
const GREETING_FLAT: ReadonlySet<string> = new Set(GREETINGS);

/** 招呼话术（五语）。要点：**先说能干什么**，别只说"很高兴为您服务"——那是填充不是信息。 */
const GREETING_COPY: Readonly<Record<Lang, string>> = {
  zh: "你好，我是沃泰的售后助手。你可以直接做三件事：① 报一个故障码（例如 E03）；② 问保修、安装或技术参数；③ 需要人工时点页面上的「转人工」。",
  en: "Hi, I'm Wotai's support assistant. Three things you can do right away: (1) give me a fault code (e.g. E03); (2) ask about warranty, installation or specs; (3) tap \"Talk to a human\" if you need a person.",
  de: "Hallo, ich bin der Wotai-Support-Assistent. Drei Dinge gehen sofort: (1) Fehlercode nennen (z. B. E03); (2) Fragen zu Garantie, Montage oder technischen Daten; (3) für einen Menschen auf „An Menschen weitergeben“ tippen.",
  nl: "Hallo, ik ben de Wotai-supportassistent. Drie dingen kunnen direct: (1) een foutcode noemen (bijv. E03); (2) vragen over garantie, montage of specificaties; (3) tik op „Doorgeven aan een mens“ als je een persoon nodig hebt.",
  es: "Hola, soy el asistente de soporte de Wotai. Puedes hacer tres cosas ahora mismo: (1) darme un código de fallo (p. ej. E03); (2) preguntar por garantía, instalación o especificaciones; (3) tocar «Hablar con una persona» si necesitas a alguien.",
};

/** 判形只做"清洗 + 分词"，归一化规则与语言检测保持同一套思路（小写、去标点、去空白）。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * 这句输入是不是"纯寒暄"。
 *
 * 返回 `false` 的情形比 `true` 多得多，这是对的：只要句子里有一个不带招呼词性的词
 * （`garantie`、`保修`、`E03`、`2032`），它就可能是真问题，必须落回正常路径。
 */
export function isGreeting(text: string): boolean {
  if (typeof text !== "string") return false;
  const clean = normalize(text);
  if (clean === "") return false;
  // 数字一律排除：故障码、型号、年份都可能是"短输入"，不能被寒暄吃掉。
  if (/\d/.test(clean)) return false;
  const flat = clean.replace(/\s+/g, "");
  if (flat.length > MAX_CHARS) return false;
  if (GREETING_FLAT.has(flat)) return true; // 中文单串
  const words = clean.split(/\s+/);
  if (words.length === 0 || words.length > MAX_WORDS) return false;
  // 每个词都必须是"招呼词或填充词"，**并且**至少有一个真招呼词：
  // "very" 这种只有填充词的输入不算招呼，"thanks a lot" 算。
  if (!words.every((word) => GREETING_SET.has(word) || FILLER_SET.has(word))) return false;
  return words.some((word) => GREETING_SET.has(word));
}

/**
 * 命中就返回该语的固定话术，否则 `null`。
 *
 * 语言用调用方解析好的 `lang`（`resolveTurnLang` 的结论），**不在这里再判一次**：
 * 两条语言判定路径迟早会给出两个答案。
 */
export function greetingReply(text: string, lang: Lang): string | null {
  if (!isGreeting(text)) return null;
  return GREETING_COPY[lang] ?? GREETING_COPY.en;
}
