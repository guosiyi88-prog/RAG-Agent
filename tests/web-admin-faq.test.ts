/**
 * FAQ 草稿面板（`09#06` / A5）与坐席端「转 FAQ 草稿」的纯逻辑断言。
 *
 * 两类比重很明确：
 *   1. **纯逻辑**：查询串（默认 `status=draft`、页大小与 `core/faq-store.ts` 同值）、分页夹取、
 *      来源/状态文案、能不能通过/驳回（角色 + 状态两个门槛）、行 HTML 的转义、
 *      "答案至少 10 字 / 语言必须是五语"这条与后端**同值**的请求体判据。
 *      这些与后端口径漂一寸，界面上就表现成"看着能点，点了 403/409"或者"填了字还是灰的"。
 *   2. **静态反回归**：面板模块必须自包含（不自己发请求、不碰票据、不读宿主全局）；
 *      导出面固定，挂载方只依赖 `mount`。
 *
 * 前端模块是 `.js`（浏览器直接跑），`tsconfig.json` 没开 `allowJs`，所以用**非字面量**动态
 * import 让类型退化成 any（`web-admin-reports` / `web-admin-kb` 已经是这个口径）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = join(repoRoot, "src", "static", "lib", "console-admin-faq.js");

/** 非字面量 specifier：`tsconfig.json` 没开 `allowJs`，写成字面量 TS 会去解析一个 `.js` 模块。 */
const load = (name: string): Promise<any> => import(`../src/static/lib/${name}.js`);

const faq = await load("console-admin-faq");
const view = await load("console-view");

const {
  DEFAULT_STATUS,
  NO_HIT_LIMIT,
  PAGE_SIZE,
  STATUS_OPTIONS,
  buildDraftQuery,
  buildNoHitQuery,
  callApi,
  canApprove,
  canReject,
  draftsRowsHtml,
  emptyText,
  errorText,
  esc,
  formatStamp,
  langLabel,
  mount,
  noHitRowsHtml,
  pageInfo,
  sourceLabel,
  statusLabel,
} = faq;

/* ───────────────────────── 查询串与分页 ───────────────────────── */

test("草稿列表查询串：默认待审、页大小与后端同值、拼错的状态回落默认值", () => {
  assert.equal(PAGE_SIZE, 20, "与 core/faq-store.ts 的 FAQ_PAGE_SIZE_DEFAULT 必须同值");
  assert.equal(DEFAULT_STATUS, "draft");
  assert.deepEqual(
    STATUS_OPTIONS.map(([value]: [string, string]) => value),
    ["draft", "approved", "rejected"],
    "状态清单要与 FAQ_STATUS_VALUES 逐字一致",
  );

  assert.equal(buildDraftQuery({}), "status=draft&page=1&size=20");
  assert.equal(buildDraftQuery({ status: "approved" }, 3), "status=approved&page=3&size=20");
  // 拼错 / 空串不发给后端：静默回落到默认视图，而不是让列表 400。
  assert.equal(buildDraftQuery({ status: "nope" }), "status=draft&page=1&size=20");
  assert.equal(buildDraftQuery({ status: "" }, 0), "status=draft&page=1&size=20");
});

test("未命中池查询串：limit 有上限（与后端 FAQ_NO_HIT_LIMIT_MAX 同值）", () => {
  assert.equal(NO_HIT_LIMIT, 20);
  assert.equal(buildNoHitQuery(), "limit=20");
  assert.equal(buildNoHitQuery(999), "limit=20", "不许把 999 发给后端（它会夹到 100，但契约写的是 20）");
  assert.equal(buildNoHitQuery(5), "limit=5");
  assert.equal(buildNoHitQuery(0), "limit=20");
});

test("分页：page 先夹进 [1, pages]（显示第 3 页、上一页还灰着就是这条错了）", () => {
  assert.deepEqual(pageInfo(0, 1), { total: 0, page: 1, pages: 1, hasPrev: false, hasNext: false, text: "第 1 / 1 页 · 共 0 条" });
  assert.equal(pageInfo(45, 3).pages, 3);
  assert.equal(pageInfo(45, 9).page, 3, "超出总页数要夹到最后一页");
  assert.equal(pageInfo(45, 3).hasNext, false);
  assert.equal(pageInfo(45, 1).hasNext, true);
  assert.equal(pageInfo(21, 2).hasPrev, true);
});

/* ───────────────────────── 能力判定 ───────────────────────── */

test("通过：只有 admin 且状态是 draft（lead 看得见但点不动，理由写在 title 上）", () => {
  const draft = { status: "draft" };
  assert.equal(canApprove(draft, "admin").enabled, true);
  const asLead = canApprove(draft, "lead");
  assert.equal(asLead.visible, true, "lead 要看得见按钮（否则不知道怎么才能通过）");
  assert.equal(asLead.enabled, false);
  assert.match(asLead.reason, /管理员/);
  assert.equal(canApprove(draft, "agent").visible, false, "agent 连按钮都不该看见");
  assert.equal(canApprove(draft, "unknown").enabled, false, "未知角色按最低档处理");

  const approved = canApprove({ status: "approved" }, "admin");
  assert.equal(approved.enabled, false, "已通过的不能再点（后端幂等回 changed:[]，这里别让人白点）");
  assert.match(approved.reason, /已经处理过/);
  assert.equal(canApprove({ status: "rejected" }, "admin").enabled, false);
});

