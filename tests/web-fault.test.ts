/**
 * 用户端第三卡（`06-user-web-ui` #03）的纯逻辑断言：
 *   ① 故障码判形（与后端 fastpath 同口径，含大小写与位数边界）
 *   ② 最近查询的去重 / 截断 / 坏数据容错（`localStorage.faultRecent` 最多 3 条）
 *   ③ 文案 key 覆盖：HTML 里出现的 `data-i18n*` 与脚本用到的 key 都能在 `src/static/i18n.json`
 *      的 **zh 主源**里找到（`08#01` 起真表是那个 JSON；缺一个 key 就等于页面上出现 key 原文，
 *      因为 `t()` 查到最后一格就是 key 本身），并把两个模板拼接出来的动态 key 一个个钉住
 *   ④ 真表没有空值、占位符只有规格点名的几个；两张 JS 兜底表不得有真表里不存在的 key
 *
 * 前端纯模块是 `.js`（浏览器直接跑），本仓库的 tsconfig 没开 `allowJs`，所以用**非字面量**
 * 动态 import 绕开类型解析——这也是 `web-lib`/`web-sheet` 已经在用的口径。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (path: string) => import("../src/static/" + path + ".js");

const { matchFaultCode } = (await load("lib/lang")) as {
  matchFaultCode: (text: string) => string | null;
};
const { pushRecent, loadRecent, saveRecent, FAULT_RECENT_MAX } = (await load("lib/fault-recent")) as {
  pushRecent: (list: string[], code: string, max?: number) => string[];
  loadRecent: (storage: Storage | undefined) => string[];
  saveRecent: (storage: Storage | undefined, list: string[]) => void;
  FAULT_RECENT_MAX: number;
};
const { DICT_DE } = (await load("lib/i18n-de")) as { DICT_DE: Record<string, string> };
const { chromeDict } = (await load("lib/i18n-chrome")) as { chromeDict: (lang: string) => Record<string, string> };
const { needsRefetch } = (await load("lib/fault-card")) as {
  needsRefetch: (input: { kind?: string; lang?: string; lastLang?: string }) => boolean;
};

/** 真表（`12-i18n.md` §1）。读盘而不是 `import` JSON：本仓库没有构建步骤，测试直接读文件即可。 */
const table = JSON.parse(await readFile(join(repoRoot, "src/static/i18n.json"), "utf8")) as Record<string, Record<string, string>>;
const zhKeys = new Set(Object.keys(table.zh ?? {}));
const LOCALES = ["zh", "en", "de", "nl", "es"] as const;

/** localStorage 的最小替身：只实现被测的两个方法，坏数据由 `writes` 直接塞进去。 */
function fakeStorage(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set("faultRecent", initial);
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

test("故障码判形：e03 / E03 / E103 命中；E3 / E0003 / 带前缀都不命中", () => {
  assert.equal(matchFaultCode("e03"), "E03", "小写要归一到大写：现场输入法常留小写");
  assert.equal(matchFaultCode("E03"), "E03");
  assert.equal(matchFaultCode("E103"), "E103");
  assert.equal(matchFaultCode(" E03 "), "E03", "前后空格来自粘贴，不该判成非法");

  assert.equal(matchFaultCode("E3"), null, "一位数字不算：那是型号/编号，不是故障码");
  assert.equal(matchFaultCode("E0003"), null, "四位数字超出规格");
  assert.equal(matchFaultCode("故障码 E03"), null, "整串锚定：带上下文就走对话，不进快路");
  assert.equal(matchFaultCode("E03?"), null);
  assert.equal(matchFaultCode(""), null);
});

/**
 * 切语言重取判据（D1）。这里钉的是**两个方向**：该重取（否则正文停在旧语言）与
 * 不该重取（否则 `onLang` 被调两次就打两遍请求、弱网下互相盖）。
 */
test("故障卡重取判据：语言变了才重取，同一语言重调两次只算一次", () => {
  assert.equal(needsRefetch({ kind: "hit", lang: "nl", lastLang: "de" }), true, "命中卡切语言要重取");
  assert.equal(needsRefetch({ kind: "miss", lang: "nl", lastLang: "de" }), true, "未命中卡也要重取（未命中文案是服务端给的）");
  assert.equal(needsRefetch({ kind: "hit", lang: "de", lastLang: "de" }), false, "语言没变不发请求：onLang 每轮会被调两次");

  // 没有结果的三种状态都不该重取：没有码可查，或者已经显示过错误。
  for (const kind of ["idle", "searching", "error"]) {
    assert.equal(needsRefetch({ kind, lang: "nl", lastLang: "de" }), false, `${kind} 状态不重取`);
  }
  assert.equal(needsRefetch({}), false, "空状态不重取");

  // 语言本身不合法时不发请求：`?lang=` 空参后端会 400，那条错误会把好卡打掉。
  assert.equal(needsRefetch({ kind: "hit", lang: "", lastLang: "de" }), false, "空语言不发请求");
  assert.equal(needsRefetch({ kind: "hit", lang: "  ", lastLang: "de" }), false, "纯空白也不发");

  // lastLang 不知道（老页面 / 首屏恢复）时按"该重取"处理：无法确认旧数据语言，就不能相信它。
  assert.equal(needsRefetch({ kind: "hit", lang: "en" }), true, "缺 lastLang 要重取一次");
  assert.equal(needsRefetch({ kind: "hit", lang: "en", lastLang: "" }), true, "空 lastLang 同上");
});

test("最近查询：去重后置顶、最多 3 条、归一化大小写", () => {
  assert.equal(FAULT_RECENT_MAX, 3);
  let list: string[] = [];
  list = pushRecent(list, "e03");
  list = pushRecent(list, "E07");
  list = pushRecent(list, "F21");
  assert.deepEqual(list, ["F21", "E07", "E03"], "最近一次排最前");

  list = pushRecent(list, "e03");
  assert.deepEqual(list, ["E03", "F21", "E07"], "重复查询要移到队首而不是占两个坑");

  list = pushRecent(list, "E11");
  assert.deepEqual(list, ["E11", "E03", "F21"], "超过 3 条丢最旧的");
  assert.equal(list.length, 3);
});

test("最近查询：入参不被修改，空码不占位", () => {
  const before = ["E03"];
  const after = pushRecent(before, "E07");
  assert.deepEqual(before, ["E03"], "pushRecent 必须返回新数组（调用方可能拿旧值做 diff）");
  assert.deepEqual(after, ["E07", "E03"]);
  assert.deepEqual(pushRecent(["E03"], "  "), ["E03"], "空码不该插进列表");
});

test("本地存储：坏 JSON / 非数组 / 非故障码项都当没有，写失败静默", () => {
  const asStorage = (value: unknown) => value as unknown as Storage;
  assert.deepEqual(loadRecent(asStorage(fakeStorage("not json"))), [], "坏 JSON 不能把页面搞白屏");
  assert.deepEqual(loadRecent(asStorage(fakeStorage('{"a":1}'))), [], "不是数组就当没有");
  assert.deepEqual(loadRecent(asStorage(fakeStorage('["E03","oops","E07","F21","C02"]'))), ["E03", "E07", "F21"], "过滤非法项并截断到 3");
  assert.deepEqual(loadRecent(asStorage(fakeStorage())), []);
  assert.deepEqual(loadRecent(undefined), [], "隐私模式下 localStorage 可能整个不可用");

  const storage: Storage = fakeStorage() as unknown as Storage;
  saveRecent(storage, ["E03", "E07"]);
  assert.equal((storage as unknown as { store: Map<string,string> }).store.get("faultRecent"), JSON.stringify(["E03", "E07"]));

  const broken = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); } };
  assert.doesNotThrow(() => saveRecent(broken as unknown as Storage, ["E03"]), "写失败只降级，不抛给页面");
});

