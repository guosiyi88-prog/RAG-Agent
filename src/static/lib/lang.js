/**
 * 语言选择与故障码判形（`06` spec 的「语言回落」接缝 / `10-ui-user.md` §8 / `12-i18n.md` §2）。
 *
 * 这里刻意只做**纯函数**：本地存储与浏览器语言由页面读出来当参数传进来，
 * 于是回落链（本地存储 → 浏览器语言前两位 → 英语）可以在 node 里一格一格断言，
 * 不用起浏览器、不用 mock 宿主全局对象。
 */

/** 五语种，顺序与后端 `LANGUAGES`（`src/core/chunk.ts`）一致；冻结防止页面脚本就地改掉。 */
export const SUPPORTED_LANGS = Object.freeze(["zh", "en", "de", "nl", "es"]);

/**
 * 语言菜单里的**母语名字**（D7）：每种语言用自己那一门写，谁都能认出自己那一行。
 *
 * 为什么不用 `i18n.json` 的 `lang.*`：那 127 条 key 是**界面语言**的产物，切到德语之后
 * 菜单里的"中文"会变成"Chinesisch"——一个中文用户就再也找不到自己的语言了。
 * 菜单的语言名必须在任何界面语言下都保持母语写法，所以它不进文案表，进这里。
 */
export const LANG_NAMES = Object.freeze({
  zh: "中文",
  en: "English",
  de: "Deutsch",
  nl: "Nederlands",
  es: "Español",
});

/** 兜底语言：PRD 定的是英语（`12-i18n.md` §2 的回落链终点）。 */
const FALLBACK_LANG = "en";

/**
 * BCP 47 之类的标签取「前两位」：`de-DE` → `de`、`zh-Hans-CN` → `zh`、`de_DE` → `de`。
 * 垃圾输入（空串、纯空白、`123`、`deutsch`、非字符串）统一返回 `""`，
 * 由调用方当成「没有这个信息」继续往下回落 —— 不要在归一化里再偷偷塞一个默认值。
 */
export function normalizeLang(tag) {
  if (typeof tag !== "string") return "";
  const primary = tag.trim().split(/[-_]/)[0] ?? "";
  // 2~3 个字母才是语言代码（`es-419` 取 `es`、`en` 取 `en`）；其余一律视为无效。
  return /^[a-z]{2,3}$/i.test(primary) ? primary.toLowerCase() : "";
}

/**
 * 语言回落：本地存储 → 浏览器语言前两位 → 英语；未知语言回落 `en`。
 *
 * `supported` 可覆盖，是为了让测试能把「五语之外」的边界单独钉住；
 * 页面调用时一律用默认的 `SUPPORTED_LANGS`，不要自己传一份，否则两处列表会漂。
 *
 * @param {{ stored?: string, browser?: string, supported?: readonly string[] }} [input]
 * @returns {string}
 */
export function pickLang({ stored, browser, supported = SUPPORTED_LANGS } = {}) {
  const list = Array.isArray(supported) && supported.length > 0 ? supported : SUPPORTED_LANGS;
  // 顺序即优先级：本地存储里是用户显式选过的，哪怕浏览器是别的语言也以它为准；
  // 但存的值不在支持列表里（比如手工改过本地存储、或换了一版砍掉某语种）就继续往下走。
  for (const candidate of [stored, browser]) {
    const lang = normalizeLang(candidate);
    if (lang !== "" && list.includes(lang)) return lang;
  }
  return list.includes(FALLBACK_LANG) ? FALLBACK_LANG : list[0];
}

/**
 * 故障码判形：整串 `字母 + 2~3 位数字`，大小写不敏感，命中返回大写码，否则 null。
 *
 * 与后端 `src/core/fastpath.ts` 的 `FAULT_CODE_RE`（`^[A-Za-z]\d{2,3}$`）**同一口径**，
 * 前后端各写一份是因为浏览器不能直接跑 TS，但这条正则必须两边一起改，否则页面会请求一个后端必然 400 的码。
 * 先 trim 再判，也与后端一致：手机上粘过来的故障码常带空格或换行。
 * 整串锚定是故意的 —— `故障码 E03`、`E03 Fehlercode` 不是故障码，得走正常对话，别被快路截断。
 */
export function matchFaultCode(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return /^[A-Za-z]\d{2,3}$/.test(trimmed) ? trimmed.toUpperCase() : null;
}