test("驳回：lead 起、状态是 draft；已通过/已驳回都点不动", () => {
  assert.equal(canReject({ status: "draft" }, "lead").enabled, true);
  assert.equal(canReject({ status: "draft" }, "admin").enabled, true);
  assert.equal(canReject({ status: "draft" }, "agent").visible, false);
  assert.equal(canReject({ status: "approved" }, "lead").enabled, false);
  assert.equal(canReject({ status: "rejected" }, "lead").enabled, false);
});

/* ───────────────────────── 行 HTML ───────────────────────── */

const ROW = {
  id: 42,
  question: 'Wechselrichter <script>alert("x")</script> & "E07"',
  lang: "de",
  source: "ticket",
  status: "draft",
  reviewer: null,
  created_at: "2026-10-28T08:30:00.000Z",
};

test("草稿行：外部输入一律转义、按钮带 id 与动作、无权限时按钮不画", () => {
  const html = draftsRowsHtml([ROW], "admin");
  assert.match(html, /data-draft-id="42"/);
  assert.match(html, /data-draft-act="approve"/);
  assert.match(html, /data-draft-act="reject"/);
  assert.equal(html.includes("<script>"), false, "问题里的 HTML 必须被转义");
  assert.ok(html.includes("&lt;script&gt;"), "转义之后仍要看得出原文");
  assert.ok(html.includes("Deutsch"), "语言显示母语名");
  assert.ok(html.includes("工单"), "source=ticket 显示成「工单」");
  assert.equal(esc('a"b\'c&d<e>' ), 'a&quot;b&#39;c&amp;d&lt;e&gt;');
});

test("草稿行：lead 的通过按钮禁用、agent 一个按钮都不画、已处理的行也给不出动作", () => {
  const asLead = draftsRowsHtml([ROW], "lead");
  assert.match(asLead, /data-draft-act="approve"[^>]*disabled/, "lead 的通过要禁用");
  assert.equal(/data-draft-act="approve"[^>]*disabled/.test(draftsRowsHtml([ROW], "admin")), false);

  const asAgent = draftsRowsHtml([ROW], "agent");
  assert.equal(asAgent.includes("data-draft-act"), false);
  assert.ok(asAgent.includes("—"), "没有动作可做时画一个破折号");

  const approvedRow = draftsRowsHtml([{ ...ROW, status: "approved", reviewer: "王强" }], "admin");
  assert.match(approvedRow, /data-draft-act="approve"[^>]*disabled/);
  assert.ok(approvedRow.includes("王强"), "审批人要显示在状态列里");
});

test("未命中池行：次数是数字、草稿数为 0 显示破折号、没有操作列", () => {
  const html = noHitRowsHtml([
    { question: "反复问 <b>E07</b>", lang: "nl", hits: 7, last_at: "2026-10-28T07:00:00.000Z", draft_count: 0 },
    { question: "已有草稿", lang: "en", hits: 2, last_at: "2026-10-27T07:00:00.000Z", draft_count: 3 },
  ]);
  assert.equal(html.includes("<b>"), false);
  assert.ok(html.includes("&lt;b&gt;"));
  assert.match(html, />7</);
  assert.match(html, />3</);
  assert.equal(html.includes("data-draft-act"), false, "未命中池是只读的");
});

/* ───────────────────────── 文案与错误 ───────────────────────── */

test("文案：状态/来源/语言、空态、错误码都是人能读的一句", () => {
  assert.equal(statusLabel("draft"), "待审");
  assert.equal(statusLabel("approved"), "已通过");
  assert.equal(statusLabel("rejected"), "已驳回");
  assert.equal(statusLabel("weird"), "weird", "认识的翻中文，不认识的原样带回");

  assert.equal(sourceLabel("ticket"), "工单");
  assert.equal(sourceLabel("no_hit"), "未命中池");
  assert.equal(sourceLabel("manual"), "手工");
  assert.equal(langLabel("nl"), "Nederlands");
  assert.equal(langLabel(""), "—");

  assert.match(emptyText("draft"), /没有待审草稿/);
  assert.match(emptyText("approved"), /还没有通过/);
  assert.match(emptyText("rejected"), /还没有驳回/);

  assert.match(errorText({ code: "FORBIDDEN" }), /管理员/);
  assert.match(errorText({ code: "EMBED_UNAVAILABLE" }), /审批未生效/);
  assert.match(errorText({ code: "CONFLICT", message: "已驳回的草稿不能通过" }), /已驳回/);
  assert.equal(errorText({ code: "HTTP_500" }), "服务端出错了，这一屏的数据可能不是最新。");
  assert.equal(errorText({ code: "SOMETHING", message: "后端原话" }), "后端原话", "不认识的码原样显示后端 message");

  assert.equal(formatStamp(""), "—");
  assert.equal(formatStamp("not-a-date"), "—");
  assert.match(formatStamp("2026-10-28T08:30:00.000Z"), /^2026-10-2\d \d\d:\d\d$/);
});

