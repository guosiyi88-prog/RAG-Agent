/**
 * 待审反馈面板（`09#04` 反馈闭环 / `docs/prdv1.2/05-api.md` §5.7）的断言。
 *
 * 这张面板接的是"有数据没消费的空池子"那条警告（`v_no_hit` / `kb_drafts` 的下场），所以下面
 * 两类断言的比重很明确：
 *   1. **纯逻辑**：查询串（默认 `status=new`、页大小与 `api/params.ts` 的缺省同值）、分页夹取、
 *      来源 / 状态文案、能不能处置（角色 + 状态两个门槛）、处置体只认两个字符串。
 *      这些与后端口径漂一寸，界面上就表现成"看着能点，点了 409"或者"处置完还在列表里"。
 *   2. **生命周期（假 DOM）**：处置成功之后**重新拉取**而不是前端硬删、403 只写页内文案不派发退出、
 *      卸载之后迟到的响应不许再画。仓库没有 DOM 测试依赖，也不为这一条加 jsdom
 *      （`tests/web-admin-shell.test.ts` 是同一套写法）。
 *
 * 前端模块是 `.js`（浏览器直接跑），`tsconfig.json` 没开 `allowJs`，所以用**非字面量**动态 import
 * 让类型退化成 any（`web-lib` / `web-admin-faults` 已经是这个口径）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = join(repoRoot, "src", "static", "lib", "console-admin-reports.js");

/** 非字面量 specifier：`tsconfig.json` 没开 `allowJs`，写成字面量 TS 会去解析一个 `.js` 模块。 */
const load = (name: string): Promise<any> => import(`../src/static/lib/${name}.js`);

const reports = await load("console-admin-reports");

const {
  DEFAULT_STATUS,
  MERGE_HINT,
  PAGE_SIZE,
  STATUS_OPTIONS,
  buildReportQuery,
  callApi,
  canResolve,
  emptyText,
  errorText,
  esc,
  formatStamp,
  langLabel,
  mount,
  pageInfo,
  reportsRowsHtml,
  resolveBody,
  sourceLabel,
  statusLabel,
} = reports;

/* ───────────────────────── 假 DOM（只为跑生命周期） ───────────────────────── */

function fakeNode(tag = "div"): any {
  const node: any = {
    tagName: String(tag).toUpperCase(),
    className: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    title: "",
    dataset: {} as Record<string, string>,
    children: [] as any[],
    classList: {
      _set: new Set<string>(),
      add(value: string) {
        this._set.add(value);
      },
      remove(value: string) {
        this._set.delete(value);
      },
      toggle(value: string, on: boolean) {
        if (on) this._set.add(value);
        else this._set.delete(value);
      },
      contains(value: string) {
        return this._set.has(value);
      },
    },
    appendChild(child: any) {
      node.children.push(child);
      return child;
    },
    replaceChildren(...kids: any[]) {
      node.children = kids;
    },
    listeners: [] as Array<{ type: string; fn: (event: any) => void }>,
    addEventListener(type: string, fn: (event: any) => void) {
      node.listeners.push({ type, fn });
    },
    removeEventListener(type: string, fn: (event: any) => void) {
      node.listeners = node.listeners.filter((one: any) => one.type !== type || one.fn !== fn);
    },
    setAttribute(name: string, value: any) {
      node[`attr:${name}`] = String(value);
    },
    getAttribute(name: string) {
      return node[`attr:${name}`] ?? null;
    },
  };
  return node;
}

function fakeDocument(): any {
  const doc: any = {};
  doc.createElement = (tag: string) => {
    const node = fakeNode(tag);
    node.ownerDocument = doc;
    return node;
  };
  return doc;
}

/** 一个「像元素」的 host：骨架就是这么传进来的（`doc.createElement("div")`）。 */
function fakeHost(): any {
  const node = fakeNode("div");
  node.className = "admin-host";
  node.ownerDocument = fakeDocument();
  return node;
}

