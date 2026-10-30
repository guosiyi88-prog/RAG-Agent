/**
 * 知识库面板（`09#05` / spec S5）与详情页「派发选人」的纯逻辑断言。
 *
 * 面板本身是 DOM 那一层，但**会错的地方都不在 DOM**：
 *   - 后端某个状态该显示成什么词、色带归哪一档（`pending|indexed|failed|archived` / `running|idle|ok|failed`）；
 *   - `lead` 进来是不是真的只读（这是纯函数判定，不是"点了才知道"）；
 *   - 保存前的三格校验（标题 / 语言 / 正文），校验没过就不许发请求；
 *   - 重建轮询什么时候该继续、什么时候该停、什么时候算超时；
 *   - 派发下拉：`agent` 不该有、已关单不该可改、选中值等于当前指派时不发请求。
 * 这些都不需要浏览器，也不需要后端 —— 全部是入参 → 出参。
 *
 * 最后两条把 `mount()` 在**假 DOM + 假定时器**里跑一遍：挂载 → 打开文档 → 重建 → 轮询失败显示后端原文 →
 * 卸载后监听器与定时器清干净。仓库没有 jsdom，也不为这两条加（与 `web-admin-shell` 同法）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_DIR = join(repoRoot, "src", "static");
const load = (name: string): Promise<any> => import(`../src/static/lib/${name}.js`);

const kb = await load("console-admin-kb");
const langLib = await load("lang");
const view = await load("console-view");

const {
  DEFAULT_FILTERS,
  DOC_STATUS,
  EMPTY_TEXT,
  LANGS,
  PAGE_SIZE,
  REBUILD_POLL_LIMIT,
  REBUILD_POLL_MS,
  bodyOf,
  buildListQuery,
  callApi,
  canWrite,
  chunkText,
  createBody,
  docStatus,
  emptyForm,
  errorText,
  esc,
  filtersHtml,
  formFieldsHtml,
  formFromDetail,
  formNote,
  isRebuildDone,
  langLabel,
  langOptions,
  listItems,
  mount,
  normalizeRebuild,
  pageInfo,
  patchBody,
  pickDocument,
  pollDecision,
  productLineOptions,
  rebuildResultText,
  rebuildStatus,
  roleNote,
  rowsHtml,
  validateForm,
  versionText,
} = kb;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ───────────────────────── 夹具 ───────────────────────── */

const DOC_ID = "11111111-1111-1111-1111-111111111111";

/** 列表行（不带正文，带 `created_at` / `updated_at`）。 */
const LIST_ROW = {
  id: DOC_ID,
  title: "保修条款",
  lang: "zh",
  product_line: "balcony",
  status: "indexed",
  chunk_count: 12,
  version: 2,
  created_at: "2026-10-20T01:00:00.000Z",
  updated_at: "2026-10-27T07:04:00.000Z",
};

/** 详情（契约字段一个不少；`rebuild` 是上一次作业的快照）。 */
const DETAIL = {
  id: DOC_ID,
  title: "保修条款",
  lang: "zh",
  product_line: "balcony",
  body: "# 保修\n\n十年质保，不含人为损坏。",
  status: "indexed",
  chunk_count: 12,
  version: 2,
  rebuild: {
    job_id: "job-0",
    status: "ok",
    error: null,
    chunk_count: 12,
    started_at: "2026-10-27T07:00:00.000Z",
    finished_at: "2026-10-27T07:04:00.000Z",
  },
};

/* ───────────────────────── 状态 → 文案 / 色带 ───────────────────────── */

test("文档状态：四个已知状态各有中文与色带，未知值原样显示（不崩、也不吞）", () => {
  assert.deepEqual(docStatus("pending"), { label: "待建索引", tone: "warn" });
  assert.deepEqual(docStatus("indexed"), { label: "已建索引", tone: "ok" });
  assert.deepEqual(docStatus("failed"), { label: "建索引失败", tone: "error" });
  assert.deepEqual(docStatus("archived"), { label: "已停用", tone: "muted" });
  assert.deepEqual(docStatus(""), { label: "—", tone: "neutral" });
  assert.deepEqual(docStatus(undefined), { label: "—", tone: "neutral" });
  // 后端加一个新状态时，面板该把那个词露出来让人报 bug，而不是悄悄画成「—」
  assert.deepEqual(docStatus("indexing"), { label: "indexing", tone: "neutral" });
  assert.deepEqual(docStatus(42), { label: "42", tone: "neutral" });
  assert.deepEqual(Object.keys(DOC_STATUS), ["pending", "indexed", "failed", "archived"]);
});

test("重建状态：idle/running/ok/failed 四档齐全，未知值同样原样显示", () => {
  assert.deepEqual(rebuildStatus("idle"), { label: "未重建", tone: "muted" });
  assert.deepEqual(rebuildStatus("running"), { label: "重建中", tone: "warn" });
  assert.deepEqual(rebuildStatus("ok"), { label: "重建完成", tone: "ok" });
  assert.deepEqual(rebuildStatus("failed"), { label: "重建失败", tone: "error" });
  assert.equal(rebuildStatus("QUEUED").label, "queued", "大小写归一，但词不改");
  assert.deepEqual(rebuildStatus(null), { label: "—", tone: "neutral" });
});

test("状态筛选下拉：默认「全部状态」，其余四项由 DOC_STATUS 推导（不另写一份清单）", () => {
  const values = kb.STATUS_OPTIONS.map(([value]: string[]) => value);
  assert.deepEqual(values, ["", "pending", "indexed", "failed", "archived"]);
  const html = filtersHtml(DEFAULT_FILTERS, "admin");
  assert.ok(html.includes('<option value="" selected>全部状态</option>'), "默认是全部（知识库量级小，停用的也要看得见）");
  assert.ok(html.includes('<option value="archived"'), "已停用的文档要能筛出来");
});

/* ───────────────────────── 语言（复用 lang.js，不抄第二份） ───────────────────────── */

test("语言名：复用 lib/lang.js 的 LANG_NAMES，未知码原样显示、空给破折号", () => {
  for (const lang of LANGS) {
    assert.equal(langLabel(lang), langLib.LANG_NAMES[lang], `${lang} 必须来自 lang.js 那一份母语名`);
  }
  assert.equal(langLabel("DE"), "Deutsch", "大写也认");
  assert.equal(langLabel("fr"), "fr", "五语之外的原样显示，不吞成「—」");
  assert.equal(langLabel(""), "—");
  assert.deepEqual([...LANGS], [...langLib.SUPPORTED_LANGS], "五语顺序与 lang.js 同一份");
});

