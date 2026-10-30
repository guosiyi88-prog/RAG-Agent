/**
 * 输入语言检测（D5 / D18 / D20 / D28）。
 *
 * **为什么不是模型**：每轮对话多一次网络往返 = 多一份延迟、成本与失败面，而这件事只需要
 * "五语里挑一个"。规则法在毫秒级、零依赖、可逐格单测，且判错时**退回用户声明的语言**
 * （`chat.ts` 的回落链），代价可控。
 *
 * **为什么不能只靠字符集**：`de/nl/es` 共享拉丁字母，`ä/ö/ü` 与 `ij` 与 `ñ` 只能给出"像哪一门"，
 * 真正的区分靠**停用词投票**（`wie/ist/die` vs `hoe/de/het` vs `que/la/de`）。字符集负责
 * "一眼定论"（中文、德语变音、西语问号），停用词负责"欧洲三兄弟里挑一个"。
 *
 * **平票必须回落**，不许猜：`hallo`（德语与荷兰语都是招呼语）、`de la`（西语与荷兰语都有这两个词）
 * 这类输入一律返回 `null`，由调用方沿 `detect → 会话记忆 → 客户端声明 → Accept-Language → en`
 * 继续往下走。猜错的代价是"答错语言"，比"用界面语言"更糟。
 */
import { LANGUAGES, type Lang } from "./chunk.ts";

/** 定论门槛：至少两票才算"这门语言"，一票不够（英语的 `die`、西语的 `la` 都会单独出现）。 */
const MIN_SCORE = 2;

/** 只看前 400 字符：一句问题远用不到这么多，而超长粘贴不该把检测变成正则赛跑。 */
const MAX_SCAN = 400;

/** 一眼定论：出现这些字符就直接判定，不再投票。中文用汉字区，西语用倒问号/倒感叹号/ñ。 */
const STRONG_SCRIPT: readonly { lang: Lang; re: RegExp }[] = [
  { lang: "zh", re: /[\u3400-\u4dbf\u4e00-\u9fff]/ },
  { lang: "es", re: /[ñ¿¡]/ },
  // `ä/ö/ü/ß` 只在德语里是正字法的一部分（荷兰语偶有外来词，但整句里不会只有它）。
  { lang: "de", re: /[äöüß]/ },
];

/** 加分项：不够"一眼定论"，但强烈倾向某语。`ij` 是荷兰语最高频的双字母组合（`mijn/zijn/tijd`）。 */
const WEAK_CHARS: readonly { lang: Lang; re: RegExp; weight: number }[] = [
  { lang: "nl", re: /ij/g, weight: 2 },
  // 西语的重音字母：`áéíóú` 在荷兰语/德语里只出现在外来词。
  { lang: "es", re: /[áéíóú]/g, weight: 2 },
];

/**
 * 停用词表：只收**在本语里高频、且尽量不与其他语同形**的词。
 *
 * 刻意不收的东西：
 *   - `hallo` / `hola` 这类招呼语 —— `hallo` 德荷同形，收进来就是制造平票；
 *   - `garantie` / `warranty` 这类术语 —— 它们来自用户问题本身，容易整句只有一个词；
 *   - `in` / `is` / `de` 里的跨语高频词能收就收一层（见下面各表内的取舍注释）。
 * 一句话：这张表是"投票器"，宁可少收，不可收脏。
 */
const STOPWORDS: Readonly<Record<Lang, readonly string[]>> = {
  en: [
    "the", "and", "are", "what", "how", "does", "do", "of", "to", "for", "my", "your", "can",
    "should", "with", "this", "that", "when", "where", "why", "have", "has", "will", "not",
    "from", "about", "there", "it", "was", "were", "would", "could", "please",
    // 单字母与短词：`Good morning, I have a question` 这类只有 have 能投票，加上 i/a 才够两票。
    "i", "a", "am", "in", "on", "at", "is",
  ],
  de: [
    "der", "die", "das", "und", "ist", "nicht", "wie", "was", "wo", "wann", "warum", "ich",
    "sie", "wir", "mein", "meine", "kann", "können", "muss", "für", "mit", "auf", "von", "zu",
    "ein", "eine", "einen", "gibt", "es", "dass", "oder", "aber", "sehr", "auch", "noch",
    "wird", "werden", "haben", "hat", "bitte", "warum", "welche", "welcher", "dieser", "diese",
    // 说明书/客服场景的高频动词与量词：`Was bedeutet Fehlercode E03?` 只有 was 一票，加了才够。
    "bedeutet", "brauche", "guten", "hilfe", "im", "enthalten", "sind", "zum", "zur", "kannst",
    // 夹英文术语的德语句（`Batterie zeigt Fault E07, was tun?`）只能靠本语动词定论。
    "zeigt", "tun", "funktioniert", "macht", "dauert", "bekomme", "bekommen", "liefert",
  ],
  nl: [
    "het", "een", "van", "niet", "wat", "hoe", "waar", "wanneer", "waarom", "ik", "wij", "mijn",
    "kan", "kunnen", "moet", "voor", "met", "op", "zijn", "wordt", "heeft", "ook", "maar", "als",
    "dan", "deze", "dit", "bij", "naar", "om", "te", "er", "nog", "geen", "welke", "graag",
    // `de` 荷兰语定冠词最常用；同时收进 es（西语的 de = of）。两语各一票，平票自然回落，
    // 而 `Hoe lang is de garantie?` 靠 hoe+de 定成荷兰语。
    "de", "betekent", "jullie", "geven", "heb", "vraag", "hoeveel", "wel",
  ],
  es: [
    "el", "la", "los", "las", "que", "y", "un", "una", "es", "son", "cómo", "como", "qué",
    "cuándo", "dónde", "por", "para", "con", "mi", "su", "puede", "puedo", "hay", "está", "muy",
    "más", "pero", "también", "este", "esta", "del", "al", "se", "lo", "cuanto", "cuánto",
    "necesito", "quiero", "favor",
    // `de`（of）与 `a`（to）与英语共用，两边都收：谁的同形词多谁就多一票，靠别的词决胜。
    "de", "a", "duración", "funciona", "tengo",
  ],
  // 中文靠字符集定论，停用词表留空：CJK 之外没有"中文 token"可言。
  zh: [],
};