/** 展开一棵假节点里的所有文本。 */
function textsOf(node: any): string[] {
  const out: string[] = [];
  if (typeof node?.textContent === "string" && node.textContent !== "") out.push(node.textContent);
  if (typeof node?.innerHTML === "string" && node.innerHTML !== "") out.push(node.innerHTML);
  for (const child of node?.children ?? []) out.push(...textsOf(child));
  return out;
}

/**
 * 按类名在一棵假节点里找节点（递归）：面板的 DOM 是分层的（`.tabs` 在 `.admin-head` 里），
 * 用 `children.find` 只查一层会把"结构挪了一层"误报成"元素不见了"。
 */
function findByClass(node: any, className: string): any {
  if (node?.className === className) return node;
  for (const child of node?.children ?? []) {
    const found = findByClass(child, className);
    if (found !== null) return found;
  }
  return null;
}

/** 按 `data-*` 键找节点（递归）：Tab 与分页按钮都靠它定位。 */
function findByData(node: any, key: string, value: string): any {
  if (node?.dataset !== undefined && String(node.dataset[key] ?? "") === value) return node;
  for (const child of node?.children ?? []) {
    const found = findByData(child, key, value);
    if (found !== null) return found;
  }
  return null;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const ROW_A = {
  id: 7,
  code: "ZZ9",
  product_line: "balcony",
  source: "page",
  lang: "de",
  quote: "用户查了 ZZ9",
  status: "new",
  created_at: "2026-10-27T03:12:00.000Z",
};
const ROW_B = { ...ROW_A, id: 8, code: "E99", quote: null };

/** 点一个带 dataset 的节点：`closest` 只认给定的那个选择器（与真 DOM 的语义对齐）。 */
function clickWith(host: any, selector: string, dataset: Record<string, string>, disabled = false) {
  const listener = host.listeners.find((one: any) => one.type === "click");
  assert.ok(listener !== undefined, "面板必须在 host 上挂 click 委托（重画之后不用重新绑）");
  const node = { dataset, disabled };
  listener.fn({ target: { closest: (want: string) => (want === selector ? node : null) } });
  return node;
}

const okWith = (data: any) => async () => ({ ok: true, data });
const failWith = (code: string) => async () => ({ ok: false, error: { code, message: "backend rejected" } });

/* ───────────────────────── 查询串 ───────────────────────── */

test("查询串：默认只看待审，页大小与 api/params.ts 的缺省同值且显式发出", () => {
  assert.equal(DEFAULT_STATUS, "new", "与 api/admin.ts 的 parseReportQuery 缺省一致");
  assert.equal(PAGE_SIZE, 20, "= QUEUE_PAGE_SIZE_DEFAULT（api/params.ts 的 size 缺省）");

  assert.equal(buildReportQuery({}, 1), "status=new&page=1&size=20");
  assert.equal(buildReportQuery({ status: "new" }, 1), "status=new&page=1&size=20");
  assert.equal(buildReportQuery({ status: "merged" }, 3), "status=merged&page=3&size=20");
  assert.equal(buildReportQuery({ status: "rejected" }, 2), "status=rejected&page=2&size=20");
  assert.equal(buildReportQuery(undefined, undefined), "status=new&page=1&size=20", "什么都不给也要能发请求");
});

test("查询串：拼错的状态与非法页码不发给后端（回落而不是 400）", () => {
  // 后端的 parseEnumList 对枚举是硬 400：把拼错的值发过去，坐席看到的是整页红色错误
  assert.equal(buildReportQuery({ status: "pendding" }, 1), "status=new&page=1&size=20");
  assert.equal(buildReportQuery({ status: "" }, 1), "status=new&page=1&size=20");
  for (const bad of [0, -3, 0.4, Number.NaN, Number.POSITIVE_INFINITY, "abc", null, undefined]) {
    assert.equal(
      buildReportQuery({ status: "new" }, bad as any),
      "status=new&page=1&size=20",
      `page=${String(bad)} 必须回落到 1`,
    );
  }
  assert.equal(buildReportQuery({ status: "new" }, 2.9 as any), "status=new&page=2&size=20", "小数取整，不抛");
});

/* ───────────────────────── 分页 ───────────────────────── */

test("分页：页数按 size=20 算，页码夹在 [1, pages] 里，按钮禁用与文案同一个数", () => {
  const empty = pageInfo(0, 1);
  assert.equal(empty.pages, 1, "0 条也是 1 页（不然会出现「第 1 / 0 页」）");
  assert.equal(empty.hasPrev, false);
  assert.equal(empty.hasNext, false);
  assert.equal(empty.text, "第 1 / 1 页 · 共 0 条");

  assert.equal(pageInfo(20, 1).hasNext, false, "正好一页时不该有下一页");
  assert.equal(pageInfo(21, 1).hasNext, true);
  assert.equal(pageInfo(21, 1).pages, 2);

  const second = pageInfo(45, 2);
  assert.deepEqual(
    { page: second.page, pages: second.pages, hasPrev: second.hasPrev, hasNext: second.hasNext },
    { page: 2, pages: 3, hasPrev: true, hasNext: true },
  );
  assert.equal(second.text, "第 2 / 3 页 · 共 45 条");

  assert.equal(pageInfo(45, 99).page, 3, "翻过头：夹到最后一页（否则按钮与文案对不上）");
  assert.equal(pageInfo(45, 0).page, 1);
  assert.equal(pageInfo(null as any, 1).total, 0, "total 缺失不许变 NaN");
});

/* ───────────────────────── 文案 ───────────────────────── */

test("文案：来源 / 状态 / 语言都翻中文，认不出的原样带回，空值给破折号", () => {
  assert.equal(sourceLabel("page"), "故障码页");
  assert.equal(sourceLabel("chat"), "对话");
  assert.equal(sourceLabel("ticket"), "工单");
  assert.equal(sourceLabel("sensor"), "sensor", "不认识的来源不编文案");
  assert.equal(sourceLabel(null), "—");

  assert.equal(statusLabel("new"), "待审");
  assert.equal(statusLabel("merged"), "已合并");
  assert.equal(statusLabel("rejected"), "已忽略");
  assert.equal(statusLabel("weird"), "weird");
  assert.equal(statusLabel(undefined), "—");

  assert.equal(langLabel("de"), "Deutsch", "母语名自显，与用户端语言菜单同一套");
  assert.equal(langLabel("zh"), "中文");
  assert.equal(langLabel("xx"), "xx");
  assert.equal(langLabel(""), "—");
});

test("文案：空列表分状态、错误码分场景，403 说的是权限不足", () => {
  assert.ok(emptyText("new").includes("没有待审反馈"));
  assert.ok(emptyText("merged").includes("还没有已合并"));
  assert.ok(emptyText("rejected").includes("还没有已忽略"));
  assert.ok(!emptyText(undefined).includes("undefined"));

  assert.ok(errorText({ code: "FORBIDDEN" }).includes("权限不足"), "403 不是没登录");
  assert.ok(errorText({ code: "AUTH_REQUIRED" }).includes("重新登录"));
  assert.ok(errorText({ code: "NETWORK" }).includes("连不上"));
  assert.ok(errorText({ code: "CONFLICT", message: "这条反馈已被处置为 merged" }).includes("merged"));
  assert.ok(errorText({ code: "HTTP_503" }).includes("服务端出错"));
  assert.equal(errorText({ code: "WEIRD", message: "后端原话" }), "后端原话");
  assert.equal(errorText({}), "请求失败。");
});

test("时间与转义：本地时分不变形，摘录里的标签被转义", () => {
  assert.equal(formatStamp(""), "—");
  assert.equal(formatStamp("not a date"), "—");
  assert.match(formatStamp("2026-10-27T03:12:00.000Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(esc('<b>"x"&y</b>'), "&lt;b&gt;&quot;x&quot;&amp;y&lt;/b&gt;");
  assert.equal(esc(null), "");
});

/* ───────────────────────── 能力判定与处置体 ───────────────────────── */

test("能不能处置：角色（lead 起）与状态（必须是 new）两个门槛，理由要能直接给人看", () => {
  const lead = canResolve({ status: "new" }, "lead");
  assert.deepEqual(lead, { visible: true, enabled: true, reason: "" });
  assert.equal(canResolve({ status: "new" }, "admin").enabled, true, "admin 也能处置（等级更高）");

  const guest = canResolve({ status: "new" }, "agent");
  assert.equal(guest.visible, false, "agent 连按钮都不该看到");
  assert.equal(guest.enabled, false);
  assert.ok(guest.reason.includes("lead"), "理由要点名需要什么角色");

  for (const status of ["merged", "rejected"]) {
    const done = canResolve({ status }, "lead");
    assert.equal(done.visible, true);
    assert.equal(done.enabled, false, `${status}：后端会回 409，按钮不该亮着`);
    assert.ok(done.reason.includes(statusLabel(status)));
  }

  assert.equal(canResolve(undefined, "lead").enabled, true, "行缺失按「还没处置」处理（列表里的行总有 status）");
  assert.equal(canResolve({ status: "new" }, undefined).enabled, false, "未知角色按最低档（与 requireRole 同口径）");
  assert.equal(canResolve({ status: "new" }, " LEAD ").enabled, true, "角色大小写与空白不影响判定");
});

test("处置体：只认 merge / reject 两个字符串，绝不猜方向", () => {
  assert.deepEqual(resolveBody("merge"), { action: "merge" });
  assert.deepEqual(resolveBody("reject"), { action: "reject" });
  assert.deepEqual(resolveBody(" merge "), { action: "merge" }, "去掉首尾空白照收");
  for (const bad of ["", "MERGED", "status", null, undefined, 42, {}]) {
    assert.equal(resolveBody(bad as any), null, `${String(bad)} 不该变成一个看起来合理的动作`);
  }
  // 终态由 action 推导：客户端连"直接写 status"的机会都没有
  assert.ok(!Object.prototype.hasOwnProperty.call(resolveBody("merge"), "status"));
});

/* ───────────────────────── 行 HTML ───────────────────────── */

test("行 HTML：七列齐全、两个按钮带 id 与动作、合并的提示指向故障卡面板", () => {
  const html = reportsRowsHtml([ROW_A, ROW_B]);

  const rows = html.split("<tr").length - 1;
  assert.equal(rows, 2, "两条反馈各一行");
  for (const rowHtml of html.split('class="admin-report-row"').slice(1)) {
    assert.equal(rowHtml.split("<td").length - 1, 7, "七列：code | 产线 | 来源 | 语言 | 摘录 | 上报时间 | 操作");
  }
  assert.ok(html.includes("ZZ9"));
  assert.ok(html.includes("balcony"));
  assert.ok(html.includes("故障码页"), "来源要翻中文");
  assert.ok(html.includes("Deutsch"), "语言显示母语名");
  assert.ok(html.includes("2026-10-27"), "上报时间按本地格式");
  assert.ok(html.includes('data-report-act="merge" data-report-id="7"'));
  assert.ok(html.includes('data-report-act="reject" data-report-id="7"'));
  assert.ok(html.includes('data-report-id="8"'), "两条反馈各一行");
  assert.ok(html.includes(MERGE_HINT), "合并按钮的 title 必须写明「去故障卡面板新建 draft」");
  assert.ok(!/undefined|NaN/.test(html), "行里不许出现 undefined / NaN");
});

test("行 HTML：空摘录给破折号，恶意文本被转义，agent 看不到处置按钮", () => {
  const html = reportsRowsHtml([{ ...ROW_B, quote: null }]);
  assert.ok(html.includes(">—</td>"), "没有摘录时给破折号");

  const evil = reportsRowsHtml([{ ...ROW_A, quote: '<img src=x onerror="alert(1)">', code: "<b>X</b>" }]);
  assert.ok(!evil.includes("<img"), "摘录是用户打的字：必须转义");
  assert.ok(!evil.includes("<b>X</b>"));
  assert.ok(evil.includes("&lt;img"));

  const agentView = reportsRowsHtml([ROW_A], "agent");
  assert.ok(!agentView.includes("data-report-act"), "agent 连按钮都不该渲染（点开就是 403）");
  assert.ok(agentView.includes("ZZ9"), "但列表内容该看得到（真权限在接口层）");
});

test("行 HTML：已处置的行按钮禁用并说明原因", () => {
  const html = reportsRowsHtml([{ ...ROW_A, status: "merged" }]);
  assert.ok(html.includes("disabled"));
  assert.ok(html.includes("已合并"));
});

test("行 HTML：空 / 坏入参不抛（接口换形状时面板不许白屏）", () => {
  for (const bad of [null, undefined, {}, "x", 42]) {
    assert.equal(reportsRowsHtml(bad as any), "", `${String(bad)} 应该画不出行，也可能不抛`);
  }
  assert.equal(reportsRowsHtml([null, undefined, {}] as any).includes("undefined"), false);
});

/* ───────────────────────── callApi 的两种约定 ───────────────────────── */

test("callApi：信封与抛异常两种约定都归一成 { ok, error }", async () => {
  assert.deepEqual(await callApi(async () => ({ ok: true, data: { total: 1 } }), "/x", {}), {
    ok: true,
    data: { total: 1 },
  });
  assert.deepEqual(await callApi(async () => ({ items: [] }), "/x", {}), { ok: true, data: { items: [] } });
  const thrown = await callApi(async () => {
    throw Object.assign(new Error("boom"), { code: "FORBIDDEN" });
  }, "/x", {});
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error.code, "FORBIDDEN");
  assert.equal((await callApi(null as any, "/x", {})).error.code, "NETWORK", "没有请求出口也不能抛");
});

/* ───────────────────────── 生命周期 ───────────────────────── */

test("mount：首屏按默认口径打一次，画出 Tab 与行", async () => {
  const host = fakeHost();
  const calls: string[] = [];
  const unmount = mount(host, {
    api: async (path: string) => {
      calls.push(path);
      return { ok: true, data: { total: 2, items: [ROW_A, ROW_B] } };
    },
    role: "lead",
    toast: () => {},
    onSignOut: () => {},
  });
  await tick();

  assert.deepEqual(calls, ["/api/admin/fault-reports?status=new&page=1&size=20"], "首屏只看待审");
  const text = textsOf(host).join("|");
  assert.ok(text.includes("待审反馈"), "标题");
  assert.ok(text.includes("ZZ9") && text.includes("E99"), "两行都要画出来");
  assert.ok(text.includes(MERGE_HINT), "面板上要写清「合并只改状态」");
  assert.ok(!text.includes("正在加载…"), "成功后状态行要清空");

  // 三个状态 Tab，默认选中 new
  const tabs = findByClass(host, "tabs");
  assert.ok(tabs !== null, "状态切换用 Tab（与看板同一套 .tabs/.tab-btn）");
  const selected = tabs.children.filter((node: any) => node.getAttribute("aria-selected") === "true");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].dataset.reportStatus, "new");
  assert.deepEqual(
    STATUS_OPTIONS.map((pair: string[]) => pair[0]),
    ["new", "merged", "rejected"],
    "与后端 FAULT_REPORT_STATUS_VALUES 同集同序",
  );

  unmount();
  assert.deepEqual(host.children, [], "卸载要把自己画的东西清掉");
});

