/**
 * 用户端纯逻辑模块的断言（`06` spec §Testing Decisions / `10-ui-user.md` §2–§8）。
 *
 * 只喂输入输出，不测 DOM、不测 CSS、不起服务器：这三块是前端最容易写错、又最难靠人眼看出来的地方 ——
 * 分帧边界（弱网才复现）、角标替换（多替换一个就是一个假引用）、语言回落（换语种才暴露）。
 *
 * `src/static/lib/*.js` 是浏览器 ES module，`tsconfig.json` 没开 `allowJs`，
 * 所以这里用**非字面量** specifier 动态导入：类型退化成 `any`，但断言照样能跑。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 运行时按名字拼路径导入，绕开 tsc 对 `.js` 的解析（不是"静默忽略"，是浏览器运行时本来就按 URL 加载）。 */
const load = (name: string): Promise<any> => import(`../src/static/lib/${name}.js`);

const stream = await load("stream");
const cite = await load("cite");
const lang = await load("lang");

const { createSseParser } = stream;
const { renderCitations } = cite;
const { SUPPORTED_LANGS, pickLang, normalizeLang, matchFaultCode, LANG_NAMES } = lang;

// ─────────────────────── SSE 分帧（06 spec 必测第一条） ───────────────────────

test("分帧：同一帧拆成 3 段依次喂入，只在第三段之后产出 1 个事件", () => {
  const parser = createSseParser();
  const frame = 'event: delta\ndata: {"t":"Die Netzspannung"}\n\n';

  const first = frame.slice(0, 5); // "event"
  const second = frame.slice(5, frame.length - 2); // 中间的字段行 + data
  const third = frame.slice(frame.length - 2); // 结尾的 "\n\n"：分隔符本身被切开
  assert.equal(first + second + third, frame, "三段必须能拼回原帧，否则这个用例测不到边界");

  assert.deepEqual(parser.push(first), [], "半帧不能产出事件");
  assert.deepEqual(parser.push(second), [], "data 行齐了但没有空行，仍然不算完整帧");

  const frames = parser.push(third);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, "delta");
  assert.equal(frames[0].data, '{"t":"Die Netzspannung"}');
  assert.deepEqual(JSON.parse(frames[0].data), { t: "Die Netzspannung" }, "跨块拼回来的 data 必须是能解析的 JSON");
});

test("分帧：一次喂 3 帧，产出 3 个事件且顺序与输入一致", () => {
  const parser = createSseParser();
  const chunk =
    'event: meta\ndata: {"conv_id":"c1","message_id":7}\n\n' +
    'event: delta\ndata: {"t":"Erste"}\n\n' +
    'event: done\ndata: {"latency_ms":3120}\n\n';

  const frames = parser.push(chunk);
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.map((frame: { event: string }) => frame.event),
    ["meta", "delta", "done"],
  );
  assert.deepEqual(
    frames.map((frame: { data: string }) => JSON.parse(frame.data)),
    [{ conv_id: "c1", message_id: 7 }, { t: "Erste" }, { latency_ms: 3120 }],
  );
});

test("分帧：多行 data 按 SSE 规范用 \\n 拼接（含行首多点一个空格的写法）", () => {
  const parser = createSseParser();
  const frames = parser.push("event: delta\ndata: erste\ndata: zweite\n\n");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, "erste\nzweite");

  const spaced = createSseParser().push("event: delta\ndata: a\n data: b\n\n");
  assert.equal(spaced.length, 1, "` data:` 前面多一个空格的写法也要算 data 行，不能整行丢掉");
  assert.equal(spaced[0].data, "a\nb");
});

test("分帧：注释行被忽略，只有注释的心跳帧不产出事件", () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push(": heartbeat\n\n"), [], "心跳帧没有 event 也没有 data，不该变成一条空事件");
  assert.deepEqual(parser.push(":\n\n"), []);

  const frames = parser.push(": ping\nevent: done\ndata: {}\n\n");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, "done");
  assert.equal(frames[0].data, "{}", "帧内注释不能污染 data");
});

