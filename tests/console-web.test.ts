/**
 * 坐席端前端一半的断言（工单 `07-console-and-security` #02 的 Testing 段）。
 *
 * 两类：
 *   1. **纯逻辑**：SLA 倒计时、锚点解析、草稿隔离、键盘映射、关单校验。这些是"看起来能用就没人测"
 *      的地方，而它们的失败方式全是静默的 —— 倒计时不动、刷新丢单、按 J 打不出字、结论差一个字也能关。
 *   2. **静态资源**：`GET /console` 与 `/assets/console.{js,css}` 真的能从 `assets.ts` 拿到，
 *      且 MIME 正确（`type="module"` 的 JS 只有 `text/javascript` 才会被执行）。
 *
 * 不做 DOM 级断言：仓库没有 jsdom，也不为这个测试加依赖（工单明确要求）。
 * `src/static/lib/console-*.js` 是浏览器 ES module，`tsconfig.json` 没开 `allowJs`，
 * 所以与 `tests/web-lib.test.ts` 同法：**非字面量** specifier 动态导入（类型退化成 any，断言照样跑）。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_DIR = join(repoRoot, "src", "static");

const load = (name: string): Promise<any> => import(`../src/static/lib/${name}.js`);

const sla = await load("console-sla");
const route = await load("console-route");
const draftLib = await load("console-draft");
const keys = await load("console-keys");
const resolution = await load("console-resolution");
const time = await load("console-time");
const view = await load("console-view");

/* ───────────────────────────── SLA ───────────────────────────── */

test("SLA：负数显示「超时 + 时长」，<1h 判紧急，null 判无截止", () => {
  const over = sla.formatSla(-130);
  assert.equal(over.level, "over", "负剩余秒数必须是 over（工单：超时显示「超时 xx」）");
  assert.equal(over.text, "超时 2m", `期望「超时 2m」，实际 "${over.text}"`);
  assert.equal(over.seconds, -130, "seconds 要原样保留负数：调用方可能还要按它排序");

  const urgent = sla.formatSla(600);
  assert.equal(urgent.level, "urgent", "剩余 600s（<1h）必须判紧急");
  assert.equal(urgent.text, "10m");

  const ok = sla.formatSla(8040);
  assert.equal(ok.level, "ok", "剩余 8040s（2h14m）是正常档");
  assert.equal(ok.text, "2h 14m", `11 §2.2 的公式：>=3600 走 Hh MMm，实际 "${ok.text}"`);

  const none = sla.formatSla(null);
  assert.equal(none.level, "none", "due_at 为空的工单排最后，不能画成 0m（那看着像刚超时）");
  assert.equal(none.text, "无截止");
  assert.equal(sla.formatSla(undefined).level, "none");
});

test("SLA：1 小时是分界线（3600 正常、3599 紧急），最后一分钟不显示 0m", () => {
  assert.equal(sla.formatSla(3600).level, "ok");
  assert.equal(sla.formatSla(3599).level, "urgent");
  assert.equal(sla.formatSla(3600).text, "1h 0m");
  // 照规格原样写会得到 "0m"，坐席分不清是还剩 40 秒还是已经归零，所以 <60s 走秒
  assert.equal(sla.formatSla(40).text, "40s");
  assert.equal(sla.formatSla(0).level, "urgent", "0 秒还没超时，但绝对紧急");
});