test("mount：处置成功 → 重新拉取（不前端硬删），那一行从 new 列表消失", async () => {
  const host = fakeHost();
  const calls: Array<{ path: string; init: any }> = [];
  const toasts: string[] = [];
  let resolved = false;
  const api = async (path: string, init: any) => {
    calls.push({ path, init });
    if (init?.method === "PATCH") {
      resolved = true;
      return { ok: true, data: { report: { ...ROW_A, status: "merged" }, changed: ["status"] } };
    }
    return { ok: true, data: { total: resolved ? 1 : 2, items: resolved ? [ROW_B] : [ROW_A, ROW_B] } };
  };
  const unmount = mount(host, { api, role: "lead", toast: (msg: string) => toasts.push(msg), onSignOut: () => {} });
  await tick();

  clickWith(host, "[data-report-act]", { reportAct: "merge", reportId: "7" });
  await tick();
  await tick();

  const patch = calls.find((one) => one.init?.method === "PATCH");
  assert.ok(patch !== undefined, "点「合并」必须发一次 PATCH");
  assert.equal(patch.path, "/api/admin/fault-reports/7", "路径里是反馈 id（不是码）");
  assert.deepEqual(patch.init.body, { action: "merge" }, "body 只有 action，终态由后端推导");

  const gets = calls.filter((one) => one.init?.method !== "PATCH");
  assert.equal(gets.length, 2, "处置之后必须重新拉取（不是前端把行删掉）");
  assert.equal(gets[1].path, "/api/admin/fault-reports?status=new&page=1&size=20");
  assert.ok(!textsOf(host).join("|").includes("ZZ9"), "已处置的那条从 new 列表消失");
  assert.ok(textsOf(host).join("|").includes("E99"), "其余行还在");
  assert.equal(toasts.length, 1);
  assert.ok(toasts[0].includes("已合并") && toasts[0].includes("故障卡"), "提示要指向建 draft 的那一步");

  unmount();
});