test("分帧：CRLF 空行也是分隔符，且分隔符本身被切成两块时仍能拼回一帧", () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push("event: meta\r\ndata: {}\r\n"), [], "单个 \\r\\n 不是分隔符，半截分隔符必须留在缓冲区");

  const frames = parser.push("\r\n"); // 补上分隔符的后半截 "\r\n"
  assert.equal(frames.length, 1, "\\r\\n + \\r\\n 拼起来才是一帧的结尾");
  assert.equal(frames[0].event, "meta");
  assert.equal(frames[0].data, "{}");

  assert.equal(createSseParser().push("event: done\r\ndata: 1\r\n\r\n").length, 1, "\\r\\n\\r\\n 一次到位也必须分得开");
});

test("分帧：未知事件名照原样吐出，解析器不做白名单", () => {
  const frames = createSseParser().push('event: telemetry\ndata: {"n":1}\n\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, "telemetry", "新增事件名不该先改解析器");
});

test("分帧：reset() 清掉半帧，上一轮的残留不会粘到新流的第一帧上", () => {
  const parser = createSseParser();
  parser.push('event: delta\ndata: {"t":"半截');
  parser.reset();

  const frames = parser.push('event: done\ndata: {"latency_ms":1}\n\n');
  assert.equal(frames.length, 1, "reset 之后只该看到新流的帧");
  assert.equal(frames[0].event, "done");
  assert.equal(frames[0].data, '{"latency_ms":1}');
});

test("分帧：空串 push 是 no-op，连续半个分隔符也不会误产出事件", () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push(""), []);
  assert.deepEqual(parser.push("event: delta\ndata: x\n"), [], "单换行不够，必须空行才算一帧结束");
  assert.deepEqual(parser.push("\n"), [{ event: "delta", data: "x" }]);
  assert.deepEqual(parser.push("\n"), [], "多出来的空行不能变成空事件");
});

// ─────────────────────── 角标替换（06 spec 必测第二、三条） ───────────────────────

const CITE_DE = { idx: 1, doc_title: "Installationshandbuch 600W", page: 12, snippet: "195–253 V", doc_lang: "de" };

test("角标：见 [1] 与 [2] 而引用列表只有 1 → 只有 [1] 变成角标，[2] 保持纯文本", () => {
  const segments = renderCitations("见 [1] 与 [2]", [CITE_DE]);
  assert.deepEqual(segments, [
    { type: "text", value: "见 " },
    { type: "cite", idx: 1, label: "引用 1" },
    { type: "text", value: " 与 [2]" },
  ]);
  assert.equal(segments[1].label, "引用 1", "label 是给读屏的短标签，页面再拼动词");
});

test("角标：引用列表为空（或没传）时正文原样返回，只产生一个纯文本片段", () => {
  assert.deepEqual(renderCitations("见 [1] 与 [2]", []), [{ type: "text", value: "见 [1] 与 [2]" }]);
  assert.deepEqual(renderCitations("见 [1] 与 [2]", undefined), [{ type: "text", value: "见 [1] 与 [2]" }]);
  assert.deepEqual(renderCitations("", []), [{ type: "text", value: "" }], "空正文也返回一段，页面不用单独判空");
});

test("角标：重复出现的 [1] 产生两个角标片段", () => {
  const segments = renderCitations("[1][1]", [CITE_DE]);
  assert.deepEqual(segments, [
    { type: "cite", idx: 1, label: "引用 1" },
    { type: "cite", idx: 1, label: "引用 1" },
  ]);
});

test("角标：[0] / [9] 这类不在列表里的编号一律保持纯文本（前端不虚构角标）", () => {
  const segments = renderCitations("[0] [9] [2]", [{ idx: 2, doc_title: "Datenblatt" }]);
  assert.deepEqual(segments, [
    { type: "text", value: "[0] [9] " },
    { type: "cite", idx: 2, label: "引用 2" },
  ]);

  // 有引用列表但正文一个合法角标都没有：仍要给出整段纯文本，不能返回空数组让气泡消失
  assert.deepEqual(renderCitations("nur [9] hier", [CITE_DE]), [{ type: "text", value: "nur [9] hier" }]);
});

