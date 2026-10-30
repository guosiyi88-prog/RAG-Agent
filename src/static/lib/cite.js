/**
 * 正文 + 引用列表 → 渲染片段（`10-ui-user.md` §3.2「角标渲染规则」/ `05-api.md` §3.2 规则 3）。
 *
 * **前端不虚构角标**：只有正文里 `[n]` 的 n 真的出现在服务端下发的 citations 里，才换成角标片段；
 * 不在列表里的一律原样留成纯文本。后端本应拦掉非法编号（`citations` 只下发答案实际引用到的片段），
 * 这里只是兜底 —— 上游一旦漏拦，宁可让用户看到一段带 `[9]` 的纯文本，也不能画一个点开是空的角标：
 * 「客户点开发现这段没支持那句话，信任直接崩」（规格原话）。
 *
 * 同理，抽屉内容也完全来自服务端：这里**不做**任何按出现顺序、按页码、按文档名的猜测补全，
 * 输出里只有 `idx` 与可访问标签，正文之外的字段由页面拿 citations 原对象去渲染。
 */

/** 与后端同一口径的角标形：`[` + 纯数字 + `]`（后端用 `/\[(\d+)\]/g` 提取，空格不算）。 */
const CITE_PATTERN = /\[(\d+)\]/g;

/** 把引用列表收成 idx → 引用 的映射；列表本身来自 JSON，形状不可信，这里逐条筛。 */
function indexCitations(citations) {
  const known = new Map();
  if (!Array.isArray(citations)) return known;
  for (const cite of citations) {
    if (cite === null || typeof cite !== "object") continue;
    const idx = cite.idx;
    if (!Number.isInteger(idx) || idx <= 0) continue;
    // 重复 idx 取第一条：后端已按 idx 升序去重，这里只是不让脏数据把角标换两次。
    if (!known.has(idx)) known.set(idx, cite);
  }
  return known;
}

/**
 * 正文 + 引用列表 → 渲染片段数组。
 *
 * 返回的片段只有一个**有序**含义：页面按顺序 append 纯文本节点与角标元素即可，不需要再切字符串。
 * `label` 是给读屏的短标签（「引用 1」），页面再拼上「查看原文」之类的动词。
 *
 * @param {string} text 助手正文（可能含 `[1]` 形态的裸角标）
 * @param {Array<{idx:number, doc_title?:string, page?:number|null, snippet?:string, doc_lang?:string}>} citations
 * @returns {Array<{ type: "text", value: string } | { type: "cite", idx: number, label: string }>}
 */
export function renderCitations(text, citations) {
  const source = typeof text === "string" ? text : String(text ?? "");
  const known = indexCitations(citations);

  // 没有引用列表时正文一个字符都不动：这是「不虚构角标」的极端情形，
  // 也是 06 spec 点名要断言的一条（空列表 → 正文原样返回，单段）。
  if (known.size === 0) return [{ type: "text", value: source }];

  const segments = [];
  let cursor = 0;

  for (const match of source.matchAll(CITE_PATTERN)) {
    const parsed = Number(match[1]);
    const cite = Number.isInteger(parsed) ? known.get(parsed) : undefined;
    if (cite === undefined) continue; // 不在列表里：不动 cursor，这段稍后按纯文本带出去

    const before = source.slice(cursor, match.index);
    if (before !== "") segments.push({ type: "text", value: before });

    segments.push({ type: "cite", idx: cite.idx, label: `引用 ${cite.idx}` });
    cursor = match.index + match[0].length;
  }

  const tail = source.slice(cursor);
  if (tail !== "") segments.push({ type: "text", value: tail });

  // 有引用列表但正文一个角标都没命中（例如答案只有 `[9]`）：同样原样返回，
  // 页面据此渲染一段纯文本，而不是渲染一个空气泡。
  if (segments.length === 0) return [{ type: "text", value: source }];
  return segments;
}