test("mount：忽略（reject）发的是 action=reject，提示不提建码", async () => {
  const host = fakeHost();
  const bodies: any[] = [];
  const toasts: string[] = [];
  const api = async (_path: string, init: any) => {
    if (init?.method === "PATCH") {
      bodies.push(init.body);
      return { ok: true, data: { report: { ...ROW_A, status: "rejected" }, changed: ["status"] } };
    }
    return { ok: true, data: { total: 2, items: [ROW_A, ROW_B] } };
  };
  mount(host, { api, role: "lead", toast: (msg: string) => toasts.push(msg), onSignOut: () => {} });
  await tick();
  clickWith(host, "[data-report-act]", { reportAct: "reject", reportId: "8" });
  await tick();
  await tick();
  assert.deepEqual(bodies, [{ action: "reject" }]);
  assert.equal(toasts.length, 1);
  assert.ok(toasts[0].includes("已忽略"));
});

test("mount：403 只写页内文案（权限不足），不派发 onSignOut、不清列表外壳", async () => {
  const host = fakeHost();
  let signOuts = 0;
  const toasts: string[] = [];
  const api = async (path: string, init: any) => {
    if (init?.method === "PATCH") return { ok: false, error: { code: "FORBIDDEN", message: "nope" } };
    void path;
    return { ok: true, data: { total: 1, items: [ROW_A] } };
  };
  mount(host, {
    api,
    role: "lead",
    toast: (msg: string) => toasts.push(msg),
    onSignOut: () => {
      signOuts += 1;
    },
  });
  await tick();
  clickWith(host, "[data-report-act]", { reportAct: "merge", reportId: "7" });
  await tick();
  await tick();

  const text = textsOf(host).join("|");
  assert.ok(text.includes("权限不足"), `403 要在页内说清，实际：${text}`);
  assert.equal(signOuts, 0, "403 不等于没登录：不许派发退出（D31）");
  assert.ok(text.includes("ZZ9"), "失败不清列表：人还要能接着看");
});

