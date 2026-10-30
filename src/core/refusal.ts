/**
 * 拒答判定与五语固定话术（06-agent.md §5.1 的 ①②③④、§5.3 的权威话术）。
 *
 * 一句话职责：把"答不了"变成**确定性路径**，而不是靠模型自觉。
 * 判定只读四个已经算好的量（检索降级标签、融合分、阈值、引用校验结论）+ 模型正文，
 * 按序短路，命中即返回一个 reason；怎么动作（丢弃正文 → 下发话术 → 建单 → 下发单号）
 * 由收尾流程按 06 §5.1 的四步执行，本文件不碰 I/O。
 *
 * 为什么是**纯函数**：这段逻辑决定"客户看到的是答案还是工单"，必须能被单测按分支钉死，
 * 且必须能在毫秒级跑完。所以本文件**零运行时依赖**（下面三个 `import type` 编译后全部消失）：
 * 话术不许来自模型、不许来自网络、不许来自文案表 —— 它是常量。
 * `tests/refusal.test.ts` 里有一条静态断言在守这条红线：本文件一旦 import 了 embed/agent/
 * hash-embed 或任何网络模块，那条断言立刻变红。
 *
 * 五条判定的顺序不可调换（06 §5.1，命中即返回），原因分配也不可调换：
 *   ①-a 检索空      → `no_citation`   检索阶段就没结果，模型**根本不该被调用**
 *   ①-b 融合分低    → `low_conf`      检索有东西但不够可信
 *   ②  哨兵/无候选  → `no_citation`   模型自己说不知道，或本轮候选缓冲为空
 *   ③  正文无角标   → `no_citation`   通篇没有角标的散文不许发给客户
 *   ④  角标非法     → `low_conf`      模型编了候选集之外的编号，整条丢弃
 *   ⑤  以上都不中   → 正常出 citations
 * ③ 记 `no_citation`、④ 记 `low_conf` 而不是反过来：③ 的模型侧修法是"补标注"，
 * ④ 的模型侧修法是"别编编号"，两个原因分开才能在工单与日志里看出该改 prompt 的哪一半。
 */
import type { Lang } from "./chunk.ts";
import type { CitationVerdict } from "./citations.ts";
import type { RetrievalFallback } from "./retrieval.ts";

/**
 * 五语固定话术（06 §5.3 逐字照抄，**不许翻译/改写/换标点**）。
 *
 * 三条铁律：
 *   - **不经模型**：由后端在拒答时直接下发，这是"拒答额外延迟 ≈ 0"的全部原因；
 *   - **不带单号占位符**：工单号走独立的 `refusal` SSE 事件（前端渲染工单小卡），
 *     话术里出现 `{no}` 就等于把"话术是常量"这件事破坏了；
 *   - **不进文案表**：`12-i18n.md` §4.10 已删掉 `refusal.*` 这 5 个 key，
 *     本表是唯一真源，加一个 key 等于多一份会各自漂移的副本。
 */
export const REFUSAL: Record<Lang, string> = {
  zh: "这个问题我需要工程师确认。已为你创建工单，我们会在 4 小时内联系你。",
  en: "I need an engineer to confirm this. I've created a ticket for you; we'll get back to you within 4 hours.",
  de: "Das muss ein Techniker prüfen. Ich habe ein Ticket für Sie erstellt; wir melden uns innerhalb von 4 Stunden.",
  nl: "Dit moet een technicus bevestigen. Ik heb een ticket voor u aangemaakt; we nemen binnen 4 uur contact op.",
  es: "Necesito que lo confirme un técnico. He creado un ticket; te contactaremos en un plazo de 4 horas.",
};

/** 工单 reason 的唯一两个取值（`05-refusal-and-tickets` T06 的"无引用 / 低置信"）。 */
export type RefusalReason = "no_citation" | "low_conf";

export type RefusalVerdict = { refuse: true; reason: RefusalReason } | { refuse: false };

export type RefusalInput = {
  /** 本轮检索的降级标签（07 §9）。`"fts_only"` 只表示语义召回降级，**本身不是拒答理由**。 */
  fallback: RetrievalFallback;
  /** 融合后归一化的分数（07 §5.2），**只有这个分能与 `minScore` 比**。 */
  topScore: number;
  /** `config.retrievalMinScore`（默认 0.30）。 */
  minScore: number;
  /** 引用校验结论（`src/core/citations.ts`）。 */
  citationVerdict: CitationVerdict;
  /** 模型已产出的正文，用于识别 `NO_ANSWER` 哨兵。 */
  text: string;
};

/** 哨兵词（06 §2 规则 3 钉成大写四个字母）。 */
const NO_ANSWER = "NO_ANSWER";

/**
 * 拒答判定（06 §5.1，按序命中即返回）。
 *
 * 注意 ① 的两条**在模型之前**判：检索空/低分时模型根本不该被调用（省一次 3s 的 LLM 调用，
 * 也避免模型用自知识补一个"看起来有道理"的答案）。传进来的 `text` 即便是空串也照样走这条，
 * 调用方不需要为"模型没跑"额外造一条分支。
 */