test("语言下拉：表单里五选一（带语言码），筛选里多一条「全部语言」", () => {
  const formOptions = langOptions();
  assert.equal(formOptions.length, 5);
  assert.deepEqual(formOptions.map(([value]: string[]) => value), ["zh", "en", "de", "nl", "es"]);
  assert.equal(formOptions[2][1], "Deutsch（de）", "母语名 + 语言码：库里存的是码");
  const filterOptions = langOptions(true);
  assert.equal(filterOptions.length, 6);
  assert.deepEqual(filterOptions[0], ["", "全部语言"]);
});

/* ───────────────────────── 写权限（纯函数，不是"点了才知道"） ───────────────────────── */

test("写权限：admin 可写，lead 只读且给出一句能照抄的理由，未知角色按最低档", () => {
  assert.deepEqual(canWrite("admin"), { enabled: true, reason: "" });
  const lead = canWrite("lead");
  assert.equal(lead.enabled, false, "lead 进知识库是只读");
  assert.match(lead.reason, /admin/, "理由要点名缺哪个角色");
  assert.match(lead.reason, /只读/);
  for (const bad of ["agent", "", null, undefined, "guest"]) {
    assert.equal(canWrite(bad as string).enabled, false, `${String(bad)} 不能写`);
  }
  assert.equal(canWrite(" ADMIN ").enabled, true, "大小写与空白不影响判定");
});

test("写权限：lead 的按钮是禁用 + 一行说明，不是隐藏（隐藏等于让他点了才发现）", () => {
  const form = formFromDetail(DETAIL, LIST_ROW);
  const html = formFieldsHtml(form, []);
  assert.ok(html.includes('data-ak-field="form-title"'), "输入区照常画：只读不等于看不到内容");
  assert.match(formNote(form, "lead"), /admin/, "表单底部要写清为什么不能改");
  assert.match(roleNote("lead"), /只读/);
  assert.match(roleNote("admin"), /可以新建/);
  assert.equal(canWrite("lead").enabled, false, "判据只有这一处：按钮与提示都从它派生");
});

/* ───────────────────────── 表单校验 ───────────────────────── */

test("校验：标题空 / 语言非法 / 正文空各自报错，`message` 只带第一条", () => {
  const blank = validateForm(emptyForm());
  assert.equal(blank.ok, false);
  assert.match(blank.errors.title, /标题/);
  assert.match(blank.errors.body, /正文/);
  assert.equal(blank.errors.lang, undefined, "默认语言是合法的 zh，不该顺带报一条");
  assert.equal(blank.message, blank.errors.title, "一行提示先说最该改的那一处");

  const badLang = validateForm({ title: "标题", lang: "fr", body: "正文" });
  assert.equal(badLang.ok, false);
  assert.match(badLang.errors.lang, /五语/);
  assert.equal(badLang.errors.title, undefined);

  const noBody = validateForm({ title: "标题", lang: "de", body: "   \n\t " });
  assert.equal(noBody.ok, false);
  assert.match(noBody.errors.body, /正文/);

  assert.deepEqual(validateForm({ title: " 标题 ", lang: "DE", body: "正文" }), { ok: true, errors: {}, message: "" });
  assert.equal(validateForm(null).ok, false, "坏输入不抛，按空表单处理");
});

test("请求体：三格归一（去空白、语言小写），产线非空才带", () => {
  assert.deepEqual(createBody({ title: " 保修 ", lang: " DE ", body: "# 正文", product_line: "  " }), {
    title: "保修",
    lang: "de",
    body: "# 正文",
  });
  assert.deepEqual(patchBody({ title: "t", lang: "zh", body: "b", product_line: "balcony" }), {
    title: "t",
    lang: "zh",
    body: "b",
    product_line: "balcony",
  });
  assert.deepEqual(createBody(null), { title: "", lang: "", body: "" }, "缺字段给空串，不给 undefined");
  assert.equal(bodyOf(emptyForm()).lang, "zh");
});

/* ───────────────────────── 重建轮询决策（不真的 setTimeout） ───────────────────────── */

test("轮询决策：running 继续（1.5s 一跳）、ok 停、failed 停、到上限算超时", () => {
  const running = pollDecision("running", 0);
  assert.equal(running.action, "continue");
  assert.equal(running.delayMs, REBUILD_POLL_MS);
  assert.equal(REBUILD_POLL_MS, 1500);

  // idle / 没见过的状态都继续等（后端可能还没把 job 记上），但绝不假装成功
  assert.equal(pollDecision("idle", 1).action, "continue");
  assert.equal(pollDecision("queued", 1).action, "continue");
  assert.equal(pollDecision(undefined, 1).action, "continue");

  assert.equal(pollDecision("ok", 3).action, "stop");
  assert.equal(pollDecision("ok", 3).tone, "ok");
  // 后端作业表里的真词是 `succeeded`（`document_rebuild_jobs.status`）：
  // 只认 `ok` 时，一次真的成功会让面板一直轮询到 60 秒超时并显示"仍在进行"。
  assert.equal(pollDecision("succeeded", 1).action, "stop", "succeeded 也是终态（后端真词）");
  assert.equal(pollDecision("SUCCEEDED", 1).tone, "ok", "大小写不敏感");
  assert.equal(isRebuildDone("succeeded"), true);
  assert.equal(isRebuildDone("ok"), true, "旧契约别名仍然认");
  assert.equal(isRebuildDone("running"), false);
  assert.equal(isRebuildDone(undefined), false);
  assert.equal(rebuildStatus("succeeded").label, "重建完成");
  assert.equal(pollDecision("failed", 1).action, "stop");
  assert.equal(pollDecision("failed", 1).tone, "error");

  const timeout = pollDecision("running", REBUILD_POLL_LIMIT);
  assert.equal(timeout.action, "timeout", "到上限就停：前端不再等，但不说「失败」");
  assert.equal(timeout.tone, "warn");
  assert.match(timeout.message, /仍在进行/);
  assert.match(timeout.message, /60 秒/, "上限换算成秒写在提示里，人要知道自己等了多久");
  assert.equal(pollDecision("running", REBUILD_POLL_LIMIT + 5).action, "timeout", "越过上限也是超时");
  assert.equal(pollDecision("running", 2, 2).action, "timeout", "limit 可覆盖（测试不真等 40 跳）");
});

