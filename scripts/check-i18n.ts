/**
 * 五语文案校验（`12-i18n.md` §6 · 08-i18n-eval-handoff 的 T09）。
 *
 * 一条命令回答一个问题：**这张文案表还配叫"五语"吗？** 五条断言，任一不达标退出码 1：
 *   a. 五语 key 集合与 zh（主源）完全一致，且总数与 `12-i18n.md` §4 的算式对得上；
 *   b. 没有空值 / null（空值在页面上就是一块空白，比显示 key 原文更难查）；
 *   c. de/nl/es 里不得出现 CJK（机翻漏译或文件贴错，荷兰客户看到汉字就以为产品不是给他的）；
 *   d. 占位符出现次数与 zh 一致（少一个 `{n}` 就是「引用 1 / 」这种半截句子）；
 *   e. 表里不得出现 `refusal.*` 与 `console.*`。
 *
 * 为什么 e 是硬失败而不是风格建议：拒答话术的唯一真源是 `src/core/refusal.ts` 的 `REFUSAL` 常量
 * （`06-agent.md` §5.3），表里再存一份等于两份真源，漂移是时间问题；坐席端只做中文（`11-ui-console.md`
 * 顶部例外），它的文案不进用户端文案表，所以 `console.*` 同样不许有 —— 有了就说明有人把两套界面混在一起了。
 *
 * 刻意不做的事：不翻译、不纠错、不猜「正确的德语是什么」，只报告差异由人决定（与 `check-terms.ts` 同一口径）。
 * 译文长度超 zh × 2.2 只**告警**不失败：德语长词是语言事实（`12-i18n.md` §8），不是翻译错误。
 *
 * 用法：node scripts/check-i18n.ts [--file src/static/i18n.json]
 *   `--file` 是给反向测试用的：测试要把表复制到临时目录、故意删一条 key 再跑，
 *   **绝不能**为了测试去改真文件（那等于测试自己制造事故）。
 */
import { readFile } from "node:fs/promises";

/** 真表位置（`12-i18n.md` §1）：`src/static/` 下，`/api/i18n/:lang` 也是从这里读的。 */
const DEFAULT_FILE = "src/static/i18n.json";

/** 五语种，zh 是主源（§1「中文为主源，其余四语由主源生成并经校验」）。 */
const LOCALES = ["zh", "en", "de", "nl", "es"] as const;
type Locale = (typeof LOCALES)[number];
const MASTER: Locale = "zh";

/**
 * `12-i18n.md` §4 的算式：`12 + 4 + 23 + 11 + 15 + 18 + 13 + 8 + 6 + 5 + 12 = 127`
 * （§4.1–§4.9、§4.11、§4.12；§4.10 拒答话术已移出）。
 *
 * 这个数**按算式断言，不按记忆**：历史上 140 / 142 / 实测 127 三个值都出现过（spec 08「Further Notes」）。
 * 改表时同步改 §4 的算式与这里，两边一起动就不会出现"表是新的、门槛是旧的"。
 */
const EXPECTED_TOTAL = 127;

/** 译文长度告警阈值：超过 zh × 2.2 就有溢出风险（`12-i18n.md` §6 步骤 4d）。 */
const LENGTH_RATIO = 2.2;

/**
 * 「长度」按**显示宽度**算，CJK / 全角记 2 列，其余 1 列 —— 这条告警问的是"排版会不会撑破"（§8），
 * 不是"字符串有几个码元"。用码元数比会得到 417 条噪音：中文两个字（`取消`）对英语 6 个字（`Cancel`）
 * 天然超 2.2 倍，可它们占的像素几乎一样，真正该看的是 `Wechselrichterkonfiguration` 那种长词。
 * 宽度是保守估计（比例字体下不等于真像素），但方向对：它只会在"译文确实比中文宽一倍多"时响。
 */

/** 一个字符占几列：CJK/全角 2 列，其余 1 列。 */
function charWidth(ch: string): number {
  return CJK_RE.test(ch) ? 2 : 1;
}