test("角标：正文以角标开头/结尾时不多切出空文本片段", () => {
  assert.deepEqual(renderCitations("[1] danach", [CITE_DE]), [
    { type: "cite", idx: 1, label: "引用 1" },
    { type: "text", value: " danach" },
  ]);
  assert.deepEqual(renderCitations("davor [1]", [CITE_DE]), [
    { type: "text", value: "davor " },
    { type: "cite", idx: 1, label: "引用 1" },
  ]);
});

test("角标：idx 用引用列表里的值，[01] 也归到 1；纯文本片段拼起来等于去掉被替换的角标", () => {
  const segments = renderCitations("A [01] B [2] C", [
    { idx: 1, doc_title: "X" },
    { idx: 2, doc_title: "Y" },
  ]);
  assert.deepEqual(segments, [
    { type: "text", value: "A " },
    { type: "cite", idx: 1, label: "引用 1" },
    { type: "text", value: " B " },
    { type: "cite", idx: 2, label: "引用 2" },
    { type: "text", value: " C" },
  ]);
  const texts: string[] = [];
  for (const segment of segments as Array<{ type: string; value?: string }>) {
    if (segment.type === "text") texts.push(segment.value ?? "");
  }
  assert.equal(texts.join(""), "A  B  C", "正文内容不许被改写，只允许角标位置被掏空");
});

// ─────────────────────── 语言回落（06 spec 必测第四条） ───────────────────────

test("语言菜单的母语名字：覆盖五语、互不相同、且不是语言代码", () => {
  assert.deepEqual(Object.keys(LANG_NAMES).sort(), [...SUPPORTED_LANGS].sort(), "菜单只能有这五项，多一项就点出空语言");
  const names = Object.values(LANG_NAMES);
  assert.equal(new Set(names).size, names.length, "五项名字必须互不相同");
  for (const [code, name] of Object.entries(LANG_NAMES)) {
    assert.ok(typeof name === "string" && name.trim() !== "", `${code} 的名字不能为空`);
    assert.notEqual(name.toLowerCase(), code, `${code} 必须是母语写法，不能退化成语言代码`);
    // 母语名字的锚点：每种语言里至少有一个"只属于这门语言"的字符或拼写。
    // 中文必须是汉字；其余四个都必须在自己的正字法里可见（这里只钉最容易漂的一条：中文）。
  }
  assert.match(LANG_NAMES.zh, /[\u4e00-\u9fff]/, "中文那一项必须是汉字，不能写成 Chinese");
  assert.equal(LANG_NAMES.de, "Deutsch");
  assert.equal(LANG_NAMES.nl, "Nederlands");
  assert.equal(LANG_NAMES.es, "Español");
});

test("pickLang：本地存储优先 → 浏览器语言前两位 → 英语", () => {
  assert.equal(pickLang({ stored: "de-DE", browser: "nl-NL" }), "de", "用户显式选过就以它为尊");
  assert.equal(pickLang({ stored: "fr", browser: "nl-NL" }), "nl", "存的语言不支持时用浏览器语言");
  assert.equal(pickLang({ stored: "fr", browser: "fr-FR" }), "en", "都不支持时回落英语");
  assert.equal(pickLang({}), "en", "什么都没有就是英语");
  assert.equal(pickLang({ stored: null, browser: null }), "en");

  assert.equal(pickLang({ stored: "de-DE" }), "de", "浏览器语言缺失但本地存储有值");
  assert.equal(pickLang({ browser: "zh-CN" }), "zh");
  assert.equal(pickLang({ stored: "", browser: "es-ES" }), "es", "空串不能挡住回落的下一步");
  assert.equal(pickLang({ stored: "deutsch", browser: "es-419" }), "es", "垃圾本地存储同样继续往下走");
});