test("重建结果文案：failed 必须带出后端 error 原文，ok 带块数", () => {
  assert.match(rebuildResultText({ status: "failed", error: "embedding 超时: connection reset" }), /embedding 超时/);
  assert.equal(
    rebuildResultText({ status: "failed", error: "  " }),
    "重建失败（后端没有给出原因）。",
    "没有原文时要说清是「后端没给原因」，不编一个",
  );
  assert.match(rebuildResultText({ status: "ok", chunk_count: 7 }), /7 块/);
  assert.match(rebuildResultText({ status: "ok" }), /重建完成/);
  // FAQ 审批直通建索引：后端没有作业行，合成一条 `succeeded`（`job_id` 为 null）。
  // 这条文案必须说"建好了"，而不是"尚未重建" —— 后者会让用户以为索引没生效。
  const adopted = rebuildResultText({ status: "succeeded", chunk_count: 1, job_id: null });
  assert.match(adopted, /重建完成/);
  assert.match(adopted, /1 块/);
  assert.match(adopted, /审批直通/, "要说清这条索引不是「点重建」点出来的");
  assert.equal(
    rebuildResultText({ status: "succeeded", chunk_count: 1, job_id: "job-9" }).includes("审批直通"),
    false,
    "有 job_id 就是正常重建，不加那句解释",
  );
  assert.match(rebuildResultText({ status: "running" }), /重建中/);
  assert.match(rebuildResultText({ status: "idle" }), /尚未重建/);
  assert.match(rebuildResultText(null), /尚未重建/, "坏输入不抛");
});

test("作业体归一：不认识的 status 原样留着（映射成 idle 会让面板说谎）", () => {
  assert.deepEqual(normalizeRebuild(null), {
    job_id: null,
    status: "idle",
    error: null,
    chunk_count: null,
    started_at: null,
    finished_at: null,
  });
  const running = normalizeRebuild({ status: "RUNNING", job_id: "j1" });
  assert.equal(running.status, "running");
  assert.equal(running.job_id, "j1");
  assert.equal(normalizeRebuild({ status: "queued" }).status, "queued");
  assert.equal(normalizeRebuild({ status: "failed", error: "  boom  " }).error, "boom", "原文去首尾空白");
  assert.equal(normalizeRebuild({ status: "ok", chunk_count: "9" }).chunk_count, 9);
  assert.equal(normalizeRebuild({ status: "ok", chunk_count: "junk" }).chunk_count, null);
});

/* ───────────────────────── 查询串 / 分页 / 错误文案 ───────────────────────── */

test("列表查询：空筛选不发参数，page 规整到 ≥1，size 显式带", () => {
  assert.equal(buildListQuery(DEFAULT_FILTERS, 1), "page=1&size=20");
  assert.equal(buildListQuery({}, 1), "page=1&size=20");
  assert.equal(
    buildListQuery({ status: "indexed", lang: "DE", product_line: " balcony " }, 3),
    "status=indexed&lang=de&product_line=balcony&page=3&size=20",
  );
  assert.equal(buildListQuery({ status: "  ", lang: "" }, 0), "page=1&size=20");
  assert.equal(buildListQuery({}, Number.NaN), "page=1&size=20");
  assert.equal(buildListQuery({}, 2.9), "page=2&size=20", "小数截断而不是四舍五入");
  assert.equal(PAGE_SIZE, 20);
});

test("分页：页数按 PAGE_SIZE 算，越界夹住，按钮禁用与文案用同一个数", () => {
  assert.deepEqual(pageInfo(0, 1), { total: 0, page: 1, pages: 1, hasPrev: false, hasNext: false, text: "第 1 / 1 页 · 共 0 条" });
  const second = pageInfo(PAGE_SIZE + 1, 2);
  assert.equal(second.pages, 2);
  assert.equal(second.hasPrev, true);
  assert.equal(second.hasNext, false);
  const over = pageInfo(120, 9);
  assert.equal(over.page, 6, "翻过头显示最后一页，而不是停在空页上");
  assert.equal(pageInfo("junk", 0).text, "第 1 / 1 页 · 共 0 条");
});

test("错误文案：404 要说「接口还没就绪」（后端并行开发中），403 说权限，原文能带就带", () => {
  assert.match(errorText({ code: "NOT_FOUND" }), /404/);
  assert.match(errorText({ code: "NOT_FOUND" }), /还没就绪/);
  assert.match(errorText({ code: "FORBIDDEN" }), /admin/);
  assert.match(errorText({ code: "AUTH_REQUIRED" }), /重新登录/);
  assert.match(errorText({ code: "NETWORK" }), /连不上/);
  assert.match(errorText({ code: "HTTP_503" }), /服务端出错/);
  assert.equal(errorText({ code: "CONFLICT", message: "版本冲突，请刷新" }), "版本冲突，请刷新", "后端原话优先");
  assert.equal(errorText({ code: "VALIDATION" }), "参数不合法。");
  assert.equal(errorText({ code: "WEIRD", message: "后端原话" }), "后端原话");
  assert.equal(errorText(null), "请求失败。");
});

test("api 适配：信封与裸数据两种挂载都归一成 { ok, data }", async () => {
  assert.deepEqual(await callApi(async () => ({ ok: true, data: { total: 1 } }), "/x"), { ok: true, data: { total: 1 } });
  assert.deepEqual(await callApi(async () => ({ items: [] }), "/x"), { ok: true, data: { items: [] } });
  const thrown = await callApi(async () => {
    throw Object.assign(new Error("no"), { code: "FORBIDDEN" });
  }, "/x");
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error.code, "FORBIDDEN");
  assert.equal((await callApi(null, "/x")).ok, false, "没有 ctx.api 也只回失败，不抛");
});

test("响应形状：items / documents 两种包装与 data / data.document 都认（差一层不打成空白）", () => {
  assert.deepEqual(listItems({ items: [1] }), [1]);
  assert.deepEqual(listItems({ documents: [2] }), [2]);
  assert.deepEqual(listItems({}), []);
  assert.deepEqual(listItems(null), []);
  assert.deepEqual(pickDocument({ id: "a" }), { id: "a" });
  assert.deepEqual(pickDocument({ document: { id: "b" } }), { id: "b" });
  assert.deepEqual(pickDocument(null), {});
});

/* ───────────────────────── HTML 片段 ───────────────────────── */