/**
 * 告警的**下限**：短于 16 列（约 8 个汉字）的文案在 390 宽下必然放得下 —— 按钮最小 44 宽、允许两行，
 * 短标签最多换行，不会撑破布局（§8 的表就是在讲这几类元素）。不加这条下限的话，
 * 中文两字（`关闭` = 4 列）对德语 `Schließen`（9 列）也是 2.25 倍，会刷出近百条无用告警，
 * 真有风险的 `chat.status.searching`（29 列）反而被埋掉。下限只影响告警，不影响任何一条硬断言。
 */
const MIN_WARN_WIDTH = 16;

/** 显示宽度（列）。 */
function displayWidth(value: string): number {
  let width = 0;
  for (const ch of value) width += charWidth(ch);
  return width;
}

/** 占位符：`{i}` `{n}` `{no}` `{page}` `{v}` 是规格点名的五个，另有 `fault.notfound` 的 `{code}`。 */
const PLACEHOLDER_RE = /\{(\w+)\}/g;

/**
 * CJK 统一表意文字 + 扩展 A + 兼容表意 + 假名 + 谚文。
 * 比"只认 U+4E00–U+9FFF"宽一点：机翻残留常常连标点一起（，。「」），漏检比误检更贵。
 */
const CJK_RE = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/u;

/** 不允许出现在表里的 key 前缀（§4.10 与 spec 08「不产生 console.*」）。 */
const FORBIDDEN_PREFIXES: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: "refusal.", reason: "拒答话术的唯一真源是 src/core/refusal.ts 的 REFUSAL 常量" },
  { prefix: "console.", reason: "坐席端只做中文、不进用户端文案表（11-ui-console.md 顶部例外）" },
];

type Level = "ok" | "warn" | "fail";

interface Line {
  level: Level;
  label: string;
  detail: string;
}

type Table = Record<string, Record<string, string>>;

/** 标签列宽度：`[ok]   ` + 标签 + 细节，人眼扫得下去就行（与 check-terms 的 12 同宽）。 */
const LABEL_WIDTH = 14;

const line = (level: Level, label: string, detail: string): Line => ({ level, label, detail });

/** 显示宽度补齐：中文标签占两列，按码元 padEnd 会让几行整体左移。 */
function padLabel(label: string): string {
  const width = [...label].reduce((sum, ch) => sum + (CJK_RE.test(ch) ? 2 : 1), 0);
  return label + " ".repeat(Math.max(0, LABEL_WIDTH - width));
}

function parseArgs(argv: readonly string[]): { file: string } {
  let file = DEFAULT_FILE;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--file") {
      const value = argv[index + 1];
      if (value === undefined || value === "") throw new Error("--file 后面要跟一个路径");
      file = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--file=")) {
      const value = arg.slice("--file=".length);
      if (value === "") throw new Error("--file= 后面要跟一个路径");
      file = value;
      continue;
    }
    throw new Error(`未知参数 "${arg}"（只支持 --file <path>）`);
  }
  return { file };
}

