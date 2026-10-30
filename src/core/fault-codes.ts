/**
 * 故障码快路（05-api.md §3.3、§5.2；06-agent.md §3.2）。
 *
 * **为什么单独一条路**：语义检索这条路对故障码是失效的 —— `03-hybrid-retrieval` #02 实测
 * `E03` 在 chunks 里零命中（同一份描述被五个语言副本切碎，分数远在 0.30 阈值之下）。
 * 所以快路的意义就是**主键命中**：按 `(code, product_line)` 直查 `fault_codes` 表，
 * 一条 SQL 拿到五语描述与步骤。因此这里刻意**没有**模型、没有 embedding、没有 LIKE/trgm、
 * 不做词形归一 —— 05 §3.3 给的预算是单条主键查询 P95 < 20ms，任何一次网络往返都会破预算，
 * 而 `like '%E03%'` 会让主键索引彻底用不上。
 *
 * 语言回退：五语齐全时（`core/ingest.ts` 的入库校验保证如此）永远命中请求语言那一列；
 * 回退链只在数据缺语时才生效 —— 那时宁可给英文/中文，也不给空串（空串会让模型把
 * "资料没写"当成"设备没有问题"来回答）。
 */
import { one } from "../db.ts";
import { LANGUAGES, type Lang } from "./chunk.ts";

export type FaultCodeHit = {
  found: true;
  code: string;
  severity: string;
  meaning: string;
  actions: string[];
  /** 实际取用的文本语言，可能不等于请求语言（见回退链）。 */
  docLang: string;
  productLine: string;
};

export type FaultCodeMiss = {
  found: false;
  code: string;
};

/** 05 §3.3 的缺省产品线（主键含 product_line，不带它就不是等值查询）。 */
export const DEFAULT_PRODUCT_LINE = "balcony";

/**
 * 缺语回退顺序：请求语言 → `en` → `zh`。
 * 为什么是这两个兜底：英文是五语语料的公共底稿（术语对得最齐），中文是源稿；
 * 其余两门语言缺语时去猜另一门欧洲语言，只会把德语内容塞给西班牙用户。
 */
const FALLBACK_LANGS: readonly Lang[] = ["en", "zh"];

/** 行形状只声明本功能要用的列：`select *` 会把用不上的列也带过网络。 */
type FaultRow = {
  code: string;
  product_line: string;
  severity: string | null;
  desc_zh: string | null;
  desc_en: string | null;
  desc_de: string | null;
  desc_nl: string | null;
  desc_es: string | null;
  act_zh: string | null;
  act_en: string | null;
  act_de: string | null;
  act_nl: string | null;
  act_es: string | null;
};

/**
 * 唯一一条查询：主键等值，无函数、无通配、无排序。
 * 参数化是硬要求（`code` 直接来自模型工具调用），拼接字符串等于把注入面交给模型。
 *
 * `status = 'published'`（09#02 / D15）是**唯一**的对外可见性判据：`draft` 与 `archived`
 * 对用户等于"没有这个码"。这条条件放在这里而不是各个调用方，是因为本函数同时被
 * `/api/fault`（公开、无令牌）与对话快路（`core/fastpath.ts`）使用 —— 漏一处就是
 * 一条没审过的码直接进答复。管理端要读草稿，走的是另一条带角色的查询。
 */
const LOOKUP_SQL = `
  select code, product_line, severity,
         desc_zh, desc_en, desc_de, desc_nl, desc_es,
         act_zh,  act_en,  act_de,  act_nl,  act_es
    from fault_codes
   where code = $1 and product_line = $2 and status = 'published'
`;

/**
 * 候选语言序列：请求语言在前，其后按回退链补齐。
 * 未知语言（核心模块也可能被直接调用）一律按 `en` 处理，与 `retrieval.langScopeOf` 的口径一致。
 */
function orderedLangs(lang: string): readonly Lang[] {
  const primary: Lang = LANGUAGES.includes(lang as Lang) ? (lang as Lang) : "en";
  return [primary, ...FALLBACK_LANGS.filter((candidate) => candidate !== primary)];
}