test("SLA 本地重算：同一输入幂等；优先 due_at，缺 due_at 才用秒数减流逝", () => {
  const at = Date.parse("2026-10-27T16:06:00Z");
  const now = Date.parse("2026-10-27T16:10:00Z");
  const snapshot = { dueAt: "2026-10-27T18:20:00Z", secondsLeft: 8040, at };

  const first = sla.remainingSeconds(snapshot, now);
  assert.equal(first, 7800, `18:20 - 16:10 = 7800s，实际 ${first}`);
  // 幂等：30 秒定时器可能因为重渲染被多调一次，重复算不能得到不同答案
  for (let i = 0; i < 5; i += 1) assert.equal(sla.remainingSeconds(snapshot, now), first);
  // 单调：同样的快照，晚一分钟就是少 60 秒（且**不发请求**，纯函数）
  assert.equal(sla.remainingSeconds(snapshot, now + 60_000), first - 60);

  const noDue = { secondsLeft: 600, at: now };
  assert.equal(sla.remainingSeconds(noDue, now), 600, "没有 due_at 时从快照秒数起算");
  assert.equal(sla.remainingSeconds(noDue, now + 30_000), 570, "没有 due_at 时按本地流逝递减");

  assert.equal(sla.remainingSeconds(null, now), null);
  assert.equal(sla.remainingSeconds({ secondsLeft: null }, now), null, "两个来源都没有 → 无截止");

  assert.equal(sla.isUrgent(3599), true);
  assert.equal(sla.isUrgent(3600), false);
  assert.equal(sla.isUrgent(null), false, "没有截止不算紧急（否则整表飘红，红色就失去意义）");
});

/* ───────────────────────────── 锚点路由 ───────────────────────────── */

test("锚点：#/ticket/31 解析成 31，其余形态一律无选中", () => {
  assert.equal(route.parseHash("#/ticket/31"), 31);
  assert.equal(route.parseHash("#/ticket/1"), 1);
  assert.equal(route.parseHash("#/Ticket/31"), 31, "手打大小写不该让人卡住");

  for (const bad of ["#/ticket/abc", "#/ticket/", "#", "", "#/ticket/0", "#/ticket/-3", "#/ticket/3.5", "#/ticket/3e1", "#/ticket/31abc", "#/board", null]) {
    assert.equal(route.parseHash(bad as string), null, `${String(bad)} 不该被当成某一单`);
  }
});

test("锚点：生成与解析互逆；复制链接保留协议/主机/路径", () => {
  for (const id of [1, 31, 2026]) {
    assert.equal(route.ticketHash(id), `#/ticket/${id}`);
    assert.equal(route.parseHash(route.ticketHash(id)), id, "ticketHash 与 parseHash 必须互逆");
  }
  assert.equal(route.ticketHash(0), "", "非法 id 不生成锚点（否则刷新会回到队列，人会以为页面丢了单");
  assert.equal(route.ticketHash("abc" as unknown as number), "");

  const location = { href: "http://127.0.0.1:8000/console#/ticket/9" };
  assert.equal(route.linkFor(location, 31), "http://127.0.0.1:8000/console#/ticket/31");
  assert.equal(route.linkFor(location, null), "http://127.0.0.1:8000/console", "回队列要真去掉 hash，不留尾随 #");
});

/* ───────────────────────────── 草稿 ───────────────────────────── */

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

test("草稿：按工单 id 隔离，写入/读取/清空都对得上", () => {
  const storage = fakeStorage();
  const store = draftLib.createDraftStore(storage);

  store.write(31, "第一单的回复");
  store.write(32, "第二单的回复");
  assert.equal(store.read(31), "第一单的回复");
  assert.equal(store.read(32), "第二单的回复", "两单必须互不污染（串单在客服场景里是事故）");
  assert.equal(storage.map.size, 2, "每单一个键：draft:<id>");
  assert.ok(storage.map.has("draft:31"), "键名必须是 draft:<id>（11 §3.3）");

  store.write(31, "   ");
  assert.equal(store.read(31), "", "全空白等于清空，否则下次打开会看到一段空回复");
  assert.equal(storage.map.has("draft:31"), false, "空串必须删键，不是写一个空值");
  assert.equal(store.read(32), "第二单的回复", "清一单不该影响另一单");
  assert.equal(store.read(999), "", "没写过的单返回空串（不是 null）");
});

test("草稿：storage 坏了就静默失败，不让整页崩", () => {
  const broken = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  const store = draftLib.createDraftStore(broken);
  assert.equal(store.read(31), "", "读失败退化成空草稿");
  assert.doesNotThrow(() => store.write(31, "内容"), "写失败不能抛到调用方（隐私模式 / 配额满 / 企业策略）");
  assert.doesNotThrow(() => store.write(31, ""), "删键失败同样静默");

  const none = draftLib.createDraftStore(null);
  assert.equal(none.read(1), "");
  assert.doesNotThrow(() => none.write(1, "x"));
});

