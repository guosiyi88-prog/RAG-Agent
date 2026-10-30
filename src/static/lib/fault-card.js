/**
 * 故障卡"切语言要不要重取"的判据（`10-ui-user.md` §5 / D1）。
 *
 * 为什么单独一个纯函数：`views.js` 里那半个判断（`kind` 是不是有结果、语言变了没有）是**唯一**
 * 会决定"发不发这次请求"的地方，而它一写错就是两种线上故障：
 *   - 该重取却没重取 → 标题跟着文案表换了语言，正文还停在抓取时那一语（录音里"描述都是中文"就是这个）；
 *   - 不该重取却重取 → `onLang` 每轮语言切换会被调用两次（旧字典一次、新字典一次），第二次照发
 *     就是同一张卡打两遍请求，弱网下还会互相盖掉。
 * 所以判据放在这里，由 `tests/web-fault.test.ts` 一格一格钉住；`views.js` 只负责发请求与渲染。
 */

/** `view.fault` 的 kind 只有这几种；只有带结果的两种值得重取。 */
const RESULT_KINDS = ["hit", "miss"];

/**
 * @param {{ kind?: string, lang?: string, lastLang?: string }} input
 *   `kind` = 当前卡片状态，`lang` = 目标语言（界面语言），`lastLang` = 卡里那份数据抓取时用的语言
 * @returns {boolean} true = 应当静默重取
 */
export function needsRefetch({ kind, lang, lastLang } = {}) {
  if (!RESULT_KINDS.includes(kind)) return false;
  // 空语言不是"变了"，是"还没定"：宁可让卡留在旧语，也不发一个 `?lang=` 的空参请求（后端会 400）。
  if (typeof lang !== "string" || lang.trim() === "") return false;
  // `lastLang` 缺失（老页面 / 首屏）也要重取一次：不知道那份数据是什么语，等于不能确认它是对的。
  if (typeof lastLang !== "string" || lastLang === "") return true;
  return lang !== lastLang;
}