test("列表行：六列、状态色带、块数与版本格式化，停用行有独立钩子", () => {
  const html = rowsHtml([LIST_ROW], "");
  for (const cell of ["保修条款", "中文", "已建索引", "12", "v2"]) {
    assert.ok(html.includes(cell), `列表要显示 ${cell}`);
  }
  assert.ok(html.includes('data-ak-row="' + DOC_ID + '"'));
  assert.ok(html.includes('data-tone="ok"'));
  assert.equal(html.includes("is-archived"), false);

  const archived = rowsHtml([{ ...LIST_ROW, status: "archived", version: 0, chunk_count: null }], DOC_ID);
  assert.ok(archived.includes("is-archived"), "停用行要有样式钩子（对外等于不存在，但行还在）");
  assert.ok(archived.includes("is-selected"), "选中的那一行也要标出来");
  assert.ok(archived.includes("已停用"));
  assert.ok(archived.includes(">—<"), "版本 0 与缺失的块数显示破折号");
  assert.equal(rowsHtml([], ""), "");
  assert.equal(rowsHtml(null, ""), "");

  assert.equal(chunkText(0), "0", "0 块是真实的（重建过但没切出块），不是「—」");
  assert.equal(chunkText(null), "—");
  assert.equal(chunkText("junk"), "—");
  assert.equal(versionText(3), "v3");
  assert.equal(versionText(0), "—", "版本 0 = 没有可回滚的上一版");
  assert.equal(versionText("x"), "—");
});

test("转义：标题与正文里的标签顶不坏表格与文本域", () => {
  const evilRow = rowsHtml([{ ...LIST_ROW, title: '<img src=x onerror="alert(1)">' }], "");
  assert.equal(evilRow.includes("<img"), false);
  assert.ok(evilRow.includes("&lt;img"));
  const form = formFromDetail({ ...DETAIL, title: '"><script>alert(1)</script>', body: "</textarea><script>x</script>" }, null);
  const html = formFieldsHtml(form, []);
  assert.equal(html.includes("</textarea><script>"), false);
  assert.ok(html.includes("&lt;/textarea&gt;"));
  assert.equal(esc(null), "");
  assert.equal(esc("a & b 'c' \"d\""), "a &amp; b &#39;c&#39; &quot;d&quot;");
});

test("表单输入区：五个语言选项、产线含当前值兜底、正文是 textarea", () => {
  const html = formFieldsHtml(formFromDetail(DETAIL, LIST_ROW), [{ code: "balcony", name: "阳台", active: true }]);
  assert.equal((html.match(/<option /g) ?? []).length, 5 + 2, "语言 5 项 + 产线（不指定 + 阳台）");
  assert.ok(html.includes('<option value="balcony" selected>阳台</option>'));
  assert.ok(html.includes('data-ak-field="form-body"'), "正文是 textarea（markdown 原样保存）");
  assert.ok(html.includes("v2") && html.includes("12 块"), "标题行要写清版本与块数");

  // 文档上的产线不在字典里：补一个选项，否则保存一次就把归属悄悄抹掉了
  const unknown = formFieldsHtml(formFromDetail({ ...DETAIL, product_line: "cni" }, null), [
    { code: "balcony", name: "阳台", active: true },
  ]);
  assert.ok(unknown.includes('<option value="cni" selected>cni（字典里没有）</option>'));
  const stopped = productLineOptions([{ code: "old", name: "旧线", active: false }], "");
  assert.deepEqual(stopped[1], ["old", "旧线（已停用）"]);
  assert.deepEqual(productLineOptions(null, ""), [["", "（不指定产线）"]]);
});

test("详情 → 表单：正文/语言/版本都对上，时间从列表行补（详情契约里没有）", () => {
  const form = formFromDetail(DETAIL, LIST_ROW);
  assert.equal(form.mode, "edit");
  assert.equal(form.id, DOC_ID);
  assert.equal(form.body, DETAIL.body);
  assert.equal(form.updated_at, LIST_ROW.updated_at, "详情不带 updated_at：从列表行补，不编");
  assert.equal(form.rebuild.status, "ok");
  const bare = formFromDetail({}, null);
  assert.equal(bare.lang, "zh", "未知语言回落到第一门");
  assert.equal(bare.status, "pending");
});

test("空表单：新建态、语言默认 zh、状态 pending", () => {
  const form = emptyForm();
  assert.equal(form.mode, "create");
  assert.equal(form.lang, "zh");
  assert.equal(form.status, "pending");
  assert.equal(emptyForm("de").lang, "de");
  assert.equal(emptyForm("fr").lang, "zh", "非法语言回落第一门");
});

/* ───────────────────────── 派发下拉（console-view.js） ───────────────────────── */

const STAFF = [
  { id: "s-zhang", name: "张伟", email: "zhang.wei@wotai.demo", role: "agent", active: true, org_unit: "客服一组" },
  { id: "s-li", name: "李娜", email: "li.na@wotai.demo", role: "lead", active: true, org_unit: "客服一组" },
  { id: "s-gone", name: "王强", email: "admin@wotai.demo", role: "admin", active: false, org_unit: null },
];

test("派发权限：lead/admin 有下拉，agent 没有；已关单不可改", () => {
  const open = { id: 7, status: "open", assignee_id: null };
  assert.equal(view.canDispatch(open, "agent").visible, false, "agent 只能认领自己，没有派发下拉");
  assert.equal(view.canDispatch(open, "lead").visible, true);
  assert.equal(view.canDispatch(open, "admin").visible, true);
  const closed = view.canDispatch({ ...open, status: "closed" }, "lead");
  assert.equal(closed.visible, true, "已关单仍然看得见谁在处理（只是不能改）");
  assert.equal(closed.enabled, false);
  assert.match(closed.reason, /已关单/);
  assert.equal(view.canDispatch(open, "guest").visible, false, "未知角色按最低档");
});

test("派发选项：第一项是「未分配」（值空串），当前指派人被选中，停用账号标出来", () => {
  const options = view.staffOptionsHtml(STAFF, "s-li");
  assert.ok(options.startsWith('<option value=""'), "「未分配」永远第一项");
  assert.ok(options.includes(">未分配</option>"));
  assert.ok(options.includes('<option value="s-li" selected>李娜</option>'));
  assert.equal(options.includes("s-zhang\" selected"), false);
  assert.ok(options.includes("王强（已停用）"), "停用账号仍可选（历史工单上可能就派给了他），但要标出来");

  const unassigned = view.staffOptionsHtml(STAFF, "");
  assert.ok(unassigned.includes('<option value="" selected>未分配</option>'));
  assert.equal(
    view.staffOptionsHtml([], "s-li"),
    '<option value="">未分配</option>',
    "没有人员时只剩「未分配」一项（而且它不会被误标成选中）",
  );
  assert.ok(view.staffOptionsHtml(null, null).includes("未分配"), "人员列表还没回来也只画「未分配」");
});

