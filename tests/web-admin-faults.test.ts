/**
 * 故障卡管理面板（`09#04` 的可见交付物）的纯逻辑断言。
 *
 * 面板本身是 DOM 那一层，但**错的地方都不在 DOM**：判"这门语齐了没"的判据、发布按钮该不该亮、
 * 筛选串该长什么样、请求体里的空串要不要变 null —— 这些一旦与后端口径漂一寸，界面上表现成
 * "看着能点，点了 409"或者"面板 5/5，用户读到的却是英文回退"。所以把这些判定都抽成导出纯函数，
 * 在这里逐条钉住；最后一条静态断言保证这个模块**顶层不碰宿主对象**（否则 node 里根本 import 不进来）。
 *
 * 前端模块是 `.js`（浏览器直接跑），本仓库 tsconfig 没开 `allowJs`，所以用**非字面量**动态 import
 * 绕开类型解析（`web-lib` / `web-fault` 已经是这个口径）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (name: string): Promise<any> => import(`../src/static/lib/${name}.js`);

const faults = await load("console-admin-faults");

const {
  LANGS,
  LANG_LABEL,
  DEFAULT_FILTERS,
  PAGE_SIZE,
  esc,
  formatStamp,
  statusLabel,
  faultKey,
  parseFaultKey,
  tabState,
  langCompleteness,
  completenessText,
  canCreate,
  canSave,
  canPublish,
  canArchive,
  formNote,
  errorText,
  callApi,
  emptyForm,
  formFromDetail,
  createBody,
  patchBody,
  buildListQuery,
  pageInfoText,
  filtersHtml,
  rowsHtml,
  formHtml,
  mount,
} = faults;

/* ───────────────────── 夹具 ───────────────────── */

/** 服务端的列表行（不带正文，只有 `complete_langs`）。 */
const LIST_ROW = {
  code: "E03",
  product_line: "balcony",
  severity: "warn",
  status: "published",
  lang_count: 3,
  complete_langs: ["zh", "en", "de"],
  missing_langs: ["nl", "es"],
  created_at: "2026-10-26T02:00:00.000Z",
  updated_at: "2026-10-27T07:04:00.000Z",
};

/** 「只有中英」的草稿（后端允许落这种 draft；发布时会被 409 挡回来）。 */
const ZH_EN = {
  code: "E99",
  product_line: "balcony",
  severity: "fatal",
  status: "draft",
  desc: { zh: "电压异常", en: "Voltage fault" },
  act: { zh: "断电重启", en: "Power cycle" },
};

/** 五语齐全的草稿（可以发布）。 */
const FULL = {
  code: "E99",
  product_line: "balcony",
  severity: "fatal",
  status: "draft",
  desc: { zh: "电压异常", en: "Voltage fault", de: "Spannungsfehler", nl: "Spanningsfout", es: "Fallo de tensión" },
  act: { zh: "断电重启", en: "Power cycle", de: "Neustart", nl: "Herstarten", es: "Reiniciar" },
};

/* ───────────────────── 语言完整度（与后端同一条判据） ───────────────────── */

test("完整度：列表行只带 complete_langs 时按它算，顺序仍是五语顺序", () => {
  const result = langCompleteness(LIST_ROW);
  assert.equal(result.count, 3);
  assert.deepEqual(result.complete, ["zh", "en", "de"]);
  assert.deepEqual(result.missing, ["nl", "es"], "缺语列表的顺序由 LANGS 决定，不由后端数组顺序决定");
  assert.equal(result.count + result.missing.length, LANGS.length, "complete 与 missing 必须互补");
});

test("完整度：有正文时以正文为准（表单里刚补上的那门语必须立刻变齐）", () => {
  const mixed = {
    ...LIST_ROW,
    // 服务端此刻的结论是 3/5，但用户刚把 nl 的 desc/act 都补上了：红点必须当场消失
    desc: { nl: "Spanning" },
    act: { nl: "Herstart" },
  };
  const result = langCompleteness(mixed);
  assert.deepEqual(result.complete, ["nl"], "正文优先：只剩 nl 一门语写全了");
  assert.equal(result.count, 1);
});