test("文案覆盖：HTML 与脚本用到的每个 key 都在 i18n.json 的 zh 主源里", async () => {
  const html = await readFile(join(repoRoot, "src/static/index.html"), "utf8");
  const views = await readFile(join(repoRoot, "src/static/views.js"), "utf8");
  const user = await readFile(join(repoRoot, "src/static/user.js"), "utf8");

  const fromHtml = [...html.matchAll(/data-i18n(?:-ph|-aria)?="([^"]+)"/g)].map((m) => m[1] ?? "");
  // 脚本里的 t("key") 与 t('key')：模板拼接出来的 key 由下面那条用例一个个钉住
  const fromJs = [...`${views}${user}`.matchAll(/\bt\("([a-z][a-zA-Z0-9_.]*)"\)/g)].map((m) => m[1] ?? "");

  const keys = [...new Set([...fromHtml, ...fromJs])].sort();
  assert.ok(keys.length > 30, `抽到的 key 太少（${keys.length}），正则或文件变了`);
  const missing = keys.filter((key) => !zhKeys.has(key));
  // 失败语义（必须保留）：缺 key 时 `t()` 查到最后一格就是 key 本身，用户会在页面上看见 "chat.send"。
  assert.deepEqual(missing, [], `这些 key 不在 i18n.json 里，页面上会直接显示 key 原文：${missing.join(", ")}`);
});

test("文案覆盖：模板拼接出来的动态 key（fault.severity.* / ticket.status.*）逐个存在", () => {
  // 这两族 key 是 `t(\`fault.severity.${severity}\`)` 拼出来的，正则抽不到；漏一条就等于某个
  // 严重度/状态在页面上显示成 key 原文 —— 恰恰是最难在手点测试里撞见的那一种。
  const dynamic = [
    ...["info", "warn", "fatal"].map((severity) => `fault.severity.${severity}`),
    // views.js 只画这四态（sql/001_init.sql 的 check 约束），别的值按 open 画，不会去查 key
    ...["open", "claimed", "escalated", "closed"].map((status) => `ticket.status.${status}`),
  ];
  const missing = dynamic.filter((key) => !zhKeys.has(key));
  assert.deepEqual(missing, [], `动态 key 缺失：${missing.join(", ")}`);
});

test("文案表：五语都没有空值，占位符只有规格点名的几个", () => {
  const empty: string[] = [];
  const bad: string[] = [];
  const allowed = new Set(["i", "n", "no", "page", "v", "code"]);
  for (const lang of LOCALES) {
    const messages = table[lang] ?? {};
    for (const [key, value] of Object.entries(messages)) {
      if (String(value).trim() === "") empty.push(`${lang}: ${key}`);
      for (const [, name] of String(value).matchAll(/\{(\w+)\}/g)) {
        if (!allowed.has(String(name))) bad.push(`${lang}: ${key} {${name}}`);
      }
    }
  }
  assert.deepEqual(empty, [], "空值等于页面上出现空白");
  assert.deepEqual(bad, [], `未知占位符：${bad.join(", ")}`);
});

test("离线兜底表不得有真表里没有的 key（否则那个 key 永远只有兜底值）", () => {
  const orphans: string[] = [];
  for (const [key] of Object.entries(DICT_DE)) if (!zhKeys.has(key)) orphans.push(`i18n-de: ${key}`);
  for (const lang of LOCALES) {
    for (const [key] of Object.entries(chromeDict(lang))) if (!zhKeys.has(key)) orphans.push(`i18n-chrome.${lang}: ${key}`);
  }
  assert.deepEqual(orphans, [], `兜底表里有真表不存在的 key：${orphans.join(", ")}`);
});