test("派发选项：姓名里的标签被转义（人员名是外部输入）", () => {
  const html = view.staffOptionsHtml([{ id: "x", name: '<script>alert(1)</script>' }], "");
  assert.equal(html.includes("<script>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
});

test("选中的就是当前指派人 → 不发请求；空值与 null 视为同一件事", () => {
  assert.equal(view.shouldDispatch("s-li", "s-li"), false, "选回原值不该产生一次写操作（审计里会多一条空派发）");
  assert.equal(view.shouldDispatch("", ""), false);
  assert.equal(view.shouldDispatch(null, ""), false, "null 与空串都是「未分配」");
  assert.equal(view.shouldDispatch("s-li", ""), true, "取消指派要发");
  assert.equal(view.shouldDispatch("", "s-li"), true, "从「未分配」派给某人要发");
  assert.equal(view.shouldDispatch("s-li", "s-zhang"), true, "改派要发");
  assert.equal(view.shouldDispatch(undefined, undefined), false);
});

test("派发请求体：空串必须发 null（空串不是 uuid，后端会 400）", () => {
  assert.deepEqual(view.dispatchBody(""), { assignee_id: null });
  assert.deepEqual(view.dispatchBody("s-li"), { assignee_id: "s-li" });
  assert.deepEqual(view.dispatchBody(null), { assignee_id: null });
  assert.equal(view.UNASSIGNED, "");
});

test("actionsHtml：lead/admin 多一块下拉，agent 与从前一字不差；忙时与关单时禁用", () => {
  const ticket = { id: 7, status: "open", assignee_id: "s-zhang" };
  const lead = view.actionsHtml(ticket, "张伟", { role: "lead", staff: STAFF, currentId: "s-zhang", loaded: true });
  assert.ok(lead.includes('data-dispatch="assignee"'), "lead 要有派发下拉");
  assert.ok(lead.includes('<option value="s-zhang" selected>张伟</option>'));
  assert.ok(lead.includes('data-act="claim"'), "认领按钮还在（认领 = 派给自己）");

  const agent = view.actionsHtml(ticket, "张伟", { role: "agent", staff: STAFF, currentId: "s-zhang", loaded: true });
  assert.equal(agent.includes("data-dispatch"), false, "agent 不出下拉");

  const busy = view.actionsHtml(ticket, "张伟", { role: "admin", staff: STAFF, currentId: "s-zhang", loaded: true, busy: true });
  assert.match(busy, /data-dispatch="assignee"[^>]*disabled/);
  assert.ok(busy.includes("正在派发"), "禁用要有理由");

  const closed = view.actionsHtml({ ...ticket, status: "closed" }, "张伟", { role: "lead", staff: STAFF, currentId: "s-zhang", loaded: true });
  assert.match(closed, /data-dispatch="assignee"[^>]*disabled/);
  assert.ok(closed.includes("已关单"));

  const loading = view.actionsHtml(ticket, "", { role: "lead", staff: [], currentId: "", loaded: false });
  assert.match(loading, /data-dispatch="assignee"[^>]*disabled/, "人员列表还没回来：下拉禁用");
  assert.ok(loading.includes("正在加载人员列表"));

  const broken = view.actionsHtml(ticket, "", {
    role: "lead",
    staff: [],
    currentId: "",
    loaded: false,
    error: "人员列表接口还没就绪（404），暂时无法派发",
  });
  assert.ok(broken.includes("暂时无法派发"), "人员列表拿不到：下拉禁用并说明原因");
  assert.match(broken, /data-dispatch="assignee"[^>]*disabled/);

  // 不传 dispatch（老调用点）时行为不变：没有下拉、没有多出来的说明
  const legacy = view.actionsHtml(ticket, "张伟");
  assert.equal(legacy.includes("data-dispatch"), false);
  assert.equal(legacy.includes("正在加载"), false);
});

/* ───────────────────────── 假 DOM（只为跑 mount 生命周期） ───────────────────────── */

function fakeNode(tag = "div"): any {
  const node: any = {
    tagName: String(tag).toUpperCase(),
    className: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    value: "",
    title: "",
    dataset: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    children: [] as any[],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(child: any) {
      node.children.push(child);
      return child;
    },
    replaceChildren(...kids: any[]) {
      node.children = kids;
    },
    setAttribute(name: string, value: string) {
      node.attrs[name] = String(value);
      if (name === "title") node.title = String(value);
    },
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
    },
    removeAttribute(name: string) {
      delete node.attrs[name];
      if (name === "title") node.title = "";
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    listeners: [] as Array<{ type: string; fn: (event: any) => void }>,
    addEventListener(type: string, fn: (event: any) => void) {
      node.listeners.push({ type, fn });
    },
    removeEventListener(type: string, fn: (event: any) => void) {
      node.listeners = node.listeners.filter((entry: any) => !(entry.type === type && entry.fn === fn));
    },
  };
  return node;
}

function fakeHost(): any {
  const host = fakeNode("div");
  host.ownerDocument = { createElement: (tag: string) => fakeNode(tag) };
  return host;
}

/** 展开一棵假节点里的全部文本（`innerHTML` 也算：输入区就是一个 HTML 串）。 */
function textsOf(node: any): string[] {
  const out: string[] = [];
  if (typeof node?.textContent === "string" && node.textContent !== "") out.push(node.textContent);
  if (typeof node?.innerHTML === "string" && node.innerHTML !== "") out.push(node.innerHTML);
  for (const child of node?.children ?? []) out.push(...textsOf(child));
  return out;
}

/** 按 `data-ak-act` 找按钮（卸载/禁用状态的断言要用）。 */
function walk(node: any, out: any[] = []): any[] {
  out.push(node);
  for (const child of node?.children ?? []) walk(child, out);
  return out;
}

function buttonsOf(host: any): Record<string, any> {
  const map: Record<string, any> = {};
  for (const node of walk(host)) {
    const act = node?.dataset?.akAct;
    if (typeof act === "string" && act !== "") map[act] = node;
  }
  return map;
}

/** 假定时器：面板同一时刻只挂一个重建轮询，所以"跑掉唯一那个"就够。 */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const cleared: number[] = [];
  let next = 1;
  return {
    pending,
    cleared,
    setTimeout(fn: () => void, ms: number) {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id: number) {
      cleared.push(id);
      pending.delete(id);
    },
    /** 跑掉唯一一个待触发的定时器，返回它等了多少毫秒（没有就返回 null）。 */
    async flush(): Promise<number | null> {
      const [id, entry] = [...pending.entries()][0] ?? [];
      if (id === undefined || entry === undefined) return null;
      pending.delete(id);
      entry.fn();
      await tick();
      await tick();
      return entry.ms;
    },
  };
}

/** 合成一次点击：`closest` 只认那一个属性选择器（与 reports/board 的测试同法）。 */
function clickEvent(attr: string, attrs: Record<string, string>, extra: Record<string, unknown> = {}) {
  const node = {
    disabled: false,
    getAttribute: (name: string) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    ...extra,
  };
  return { target: { closest: (selector: string) => (selector === `[${attr}]` ? node : null) } };
}

function listenerFor(host: any, type: string) {
  return host.listeners.find((entry: any) => entry.type === type)?.fn ?? null;
}

/* ───────────────────────── mount：列表 → 打开 → 重建 → 轮询失败 ───────────────────────── */

test("mount：两次首屏请求 → 打开文档 → 重建 → 轮询把后端 error 原文显示出来", async () => {
  const host = fakeHost();
  const timers = fakeTimers();
  const calls: string[] = [];
  const toasts: string[] = [];
  let pollCount = 0;

  const api = async (path: string, init: any) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/admin/product-lines") {
      return { ok: true, data: { total: 1, items: [{ code: "balcony", name: "阳台", active: true }] } };
    }
    if (path.startsWith("/api/admin/documents?")) {
      return { ok: true, data: { items: [LIST_ROW], page: 1, size: PAGE_SIZE, total: 1 } };
    }
    if (path === `/api/admin/documents/${DOC_ID}`) return { ok: true, data: DETAIL };
    if (path === `/api/admin/documents/${DOC_ID}/rebuild` && init?.method === "POST") {
      return { ok: true, data: { job_id: "job-1", status: "running" } };
    }
    if (path === `/api/admin/documents/${DOC_ID}/rebuild`) {
      pollCount += 1;
      return {
        ok: true,
        data: {
          job_id: "job-1",
          status: "failed",
          error: "embedding 服务不可用：connect ECONNREFUSED",
          chunk_count: null,
          started_at: "2026-10-27T07:00:00.000Z",
          finished_at: "2026-10-27T07:00:02.000Z",
        },
      };
    }
    throw Object.assign(new Error("unexpected"), { code: "NOT_FOUND" });
  };

  const unmount = mount(host, { api, role: "admin", toast: (m: string) => toasts.push(m), timers });

  assert.equal(typeof unmount, "function");
  await tick();
  await tick();
  assert.deepEqual(calls, [
    "GET /api/admin/product-lines",
    `GET /api/admin/documents?page=1&size=20`,
  ], "先取产线字典，再取列表（默认全部状态）");

  // 打开第一篇：GET 详情，表单出现
  const click = listenerFor(host, "click");
  assert.ok(click !== null, "事件用委托挂在 host 上");
  click(clickEvent("data-ak-row", { "data-ak-row": DOC_ID }));
  await tick();
  await tick();
  assert.ok(calls.includes(`GET /api/admin/documents/${DOC_ID}`));
  const buttons = buttonsOf(host);
  assert.equal(buttons.save.disabled, false, "admin 可写");
  assert.equal(buttons.rebuild.disabled, false);
  assert.ok(textsOf(host).join(" ").includes("十年质保"), "正文进了输入区");

  // 重建：POST 之后挂一跳轮询（1.5s）
  click(clickEvent("data-ak-act", { "data-ak-act": "rebuild" }));
  await tick();
  await tick();
  assert.ok(calls.includes(`POST /api/admin/documents/${DOC_ID}/rebuild`));
  assert.equal(timers.pending.size, 1, "202 running → 挂一跳轮询");
  assert.equal([...timers.pending.values()][0].ms, REBUILD_POLL_MS);

  // 轮询回 failed：停下，并把后端原文显示出来
  const delay = await timers.flush();
  assert.equal(delay, REBUILD_POLL_MS);
  assert.equal(pollCount, 1);
  const text = textsOf(host).join(" ");
  assert.ok(text.includes("ECONNREFUSED"), `failed 必须显示后端 error 原文，实际：${text.slice(0, 400)}`);
  assert.ok(text.includes("重建失败"));
  assert.equal(timers.pending.size, 0, "failed 之后不再轮询（再跳一万次也还是这个错）");
  assert.equal(toasts.some((m: string) => m.includes("重建仍在进行")), false, "没超时就不该说「仍在进行」");
  assert.equal(toasts.some((m: string) => m.includes("重建完成")), false, "失败不是完成");

  // 卸载：监听器摘干净、内容清空
  unmount();
  assert.equal(host.listeners.length, 0, "四个监听器全部摘掉");
  assert.deepEqual(host.children, [], "内容清空，host 还原成空 div");
});