test("完整度：空白串不算写了（与后端 nullif(btrim(x),'') 同口径）", () => {
  const blank = {
    code: "E98",
    status: "draft",
    desc: { zh: "含义", en: "meaning", de: "   " },
    act: { zh: "步骤", en: "steps", de: "\n\t " },
  };
  const result = langCompleteness(blank);
  assert.deepEqual(result.complete, ["zh", "en"]);
  assert.deepEqual(result.missing, ["de", "nl", "es"], "德语两列都是空白串，不能算齐全");
  assert.equal(result.count, 2);
});

test("完整度：只有 desc 没 act 也算缺（两列都要写）", () => {
  const half = tabState({ desc: { zh: "只有含义" }, act: { zh: "" } })[0];
  assert.equal(half.hasDesc, true);
  assert.equal(half.hasAct, false);
  assert.equal(half.complete, false, "含义写了、处理步骤没写，用户读到的是一条没头没尾的答复");
});

test("完整度：坏输入不抛，退化成 0/5", () => {
  for (const garbage of [null, undefined, {}, "E03", 42, []]) {
    const result = langCompleteness(garbage);
    assert.equal(result.count, 0, `坏输入必须退化成 0：${JSON.stringify(garbage)}`);
    assert.deepEqual(result.missing, [...LANGS]);
  }
});

test("Tab 状态：五项、顺序与母语名固定，缺语的那一项要被标出来", () => {
  const tabs = tabState(ZH_EN);
  assert.deepEqual(
    tabs.map((tab: any) => tab.lang),
    ["zh", "en", "de", "nl", "es"],
    "Tab 顺序 = 后端 FAULT_TEXT_LANGS 的顺序，前端不重排",
  );
  assert.deepEqual(
    tabs.map((tab: any) => tab.label),
    ["中文", "English", "Deutsch", "Nederlands", "Español"],
  );
  assert.deepEqual(
    tabs.map((tab: any) => tab.complete),
    [true, true, false, false, false],
  );
  assert.equal(LANG_LABEL.es, "Español", "母语名自显，不能写成 Spanish");
  assert.deepEqual([...LANGS], ["zh", "en", "de", "nl", "es"]);
});

test("完整度文案：缺语时点名缺哪几门（发布按钮的理由要能照抄）", () => {
  assert.equal(completenessText(ZH_EN), "语言完整度 2/5（还缺 de、nl、es，发布前必须补齐）");
  assert.equal(completenessText(FULL), "语言完整度 5/5（五语齐全）");
});

/* ───────────────────── 发布 / 保存 / 归档的门槛 ───────────────────── */

test("发布：lead 看不见，admin 看得见但五语不齐时禁用并点名缺语", () => {
  assert.equal(canPublish(ZH_EN, "lead").visible, false, "发布是 admin 的签字，lead 连按钮都不该看到");
  const blocked = canPublish(ZH_EN, "admin");
  assert.equal(blocked.visible, true);
  assert.equal(blocked.enabled, false);
  for (const lang of ["de", "nl", "es"]) {
    assert.match(blocked.reason, new RegExp(lang), `理由要点名缺 ${lang}`);
  }
});

test("发布：五语齐全的 draft 才亮；published 已发过、archived 不能发", () => {
  assert.equal(canPublish(FULL, "admin").enabled, true);
  const published = canPublish({ ...FULL, status: "published" }, "admin");
  assert.equal(published.visible, true);
  assert.equal(published.enabled, false, "重复发布是幂等的，但按钮点它没有意义");
  assert.match(published.reason, /已经/);
  assert.equal(canPublish({ ...FULL, status: "archived" }, "admin").visible, false, "归档是终点");
});

test("发布：码不合对外判形时不放行（发布了用户也查不到的码就是假发布）", () => {
  const weird = canPublish({ ...FULL, code: "e99" }, "admin");
  assert.equal(weird.enabled, false);
  assert.match(weird.reason, /判形/);
});