test("mount：加载失败 / 空列表 / 网络错都有明确文案，且不抛", async () => {
  const scenarios: Array<[string, any, string]> = [
    ["403", failWith("FORBIDDEN"), "权限不足"],
    ["网络错", failWith("NETWORK"), "连不上服务端"],
    ["5xx", failWith("HTTP_503"), "服务端出错"],
  ];
  for (const [label, api, expect] of scenarios) {
    const host = fakeHost();
    mount(host, { api, role: "lead", toast: () => {}, onSignOut: () => {} });
    await tick();
    const text = textsOf(host).join("|");
    assert.ok(text.includes(expect), `${label}：页内文案要含「${expect}」，实际：${text}`);
    assert.ok(!text.includes("undefined"));
  }

  const emptyHost = fakeHost();
  mount(emptyHost, { api: okWith({ total: 0, items: [] }), role: "lead", toast: () => {}, onSignOut: () => {} });
  await tick();
  assert.ok(textsOf(emptyHost).join("|").includes("没有待审反馈"), "空列表要说清是空，不是加载中");
});

test("mount：切换状态 Tab 换查询串并回到第 1 页；分页按钮按 total 启用", async () => {
  const host = fakeHost();
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    return { ok: true, data: { total: 45, items: [ROW_A] } };
  };
  mount(host, { api, role: "lead", toast: () => {}, onSignOut: () => {} });
  await tick();
  assert.equal(calls[0], "/api/admin/fault-reports?status=new&page=1&size=20");

  const pager = findByClass(host, "admin-report-pager");
  assert.ok(pager !== null, "分页条要画出来");
  const next = findByData(pager, "reportAct", "next");
  const prev = findByData(pager, "reportAct", "prev");
  const info = findByClass(pager, "admin-report-page");
  assert.equal(next.disabled, false, "45 条 = 3 页，下一页要能点");
  assert.equal(prev.disabled, true, "第 1 页的上一页禁用");
  assert.equal(info.textContent, "第 1 / 3 页 · 共 45 条");

  clickWith(host, "[data-report-act]", { reportAct: "next" });
  await tick();
  assert.equal(calls[1], "/api/admin/fault-reports?status=new&page=2&size=20");

  clickWith(host, "[data-report-status]", { reportStatus: "merged" });
  await tick();
  assert.equal(calls[2], "/api/admin/fault-reports?status=merged&page=1&size=20", "换状态回到第 1 页");

  const mergedTab = findByData(findByClass(host, "tabs"), "reportStatus", "merged");
  assert.equal(mergedTab.getAttribute("aria-selected"), "true");
  assert.equal(findByData(findByClass(host, "tabs"), "reportStatus", "new").getAttribute("aria-selected"), "false");
});