test("草稿：输入即存是防抖的（默认 300ms），只落最后一次输入", () => {
  const storage = fakeStorage();
  const timers: Array<{ fn: () => void; id: number }> = [];
  let seq = 0;
  const store = draftLib.createDraftStore(storage, {
    debounceMs: 300,
    setTimeout: (fn: () => void) => {
      seq += 1;
      timers.push({ fn, id: seq });
      return seq;
    },
    clearTimeout: () => {},
  });

  store.schedule(31, "a");
  store.schedule(31, "ab");
  store.schedule(31, "abc");
  assert.equal(storage.map.has("draft:31"), false, "还没到点就不该写盘");
  assert.equal(store.debounceMs, 300, "工单要求 ~300ms");

  const last = timers[timers.length - 1];
  last.fn();
  assert.equal(store.read(31), "abc", "防抖只落最后一次输入");

  // flush 是"关页面 / 切工单"那条路：不等定时器，立刻落盘
  store.schedule(32, "还没到点");
  store.flush(32);
  assert.equal(store.read(32), "还没到点");
  assert.deepEqual(store.pending(), []);
});

/* ───────────────────────────── 键盘 ───────────────────────────── */

const keyEvent = (key: string, extra: Record<string, unknown> = {}) => ({ key, ...extra });

test("键盘：队列里 j/k/Enter/Escape 映射到 next/prev/open/ignore", () => {
  const queue = { view: "queue", editable: false };
  assert.equal(keys.mapKey(keyEvent("j"), queue), "next");
  assert.equal(keys.mapKey(keyEvent("J"), queue), "next", "大写也算（Caps Lock 开着时人人都会撞上）");
  assert.equal(keys.mapKey(keyEvent("k"), queue), "prev");
  assert.equal(keys.mapKey(keyEvent("Enter"), queue), "open");
  assert.equal(keys.mapKey(keyEvent("Escape"), queue), "ignore", "已经在队列里，Esc 没有可返回的地方");
  assert.equal(keys.mapKey(keyEvent("K", { ctrlKey: true }), queue), "ignore", "Ctrl+K 属于浏览器/系统，不能被抢");

  const detail = { view: "detail", editable: false };
  assert.equal(keys.mapKey(keyEvent("Escape"), detail), "back", "详情里 Esc 返回队列");
  assert.equal(keys.mapKey(keyEvent("j"), detail), "ignore", "详情没有「上下移动」的语义");
  assert.equal(keys.mapKey(keyEvent("Enter"), detail), "ignore");
});