test("mount：卸载会把还在等的重建轮询停掉（不留定时器）", async () => {
  const host = fakeHost();
  const timers = fakeTimers();
  const api = async (path: string, init: any) => {
    if (path === "/api/admin/product-lines") return { ok: true, data: { items: [] } };
    if (path.startsWith("/api/admin/documents?")) return { ok: true, data: { items: [LIST_ROW], total: 1 } };
    if (path === `/api/admin/documents/${DOC_ID}`) return { ok: true, data: DETAIL };
    if (init?.method === "POST") return { ok: true, data: { job_id: "j", status: "running" } };
    return { ok: true, data: { job_id: "j", status: "running" } };
  };
  const unmount = mount(host, { api, role: "admin", toast: () => {}, timers });
  await tick();
  await tick();

  listenerFor(host, "click")(clickEvent("data-ak-row", { "data-ak-row": DOC_ID }));
  await tick();
  await tick();
  listenerFor(host, "click")(clickEvent("data-ak-act", { "data-ak-act": "rebuild" }));
  await tick();
  await tick();
  assert.equal(timers.pending.size, 1, "轮询挂着");

  unmount();
  assert.equal(timers.pending.size, 0, "卸载必须 clearTimeout，否则定时器活到刷新页面");
  assert.equal(timers.cleared.length, 1, "清掉的正是那一个");
});