test("发布：列表行（只有 complete_langs）与详情（有正文）结论必须一致", () => {
  const fromList = { code: "E03", status: "draft", complete_langs: ["zh", "en", "de", "nl", "es"], missing_langs: [] };
  const fromDetail = { ...FULL, code: "E03" };
  assert.equal(canPublish(fromList, "admin").enabled, true);
  assert.equal(canPublish(fromDetail, "admin").enabled, true);
  const fromListShort = { code: "E03", status: "draft", complete_langs: ["zh", "en"], missing_langs: ["de", "nl", "es"] };
  assert.equal(canPublish(fromListShort, "admin").enabled, false);
  assert.equal(canPublish(ZH_EN, "admin").enabled, false);
});

test("保存：draft/published 都能改，archived 不能改", () => {
  assert.equal(canSave({ status: "draft" }, "lead").enabled, true);
  assert.equal(canSave({ status: "published" }, "lead").enabled, true, "发布态可以改，改完落回草稿");
  const archived = canSave({ status: "archived" }, "admin");
  assert.equal(archived.visible, false);
  assert.match(archived.reason, /已归档/);
  assert.equal(canSave({ status: "draft" }, "agent").visible, false, "坐席（agent）不开这张卡");
});

test("归档：只有 admin 且行还没归档", () => {
  assert.equal(canArchive({ status: "draft" }, "admin").enabled, true);
  assert.equal(canArchive({ status: "published" }, "admin").enabled, true);
  assert.equal(canArchive({ status: "draft" }, "lead").visible, false);
  assert.equal(canArchive({ status: "archived" }, "admin").visible, false);
});

test("新建：lead 与 admin 都能建，未知角色看不到", () => {
  assert.equal(canCreate("lead").enabled, true);
  assert.equal(canCreate("admin").enabled, true);
  assert.equal(canCreate("agent").visible, false);
  assert.equal(canCreate(undefined).visible, false);
});

test("表单提示：一次只说最该做的那件事", () => {
  assert.match(formNote(ZH_EN, "admin"), /补齐 de、nl、es/);
  assert.match(formNote(FULL, "admin"), /可以发布/);
  assert.match(formNote({ ...FULL, status: "published" }, "admin"), /落回草稿/);
  assert.match(formNote(ZH_EN, "lead"), /管理员/, "lead 看到的是权限说明，不是'你去补语'");
  assert.match(formNote({ ...FULL, status: "archived" }, "admin"), /已归档/);
});

/* ───────────────────── 请求体与查询串 ───────────────────── */

test("新建体：空串变 null（缺语只有 NULL 一种形状）、码大写、不带 status", () => {
  const form = emptyForm("balcony");
  form.code = " e99 ";
  form.desc.zh = " 电压异常 ";
  form.desc.en = "   ";
  form.act.zh = "断电重启";
  form.severity = "fatal";
  const body = createBody(form);

  assert.equal(body.code, "E99");
  assert.equal(body.product_line, "balcony");
  assert.equal(body.desc.zh, "电压异常", "去首尾空白");
  assert.equal(body.desc.en, null, "空白串必须变 null，否则库里多出第二种'缺语'形状");
  assert.equal(body.act.nl, null);
  assert.equal(body.severity, "fatal");
  assert.deepEqual(Object.keys(body).sort(), ["act", "code", "desc", "product_line", "severity"]);
  assert.equal("status" in body, false, "新建一律落 draft，客户端连表达'直接发布'的机会都没有");
});

test("编辑体：不带 code/product_line（它们在 URL 上），严重度为空时显式发 null", () => {
  const form = formFromDetail({ ...FULL, severity: null });
  const body = patchBody(form);
  assert.deepEqual(Object.keys(body).sort(), ["act", "desc", "severity"], "severity 一列必须出现（三态靠键在不在区分）");
  assert.equal(body.severity, null, "「（未设置）」= 显式 null（清空），不是省略（省略 = 不改，面板上就是假成功）");
  assert.equal("code" in body, false);
  assert.equal("product_line" in body, false);
  assert.equal(patchBody({ ...form, severity: "warn" }).severity, "warn");
});