test("键盘：输入框 / textarea 聚焦时 J/K/Enter/Escape 全部让位（不劫持打字）", () => {
  for (const view of ["queue", "detail"]) {
    const ctx = { view, editable: true };
    for (const key of ["j", "k", "Enter", "Escape", "?"]) {
      assert.equal(keys.mapKey(keyEvent(key), ctx), "ignore", `${view} 视图输入框里的 ${key} 必须交给浏览器`);
    }
  }
  // Ctrl/Cmd+Enter 是唯一的例外：它在输入框里也要发送（那是坐席最常按的地方）
  assert.equal(keys.mapKey(keyEvent("Enter", { ctrlKey: true }), { view: "detail", editable: true }), "send");
  assert.equal(keys.mapKey(keyEvent("Enter", { metaKey: true }), { view: "detail", editable: true }), "send");
  assert.equal(keys.mapKey(keyEvent("Enter", { ctrlKey: true }), { view: "queue", editable: false }), "ignore");

  assert.equal(keys.isEditableTarget({ tagName: "INPUT" }), true);
  assert.equal(keys.isEditableTarget({ tagName: "textarea" }), true);
  assert.equal(keys.isEditableTarget({ tagName: "SELECT" }), true);
  assert.equal(keys.isEditableTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(keys.isEditableTarget({ tagName: "DIV" }), false);
  assert.equal(keys.isEditableTarget(null), false);
});

test("键盘：? 出帮助提示，未定义的键一律忽略", () => {
  assert.equal(keys.mapKey(keyEvent("?"), { view: "queue", editable: false }), "help");
  assert.equal(keys.mapKey(keyEvent("x"), { view: "queue", editable: false }), "ignore");
  assert.equal(keys.mapKey(null as unknown as Record<string, unknown>), "ignore");
});

/* ───────────────────────────── 关单校验 ───────────────────────────── */

test("关单结论：≥10 字符（trim 后、按字符计），中文按 1 个算", () => {
  assert.equal(resolution.RESOLUTION_MIN_CHARS, 10);
  assert.equal(resolution.countChars("已电话指导复位，问题解决"), 12);
  assert.equal(resolution.isValidResolution("已电话指导复位，问题解决"), true);
  assert.equal(resolution.isValidResolution("已电话指导复位"), false, "8 字不够，按钮必须禁用");

  assert.equal(resolution.isValidResolution("  短  "), false, "首尾空白不算字数");
  assert.equal(resolution.isValidResolution("           "), false, "十个空格不是结论");
  assert.equal(resolution.isValidResolution("1234567890"), true, "纯数字也是 10 字符");
  assert.equal(resolution.countChars("👍👍👍👍👍"), 5, "按码点计数：5 个 emoji 是 5 个字符，不是 10 个 UTF-16 码元");
  assert.equal(resolution.isValidResolution("👍👍👍👍👍"), false, "5 个 emoji 不够 10 字");
  assert.equal(resolution.countChars(null), 0);

  assert.equal(resolution.resolutionHint("短"), "还差 9 字");
  assert.equal(resolution.resolutionHint("已电话指导复位，问题解决"), "可以关单");
  assert.equal(resolution.normalizeResolution("  已电话指导复位  "), "已电话指导复位");
});

/* ───────────────────────────── 时间格式 ───────────────────────────── */

test("时间格式：MM-DD HH:mm / HH:mm（本地时区），认不出给破折号", () => {
  const iso = "2026-10-27T14:20:00Z";
  assert.match(time.formatDayMinute(iso), /^\d{2}-\d{2} \d{2}:\d{2}$/, "列表的创建列是 MM-DD HH:mm（11 §2.1）");
  assert.match(time.formatClock(iso), /^\d{2}:\d{2}$/, "对话流的时间是 HH:mm（11 §3.2）");
  for (const bad of [null, undefined, "", "not-a-date"]) {
    assert.equal(time.formatDayMinute(bad), "—", `${String(bad)} 不该让整行渲染失败`);
    assert.equal(time.formatClock(bad), "—");
  }
});

/* ───────────────────────────── 渲染与转义 ───────────────────────────── */

test("渲染：工单内容里的尖括号不会破坏表格结构（摘要与 title 都必须转义）", () => {
  const hostile = '<img src=x onerror="alert(1)">&"';
  const html = view.rowHtml(
    {
      id: 31,
      no: "WT-2026-0031",
      reason: "no_citation",
      status: "open",
      question: hostile,
      lang: "de",
      assignee: null,
      created_at: "2026-10-27T14:20:00Z",
    },
    { sla: { text: "2h 14m", level: "ok" }, assignee: "", fresh: false },
  );
  assert.ok(!html.includes("<img"), "客户填的问题摘要不得原样进 HTML");
  assert.ok(!html.includes("onerror=\"alert(1)\""), "属性里的引号必须被转义，否则可以逃出 title");
  assert.ok(html.includes("&lt;img"), "应该以转义形态出现在摘要里");
  assert.ok(html.includes("&amp;"), "& 也要转义（否则 &amp;lt; 这类双重编码会弄坏显示）");
  assert.equal(view.esc("'\"<>"), "&#39;&quot;&lt;&gt;");
  assert.equal(view.esc(null), "");
});

test("渲染：AI 那一轮没有检索证据时给出明确标记（拒答 / 零引用两种情况）", () => {
  const refused = view.messageHtml({ id: 1, role: "assistant", content: "no source", refused: true, citations_count: 0, citations: [] });
  assert.ok(refused.includes("本轮无检索证据"), "拒答必须有标记");
  assert.ok(refused.includes("已自动转人工"), "拒答意味着已经建单转人工");

  const empty = view.messageHtml({ id: 2, role: "assistant", content: "guess", refused: false, citations_count: 0, citations: [] });
  assert.ok(empty.includes("本轮无检索证据"), "答了但零引用同样是「没有证据」，坐席据此决定要不要采纳");

  const cited = view.messageHtml({ id: 3, role: "assistant", content: "答案 [1]", citations_count: 1, citations: [{ idx: 1, doc_title: "手册", page: 12, snippet: "原文" }] });
  assert.ok(!cited.includes("本轮无检索证据"), "有引用就不该报无证据");
  assert.ok(cited.includes('class="cite"'), "引用角标必须可点");
  assert.ok(cited.includes('data-idx="1"'));

  // 正文里出现 citations 之外的编号：保持纯文本，不画空气泡
  const fake = view.messageHtml({ id: 4, role: "assistant", content: "见 [9]", citations_count: 1, citations: [{ idx: 1 }] });
  assert.ok(!fake.includes('data-idx="9"'), "不在引用列表里的编号不许变成角标");
  assert.ok(fake.includes("[9]"));

  const local = view.messageHtml({ id: 5, role: "staff", content: "回复", local: true });
  assert.ok(local.includes("本地记录，未外发"), "本期没有外发接口，本地消息必须自带标签");
});

test("渲染：无证据标记以后端的 no_evidence 为准，不信可能停在 0 的 citations_count", () => {
  // citation-store 回填失败时 `messages.citations_count` 会停在默认 0，但 `citations` 行是真的。
  // 后端按行数算出的 `no_evidence: false` 必须压过那个 0，否则一个可信答案会被标成"不可采纳"。
  const stale = view.messageHtml({
    id: 6,
    role: "assistant",
    content: "答案 [1]",
    refused: false,
    citations_count: 0,
    no_evidence: false,
    citations: [{ idx: 1, doc_title: "手册", page: 3, snippet: "原文" }],
  });
  assert.ok(!stale.includes("本轮无检索证据"), "后端说 no_evidence=false 就不许标无证据");
  assert.ok(stale.includes('class="cite"'), "有引用行就必须画角标");

  const flagged = view.messageHtml({
    id: 7,
    role: "assistant",
    content: "猜的",
    refused: false,
    citations_count: 0,
    no_evidence: true,
    citations: [],
  });
  assert.ok(flagged.includes("本轮无检索证据"), "后端标了 no_evidence 就必须显示标记");
  assert.ok(!flagged.includes("已自动转人工"), "no_evidence 不是拒答，别把两个语义混在一起");
});

test("渲染：工具轨迹折叠、默认收起；没有时长就写「耗时未记录」而不是编一个数", () => {
  const named = view.messageHtml({ id: 1, role: "assistant", content: "x", citations_count: 0, tool_names: ["kb_search"] });
  assert.ok(named.includes("<details class=\"t-tools\">"), "工具轨迹用原生 details，默认收起（不带 open）");
  assert.ok(!named.includes("<details class=\"t-tools\" open"), "默认必须收起");
  assert.ok(named.includes("kb_search · 耗时未记录"), "05 §4.2 只给 tool_names，没有耗时");

  const timed = view.messageHtml({ id: 2, role: "assistant", content: "x", citations_count: 0, tools: [{ name: "kb_search", ms: 420 }] });
  assert.ok(timed.includes("kb_search · 420ms"), "后端给 tools[].ms 时直接显示毫秒");

  const none = view.messageHtml({ id: 3, role: "user", content: "hi" });
  assert.ok(!none.includes("t-tools"), "用户消息没有工具轨迹");
});

test("渲染：空引用聚合给空态，而不是一个空 ul", () => {
  assert.ok(view.citesHtml([]).includes("暂无引用"));
  assert.ok(view.citesHtml([{ id: 1, role: "assistant", citations: [] }]).includes("暂无引用"));
  const html = view.citesHtml([{ id: 12, citations: [{ idx: 1, doc_title: "Installationshandbuch", page: 12, doc_lang: "de" }] }]);
  assert.ok(html.includes("Installationshandbuch"));
  assert.ok(html.includes('data-msg="12"'), "点开的原文要能定位到具体消息的引用");
  assert.ok(html.includes("第 12 页"));
});

/* ───────────────────────────── 静态资源 ───────────────────────────── */

let app: FastifyInstance | undefined;

before(async () => {
  // 只注册静态路由：不碰 PG / Redis / MinIO，红了就知道是这一条路由的锅（与 tests/assets.test.ts 同法）
  const { default: Fastify } = await import("fastify");
  const { registerAssetRoutes } = await import("../src/api/assets.ts");
  const { toErrorBody } = await import("../src/errors.ts");

  const instance = Fastify({ logger: false });
  instance.setErrorHandler((err, request, reply) => {
    const { status, body } = toErrorBody(err, String(request.id));
    return reply.code(status).send(body);
  });
  instance.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Not found", trace_id: String(request.id) } }),
  );
  await registerAssetRoutes(instance);
  await instance.ready();
  app = instance;
});