test("mount：接口 404 / 网络错只渲染空态说明，不抛也不白屏", async () => {
  for (const code of ["NOT_FOUND", "NETWORK"]) {
    const host = fakeHost();
    const toasts: string[] = [];
    const api = async () => ({ ok: false, error: { code, message: "boom" } });
    let unmount: any = null;
    assert.doesNotThrow(() => {
      unmount = mount(host, { api, role: "lead", toast: (m: string) => toasts.push(m) });
    });
    await tick();
    await tick();
    const text = textsOf(host).join(" ");
    assert.ok(text.includes(EMPTY_TEXT.unavailable), `${code}：空态要说清是「接口不在」，不是「你没有文档」`);
    assert.ok(text.includes(errorText({ code })), `${code}：状态行要写清原因`);
    assert.equal(toasts.length >= 1, true, "失败弹一次提示（骨架的 401/403 口径之外，面板自己说一句）");
    assert.doesNotThrow(() => unmount());
  }
});

test("mount：标题空就点保存 → 只有一句报错，一个写请求都不发", async () => {
  const host = fakeHost();
  const calls: string[] = [];
  const toasts: string[] = [];
  const api = async (path: string, init: any) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/admin/product-lines") return { ok: true, data: { items: [] } };
    return { ok: true, data: { items: [], total: 0 } };
  };
  const unmount = mount(host, { api, role: "admin", toast: (m: string) => toasts.push(m), timers: fakeTimers() });
  await tick();
  await tick();
  const before = calls.length;

  listenerFor(host, "click")(clickEvent("data-ak-act", { "data-ak-act": "new" }));
  await tick();
  listenerFor(host, "click")(clickEvent("data-ak-act", { "data-ak-act": "save" }));
  await tick();
  await tick();

  assert.equal(calls.length, before, "校验没过就不许发请求（POST 空标题只会换回 400）");
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /标题不能为空/);
  unmount();
});

test("mount：lead 打开文档是只读 —— 写按钮全禁用，说明里点名 admin", async () => {
  const host = fakeHost();
  const api = async (path: string) => {
    if (path === "/api/admin/product-lines") return { ok: true, data: { items: [] } };
    if (path.startsWith("/api/admin/documents?")) return { ok: true, data: { items: [LIST_ROW], total: 1 } };
    return { ok: true, data: DETAIL };
  };
  const unmount = mount(host, { api, role: "lead", toast: () => {}, timers: fakeTimers() });
  await tick();
  await tick();
  listenerFor(host, "click")(clickEvent("data-ak-row", { "data-ak-row": DOC_ID }));
  await tick();
  await tick();

  const buttons = buttonsOf(host);
  for (const act of ["save", "rebuild", "archive"]) {
    assert.equal(buttons[act].disabled, true, `lead 的 ${act} 必须禁用（不是隐藏后点了 403）`);
  }
  assert.match(buttons.save.title ?? "", /admin/, "禁用要说清缺哪个角色");
  const text = textsOf(host).join(" ");
  assert.ok(text.includes("需要管理员（admin）角色"), `表单底部要写清为什么不能改，实际：${text.slice(0, 300)}`);
  unmount();
});

test("mount：新建成功但响应没带 id → 不假装拿到文档，回列表并说清", async () => {
  const host = fakeHost();
  const calls: string[] = [];
  const toasts: string[] = [];
  const api = async (path: string, init: any) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/admin/product-lines") return { ok: true, data: { items: [] } };
    if (path.startsWith("/api/admin/documents?")) return { ok: true, data: { items: [], total: 0 } };
    if (path === "/api/admin/documents" && init?.method === "POST") return { ok: true, data: {} };
    return { ok: true, data: {} };
  };
  const unmount = mount(host, { api, role: "admin", toast: (m: string) => toasts.push(m), timers: fakeTimers() });
  await tick();
  await tick();

  const input = (field: string, value: string) => ({
    target: { value, getAttribute: (name: string) => (name === "data-ak-field" ? field : null) },
  });
  listenerFor(host, "click")(clickEvent("data-ak-act", { "data-ak-act": "new" }));
  await tick();
  listenerFor(host, "input")(input("form-title", "新文档"));
  listenerFor(host, "input")(input("form-body", "# 正文"));
  listenerFor(host, "click")(clickEvent("data-ak-act", { "data-ak-act": "save" }));
  await tick();
  await tick();

  assert.ok(calls.includes("POST /api/admin/documents"), "校验通过就该真的发 POST");
  assert.equal(calls.some((call) => call.startsWith("PATCH")), false, "没有 id 就不该出现 PATCH /documents/ 这种 404 请求");
  const form = walk(host).find((node) => node.className === "ak-form");
  assert.equal(form.hidden, true, "表单收起来：留一个 id 为空的编辑态会让下一次保存打到 404 上");
  assert.ok(toasts.some((m: string) => m.includes("没带文档 id")), `提示要说清为什么回列表，实际：${toasts.join(" / ")}`);
  unmount();
});

test("mount：回滚与停用要二次确认，取消就一个请求都不发", async () => {
  const host = fakeHost();
  const calls: string[] = [];
  const api = async (path: string, init: any) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/admin/product-lines") return { ok: true, data: { items: [] } };
    if (path.startsWith("/api/admin/documents?")) return { ok: true, data: { items: [LIST_ROW], total: 1 } };
    return { ok: true, data: DETAIL };
  };
  const unmount = mount(host, { api, role: "admin", toast: () => {}, timers: fakeTimers() });
  await tick();
  await tick();
  listenerFor(host, "click")(clickEvent("data-ak-row", { "data-ak-row": DOC_ID }));
  await tick();
  await tick();
  const before = calls.length;

  const original = (globalThis as any).confirm;
  try {
    (globalThis as any).confirm = () => false;
    for (const act of ["rollback", "archive"]) {
      listenerFor(host, "click")(clickEvent("data-ak-act", { "data-ak-act": act }));
      await tick();
      await tick();
    }
    assert.equal(calls.length, before, "取消确认之后不许发请求（回滚/停用都是破坏性动作）");

    (globalThis as any).confirm = () => true;
    listenerFor(host, "click")(clickEvent("data-ak-act", { "data-ak-act": "rollback" }));
    await tick();
    await tick();
    assert.ok(calls.includes(`POST /api/admin/documents/${DOC_ID}/rollback`), "确认之后才真的回滚");
  } finally {
    if (original === undefined) delete (globalThis as any).confirm;
    else (globalThis as any).confirm = original;
  }
  unmount();
});