export function decideRefusal(input: RefusalInput): RefusalVerdict {
  const { fallback, topScore, minScore, citationVerdict, text } = input;

  // ①-a 检索阶段就没结果（`retrieve()` 返回 `chunks: []` + `fallback: "empty"`）。
  // `"fts_only"` 刻意**不**在这里拒答：它只说明向量召回降级到词法召回，语义质量下降，
  // 但结果可能依然够用。把降级标签直接当拒答理由，会让一次 embed 超时把接下来整段时间
  // 的正常问答全部变成工单 —— 拒答与否交给分数（①-b）与引用校验（③④）决定。
  if (fallback === "empty") return { refuse: true, reason: "no_citation" };

  // ①-b 融合分低于阈值。**严格小于**：等于阈值算"够用"。
  // 写成 `<=` 会让阈值上下的正例在边界上随机翻脸（同一句话今天答、明天拒），
  // 评测里表现为 hit@5 正常但拒答率莫名波动。
  if (topScore < minScore) return { refuse: true, reason: "low_conf" };

  const failure = failureReason(citationVerdict);

  // ② 模型自己说不知道，或本轮候选缓冲为空（`no_candidates`）。
  // 哨兵先于 ③④：模型已经声明"不知道"时，正文里的角标/瑕疵都不再值得解释，原因记 no_citation。
  if (hasNoAnswer(text)) return { refuse: true, reason: "no_citation" };

  switch (failure) {
    // ② 候选缓冲为空（本轮 `kb_search` 一条都没返回）。
    case "no_candidates":
      return { refuse: true, reason: "no_citation" };
    // ③ 通篇没有角标的散文：说得再像样也一句都无法回溯。
    case "no_marks":
      return { refuse: true, reason: "no_citation" };
    // ④ 出现候选集之外的编号（模型编了 `[9]` 而本轮只有 2 条候选）：整条丢弃，不挑着用。
    case "illegal_mark":
      return { refuse: true, reason: "low_conf" };
    // ⑤ 通过。switch 不留 default：新增一个失败原因时 TS 会因为"函数可能不返回"而报错，
    //    逼着人先给它一个归属，而不是让它悄悄落进"通过"。
    case null:
      return { refuse: false };
  }
}

/**
 * 取引用校验的失败原因；通过时返回 `null`。
 * 单列成函数是为了让上面的 switch 拿到一个可穷举的联合类型（`CitationVerdict` 的 ok 分支
 * 没有 `reason`，直接取属性需要每处都写一遍类型收窄）。
 */
function failureReason(verdict: CitationVerdict): "no_candidates" | "no_marks" | "illegal_mark" | null {
  return verdict.ok ? null : verdict.reason;
}

/**
 * 哨兵识别（②）。两层，都只在"模型说了不知道"这一个语义上：
 *
 * 1. **区分大小写的子串匹配** —— 这是规范口径（06 §5.1 ② 的 `text.includes("NO_ANSWER")`，
 *    §2 规则 3 也把哨兵钉成大写）。不改成不区分大小写的子串：正文里正常出现的
 *    "no answer" 之类散文会被误判成哨兵，而那些场合该由 ③/④ 判，原因统计会被算歪。
 * 2. **整段相等的加固** —— `text.trim()` 去掉结尾标点后，只剩哨兵本身（大小写不限）也认。
 *    判定面极窄（整段就是那 9 个字符），不碰散文；代价是漏判时把 `no_answer` 原样发给客户。
 *    所以这层是"收得极紧的补丁"，不是放宽。
 */
function hasNoAnswer(text: string): boolean {
  if (text.includes(NO_ANSWER)) return true;
  const whole = text.trim().replace(/[.。!！?？;；:：]+$/u, "").trim();
  return whole.toUpperCase() === NO_ANSWER;
}

/**
 * 取话术。`lang` 是 `string` 而不是 `Lang`：语种可能来自客户端（`Accept-Language`、表单），
 * 到这一步时合法性已经判过，这里只负责"取不到就用英语"—— 拒答路径上**绝不允许**下发空字符串，
 * 那会让客户看到一个空气泡，比答错更像事故。
 *
 * 带地区的标签（`de-DE`、`zh_CN`）先取主语言子标签再试一次：浏览器直接给的就是这种形式，
 * 不认的话德语用户会拿到英语拒答，而他的提问被拒答时最需要看懂那两句话。
 *
 * `copy` 只为单测留口（断言"话术是从表里取的，不是硬编码的某个分支"），生产调用不传第二参。
 */
export function refusalText(lang: string, copy: Record<Lang, string> = REFUSAL): string {
  const tag = String(lang ?? "").trim().toLowerCase();
  if (isLang(tag)) return copy[tag];
  const base = tag.split(/[-_]/u)[0] ?? "";
  if (isLang(base)) return copy[base];
  return copy.en;
}

function isLang(value: string): value is Lang {
  return value === "zh" || value === "en" || value === "de" || value === "nl" || value === "es";
}