after(async () => {
  if (app !== undefined) await app.close();
});

function instance(): FastifyInstance {
  assert.ok(app !== undefined, "app 未初始化");
  return app;
}

test("GET /console 返回 console.html：text/html + 入口页缓存 + nosniff", async (t) => {
  if (!existsSync(join(STATIC_DIR, "console.html"))) {
    t.skip("缺少 src/static/console.html");
    return;
  }
  const response = await instance().inject({ method: "GET", url: "/console" });
  assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body.slice(0, 200)}`);

  const contentType = String(response.headers["content-type"] ?? "");
  assert.ok(contentType.startsWith("text/html"), `content-type 应是 text/html，实际 "${contentType}"`);
  assert.ok(contentType.includes("charset=utf-8"), "中文硬编码的坐席端必须声明 charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-cache", "入口页每次回源（它引用的是没有内容哈希的 /assets/*）");
  assert.equal(response.headers["x-content-type-options"], "nosniff");

  const html = response.body;
  assert.match(html, /<html lang="zh"/i, "坐席端刻意只做中文：<html lang> 必须是 zh（i18n 例外写进 PRD）");
  assert.ok(html.includes("/assets/console.js"), "console.html 必须引用 /assets/console.js");
  assert.ok(html.includes("/assets/console.css"), "console.html 必须引用 /assets/console.css");
  assert.ok(!/data-i18n[a-z-]*=/i.test(html), "坐席端不走五语文案表：出现 data-i18n 属性说明有人把内部工具接进了用户端机制");
});

test("GET /assets/console.js 返回 text/javascript：否则 type=module 整页不执行", async (t) => {
  if (!existsSync(join(STATIC_DIR, "console.js"))) {
    t.skip("缺少 src/static/console.js");
    return;
  }
  const response = await instance().inject({ method: "GET", url: "/assets/console.js" });
  assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body.slice(0, 200)}`);
  assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.match(String(response.headers["cache-control"] ?? ""), /^public, max-age=\d+$/, "资源缓存策略与 user.js 一致");
  // 返回的必须是文件本身，而不是被某个 404 页面 200 掉（那就是"页面白屏但状态码好看"）
  assert.ok(response.body.includes('./lib/console-sla.js'), "console.js 必须是真文件（含它对 lib/ 的 import）");
  assert.ok(response.body.length > 0);

  // 逻辑拆到 lib/ 之后，那些文件也得能取到（否则页面在浏览器里 import 404，白屏且只在控制台报错）
  for (const name of ["console-sla", "console-route", "console-draft", "console-keys", "console-resolution", "console-time", "console-view"]) {
    const sub = await instance().inject({ method: "GET", url: `/assets/lib/${name}.js` });
    assert.equal(sub.statusCode, 200, `/assets/lib/${name}.js 期望 200，实际 ${sub.statusCode}`);
    assert.equal(sub.headers["content-type"], "text/javascript; charset=utf-8");
  }
});

test("GET /assets/console.css 返回 text/css", async (t) => {
  if (!existsSync(join(STATIC_DIR, "console.css"))) {
    t.skip("缺少 src/static/console.css");
    return;
  }
  const response = await instance().inject({ method: "GET", url: "/assets/console.css" });
  assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body.slice(0, 200)}`);
  assert.equal(response.headers["content-type"], "text/css; charset=utf-8");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.ok(response.body.length > 0);
});