test("pickLang：supported 覆盖时按同一顺序判定，兜底不给出列表外的语种", () => {
  assert.equal(pickLang({ stored: "de-DE", browser: "nl-NL", supported: ["nl", "en"] }), "nl");
  assert.equal(pickLang({ stored: "zh", browser: "de-DE", supported: ["de"] }), "de");
  assert.equal(pickLang({ supported: ["nl"] }), "nl", "列表里没有 en 时返回列表第一项，不回一个不支持的值");
  assert.deepEqual([...SUPPORTED_LANGS], ["zh", "en", "de", "nl", "es"], "五语种顺序与后端 LANGUAGES 一致");
});

test("normalizeLang：取语言标签前两位并小写，垃圾输入返回空串", () => {
  assert.equal(normalizeLang("de-DE"), "de");
  assert.equal(normalizeLang("DE-de"), "de");
  assert.equal(normalizeLang("zh-Hans-CN"), "zh");
  assert.equal(normalizeLang("es-419"), "es");
  assert.equal(normalizeLang("de_DE"), "de");
  assert.equal(normalizeLang("EN"), "en");
  assert.equal(normalizeLang("  de-DE  "), "de");

  for (const garbage of ["", "   ", "e", "1234", "deutsch", null, undefined, 42, {}]) {
    assert.equal(normalizeLang(garbage), "", `垃圾输入必须返回空串：${String(garbage)}`);
  }
});

// ─────────────────────── 故障码判形（06 spec 必测第五条） ───────────────────────

test("matchFaultCode：整串 字母 + 2~3 位数字才命中，命中返回大写码", () => {
  assert.equal(matchFaultCode("e03"), "E03", "小写也要命中（输入框 autocapitalize 不等于用户一定大写）");
  assert.equal(matchFaultCode("E03"), "E03");
  assert.equal(matchFaultCode("E103"), "E103", "3 位数字的码存在，不能只认两位");
  assert.equal(matchFaultCode("e103"), "E103");
  assert.equal(matchFaultCode("  e03 \n"), "E03", "粘过来的码常带空格换行，与后端 fastpath 一样先 trim");
});

test("matchFaultCode：位数不对或夹在句子里一律不命中（否则快路会截断真问题）", () => {
  for (const input of ["E3", "E0003", "故障码 E03", "E03 Fehlercode", "", "03", "EE03", "E03 是什么意思"]) {
    assert.equal(matchFaultCode(input), null, `不该判成故障码：${JSON.stringify(input)}`);
  }
  assert.equal(matchFaultCode(42), null, "非字符串输入返回 null，不抛");
});

// ─────────────────────── 反回归（静态）：三个模块必须保持"纯" ───────────────────────

test("静态：三个 lib 模块不碰 DOM / 宿主全局 / 网络，也没有任何模块依赖", async () => {
  for (const name of ["stream", "cite", "lang"]) {
    const source = await readFile(join(repoRoot, "src/static/lib", `${name}.js`), "utf8");

    // 这些是"能在 node 里直接测"的前提条件：一旦有人加了宿主对象或 npm 依赖，这条先红。
    assert.doesNotMatch(source, /\bdocument\b/, `${name}.js 不许碰 DOM`);
    assert.doesNotMatch(source, /\bwindow\b/, `${name}.js 不许读宿主全局对象`);
    assert.doesNotMatch(source, /\bconsole\b/, `${name}.js 不许打日志（页面控制台已经有自己的日志层）`);
    assert.doesNotMatch(source, /\bimport\b/, `${name}.js 必须自包含：静态目录内只允许本地模块互相引用，这里连引用都不要`);
    assert.doesNotMatch(source, /\brequire\s*\(/, `${name}.js 不许走 CommonJS 旁路`);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${name}.js 不许发网络请求`);

    assert.match(source, /^export /m, `${name}.js 必须导出供页面使用的符号`);
  }
});