test("mount：只有一版索引（version=1）时回滚按钮禁用并说明原因；有两版才开", async () => {
  // 版本从 1 开始，回滚目标是 `version - 1` → `version = 1` 时目标 0 不存在。
  // FAQ 审批直通建索引的文档永远是 v1，旧的 `version > 0` 判据会给一个点了必然 409 的按钮。
  const openWith = async (version: number) => {
    const host = fakeHost();
    const api = async (path: string) => {
      if (path === "/api/admin/product-lines") return { ok: true, data: { items: [] } };
      if (path.startsWith("/api/admin/documents?")) return { ok: true, data: { items: [{ ...LIST_ROW, version }], total: 1 } };
      return { ok: true, data: { ...DETAIL, version } };
    };
    const unmount = mount(host, { api, role: "admin", toast: () => {}, timers: fakeTimers() });
    await tick();
    await tick();
    listenerFor(host, "click")(clickEvent("data-ak-row", { "data-ak-row": DOC_ID }));
    await tick();
    await tick();
    return { host, buttons: buttonsOf(host), unmount };
  };

  const first = await openWith(1);
  assert.equal(first.buttons.rollback?.disabled, true, "v1 没有可回滚的上一版");
  assert.match(String(first.buttons.rollback?.title ?? ""), /还没有可回滚的上一版/);
  first.unmount();

  const second = await openWith(2);
  assert.equal(second.buttons.rollback?.disabled, false, "v2 的上一版是 v1，可以回滚");
  second.unmount();
});

test("mount：host 不合法时返回 no-op 卸载函数，绝不抛", () => {
  for (const bad of [null, undefined, 42, "div", {}, { appendChild: () => {} }]) {
    const unmount = mount(bad as any, {});
    assert.equal(typeof unmount, "function", `host=${String(bad)} 也要给出可调用的卸载函数`);
    assert.doesNotThrow(() => unmount());
  }
});

/* ───────────────────────── 静态断言（反回归） ───────────────────────── */

test("静态：知识库模块顶层不碰宿主全局对象、不发请求，语言名取自 lang.js", async () => {
  const source = await readFile(join(STATIC_DIR, "lib", "console-admin-kb.js"), "utf8");

  // DOM 只经由 host 走：`doc = host.ownerDocument`（node 里 import 不炸的前提）
  assert.doesNotMatch(source, /\bwindow\./, "不许读宿主全局对象");
  assert.doesNotMatch(source, /\bglobalThis\.document\b/, "文档对象只能从 host 拿（host.ownerDocument）");
  assert.match(source, /host\.ownerDocument/, "面板必须从宿主节点取文档对象");
  assert.doesNotMatch(source, /\blocalStorage\b/, "不许碰票据存储");
  assert.doesNotMatch(source, /\bfetch\s*\(/, "不许自己发请求：票据与 401 处理都在 ctx.api 里");
  assert.doesNotMatch(source, /\brequire\s*\(/, "不许走 CommonJS 旁路");
  assert.doesNotMatch(source, /\bconsole\.(log|warn|error|info)\b/, "不许打日志（页面有自己的提示层）");

  assert.match(source, /import \{ LANG_NAMES, SUPPORTED_LANGS \} from "\.\/lang\.js"/, "母语名必须复用 lang.js");
  assert.doesNotMatch(source, /LANG_NAMES\s*=\s*\{/, "不许在前端抄第二份母语名表");
});

test("静态：导出面固定（挂载方只依赖 mount，其余是给测试与复用用的纯函数）", async () => {
  for (const name of [
    "mount",
    "buildListQuery",
    "pageInfo",
    "canWrite",
    "roleNote",
    "validateForm",
    "createBody",
    "patchBody",
    "bodyOf",
    "emptyForm",
    "formFromDetail",
    "normalizeRebuild",
    "rebuildResultText",
    "pollDecision",
    "docStatus",
    "rebuildStatus",
    "langLabel",
    "langOptions",
    "chunkText",
    "versionText",
    "productLineOptions",
    "formFieldsHtml",
    "formNote",
    "filtersHtml",
    "rowsHtml",
    "errorText",
    "callApi",
    "listItems",
    "pickDocument",
    "esc",
    "formatStamp",
  ]) {
    assert.equal(typeof kb[name], "function", `必须导出 ${name}`);
  }
  assert.equal(typeof kb.default, "function", "骨架两种写法都认，default 也要有");
  assert.equal(PAGE_SIZE, 20);
  assert.equal(REBUILD_POLL_MS, 1500);
  assert.equal(REBUILD_POLL_LIMIT, 40);
  assert.deepEqual(Object.keys(DEFAULT_FILTERS).sort(), ["lang", "product_line", "status"]);
  // 面板的样式自包含（`.ak` 前缀 + 内联 <style>）：`console.css` 不必为它加一行，
  // 也不会误伤别人前缀下的规则（`.af` 是故障卡、`.admin-report` 是待审反馈）。
  const source = await readFile(join(STATIC_DIR, "lib", "console-admin-kb.js"), "utf8");
  assert.ok(!/\.af-|admin-report/.test(source), "知识库面板不许引用别的面板的类名");
});

test("静态：console.js 的派发接线 —— 下拉变化才发 PATCH，判定复用 console-view 的纯函数", async () => {
  const consoleSource = await readFile(join(STATIC_DIR, "console.js"), "utf8");
  const viewSource = await readFile(join(STATIC_DIR, "lib", "console-view.js"), "utf8");

  assert.match(consoleSource, /canDispatch/, "console.js 必须 import canDispatch（角色判定不许在控制器里再写一份）");
  assert.match(consoleSource, /shouldDispatch/, "'选中值等于当前指派人就不发请求' 这条判定必须来自纯函数");
  assert.match(consoleSource, /dispatchBody/, "请求体由 console-view 生成（空串 → null 只写一遍）");
  assert.match(consoleSource, /dataset\?\.dispatch === "assignee"/, "下拉的 change 事件按 data-dispatch 认");
  assert.match(consoleSource, /staffLoaded/, "人员列表要缓存（一个班次取一次）");
  assert.match(consoleSource, /api\("\/api\/admin\/staff"\)/, "人员列表来自 /api/admin/staff");
  assert.match(viewSource, /data-dispatch="assignee"/, "下拉的标记在 console-view 里生成（纯字符串）");
  assert.match(viewSource, /assignee_id: value === "" \? null : value/, "空串必须映射成 null");
});