/** 解析出的表必须是「语种 → key → 字符串」两层；形状不对直接抛，绝不"零条 key 零违规"地通过。 */
function parseTable(raw: string, file: string): Table {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} 顶层必须是对象（{ "zh": {...}, "en": {...} }）`);
  }
  const table: Table = {};
  for (const [lang, messages] of Object.entries(parsed as Record<string, unknown>)) {
    if (messages === null || typeof messages !== "object" || Array.isArray(messages)) {
      throw new Error(`${file} 的 "${lang}" 必须是「key → 字符串」的扁平对象（§1：不嵌套）`);
    }
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(messages as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw new Error(`${file} 的 ${lang}: ${key} 不是字符串（收到 ${JSON.stringify(value)}）`);
      }
      if (key.includes(".") === false) {
        throw new Error(`${file} 的 ${lang}: "${key}" 不符合 §3 的 模块.元素 命名`);
      }
      flat[key] = value;
    }
    table[lang] = flat;
  }
  return table;
}

/** 逐 key 抽占位符名单（保持出现顺序，便于报"少的是哪一个"）。 */
function placeholdersIn(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_RE)].map((match) => String(match[1]));
}

function countBy(names: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

function firstCjk(value: string): string | null {
  for (const ch of value) if (CJK_RE.test(ch)) return ch;
  return null;
}

function check(table: Table, file: string): Line[] {
  const lines: Line[] = [];
  const master = table[MASTER] ?? {};
  const masterKeys = Object.keys(master);

  // ── 语种齐全：缺一整语时后面的每条断言都会刷屏，先单独报一条再继续 ──
  const missingLocales = LOCALES.filter((lang) => table[lang] === undefined);
  for (const lang of missingLocales) {
    lines.push(line("fail", "语种", `${lang} 整个语种缺失（表里只有 ${Object.keys(table).join("/")}）`));
  }
  const extraLocales = Object.keys(table).filter((lang) => (LOCALES as readonly string[]).includes(lang) === false);
  for (const lang of extraLocales) {
    lines.push(line("fail", "语种", `${lang} 不在五语之列（zh/en/de/nl/es）`));
  }
  // zh 都没有就没法比：后面所有断言都会退化成"零条通过"，那是假绿灯。
  if (table[MASTER] === undefined) {
    lines.push(line("fail", "语种", `主源 ${MASTER} 缺失，无法校验`));
    return lines;
  }
  if (missingLocales.length === 0) lines.push(line("ok", "语种", LOCALES.join(" / ")));

  // ── a. key 集合一致 + 总数与算式一致 ──
  let keysOk = true;
  for (const lang of LOCALES) {
    const messages = table[lang];
    if (messages === undefined) {
      keysOk = false;
      continue;
    }
    const keys = Object.keys(messages);
    const missing = masterKeys.filter((key) => messages[key] === undefined);
    const extra = keys.filter((key) => master[key] === undefined);
    if (missing.length === 0 && extra.length === 0) continue;
    keysOk = false;
    for (const key of missing) {
      lines.push(line("fail", lang, `${key} 缺失（${MASTER} 有、${lang} 没有）`));
    }
    for (const key of extra) {
      lines.push(line("fail", lang, `${key} 多余（${MASTER} 里没有这个 key）`));
    }
  }
  const total = masterKeys.length;
  if (total !== EXPECTED_TOTAL) {
    keysOk = false;
    lines.push(
      line(
        "fail",
        "keys",
        `${MASTER} 有 ${total} 条，期望 ${EXPECTED_TOTAL}（12-i18n.md §4 算式 12+4+23+11+15+18+13+8+6+5+12）`,
      ),
    );
  }
  if (keysOk && total === EXPECTED_TOTAL) lines.push(line("ok", "keys", `${total}/${EXPECTED_TOTAL}`));

  // ── b. 无空值 / null ──
  let emptyCount = 0;
  for (const lang of LOCALES) {
    const messages = table[lang];
    if (messages === undefined) continue;
    for (const [key, value] of Object.entries(messages)) {
      // 全空白也算空：页面上它就是一块没有内容的区域。
      if (value.trim() !== "") continue;
      emptyCount += 1;
      lines.push(line("fail", lang, `${key} 是空值（页面上会是一块空白）`));
    }
  }
  if (emptyCount === 0) {
    const cells = LOCALES.reduce((sum, lang) => sum + Object.keys(table[lang] ?? {}).length, 0);
    lines.push(line("ok", "values", `${cells} 个非空译文`));
  }

  // ── c. de/nl/es 中不得出现 CJK ──
  let cjkCount = 0;
  for (const lang of LOCALES) {
    if (lang === MASTER) continue; // zh 本来就是中文
    const messages = table[lang];
    if (messages === undefined) continue;
    for (const [key, value] of Object.entries(messages)) {
      const hit = firstCjk(value);
      if (hit === null) continue;
      cjkCount += 1;
      lines.push(line("fail", lang, `${key} 含 CJK 字符「${hit}」：${value}`));
    }
  }
  if (cjkCount === 0) lines.push(line("ok", "cjk", "de / nl / es 无 CJK 残留"));

  // ── d. 占位符出现次数与 zh 一致 ──
  let placeholderCount = 0;
  for (const lang of LOCALES) {
    if (lang === MASTER) continue;
    const messages = table[lang];
    if (messages === undefined) continue;
    for (const key of masterKeys) {
      const own = messages[key];
      if (own === undefined) continue; // 缺 key 已经由 a 报过，别重复刷屏
      const expected = countBy(placeholdersIn(master[key] ?? ""));
      const actual = countBy(placeholdersIn(own));
      for (const [name, want] of expected) {
        const got = actual.get(name) ?? 0;
        if (got === want) continue;
        placeholderCount += 1;
        lines.push(
          line("fail", lang, `${key} ${got === 0 ? "缺失占位符" : "占位符次数不一致"} {${name}}（zh ${want} 次、${lang} ${got} 次）`),
        );
      }
      for (const [name, got] of actual) {
        if (expected.has(name)) continue;
        placeholderCount += 1;
        lines.push(line("fail", lang, `${key} 多出占位符 {${name}}（zh 没有，运行时会原样留在页面上）`));
      }
    }
  }
  if (placeholderCount === 0) {
    const names = [...new Set(masterKeys.flatMap((key) => placeholdersIn(master[key] ?? "")))].sort();
    lines.push(line("ok", "placeholders", `${names.map((name) => `{${name}}`).join(" ")} 五语一致`));
  }

  // ── e. 不得出现 refusal.* / console.*（防止第二份真源复活） ──
  let forbiddenCount = 0;
  for (const lang of LOCALES) {
    const messages = table[lang];
    if (messages === undefined) continue;
    for (const key of Object.keys(messages)) {
      const hit = FORBIDDEN_PREFIXES.find((item) => key.startsWith(item.prefix));
      if (hit === undefined) continue;
      forbiddenCount += 1;
      lines.push(line("fail", lang, `${key} 是禁止的 key：${hit.reason}`));
    }
  }
  if (forbiddenCount === 0) {
    lines.push(line("ok", "forbidden", "无 refusal.* / console.*（拒答话术只在 REFUSAL 常量里）"));
  }

  // ── 告警：译文长度 > zh × 2.2（德语长词，§8；只报不拦） ──
  for (const lang of LOCALES) {
    if (lang === MASTER) continue;
    const messages = table[lang];
    if (messages === undefined) continue;
    for (const key of masterKeys) {
      const zh = master[key] ?? "";
      const own = messages[key];
      if (own === undefined) continue;
      const zhWidth = displayWidth(zh);
      const ownWidth = displayWidth(own);
      if (ownWidth < MIN_WARN_WIDTH) continue;
      if (ownWidth <= zhWidth * LENGTH_RATIO) continue;
      lines.push(
        line("warn", lang, `${key} = ${ownWidth} cols (zh ${zhWidth}) — 可能溢出`),
      );
    }
  }

  // 文件路径放在最后一行说明里，便于贴进工单/CI 日志时知道验的是哪一份（`--file` 的临时副本尤其重要）
  lines.push(line("ok", "file", file));
  return lines;
}

async function main(): Promise<void> {
  const { file } = parseArgs(process.argv.slice(2));
  // 不启用 `--env-file`：这个脚本只读一个 JSON，不碰数据库也不读 .env（08#01 的验收要在纯净 CI 上跑）。
  const raw = await readFile(file, "utf8");
  const table = parseTable(raw, file);

  process.stdout.write(
    `五语文案校验：${file}、语种 ${LOCALES.join("/")}、期望 ${EXPECTED_TOTAL} 条（12-i18n.md §4 算式）、` +
      `长度告警阈值 zh×${LENGTH_RATIO}\n`,
  );

  const lines = check(table, file);
  for (const item of lines) {
    const tag = item.level === "ok" ? "[ok]  " : item.level === "warn" ? "[warn]" : "[fail]";
    process.stdout.write(`${tag} ${padLabel(item.label)}${item.detail}\n`);
  }

  const failed = lines.filter((item) => item.level === "fail");
  const warned = lines.filter((item) => item.level === "warn");
  const total = Object.keys(table[MASTER] ?? {}).length;
  process.stdout.write(
    failed.length === 0
      ? `结论：五语各 ${total} 条一致，${warned.length} 条长度告警（不拦提交，出德语长词时先看 390 宽下是否会撑破）。\n`
      : `结论：${failed.length} 项不达标（${[...new Set(failed.map((item) => item.label))].join("、")}），` +
          `先修文案表再提交；${warned.length} 条长度告警。\n`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  // 读不到文件 / JSON 坏 / 参数错：一律退出码 1。文案表都读不懂时给绿灯是最糟的结果。
  process.stderr.write(`文案校验失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