test("mount：409 / 404（别人先处置了）→ 先刷新再说明，不装作成功", async () => {
  const host = fakeHost();
  const calls: Array<{ path: string; init: any }> = [];
  let conflict = true;
  const toasts: string[] = [];
  const api = async (path: string, init: any) => {
    calls.push({ path, init });
    if (init?.method === "PATCH") {
      conflict = false;
      return { ok: false, error: { code: "CONFLICT", message: "这条反馈已被处置为 merged，不能再改成 merged" } };
    }
    return { ok: true, data: { total: 1, items: [ROW_A] } };
  };
  mount(host, { api, role: "lead", toast: (msg: string) => toasts.push(msg), onSignOut: () => {} });
  await tick();
  clickWith(host, "[data-report-act]", { reportAct: "merge", reportId: "7" });
  await tick();
  await tick();

  assert.equal(conflict, false);
  assert.equal(calls.filter((one) => one.init?.method !== "PATCH").length, 2, "冲突后必须刷新列表");
  assert.ok(textsOf(host).join("|").includes("已被处置"));
  assert.deepEqual(toasts, [], "409 不算成功：不给成功提示（改由页内文案说明）");
});

test("mount：没权限时（agent）不发 PATCH，只提示原因", async () => {
  const host = fakeHost();
  const calls: any[] = [];
  const toasts: string[] = [];
  const api = async (path: string, init: any) => {
    calls.push({ path, init });
    return { ok: true, data: { total: 1, items: [ROW_A] } };
  };
  mount(host, { api, role: "agent", toast: (msg: string) => toasts.push(msg), onSignOut: () => {} });
  await tick();
  clickWith(host, "[data-report-act]", { reportAct: "merge", reportId: "7" });
  await tick();
  assert.equal(calls.filter((one) => one.init?.method === "PATCH").length, 0, "agent 不该发出写请求");
  assert.equal(toasts.length, 1);
  assert.ok(toasts[0].includes("lead"));
});