/** 每门语言一张查表集合：投票是"逐 token × 逐语言"的矩形扫描，Set 查找是这里的性能关键。 */
const STOPWORD_SETS: Readonly<Record<Lang, ReadonlySet<string>>> = {
  zh: new Set(STOPWORDS.zh),
  en: new Set(STOPWORDS.en),
  de: new Set(STOPWORDS.de),
  nl: new Set(STOPWORDS.nl),
  es: new Set(STOPWORDS.es),
};

/** 切词：只留字母（含变音与西语重音）。`E03`、`230V` 这类数字与型号不参与投票。 */
const TOKEN_RE = /[a-zà-öø-ÿßñ]+/g;

/**
 * 检测一段输入的语言。
 *
 * @param text 用户原话（长度不限；只取前 `MAX_SCAN` 个字符，够投票且防超长输入拖慢）
 * @returns 五语之一；**判断不出来返回 `null`**（平票、太短、没有特征、非五语文字）
 */
export function detectLang(text: string): Lang | null {
  if (typeof text !== "string") return null;
  const sample = text.slice(0, MAX_SCAN).toLowerCase();
  if (sample.trim() === "") return null;

  // ① 一眼定论：汉字 / 西语倒问号 / 德语变音。这一步不看词，也不会平票。
  for (const { lang, re } of STRONG_SCRIPT) {
    if (re.test(sample)) return lang;
  }

  // ② 字符加分：`ij` 偏荷兰语、`áéíóú` 偏西语。
  const score = new Map<Lang, number>(LANGUAGES.map((lang) => [lang, 0]));
  for (const { lang, re, weight } of WEAK_CHARS) {
    const hits = sample.match(re)?.length ?? 0;
    if (hits > 0) score.set(lang, (score.get(lang) ?? 0) + Math.min(hits, 3) * weight);
  }

  // ③ 停用词投票：按**去重后**的词计票（同一词出现五次只算一票，否则复读一句话就能刷票）。
  const tokens = new Set(sample.match(TOKEN_RE) ?? []);
  for (const token of tokens) {
    for (const lang of LANGUAGES) {
      if (STOPWORD_SETS[lang].has(token)) score.set(lang, (score.get(lang) ?? 0) + 1);
    }
  }

  // ④ 取最高分：低于门槛不给结论；**并列最高也不给**（平票=不知道，交给回落链）。
  let best: Lang | null = null;
  let bestScore = 0;
  let tied = false;
  for (const lang of LANGUAGES) {
    const value = score.get(lang) ?? 0;
    if (value > bestScore) { best = lang; bestScore = value; tied = false; }
    else if (value === bestScore && value > 0) tied = true;
  }
  if (best === null || bestScore < MIN_SCORE || tied) return null;
  return best;
}

/**
 * 本轮该用哪门语言回答 —— **回落链的唯一实现**（D28）。
 *
 * 顺序固定：`检测 → 会话记忆 → 客户端声明 → Accept-Language → en`。放在这里而不是散在
 * `parseChat` 的 if 里，是因为"顺序"本身就是规格：任何两格换位置都会产生一种难查的行为
 * （最典型：把界面语言摆在会话记忆前面，裸码 `E03` 就会突然答成界面语言）。
 *
 * @param input.text 用户本轮原话
 * @param input.declared 客户端声明的语言（= 界面语言），没声明传 `undefined`
 * @param input.remembered 本会话上一轮的语言（池里读），读不到传 `undefined`
 * @param input.acceptLanguage 从 `Accept-Language` 猜出来的语言，猜不到传 `undefined`
 */
export function resolveTurnLang(input: {
  text: string;
  declared?: Lang;
  remembered?: string;
  acceptLanguage?: Lang;
}): Lang {
  const detected = detectLang(input.text);
  if (detected !== null) return detected;
  const remembered = input.remembered;
  if (typeof remembered === "string" && isLang(remembered)) return remembered;
  if (input.declared !== undefined) return input.declared;
  if (input.acceptLanguage !== undefined) return input.acceptLanguage;
  return "en";
}

/** 运行时的 `isKnownLang` 版本：池里的 `slot.lang` 是 string，不能直接当 `Lang` 用。 */
function isLang(value: string): value is Lang {
  return (LANGUAGES as readonly string[]).includes(value);
}