type TextPick = { text: string; lang: Lang };

/** 按候选顺序取第一个非空列；`null`/空白都算缺语（入库理论上不允许，但库里可能被手改过）。 */
function pickText(row: FaultRow, kind: "desc" | "act", langs: readonly Lang[]): TextPick | null {
  for (const lang of langs) {
    const value = row[`${kind}_${lang}` as keyof FaultRow];
    if (typeof value === "string" && value.trim() !== "") {
      return { text: value.trim(), lang };
    }
  }
  return null;
}

/**
 * 把 `act_*` 里的一整段拆成有序步骤数组（06 §3.2 要模型按步骤回答）。
 *
 * 格式假设：语料把 `1. …; 2. …; 3. …` 塞在**一列**文本里（`corpus/fault_codes.json` 的
 * `act.<lang>`），步骤之间用分号分隔、编号写作 `1.` / `2)`。所以切分点取"行首或分号之后
 * 紧跟的编号"，**保留编号本身**（模型要靠编号保持顺序，前端也原样显示）。
 *
 * 为什么不用简单的 `split(";")`：步骤正文里可能出现分号（英文长句），那样会把一步劈成两半；
 * 而 `\d{1,2}[.)]` 后面若紧跟数字（`3.65 V`）就**不是**编号，必须排除，否则电池电压会被
 * 当成第三步。切不出 2 段以上（没有编号、或只有一步）就原样返回整段 —— 宁可给一段
 * 没编号的文本，也不要把步骤拆坏。
 */
export function splitActions(raw: string): string[] {
  const text = raw.trim();
  if (text === "") return [];

  const boundary = /(?:^|(?<=[;；]))\s*(?=\d{1,2}[.)](?:\s+|(?=[^\d\s])))/g;
  const starts: number[] = [];
  for (const match of text.matchAll(boundary)) {
    starts.push(match.index + match[0].length);
  }
  if (starts.length < 2) return [text];

  const actions: string[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const end = starts[index + 1] ?? text.length;
    // 步骤之间的分号属于分隔符，不属于正文
    const step = text.slice(starts[index], end).replace(/[;；]\s*$/, "").trim();
    if (step !== "") actions.push(step);
  }
  return actions.length === 0 ? [text] : actions;
}

export async function lookupFaultCode(input: {
  code: string;
  lang: string;
  productLine?: string;
}): Promise<FaultCodeHit | FaultCodeMiss> {
  // 语料主键全大写，而模型按用户输入传 `e03` 是常见的。归一化放在**参数**上（而不是写成
  // `where upper(code) = …`）：函数套在列上会让主键索引失效，退化成全表扫描。
  const code = input.code.trim().toUpperCase();
  const productLine = (input.productLine ?? DEFAULT_PRODUCT_LINE).trim();
  const langs = orderedLangs(input.lang.trim().toLowerCase());

  const row = await one<FaultRow>(LOOKUP_SQL, [code, productLine]);
  if (row === null) {
    // 未命中是正常业务结果，不是错误：调用方（工具）要把"没有这个码"如实告诉模型。
    return { found: false, code };
  }

  const desc = pickText(row, "desc", langs);
  const act = pickText(row, "act", langs);

  return {
    found: true,
    // 回显库里的规范写法（大小写以表为准），而不是调用方传进来的字符串。
    code: row.code,
    // severity 无语言维度；库里允许 NULL（列约束只校验取值），给空串而不是 "null"。
    severity: row.severity ?? "",
    meaning: desc?.text ?? "",
    actions: splitActions(act?.text ?? ""),
    // `doc_lang` 记的是描述实际取自哪一列：描述是回答主体，模型据此选回答语言。
    // 描述与步骤都缺语这种数据事故极少，此时退回请求语言，让调用方看得出"没取到内容"。
    docLang: desc?.lang ?? act?.lang ?? langs[0],
    productLine: row.product_line,
  };
}
