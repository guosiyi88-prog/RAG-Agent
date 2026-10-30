/**
 * 清洗 —— 按顺序执行的四步（08-ingestion.md §3）。顺序是契约，不可换、不可合并：
 * 1 去页眉页脚 → 2 折叠空白 → 3 去孤立页码行 → 4 全角转半角 → 5 保留大小写与标点。
 * 已知代价：全角写的页码行（`１２`）在第 3 步还认不出来，会漏删 ——
 * 这是规格规定的顺序，不许为了多删一行页码把第 4 步挪到第 3 步前面。
 *
 * 不做：不去 HTML 标签、不做拼写纠正、不翻译、不去标点、不改大小写。
 * 这些看起来"顺手就能做"的动作会破坏术语（`WT-ESS-5K` 被当成拼写错误改掉就是事故）。
 */

/** 08 §3.1：连续 3 页出现且长度 < 60 的行判为页眉/页脚。 */
export const HEADER_MIN_PAGES = 3;
export const HEADER_MAX_CHARS = 60;

function normalizeLineKey(line: string): string {
  // 只压空白做比较键：页眉常带页码对齐用的多个空格，原样比较会漏掉
  return line.trim().replace(/\s+/g, " ");
}

/**
 * 步骤 1：去页眉页脚。
 *
 * 判定口径是"同一行文本连续出现在 ≥3 页"且 `length < 60`，不是"第一行/最后一行"。
 * 按位置删会在只有一页的文档上误删正文首行；按内容删需要至少三页才能成立 ——
 * 单页文档没有页眉可去，这里就是 no-op，这是刻意接受的漏。
 */
export function stripRepeatedHeaders(pages: readonly string[]): string[] {
  const pagesOfKey = new Map<string, number[]>();
  pages.forEach((page, pageIndex) => {
    const seenOnThisPage = new Set<string>();
    for (const line of page.split("\n")) {
      const key = normalizeLineKey(line);
      if (key === "" || key.length >= HEADER_MAX_CHARS) continue;
      if (seenOnThisPage.has(key)) continue;
      seenOnThisPage.add(key);
      const list = pagesOfKey.get(key) ?? [];
      list.push(pageIndex);
      pagesOfKey.set(key, list);
    }
  });

  const dropByPage = new Map<number, Set<string>>();
  for (const [key, pageIndexes] of pagesOfKey) {
    let runStart = 0;
    for (let i = 1; i <= pageIndexes.length; i += 1) {
      const continues = i < pageIndexes.length && pageIndexes[i] === pageIndexes[i - 1]! + 1;
      if (continues) continue;
      const runLength = i - runStart;
      if (runLength >= HEADER_MIN_PAGES) {
        for (let j = runStart; j < i; j += 1) {
          const pageIndex = pageIndexes[j]!;
          const set = dropByPage.get(pageIndex) ?? new Set<string>();
          set.add(key);
          dropByPage.set(pageIndex, set);
        }
      }
      runStart = i;
    }
  }

  if (dropByPage.size === 0) return [...pages];

  return pages.map((page, pageIndex) => {
    const drop = dropByPage.get(pageIndex);
    if (!drop) return page;
    return page
      .split("\n")
      .filter((line) => !drop.has(normalizeLineKey(line)))
      .join("\n");
  });
}

/** 步骤 4：全角 → 半角，范围严格限制在数字与英文括号。 */
const FULLWIDTH_DIGIT = /[\uFF10-\uFF19]/g;
const FULLWIDTH_PAREN = /[\uFF08\uFF09]/g;

export function toHalfwidthDigitsAndParens(text: string): string {
  return text
    .replace(FULLWIDTH_DIGIT, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(FULLWIDTH_PAREN, (ch) => (ch === "\uFF08" ? "(" : ")"));
}

/** 步骤 3：孤立页码行（只含 1–3 位数字）。 */
const ISOLATED_PAGE_NUMBER = /^\s*\d{1,3}\s*$/;

/**
 * 清洗入口：输入按页切好的文本，输出同样页数的清洗结果。
 * 页数与页序必须保持不变 —— 片段页码（`chunks.page`）直接吃这里的下标。
 */
export function cleanPages(pages: readonly string[]): string[] {
  // 1. 去页眉页脚
  const withoutHeaders = stripRepeatedHeaders(pages);

  return withoutHeaders.map((raw) => {
    // 2. 折叠空白：行尾空格删掉，\n{3,} → \n\n
    let text = raw
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n");

    // 3. 去孤立页码行（留下空行没关系，段落切分只看空行）
    const lines = text.split("\n").map((line) => (ISOLATED_PAGE_NUMBER.test(line) ? "" : line));
    text = lines.join("\n").replace(/\n{3,}/g, "\n\n");

    // 4. 全角转半角（仅数字与英文括号）
    text = toHalfwidthDigitsAndParens(text);

    // 5. 保留原文大小写与标点 —— 这一步是"什么都不做"，写出来是为了让顺序可审
    return text;
  });
}

/** 单页便利入口（`.txt` / `.md` 不分页时用）。 */
export function cleanText(text: string): string {
  return cleanPages([text])[0] ?? "";
}