test("mount：卸载之后迟到的响应一个字都不许往面板里写", async () => {
  const host = fakeHost();
  let release: (value: unknown) => void = () => {};
  const toasts: string[] = [];
  const unmount = mount(host, {
    api: () =>
      new Promise<unknown>((resolve) => {
        release = resolve;
      }),
    role: "lead",
    toast: (msg: string) => toasts.push(msg),
    onSignOut: () => {},
  });
  unmount();
  assert.deepEqual(host.children, [], "卸载先把自己画的东西清掉");
  release({ ok: true, data: { total: 1, items: [ROW_A] } });
  await tick();
  assert.deepEqual(host.children, [], "卸载后迟到的响应不得再画");
  assert.deepEqual(toasts, []);
});

test("mount：host 不合法时返回 no-op 卸载函数，绝不抛", () => {
  for (const bad of [null, undefined, 42, "div", {}]) {
    const unmount = mount(bad as any, {});
    assert.equal(typeof unmount, "function", `host=${String(bad)} 也要给出可调用的卸载函数`);
    assert.doesNotThrow(() => unmount());
  }
  // 拿不到宿主文档（不是浏览器元素）时同样是 no-op，而不是崩掉整块面板
  const orphan = fakeNode("div");
  const unmount = mount(orphan, {});
  assert.equal(typeof unmount, "function");
  assert.doesNotThrow(() => unmount());
});