test("callApi：三种返回形状都归一成 { ok, data } / { ok: false, error }", async () => {
  const ok = await callApi(async () => ({ ok: true, data: { total: 1 } }), "/x", {});
  assert.deepEqual(ok, { ok: true, data: { total: 1 } });

  const bare = await callApi(async () => ({ total: 2 }), "/x", {});
  assert.deepEqual(bare, { ok: true, data: { total: 2 } }, "console.js 的 api() 成功时直接回 data");

  const thrown = await callApi(async () => {
    throw Object.assign(new Error("权限不足"), { code: "FORBIDDEN" });
  }, "/x", {});
  assert.deepEqual(thrown, { ok: false, error: { code: "FORBIDDEN", message: "权限不足" } });

  const missing = await callApi(null, "/x", {});
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "NETWORK");
});

/* ───────────────────────── 挂载契约 ───────────────────────── */

test("mount：host 不合法时返回 no-op 卸载函数，绝不抛", () => {
  for (const bad of [null, undefined, 42, "div", {}]) {
    const unmount = mount(bad, {});
    assert.equal(typeof unmount, "function", `host=${String(bad)} 也要给出可调用的卸载函数`);
    assert.doesNotThrow(() => unmount());
  }
  assert.equal(typeof faq.default, "function", "export default mount（骨架两种写法都认）");
});

/* ───────────────── 坐席端「转 FAQ 草稿」的请求体（console-view.js） ───────────────── */

test("faqDraftBody：答案至少 10 字、语言必须五语之一、ticket_id 只在合法时带上", () => {
  const ok = view.faqDraftBody({ ticketId: 7, question: "  问题  ", answer: "  1234567890  ", lang: "DE" });
  assert.deepEqual(ok, { question: "问题", answer: "1234567890", lang: "de", ticket_id: 7 }, "trim + 小写化");

  assert.equal(view.faqDraftBody({ ticketId: 7, question: "问题", answer: "短", lang: "de" }), null, "答案太短");
  assert.equal(view.faqDraftBody({ ticketId: 7, question: "", answer: "1234567890", lang: "de" }), null, "问题为空");
  assert.equal(view.faqDraftBody({ ticketId: 7, question: "问题", answer: "1234567890", lang: "fr" }), null, "不是五语");
  // 没有工单（未命中池起稿）：不带 ticket_id，后端据此写 source=no_hit。
  const noTicket = view.faqDraftBody({ ticketId: null, question: "问题", answer: "1234567890", lang: "de" });
  assert.deepEqual(noTicket, { question: "问题", answer: "1234567890", lang: "de" });
  assert.equal(view.FAQ_ANSWER_MIN_CHARS, 10, "与后端 core/faq-store.ts 的 FAQ_ANSWER_MIN_CHARS 必须同值");
});

test("faqHint：缺什么说什么（与 faqDraftBody 用同一份阈值）", () => {
  assert.match(view.faqHint("", "1234567890"), /问题不能为空/);
  assert.match(view.faqHint("问题", "123"), /还差 7/);
  assert.match(view.faqHint("问题", "1234567890"), /10 字/);
});

test("actionsHtml：已升级的单按钮变文案并禁用，note 说明等 L2 接手", () => {
  const open = view.actionsHtml({ id: 1, status: "open" }, "", undefined);
  assert.ok(open.includes(">转 L2<"));
  assert.match(open, /data-act="l2"(?! disabled)/);

  const escalated = view.actionsHtml({ id: 1, status: "escalated" }, "张伟", undefined);
  assert.ok(escalated.includes("已升级 L2"), "已升级时按钮文案要变");
  assert.match(escalated, /data-act="l2" disabled/);
  assert.ok(escalated.includes("等 L2 接手"));

  const closed = view.actionsHtml({ id: 1, status: "closed" }, "张伟", undefined);
  assert.match(closed, /data-act="l2" disabled/);
  assert.match(closed, /data-act="faq" disabled/);
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

test("静态：导出面固定（挂载方只依赖 mount，其余是给测试与复用用的纯函数）", () => {
  for (const name of [
    "mount",
    "buildDraftQuery",
    "buildNoHitQuery",
    "draftsRowsHtml",
    "noHitRowsHtml",
    "canApprove",
    "canReject",
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
    assert.equal(typeof (faq as any)[name], "function", `必须导出 ${name}`);
  }
  assert.equal(typeof faq.NO_HIT_HINT, "string");
  assert.ok(Array.isArray(STATUS_OPTIONS));
});