test("详情 → 表单：十列都变成字符串、不复制服务端的 complete_langs", () => {
  const form = formFromDetail({
    code: "E03",
    product_line: "balcony",
    severity: null,
    status: "published",
    desc: { zh: "电压异常" },
    act: { en: "Power cycle" },
    complete_langs: ["zh", "en", "de", "nl", "es"],
    lang_count: 5,
  });
  assert.equal(form.mode, "edit");
  assert.equal(form.severity, "", "severity 为 NULL 时给空串，选择框才不会有幽灵值");
  assert.deepEqual(Object.keys(form.desc), ["zh", "en", "de", "nl", "es"]);
  assert.equal(form.desc.es, "");
  assert.equal("complete_langs" in form, false, "带过来就会让刚补完的 Tab 一直挂着红点");
  assert.equal(langCompleteness(form).count, 0, "服务端说 5/5，但正文里只有 zh 的 desc：以正文为准");
  assert.equal(formFromDetail({}, "de").activeTab, "de");
  assert.equal(formFromDetail({}, "fr").activeTab, "zh", "未知 Tab 回落到第一门语");
});

test("列表查询：默认排除已归档，空筛选不发参数，page 规整到 ≥1", () => {
  assert.equal(buildListQuery(DEFAULT_FILTERS, 1), "status=draft%2Cpublished&page=1");
  assert.equal(buildListQuery({}, 1), "status=draft%2Cpublished&page=1", "缺省即'未归档'");
  assert.equal(buildListQuery({ status: "" }, 1), "page=1", "status 置空 = 全部状态，不出现该键");
  assert.equal(
    buildListQuery({ product_line: "balcony", severity: "warn", status: "archived", missing_lang: true }, 3),
    "product_line=balcony&severity=warn&status=archived&missing_lang=true&page=3",
  );
  assert.equal(buildListQuery({ status: "", product_line: "  " }, 1), "page=1", "空白产线不发");
  assert.equal(buildListQuery({ status: "" }, 0), "page=1");
  assert.equal(buildListQuery({ status: "" }, -3), "page=1");
  assert.equal(buildListQuery({ status: "" }, Number.NaN), "page=1");
  assert.equal(buildListQuery({ status: "" }, 2.9), "page=2", "小数截断而不是四舍五入");
  assert.equal(buildListQuery({ status: "", missing_lang: false }, 1), "page=1", "不勾'只有缺语'就不发该键");
});

test("分页文案：页数按 PAGE_SIZE 算，越界夹住", () => {
  assert.equal(pageInfoText(0, 1), "第 1 / 1 页 · 共 0 条");
  assert.equal(pageInfoText(51, 2), "第 2 / 2 页 · 共 51 条");
  assert.equal(pageInfoText(PAGE_SIZE, 1), "第 1 / 1 页 · 共 50 条");
  assert.equal(pageInfoText(PAGE_SIZE + 1, 1), "第 1 / 2 页 · 共 51 条");
  assert.equal(pageInfoText(120, 9), "第 3 / 3 页 · 共 120 条", "翻过头了显示最后一页，而不是空页");
  assert.equal(pageInfoText("junk", 0), "第 1 / 1 页 · 共 0 条");
});

/* ───────────────────── 转义（别人填的内容会进 DOM） ───────────────────── */

test("转义：列表行的码与产线里出现标签也顶不坏表结构", () => {
  const html = rowsHtml(
    [
      {
        code: '<img src=x onerror="alert(1)">',
        product_line: "</td><td>evil",
        status: "draft",
        severity: "warn",
        complete_langs: ["zh"],
        updated_at: "2026-10-27T07:04:00.000Z",
      },
    ],
    "",
  );
  assert.equal(html.includes("<img"), false, "原样的标签不许出现");
  assert.equal(html.includes("</td><td>evil"), false);
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("&quot;alert(1)&quot;"));
});