/* ───────────────────── 反回归（静态）：模块必须保持"纯" ───────────────────── */

test("静态：脚本顶层不碰宿主对象、不发请求、不引用别的模块", async () => {
  const source = await readFile(MODULE_PATH, "utf8");

  assert.doesNotMatch(source, /\bfetch\s*\(/, "不许自己发请求：票据与 401/403 处理都在 ctx.api 里");
  assert.doesNotMatch(source, /localStorage/, "不许碰票据存储");
  assert.doesNotMatch(source, /\bwindow\b/, "不许读宿主全局对象");
  assert.doesNotMatch(source, /\bconsole\s*\.\s*(log|warn|error|debug|info)\s*\(/, "不许打日志");
  assert.doesNotMatch(source, /^\s*import\s/m, "必须自包含：不引用任何别的模块（ctx.api 就是唯一的网络出口）");
  assert.doesNotMatch(source, /\brequire\s*\(/, "不许走 CommonJS 旁路");
  assert.match(source, /export function mount\(host, ctx\)/, "契约：mount(host, ctx) 是唯一入口");
  assert.match(source, /return function unmount\(\)/, "要回一个可调用的卸载函数");
});

test("静态：导出面固定（挂载方只依赖 mount，其余是给测试与复用用的纯函数）", async () => {
  for (const name of [
    "mount",
    "buildReportQuery",
    "reportsRowsHtml",
    "canResolve",
    "resolveBody",
    "pageInfo",
    "sourceLabel",
    "statusLabel",
    "emptyText",
    "errorText",
    "callApi",
    "formatStamp",
    "langLabel",
    "esc",
  ]) {
    assert.equal(typeof (reports as any)[name], "function", `必须导出 ${name}`);
  }
  assert.equal(typeof (reports as any).default, "function", "export default mount（骨架两种写法都认）");
  assert.equal(PAGE_SIZE, 20);
  assert.ok(Array.isArray(STATUS_OPTIONS));
  assert.equal(typeof MERGE_HINT, "string");
});