test("转义：文本域里写 </textarea> 不会提前闭合，五行字面量与引号同样处理", () => {
  const html = formHtml(
    {
      mode: "edit",
      code: "E03",
      product_line: "balcony",
      severity: "warn",
      status: "draft",
      activeTab: "zh",
      desc: { zh: "</textarea><script>alert(1)</script>" },
      act: { zh: "a & b 'c' \"d\" <e>" },
    },
    "admin",
    [],
  );
  assert.equal(html.includes("</textarea><script>"), false);
  assert.ok(html.includes("&lt;/textarea&gt;"));
  assert.ok(html.includes("&amp;") && html.includes("&#39;") && html.includes("&quot;"), "五类字符各转一次");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
});

/* ───────────────────── 表单与列表片段的结构 ───────────────────── */

test("表单：五个 Tab、每语两个文本域、缺语 Tab 带 missing 标记", () => {
  const html = formHtml(ZH_EN, "admin", [{ code: "balcony", name: "阳台", active: true }]);
  assert.equal((html.match(/data-af-tab="/g) ?? []).length, 5, "五个 Tab 一个不少");
  assert.equal((html.match(/data-af-kind="desc"/g) ?? []).length, 5, "含义：五语各一个文本域");
  assert.equal((html.match(/data-af-kind="act"/g) ?? []).length, 5, "处理步骤：五语各一个文本域");
  // Tab 的圆点与逐个面板的提示都带 data-state，所以要在 Tab 那一截里数（面板那一截下面单独数）
  const tabList = html.slice(0, html.indexOf('<div class="af-panes">'));
  const panes = html.slice(html.indexOf('<div class="af-panes">'));
  assert.equal((tabList.match(/data-state="missing"/g) ?? []).length, 3, "de/nl/es 三门缺语的 Tab 要标出来");
  assert.equal((tabList.match(/data-state="complete"/g) ?? []).length, 2);
  assert.ok(tabList.includes("发布前必须补齐"), "缺语的 Tab 上要有这句提示（title）");
  assert.equal((panes.match(/data-state="missing"/g) ?? []).length, 3, "每门缺语的正文区也要给一句'还缺什么'");
  assert.ok(html.includes("语言完整度 2/5"));
});

test("表单：动作按钮按角色与状态显隐（按钮隐藏只是免挫败，接口层仍会再判）", () => {
  const adminFull = formHtml(FULL, "admin", []);
  assert.ok(adminFull.includes('data-af-act="save"'));
  assert.ok(adminFull.includes('data-af-act="publish"'));
  assert.ok(adminFull.includes('data-af-act="archive"'));

  const leadHtml = formHtml(ZH_EN, "lead", []);
  assert.ok(leadHtml.includes('data-af-act="save"'), "lead 能编辑");
  assert.equal(leadHtml.includes('data-af-act="publish"'), false, "lead 看不到发布");
  assert.equal(leadHtml.includes('data-af-act="archive"'), false, "lead 看不到归档");

  const blockedPublish = formHtml(ZH_EN, "admin", []);
  assert.ok(blockedPublish.includes('data-af-act="publish" disabled'), "admin 看得见但缺语时禁用");
  assert.match(blockedPublish, /data-af-act="publish" disabled title="还缺 de、nl、es/);

  const archivedHtml = formHtml({ ...FULL, status: "archived" }, "admin", []);
  assert.equal(archivedHtml.includes('data-af-act="save"'), false, "归档行不显示保存");
  assert.equal(archivedHtml.includes('data-af-act="publish"'), false, "归档行不显示发布");
  assert.equal(archivedHtml.includes('data-af-act="archive"'), false);
  assert.ok(archivedHtml.includes("已归档"));
  assert.ok(archivedHtml.includes("readonly"), "归档行的正文只读，但可以选中复制");
});

test("表单：新建模式才给码输入框与产线下拉，编辑模式显示静态主键", () => {
  const createHtml = formHtml(emptyForm("balcony"), "lead", [
    { code: "balcony", name: "阳台", active: true },
    { code: "old", name: "旧线", active: false },
  ]);
  assert.ok(createHtml.includes('data-af-field="form-code"'));
  assert.ok(createHtml.includes('data-af-field="form-product-line"'));
  assert.ok(createHtml.includes("阳台"));
  assert.equal(createHtml.includes("旧线"), false, "停用的产线不该出现在新建下拉里");

  const editHtml = formHtml(FULL, "lead", []);
  assert.equal(editHtml.includes('data-af-field="form-code"'), false, "编辑态改码等于换一条行，不做");
  assert.ok(editHtml.includes('<span class="af-static af-code-static">E99</span>'));
});

test("筛选：产线含停用标记、默认状态是'未归档'、新建按钮对 agent 禁用", () => {
  const html = filtersHtml(
    [
      { code: "balcony", name: "阳台", active: true },
      { code: "old", name: "旧线", active: false },
    ],
    DEFAULT_FILTERS,
    "lead",
  );
  assert.ok(html.includes("旧线（已停用）"), "管理端要能看到停用产线（并知道它停了）");
  assert.ok(html.includes('<option value="draft,published" selected>未归档'), "默认不含已归档");
  assert.ok(html.includes('<option value="archived"'));
  assert.ok(html.includes('data-af-field="filter-missing"'));
  assert.ok(html.includes('data-af-act="new"'));
  assert.equal(html.includes('data-af-act="new" disabled'), false);

  const noRole = filtersHtml([], DEFAULT_FILTERS, "agent");
  assert.ok(noRole.includes('data-af-act="new" disabled'), "未知角色连新建都不给点");
});

test("列表：归档行有视觉标识、完整度显示 n/5 与缺语、空列表返回空串", () => {
  const archivedHtml = rowsHtml([{ ...LIST_ROW, status: "archived", complete_langs: ["zh", "en"], missing_langs: ["de", "nl", "es"] }], "");
  assert.ok(archivedHtml.includes("is-archived"), "归档行要有独立样式钩子（对外等于不存在）");
  assert.ok(archivedHtml.includes("已归档"));
  assert.ok(archivedHtml.includes("2/5"));
  assert.ok(archivedHtml.includes("缺 de、nl、es"));
  assert.equal(rowsHtml([], ""), "");
  assert.equal(rowsHtml(null, ""), "");
});

test("列表：选中行有 is-selected，行键是 (code, product_line)", () => {
  const html = rowsHtml([LIST_ROW], "E03@balcony");
  assert.ok(html.includes("is-selected"));
  assert.ok(html.includes('aria-selected="true"'));
  assert.equal(html.includes('data-af-row="E03@balcony"'), true);
  const other = rowsHtml([LIST_ROW], "E03@residential");
  assert.equal(other.includes("is-selected"), false);
});

/* ───────────────────── 杂项纯函数 ───────────────────── */

test("行键：两列拼一起；逆运算对坏输入返回空（不猜）", () => {
  assert.equal(faultKey(LIST_ROW), "E03@balcony");
  assert.equal(faultKey({}), "@");
  assert.deepEqual(parseFaultKey("E03@balcony"), { code: "E03", productLine: "balcony" });
  assert.deepEqual(parseFaultKey("E03@"), { code: "E03", productLine: "" });
  assert.deepEqual(parseFaultKey("nope"), { code: "", productLine: "" });
  assert.deepEqual(parseFaultKey(null), { code: "", productLine: "" });
});

test("时间与状态标签：坏输入不产出 NaN，未知状态原样显示", () => {
  assert.match(formatStamp("2026-10-27T07:04:00.000Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatStamp(""), "—");
  assert.equal(formatStamp("nonsense"), "—");
  assert.equal(formatStamp(null), "—");
  assert.equal(statusLabel("draft"), "草稿");
  assert.equal(statusLabel("published"), "已发布");
  assert.equal(statusLabel("archived"), "已归档");
  assert.equal(statusLabel(""), "—");
  assert.equal(statusLabel("weird"), "weird", "未知状态原样显示，不吞成'—'（藏起来就没人报 bug）");
});

test("错误文案：403 是'权限不足'（不清登录态），409 直接用后端那句点名缺语的话", () => {
  assert.equal(errorText({ code: "FORBIDDEN", message: "forbidden" }), "权限不足");
  assert.equal(
    errorText({ code: "CONFLICT", message: "发布要求五语齐全，还缺 de、nl、es（含义与处理步骤都要写）" }),
    "发布要求五语齐全，还缺 de、nl、es（含义与处理步骤都要写）",
    "后端已经点名缺哪几门语，前端不要换成一句空话",
  );
  assert.equal(errorText({ code: "CONFLICT" }), "这个状态下不允许该操作");
  assert.match(errorText({ code: "AUTH_REQUIRED" }), /重新登录/);
  assert.match(errorText({ code: "NETWORK" }), /服务/);
  assert.equal(errorText({ code: "WEIRD", message: "后端原话" }), "后端原话");
  assert.equal(errorText(null), "请求失败");
});

/* ───────────────────── ctx.api 适配（两种挂载都要认） ───────────────────── */

test("api 适配：信封形状（契约）与裸数据形状（坐席端现有 api）都归一成 { ok, data }", async () => {
  const envelope = await callApi(async () => ({ ok: true, data: { total: 2 } }), "/api/admin/faults");
  assert.deepEqual(envelope, { ok: true, data: { total: 2 } });

  const bare = await callApi(async () => ({ items: [] }), "/api/admin/faults");
  assert.deepEqual(bare, { ok: true, data: { items: [] } }, "坐席端的 api() 成功时直接回 data");

  const failure = await callApi(async () => ({ ok: false, error: { code: "FORBIDDEN", message: "no" } }), "/x");
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "FORBIDDEN");

  const thrown = await callApi(
    async () => {
      throw Object.assign(new Error("封锁"), { code: "CONFLICT" });
    },
    "/x",
  );
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error.code, "CONFLICT", "抛出形式的失败（坐席端 api 的 401/403 就是这样）也要接住");

  const thrownPlain = await callApi(async () => {
    throw new Error("boom");
  }, "/x");
  assert.equal(thrownPlain.ok, false);
  assert.equal(thrownPlain.error.code, "NETWORK", "没有 code 的异常按网络错处理，不把面板整块打成白屏");

  const missing = await callApi(null, "/x");
  assert.equal(missing.ok, false);
});

test("api 适配：path/init 原样透传（method 与 body 由本模块决定）", async () => {
  let seen: any = null;
  await callApi(
    async (path: string, init: any) => {
      seen = { path, init };
      return { ok: true, data: {} };
    },
    "/api/admin/faults/E03/publish?product_line=balcony",
    { method: "POST" },
  );
  assert.deepEqual(seen, { path: "/api/admin/faults/E03/publish?product_line=balcony", init: { method: "POST" } });
});

/* ───────────────────── mount 的接线（不跑浏览器） ───────────────────── */

/** 只实现本模块用到的那几个成员：innerHTML / querySelector / classList / 四个事件。 */
function fakeHost() {
  const listeners = new Map<string, unknown>();
  const node: any = {
    innerHTML: "",
    classList: { add() {}, remove() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type: string, fn: unknown) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  node.listeners = listeners;
  return node;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("mount：按契约打三处端点，卸载后摘干净监听器与内容", async () => {
  const host = fakeHost();
  const paths: string[] = [];
  const toasts: string[] = [];
  const unmount = mount(host, {
    api: async (path: string) => {
      paths.push(path);
      if (path === "/api/admin/product-lines") return { ok: true, data: { total: 1, items: [{ code: "balcony", name: "阳台", active: true }] } };
      return { ok: true, data: { total: 0, items: [] } };
    },
    role: "admin",
    toast: (message: string) => toasts.push(message),
    onSignOut: () => {},
  });

  assert.equal(typeof unmount, "function");
  assert.equal(host.listeners.has("click"), true, "事件用委托挂在 host 上");
  host.innerHTML = ""; // 模拟"画过了"（fakeHost 不真的解析 HTML）
  await tick();
  await tick();

  assert.equal(paths[0], "/api/admin/product-lines", "先取产线下拉");
  assert.equal(paths[1], "/api/admin/faults?status=draft%2Cpublished&page=1", "再取列表：默认不含已归档");
  assert.deepEqual(toasts, [], "正常路径不弹任何提示");

  unmount();
  assert.equal(host.listeners.size, 0, "四个监听器全部摘掉");
  assert.equal(host.innerHTML, "", "内容清空，host 还原成空 div");
});

test("mount：失败时只 toast 不抛，卸载后再来的响应不落盘", async () => {
  const host = fakeHost();
  const toasts: string[] = [];
  let release: (value: unknown) => void = () => {};
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const unmount = mount(host, {
    api: async () => pending,
    role: "lead",
    toast: (message: string) => toasts.push(message),
  });
  unmount(); // 请求还在半路就卸载
  release({ ok: false, error: { code: "FORBIDDEN", message: "nope" } });
  await tick();
  await tick();
  assert.deepEqual(toasts, [], "卸载之后的响应一个字都不该被处理（不弹提示、不派发 onSignOut）");
});

test("mount：host 不合法时返回 no-op 卸载函数，绝不抛", () => {
  for (const bad of [null, undefined, 42, "div", {}]) {
    const unmount = mount(bad as any, {});
    assert.equal(typeof unmount, "function", `host=${String(bad)} 也要给出可调用的卸载函数`);
    assert.doesNotThrow(() => unmount());
  }
});

/* ───────────────────── 反回归（静态）：模块必须保持"纯" ───────────────────── */

test("静态：脚本顶层不碰宿主对象、不发请求、不引用别的模块", async () => {
  const source = await readFile(join(repoRoot, "src/static/lib", "console-admin-faults.js"), "utf8");

  // 顶层"零副作用"是 node 里能直接 import 的前提，也是这条断言存在的全部理由。
  assert.doesNotMatch(source, /\bdocument\b/, "不许碰 DOM 文档对象（DOM 只活在 mount 里）");
  assert.doesNotMatch(source, /\bwindow\b/, "不许读宿主全局对象");
  assert.doesNotMatch(source, /\bconsole\b/, "不许打日志（页面已经有自己的日志/提示层）");
  assert.doesNotMatch(source, /\bimport\b/, "必须自包含：不引用任何别的模块（ctx.api 就是唯一的网络出口）");
  assert.doesNotMatch(source, /\brequire\s*\(/, "不许走 CommonJS 旁路");
  assert.doesNotMatch(source, /\bfetch\s*\(/, "不许自己发请求：票据与 401 处理都在 ctx.api 里");
  assert.doesNotMatch(source, /localStorage/, "不许碰票据存储");
});

test("静态：导出面固定（挂载方只依赖这一个 mount，其余是给测试与复用用的纯函数）", () => {
  for (const name of [
    "mount",
    "buildListQuery",
    "langCompleteness",
    "tabState",
    "canPublish",
    "canSave",
    "canArchive",
    "canCreate",
    "formNote",
    "errorText",
    "callApi",
    "rowsHtml",
    "formHtml",
    "filtersHtml",
    "pageInfoText",
    "createBody",
    "patchBody",
    "formFromDetail",
    "emptyForm",
    "faultKey",
    "parseFaultKey",
    "completenessText",
    "formatStamp",
    "statusLabel",
    "esc",
  ]) {
    assert.equal(typeof faults[name], "function", `必须导出 ${name}`);
  }
  assert.deepEqual([...LANGS], ["zh", "en", "de", "nl", "es"]);
  assert.equal(typeof DEFAULT_FILTERS, "object");
  assert.equal(PAGE_SIZE, 50);
});
