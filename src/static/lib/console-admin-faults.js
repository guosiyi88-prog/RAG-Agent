/**
 * 故障卡管理面板（`09#04` 的可见交付物 / `docs/prdv1.3/scope-delta.md` S4）。
 *
 * 一个模块、一个出口：`mount(host, ctx) → unmount`。父容器只给一个空 `<div>`，负责它的尺寸与位置；
 * 本模块自己铺列表 + 筛选 + 五语表单，所有网络都走 `ctx.api`（票据在那一层，本模块看不见它）。
 *
 * 三条设计约束，都是为了"这一块能在 node 里直接断言"：
 *   1. **顶层零副作用**：文件里不出现宿主对象、不发请求、不引用任何别的模块。可测的判定全部是
 *      导出纯函数（入参 → 出参 / 出字符串），DOM 只活在 `mount()` 里。`tests/web-admin-faults.test.ts`
 *      有一条静态断言盯着这一点。
 *   2. **判定只写一遍**：`langCompleteness` / `canPublish` / `canSave` / `canArchive` 既给表单的
 *      按钮用、也给列表与提示文案用。按钮隐藏只是"免挫败"，**接口层仍会再判一次** ——
 *      前端唯一的职责是别让人点一个注定 403 的东西。
 *   3. **缺语的判据与后端同口径**：`nullif(btrim(x),'') is not null` 两列都非空才算这门语齐
 *      （`src/core/admin-store.ts` 的 `langCompleteSql`）。允许前端算宽一点，就会出现
 *      "面板说 5/5、点发布却 409" 的自相矛盾。
 *
 * 与后端的对应（`src/api/admin.ts` / `docs/prdv1.2/05-api.md` §5.6）：
 *   列表 `GET /api/admin/faults?product_line=&severity=&status=&missing_lang=&page=`
 *   详情 `GET /api/admin/faults/:code?product_line=`（**主键是两列，product_line 必须带**）
 *   新建 `POST /api/admin/faults`（一律落 draft）、编辑 `PATCH .../:code?product_line=`
 *   发布 `POST .../:code/publish?product_line=`（admin）、归档 `POST .../:code/archive?product_line=`（admin）
 *   产线 `GET /api/admin/product-lines`（含停用项，面板要标出来）
 */

/* ───────────────────────── 常量 ───────────────────────── */

/** 五语种的顺序 = 后端 `FAULT_TEXT_LANGS` 的顺序 = Tab 的顺序（不要在前端重排）。 */
export const LANGS = Object.freeze(["zh", "en", "de", "nl", "es"]);

/** 母语名自显（与用户端顶部语言菜单同一套写法，`lib/lang.js` 的 `LANG_NAMES`）。 */
export const LANG_LABEL = Object.freeze({
  zh: "中文",
  en: "English",
  de: "Deutsch",
  nl: "Nederlands",
  es: "Español",
});

export const STATUS_LABEL = Object.freeze({ draft: "草稿", published: "已发布", archived: "已归档" });

/**
 * 状态筛选。**默认值 `draft,published` 就是"不含已归档"**：归档对外等于不存在，
 * 管理端第一眼看到的是还在生命里的那几条；要看归档必须自己选。
 */
export const STATUS_OPTIONS = Object.freeze([
  ["draft,published", "未归档（草稿 + 已发布）"],
  ["draft", "仅草稿"],
  ["published", "仅已发布"],
  ["archived", "已归档"],
  ["", "全部状态"],
]);

export const SEVERITY_LABEL = Object.freeze({ info: "提示", warn: "警告", fatal: "严重" });
export const SEVERITY_OPTIONS = Object.freeze([
  ["", "全部严重度"],
  ["info", "提示"],
  ["warn", "警告"],
  ["fatal", "严重"],
]);

export const DEFAULT_FILTERS = Object.freeze({
  product_line: "",
  severity: "",
  status: "draft,published",
  missing_lang: false,
});

/** 一页 50 条：`fault_codes` 的量级是几十行，翻页只是兜底（后端 `size` 上限 100）。 */
export const PAGE_SIZE = 50;

/** 与 `src/core/fastpath.ts` 的 `FAULT_CODE_RE` 同形：发布了用户查不到的码就是假发布。 */
const FAULT_CODE_RE = /^[A-Z]\d{2,3}$/;

/* ───────────────────────── 小工具 ───────────────────────── */

/** 唯一的转义出口（文案与码都是人填的，`</textarea>` 出现在处理步骤里完全正常）。 */
export function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

/** 「这门语写了」的判据：字符串且去空白后非空。与后端 `btrim` 一致。 */
function filled(value) {
  return typeof value === "string" && value.trim() !== "";
}

function normText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

/** 列表行的稳定键：主键是 `(code, product_line)`，只用 code 会把两条产线的同码行认成一条。 */
export function faultKey(row) {
  const source = row ?? {};
  return `${String(source.code ?? "")}@${String(source.product_line ?? "")}`;
}

/** `faultKey` 的逆运算（产线 code 的形状不允许 `@`，见 `api/admin.ts` 的 `PRODUCT_LINE_CODE_RE`）。 */
export function parseFaultKey(key) {
  const text = String(key ?? "");
  const at = text.indexOf("@");
  if (at <= 0) return { code: "", productLine: "" };
  return { code: text.slice(0, at), productLine: text.slice(at + 1) };
}

/** 更新时间：本地 `YYYY-MM-DD HH:MM`（不用 Intl，免得同一串在不同环境给出不同形状）。 */
export function formatStamp(value) {
  const text = String(value ?? "");
  if (text === "") return "—";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function statusLabel(status) {
  const key = String(status ?? "");
  return STATUS_LABEL[key] ?? (key === "" ? "—" : key);
}

/* ───────────────────────── 语言完整度 ───────────────────────── */

/**
 * 每门语的两个字段齐了没。**详情（十列正文）与列表行（`complete_langs`）都能喂进来**：
 * 表单里用户正在改的那份草稿只有正文，没有服务端的 `complete_langs`，所以这里优先读正文，
 * 只有正文整块缺失时才退回服务端给的数组 —— 反过来会让"刚补上德语"的 Tab 一直挂着红点。
 */
export function tabState(input) {
  const source = input ?? {};
  const desc = source.desc ?? {};
  const act = source.act ?? {};
  return LANGS.map((lang) => {
    const hasDesc = filled(desc[lang]);
    const hasAct = filled(act[lang]);
    return { lang, label: LANG_LABEL[lang], hasDesc, hasAct, complete: hasDesc && hasAct };
  });
}

/** `{ count, complete, missing }`：`count` 给表格的 `n/5`，`missing` 给发布按钮的理由。 */
export function langCompleteness(input) {
  const source = input ?? {};
  const hasText = LANGS.some((lang) => filled(source.desc?.[lang]) || filled(source.act?.[lang]));
  if (!hasText && Array.isArray(source.complete_langs)) {
    // 列表行不带正文：直接信服务端（同一个 SQL 判据算出来的，与详情永远一致）。
    const complete = LANGS.filter((lang) => source.complete_langs.includes(lang));
    return { count: complete.length, complete, missing: LANGS.filter((lang) => !complete.includes(lang)) };
  }
  const complete = tabState(source)
    .filter((tab) => tab.complete)
    .map((tab) => tab.lang);
  return { count: complete.length, complete, missing: LANGS.filter((lang) => !complete.includes(lang)) };
}

export function completenessText(input) {
  const { count, missing } = langCompleteness(input);
  return missing.length === 0
    ? `语言完整度 ${count}/5（五语齐全）`
    : `语言完整度 ${count}/5（还缺 ${missing.join("、")}，发布前必须补齐）`;
}

function paneHintText(tab) {
  if (tab.complete) return "这门语已补齐（含义与处理步骤都有）。";
  const lack = [!tab.hasDesc ? "含义" : "", !tab.hasAct ? "处理步骤" : ""].filter((part) => part !== "");
  return `这门语还缺：${lack.join("、")}`;
}

/* ───────────────────────── 能力判定（按钮的显隐与禁用） ───────────────────────── */

/**
 * 返回 `{ visible, enabled, reason }`：`visible` 决定画不画，`enabled` 决定能不能点，
 * `reason` 是"为什么不能点"的一句话（画在按钮的 title 和表单提示里）。
 * **接口层各自还有一道门**（`ROUTE_MIN_ROLE`）：这里隐藏只是不让人白点。
 */
function capability(visible, enabled, reason) {
  return { visible, enabled, reason };
}

export function canCreate(role) {
  return role === "admin" || role === "lead"
    ? capability(true, true, "")
    : capability(false, false, "需要坐席主管或管理员角色");
}

export function canSave(input, role) {
  const status = String(input?.status ?? "draft");
  if (status === "archived") return capability(false, false, "已归档的故障码不能再修改");
  return canCreate(role).visible ? capability(true, true, "") : capability(false, false, "需要坐席主管或管理员角色");
}

/**
 * 发布：`admin` 起，且五语齐全（D14）。`published` 再点是幂等的，但按钮就没意义了 ——
 * 禁用并说明，比让人点完看到一句"没变化"更好。码的形状也在这里挡一次：不合对外判形的码
 * 发布了用户也查不到（后端 `publishFault` 入口处会 400，这里提前说清楚）。
 */
export function canPublish(input, role) {
  const source = input ?? {};
  const status = String(source.status ?? "draft");
  if (status === "archived") return capability(false, false, "已归档的故障码不能发布");
  if (role !== "admin") return capability(false, false, "发布需要管理员（admin）角色");
  const { missing } = langCompleteness(source);
  if (missing.length > 0) {
    return capability(true, false, `还缺 ${missing.join("、")}（含义与处理步骤都要写）`);
  }
  if (!FAULT_CODE_RE.test(String(source.code ?? ""))) {
    return capability(true, false, "故障码不符合对外判形（字母 + 2~3 位数字），发布了用户也查不到");
  }
  if (status === "published") return capability(true, false, "已经是发布态");
  return capability(true, true, "");
}

export function canArchive(input, role) {
  const status = String(input?.status ?? "draft");
  if (status === "archived") return capability(false, false, "已经是归档态");
  if (role !== "admin") return capability(false, false, "归档需要管理员（admin）角色");
  return capability(true, true, "");
}

/** 表单底部那一句提示：只说**最该做的那一件事**，不堆三条规则。 */
export function formNote(input, role) {
  const source = input ?? {};
  const status = String(source.status ?? "draft");
  const { missing } = langCompleteness(source);
  if (status === "archived") return "已归档：对外等于不存在，也不能再编辑或发布。";
  if (role !== "admin") {
    const tail = missing.length > 0 ? `本卡还缺 ${missing.join("、")}。` : "";
    return status === "published"
      ? `发布态：改动保存后会落回草稿，需要重新发布（重新发布需管理员）。${tail}`
      : `发布与归档需要管理员（admin）角色。${tail}`;
  }
  if (missing.length > 0) return `发布前必须补齐 ${missing.join("、")}（含义与处理步骤都要写）。`;
  if (status === "published") return "已经是发布态；改动保存后会落回草稿。";
  return "五语齐全，可以发布。";
}

/* ───────────────────────── 请求 ───────────────────────── */

/**
 * 把 `ctx.api` 的返回值归一成 `{ ok, data } | { ok:false, error }`。
 *
 * 两种挂载都认：契约上的 `api()` 回信封（`{ ok, data }`），而坐席端现有的 `api()`
 * 成功时直接回 `data`、失败时**抛**。挂载方将来换成哪一种都不该让面板整体报错，所以这里
 * 既能读信封、也能接住抛出的异常 —— 一份适配代码，胜过让两侧各记住一种约定。
 */
export async function callApi(api, path, init) {
  if (typeof api !== "function") {
    return { ok: false, error: { code: "NETWORK", message: "缺少 ctx.api" } };
  }
  let result;
  try {
    result = await api(path, init);
  } catch (error) {
    const code = typeof error?.code === "string" && error.code !== "" ? error.code : "NETWORK";
    return { ok: false, error: { code, message: String(error?.message ?? "请求失败") } };
  }
  if (result !== null && typeof result === "object" && "ok" in result) {
    if (result.ok === true) return { ok: true, data: result.data ?? {} };
    return { ok: false, error: result.error ?? { code: "UNKNOWN", message: "请求失败" } };
  }
  return { ok: true, data: result ?? {} };
}

/** 错误码 → 面板上的一句话。`CONFLICT` 直接用后端 message（发布缺语时它点名缺哪几门）。 */
export function errorText(error) {
  const code = String(error?.code ?? "");
  const message = typeof error?.message === "string" ? error.message : "";
  if (code === "FORBIDDEN") return "权限不足";
  if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID") return "会话已过期，请重新登录";
  if (code === "NETWORK") return "连不上服务端，请确认服务已启动";
  if (code === "NOT_FOUND") return "故障码不存在（可能已被改动，请刷新列表）";
  if (code === "CONFLICT") return message === "" ? "这个状态下不允许该操作" : message;
  if (code === "VALIDATION") return message === "" ? "参数不合法" : message;
  return message === "" ? "请求失败" : message;
}

/* ───────────────────────── 请求体 ───────────────────────── */

function emptyText() {
  return Object.fromEntries(LANGS.map((lang) => [lang, ""]));
}

export function emptyForm(productLine = "") {
  return {
    mode: "create",
    code: "",
    product_line: String(productLine ?? ""),
    severity: "",
    status: "draft",
    desc: emptyText(),
    act: emptyText(),
    activeTab: LANGS[0],
  };
}

/**
 * 详情 → 表单状态。**不复制 `complete_langs`**：那份数组描述的是服务端此刻的行，
 * 而表单里用户正在改的是另一份文本；把两份混在一起，补完德语之后 Tab 还会挂着红点。
 * 空串归一成空串（不写 null）：文本域的 value 只认字符串。
 */
export function formFromDetail(detail, activeTab) {
  const source = detail ?? {};
  const desc = Object.fromEntries(LANGS.map((lang) => [lang, typeof source.desc?.[lang] === "string" ? source.desc[lang] : ""]));
  const act = Object.fromEntries(LANGS.map((lang) => [lang, typeof source.act?.[lang] === "string" ? source.act[lang] : ""]));
  return {
    mode: "edit",
    code: String(source.code ?? ""),
    product_line: String(source.product_line ?? ""),
    severity: typeof source.severity === "string" ? source.severity : "",
    status: String(source.status ?? "draft"),
    desc,
    act,
    activeTab: LANGS.includes(activeTab) ? activeTab : LANGS[0],
  };
}

function textBlock(form, kind) {
  const block = form?.[kind] ?? {};
  return Object.fromEntries(LANGS.map((lang) => [lang, normText(block[lang])]));
}

/** 新建体：`status` 不在这里 —— 后端 SQL 里写死 `draft`，客户端连表达"直接发布"的机会都没有。 */
export function createBody(form) {
  const body = {
    code: String(form?.code ?? "").trim().toUpperCase(),
    product_line: String(form?.product_line ?? "").trim(),
    desc: textBlock(form, "desc"),
    act: textBlock(form, "act"),
  };
  const severity = String(form?.severity ?? "");
  if (severity !== "") body.severity = severity;
  return body;
}

/**
 * 编辑体：十列一次全发（没改的列后端比对后不进 `changed`）。
 *
 * `severity` 是**三态**（`09#05` 收口 `09#04` 未做第 5 条）：`（未设置）` 必须显式发 `null`，
 * 因为后端把"键缺失"读成"不改"、把"值是 null"读成"清空"。省略这一列 = 用户选了未设置、
 * 保存成功、值还在 —— 面板上最典型的假成功。
 *
 * 新建（`createBody`）不发 `null`：新建时"没设置"与"清空"没有可观察差别，少一个字段少一份歧义。
 */
export function patchBody(form) {
  const body = { desc: textBlock(form, "desc"), act: textBlock(form, "act") };
  const severity = String(form?.severity ?? "");
  body.severity = severity === "" ? null : severity;
  return body;
}

/* ───────────────────────── 列表查询 ───────────────────────── */

/** 筛选 → 查询串。空值不发（后端把缺省与空串当同一件事，但少一个参数就少一次看错的机会）。 */
export function buildListQuery(filters, page = 1) {
  const merged = { ...DEFAULT_FILTERS, ...(filters ?? {}) };
  const params = new URLSearchParams();
  const productLine = String(merged.product_line ?? "").trim();
  if (productLine !== "") params.set("product_line", productLine);
  if (String(merged.severity ?? "") !== "") params.set("severity", String(merged.severity));
  if (String(merged.status ?? "") !== "") params.set("status", String(merged.status));
  if (merged.missing_lang === true) params.set("missing_lang", "true");
  const wanted = Math.trunc(Number(page));
  params.set("page", String(Number.isFinite(wanted) && wanted > 1 ? wanted : 1));
  return params.toString();
}

export function pageInfoText(total, page) {
  const count = Math.max(0, Math.trunc(Number(total) || 0));
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.trunc(Number(page) || 1)), pages);
  return `第 ${current} / ${pages} 页 · 共 ${count} 条`;
}

/* ───────────────────────── HTML 片段（纯字符串） ───────────────────────── */

function optionsHtml(options, current) {
  return options
    .map(
      ([value, label]) =>
        `<option value="${esc(value)}"${String(current) === String(value) ? " selected" : ""}>${esc(label)}</option>`,
    )
    .join("");
}

export function filtersHtml(productLines, filters, role) {
  const merged = { ...DEFAULT_FILTERS, ...(filters ?? {}) };
  const lines = Array.isArray(productLines) ? productLines : [];
  const lineOptions = [["", "全部产线"]].concat(
    lines.map((line) => {
      const name = String(line?.name ?? line?.code ?? "");
      return [String(line?.code ?? ""), line?.active === false ? `${name}（已停用）` : name];
    }),
  );
  const create = canCreate(role);
  return `<label class="af-field"><span class="af-label">产线</span>
    <select class="af-select" data-af-field="filter-product-line" aria-label="按产线筛选">${optionsHtml(lineOptions, merged.product_line)}</select></label>
  <label class="af-field"><span class="af-label">严重度</span>
    <select class="af-select" data-af-field="filter-severity" aria-label="按严重度筛选">${optionsHtml(SEVERITY_OPTIONS, merged.severity)}</select></label>
  <label class="af-field"><span class="af-label">状态</span>
    <select class="af-select" data-af-field="filter-status" aria-label="按状态筛选">${optionsHtml(STATUS_OPTIONS, merged.status)}</select></label>
  <label class="af-check"><input type="checkbox" data-af-field="filter-missing"${merged.missing_lang === true ? " checked" : ""}> 只有缺语</label>
  <span class="af-spacer"></span>
  <button class="af-btn af-btn-primary" type="button" data-af-act="new"${create.enabled ? "" : ` disabled title="${esc(create.reason)}"`}>新建故障卡</button>`;
}

export function rowsHtml(rows, selectedKey = "") {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const key = faultKey(row);
    const { count, missing } = langCompleteness(row);
    const status = String(row?.status ?? "");
    const severity = typeof row?.severity === "string" ? row.severity : "";
    const selected = key === String(selectedKey ?? "");
    return `<tr class="af-row${selected ? " is-selected" : ""}${status === "archived" ? " is-archived" : ""}" data-af-row="${esc(key)}" tabindex="0" aria-selected="${selected}">
  <td class="af-code">${esc(row?.code ?? "")}</td>
  <td>${esc(row?.product_line ?? "")}</td>
  <td>${severity === "" ? "—" : `<span class="af-sev" data-sev="${esc(severity)}">${esc(SEVERITY_LABEL[severity] ?? severity)}</span>`}</td>
  <td><span class="af-badge" data-status="${esc(status)}">${esc(statusLabel(status))}</span></td>
  <td class="af-langs"><span class="${count === LANGS.length ? "af-langs-ok" : "af-langs-miss"}">${count}/5</span>${
    missing.length === 0 ? "" : ` <span class="af-miss">缺 ${esc(missing.join("、"))}</span>`
  }</td>
  <td class="af-time">${esc(formatStamp(row?.updated_at))}</td>
</tr>`;
  }).join("");
}

function codeFieldHtml(form, lines) {
  if (form.mode === "create") {
    const active = (Array.isArray(lines) ? lines : []).filter((line) => line?.active !== false);
    const options = [["", "选择产线"]].concat(active.map((line) => [String(line.code ?? ""), String(line.name ?? line.code ?? "")]));
    return `<label class="af-field"><span class="af-label">故障码</span>
      <input class="af-input af-code-input" type="text" data-af-field="form-code" value="${esc(form.code)}" placeholder="例如 E03" aria-label="故障码" autocomplete="off" spellcheck="false"></label>
    <label class="af-field"><span class="af-label">产品线</span>
      <select class="af-select" data-af-field="form-product-line" aria-label="产品线">${optionsHtml(options, form.product_line)}</select></label>`;
  }
  return `<label class="af-field"><span class="af-label">故障码</span>
      <span class="af-static af-code-static">${esc(form.code)}</span></label>
    <label class="af-field"><span class="af-label">产品线</span>
      <span class="af-static">${esc(form.product_line)}</span></label>`;
}

/** 五语表单。Tab 上缺语的圆点由 `data-state` 驱动（CSS 画），切换 Tab 不重画正文（焦点会丢）。 */
export function formHtml(form, role, productLines) {
  if (form === null || typeof form !== "object") return "";
  const source = form;
  const status = String(source.status ?? "draft");
  const archived = status === "archived";
  const creating = source.mode === "create";
  const tabs = tabState(source);
  const activeTab = LANGS.includes(source.activeTab) ? source.activeTab : LANGS[0];
  const save = canSave(source, role);
  const publish = canPublish(source, role);
  const archive = canArchive(source, role);

  const tabButtons = tabs
    .map((tab) => {
      const active = tab.lang === activeTab;
      return `<button class="af-tab" type="button" role="tab" data-af-tab="${esc(tab.lang)}" aria-selected="${active}" aria-controls="af-pane-${esc(tab.lang)}" data-state="${tab.complete ? "complete" : "missing"}" title="${esc(tab.complete ? "这门语已补齐" : "发布前必须补齐")}">
        <span class="af-tab-name">${esc(tab.label)}</span><span class="af-tab-dot" aria-hidden="true"></span>
        <span class="af-sr">${tab.complete ? "" : "（缺语）"}</span>
      </button>`;
    })
    .join("");

  const panes = tabs
    .map((tab) => {
      const active = tab.lang === activeTab;
      const lock = archived ? " readonly" : "";
      return `<div class="af-pane" id="af-pane-${esc(tab.lang)}" role="tabpanel" aria-label="${esc(tab.label)}" data-af-pane="${esc(tab.lang)}"${active ? "" : " hidden"}>
      <label class="af-field af-field-block"><span class="af-label">含义（desc_${esc(tab.lang)}）</span>
        <textarea class="af-input af-textarea" rows="3" data-af-kind="desc" data-af-lang="${esc(tab.lang)}" aria-label="${esc(tab.label)}含义"${lock}>${esc(source.desc?.[tab.lang] ?? "")}</textarea></label>
      <label class="af-field af-field-block"><span class="af-label">处理步骤（act_${esc(tab.lang)}）</span>
        <textarea class="af-input af-textarea" rows="4" data-af-kind="act" data-af-lang="${esc(tab.lang)}" aria-label="${esc(tab.label)}处理步骤"${lock}>${esc(source.act?.[tab.lang] ?? "")}</textarea></label>
      <p class="af-pane-hint" data-af="pane-hint" data-lang="${esc(tab.lang)}" data-state="${tab.complete ? "complete" : "missing"}">${esc(paneHintText(tab))}</p>
    </div>`;
    })
    .join("");

  const actions = [
    save.visible
      ? `<button class="af-btn af-btn-primary" type="button" data-af-act="save"${save.enabled ? "" : ` disabled title="${esc(save.reason)}"`}>保存</button>`
      : "",
    publish.visible
      ? `<button class="af-btn af-btn-go" type="button" data-af-act="publish"${publish.enabled ? "" : ` disabled title="${esc(publish.reason)}"`}>发布</button>`
      : "",
    archive.visible
      ? `<button class="af-btn af-btn-danger" type="button" data-af-act="archive"${archive.enabled ? "" : ` disabled title="${esc(archive.reason)}"`}>归档</button>`
      : "",
    `<button class="af-btn af-btn-ghost" type="button" data-af-act="close">关闭</button>`,
  ]
    .filter((part) => part !== "")
    .join("");

  return `<div class="af-form-head">
    <div class="af-form-title">
      <span class="af-form-name">${creating ? "新建故障卡" : `${esc(source.code)} · ${esc(source.product_line)}`}</span>
      <span class="af-badge" data-status="${esc(status)}">${esc(statusLabel(status))}</span>
    </div>
    <div class="af-form-fields">${codeFieldHtml(source, productLines)}
      <label class="af-field"><span class="af-label">严重度</span>
        <select class="af-select" data-af-field="form-severity" aria-label="严重度"${archived ? " disabled" : ""}>${
          optionsHtml([["", "（未设置）"], ["info", "提示"], ["warn", "警告"], ["fatal", "严重"]], source.severity)
        }</select></label>
    </div>
    <div class="af-actions">${actions}</div>
    <p class="af-note" data-af="form-note">${esc(formNote(source, role))}</p>
    <p class="af-note af-completeness" data-af="completeness">${esc(completenessText(source))}</p>
  </div>
  <div class="af-tabs" role="tablist" aria-label="五语文案">${tabButtons}</div>
  <div class="af-panes">${panes}</div>`;
}

/* ───────────────────────── 样式（只在本模块的 `.af` 前缀下生效） ───────────────────────── */

const STYLE = `
.af{display:flex;flex-direction:column;gap:var(--s3,12px);box-sizing:border-box;height:100%;min-height:0;overflow:auto;font-size:var(--t-sm,13px);line-height:1.5;color:var(--c-text,#0f172a);background:var(--c-bg,#f8fafc)}
.af *{box-sizing:border-box}
.af-list,.af-form{display:flex;flex-direction:column;gap:var(--s2,8px);padding:var(--s4,16px);border:1px solid var(--c-border,#e2e8f0);border-radius:var(--r-md,8px);background:var(--c-surface,#fff)}
.af-form[hidden]{display:none}
.af-toolbar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--s2,8px)}
.af-field{display:flex;flex-direction:column;gap:2px}
.af-field-block{gap:4px}
.af-label{font-size:var(--t-cap,11px);font-weight:600;color:var(--c-muted,#64748b);text-transform:uppercase;letter-spacing:.02em}
.af-static{font-weight:600}
.af-select,.af-input{font:inherit;color:inherit;background:var(--c-surface,#fff);border:1px solid var(--c-border,#e2e8f0);border-radius:var(--r-sm,6px);padding:6px 8px;min-height:34px}
.af-select{min-width:130px}
.af-input:focus-visible,.af-select:focus-visible,.af-btn:focus-visible,.af-tab:focus-visible,.af-row:focus-visible{outline:2px solid var(--c-cta,#0369a1);outline-offset:1px}
.af-textarea{width:100%;resize:vertical;min-height:64px;line-height:1.55}
.af-check{display:inline-flex;align-items:center;gap:6px;padding-bottom:6px;font-weight:600;white-space:nowrap}
.af-spacer{flex:1 1 auto}
.af-btn{font:inherit;font-weight:600;min-height:34px;padding:0 12px;border:1px solid var(--c-border,#e2e8f0);border-radius:var(--r-sm,6px);background:var(--c-surface,#fff);color:inherit;cursor:pointer}
.af-btn:disabled{opacity:.5;cursor:not-allowed}
.af-btn-primary{background:var(--c-cta,#0369a1);border-color:transparent;color:#fff}
.af-btn-go{background:var(--c-st-closed,#22c55e);border-color:transparent;color:#08240f}
.af-btn-danger{color:var(--c-st-sla,#ef4444);border-color:color-mix(in srgb,var(--c-st-sla,#ef4444) 45%,transparent)}
.af-btn-ghost{background:transparent}
.af-status{font-size:var(--t-sm,13px)}
.af-status:empty{display:none}
.af-status[data-tone="error"]{padding:6px 10px;border-left:3px solid var(--c-st-sla,#ef4444);background:color-mix(in srgb,var(--c-st-sla,#ef4444) 8%,transparent)}
.af-status[data-tone="loading"]{color:var(--c-muted,#64748b)}
.af-table-wrap{overflow:auto;border:1px solid var(--c-border,#e2e8f0);border-radius:var(--r-sm,6px)}
.af-table{width:100%;border-collapse:collapse;table-layout:fixed}
.af-table th,.af-table td{height:40px;padding:0 10px;text-align:left;vertical-align:middle;border-bottom:1px solid var(--c-border,#e2e8f0);font-size:var(--t-sm,13px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.af-table thead th{position:sticky;top:0;z-index:1;height:32px;background:var(--c-bg,#f8fafc);color:var(--c-muted,#64748b);font-size:var(--t-cap,11px);font-weight:600}
.af-row{cursor:pointer}
.af-row:hover{background:color-mix(in srgb,var(--c-cta,#0369a1) 6%,transparent)}
.af-row.is-selected{background:color-mix(in srgb,var(--c-cta,#0369a1) 12%,transparent);box-shadow:inset 3px 0 0 var(--c-cta,#0369a1)}
.af-row.is-archived .af-code{color:var(--c-muted,#64748b);text-decoration:line-through}
.af-code{font-family:var(--font-mono,ui-monospace,monospace);font-weight:700;letter-spacing:.04em}
.af-sev[data-sev="fatal"]{color:var(--c-st-sla,#ef4444);font-weight:700}
.af-sev[data-sev="warn"]{color:var(--c-st-open,#f59e0b);font-weight:700}
.af-langs-ok{color:var(--c-st-closed,#16a34a);font-weight:700}
.af-langs-miss{color:var(--c-st-open,#f59e0b);font-weight:700}
.af-miss{color:var(--c-muted,#64748b);font-size:var(--t-cap,11px)}
.af-time{color:var(--c-muted,#64748b)}
.af-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:var(--t-cap,11px);font-weight:700;border:1px solid currentColor}
.af-badge[data-status="published"]{color:var(--c-st-closed,#16a34a)}
.af-badge[data-status="draft"]{color:var(--c-st-open,#b45309)}
.af-badge[data-status="archived"]{color:var(--c-muted,#64748b);background:color-mix(in srgb,var(--c-muted,#64748b) 12%,transparent)}
.af-empty{padding:16px;color:var(--c-muted,#64748b)}
.af-empty[hidden]{display:none}
.af-pager{display:flex;align-items:center;gap:8px}
.af-page{font-size:var(--t-cap,12px);color:var(--c-muted,#64748b)}
.af-form-head{display:flex;flex-direction:column;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--c-border,#e2e8f0)}
.af-form-title{display:flex;align-items:center;gap:8px}
.af-form-name{font-family:var(--font-display,inherit);font-size:var(--t-title,15px);font-weight:700}
.af-form-fields{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
.af-code-input{width:130px;text-transform:uppercase}
.af-actions{display:flex;flex-wrap:wrap;gap:8px}
.af-note{margin:0;font-size:var(--t-cap,12px);color:var(--c-muted,#64748b)}
.af-completeness{color:var(--c-text,#0f172a);font-weight:600}
.af-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:3px;border:1px solid var(--c-border,#e2e8f0);border-radius:var(--r-md,8px)}
.af-tab{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 12px;border:0;border-radius:var(--r-sm,6px);background:transparent;color:var(--c-muted,#64748b);font:inherit;font-weight:600;cursor:pointer}
.af-tab[aria-selected="true"]{background:var(--c-primary,#0f172a);color:#fff}
.af-tab-dot{width:7px;height:7px;border-radius:50%;background:transparent}
.af-tab[data-state="missing"] .af-tab-dot{background:var(--c-st-sla,#ef4444);box-shadow:0 0 0 2px color-mix(in srgb,var(--c-st-sla,#ef4444) 22%,transparent)}
.af-pane{display:flex;flex-direction:column;gap:8px;padding-top:4px}
.af-pane[hidden]{display:none}
.af-pane-hint{margin:0;font-size:var(--t-cap,12px);color:var(--c-st-open,#b45309)}
.af-pane-hint[data-state="complete"]{color:var(--c-st-closed,#16a34a)}
.af-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
`;

function skeletonHtml() {
  return `<section class="af-list" aria-label="故障卡列表">
    <div class="af-toolbar" data-af="filters"></div>
    <div class="af-status" data-af="list-status" role="status" data-tone=""></div>
    <div class="af-table-wrap">
      <table class="af-table">
        <colgroup><col style="width:96px"><col style="width:132px"><col style="width:88px"><col style="width:88px"><col style="width:200px"><col style="width:132px"></colgroup>
        <thead><tr>
          <th scope="col">code</th><th scope="col">product_line</th><th scope="col">严重度</th>
          <th scope="col">状态</th><th scope="col">语言完整度</th><th scope="col">更新时间</th>
        </tr></thead>
        <tbody data-af="rows"></tbody>
      </table>
      <p class="af-empty" data-af="empty" hidden>没有符合条件的故障码</p>
    </div>
    <div class="af-pager">
      <button class="af-btn af-btn-ghost" type="button" data-af-act="prev">上一页</button>
      <span class="af-page" data-af="page-info"></span>
      <button class="af-btn af-btn-ghost" type="button" data-af-act="next">下一页</button>
      <span class="af-spacer"></span>
      <button class="af-btn af-btn-ghost" type="button" data-af-act="reload">刷新</button>
    </div>
  </section>
  <section class="af-form" data-af="form" aria-label="故障卡编辑" hidden></section>`;
}

/* ───────────────────────── 挂载 ───────────────────────── */

/**
 * `host` 是一个空 `<div>`；`ctx` 见文件头。返回卸载函数（摘监听、清内容）。
 * 这里才开始碰 DOM —— 文件顶层一个宿主对象都没有，所以在 node 里加载本模块是安全的。
 */
export function mount(host, ctx) {
  if (host === null || typeof host !== "object" || typeof host.querySelector !== "function") {
    return () => {};
  }
  const config = ctx ?? {};
  const api = typeof config.api === "function" ? config.api : null;
  const role = config.role === "admin" ? "admin" : "lead";
  const toast = typeof config.toast === "function" ? config.toast : () => {};
  const onSignOut = typeof config.onSignOut === "function" ? config.onSignOut : null;

  const state = {
    productLines: [],
    filters: { ...DEFAULT_FILTERS },
    page: 1,
    total: 0,
    rows: [],
    selected: "",
    form: null,
    busy: false,
    alive: true,
    listSeq: 0,
    detailSeq: 0,
  };

  const find = (selector) => host.querySelector(selector);
  const findIn = (root, selector) => (root === null ? null : root.querySelector(selector));
  const setHtml = (node, html) => {
    if (node !== null) node.innerHTML = html;
  };
  const closestIn = (node, selector) =>
    node !== null && node !== undefined && typeof node.closest === "function" ? node.closest(selector) : null;

  function defaultProductLine() {
    const active = state.productLines.find((line) => line?.active !== false);
    const line = active ?? state.productLines[0];
    return typeof line?.code === "string" ? line.code : "";
  }

  function setListStatus(text, tone) {
    const node = find('[data-af="list-status"]');
    if (node === null) return;
    node.textContent = text;
    node.dataset.tone = tone ?? "";
  }

  function paintFilters() {
    setHtml(find('[data-af="filters"]'), filtersHtml(state.productLines, state.filters, role));
  }

  function paintList() {
    setHtml(find('[data-af="rows"]'), rowsHtml(state.rows, state.selected));
    const empty = find('[data-af="empty"]');
    if (empty !== null) empty.hidden = state.rows.length > 0;
    const info = find('[data-af="page-info"]');
    if (info !== null) info.textContent = pageInfoText(state.total, state.page);
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    const prev = find('[data-af-act="prev"]');
    if (prev !== null) prev.disabled = state.page <= 1;
    const next = find('[data-af-act="next"]');
    if (next !== null) next.disabled = state.page >= pages;
  }

  /** 表单里"随输入变化"的那几处：Tab 圆点、逐语提示、按钮禁用与理由、完整度。 */
  function syncFormChrome() {
    const formHost = find('[data-af="form"]');
    const form = state.form;
    if (formHost === null || form === null) return;
    for (const tab of tabState(form)) {
      const button = findIn(formHost, `[data-af-tab="${tab.lang}"]`);
      if (button !== null) {
        button.dataset.state = tab.complete ? "complete" : "missing";
        button.title = tab.complete ? "这门语已补齐" : "发布前必须补齐";
      }
      const hint = findIn(formHost, `[data-af="pane-hint"][data-lang="${tab.lang}"]`);
      if (hint !== null) {
        hint.textContent = paneHintText(tab);
        hint.dataset.state = tab.complete ? "complete" : "missing";
      }
    }
    const completeness = findIn(formHost, '[data-af="completeness"]');
    if (completeness !== null) completeness.textContent = completenessText(form);
    const note = findIn(formHost, '[data-af="form-note"]');
    if (note !== null) note.textContent = formNote(form, role);
    for (const [act, capabilityOf] of [
      ["save", canSave(form, role)],
      ["publish", canPublish(form, role)],
      ["archive", canArchive(form, role)],
    ]) {
      const button = findIn(formHost, `[data-af-act="${act}"]`);
      if (button === null) continue;
      button.disabled = state.busy || !capabilityOf.enabled;
      button.title = capabilityOf.reason;
    }
  }

  function paintForm() {
    const formHost = find('[data-af="form"]');
    if (formHost === null) return;
    if (state.form === null) {
      formHost.hidden = true;
      formHost.innerHTML = "";
      return;
    }
    formHost.hidden = false;
    formHost.innerHTML = formHtml(state.form, role, state.productLines);
    syncFormChrome();
  }

  function paintAll() {
    host.classList.add("af");
    host.innerHTML = `<style>${STYLE}</style>${skeletonHtml()}`;
    paintFilters();
    paintList();
    paintForm();
  }

  async function request(path, init) {
    const result = await callApi(api, path, init);
    if (result.ok) return result;
    // 卸载之后回来的失败既不提示也不回登录页：那块界面已经不在页面上了，弹一句"权限不足"
    // 会挂在别人的页面上，而且没人知道它在说什么。
    if (!state.alive) return result;
    const code = String(result.error?.code ?? "");
    if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID") {
      // 401 的"回登录页/清票据"是挂载方的事（`ctx.api` 已经做了一次），这里只补一个主动信号。
      if (onSignOut !== null) onSignOut();
    }
    toast(errorText(result.error));
    return result;
  }

  async function loadProductLines() {
    const result = await request("/api/admin/product-lines", { method: "GET" });
    if (!state.alive) return;
    if (!result.ok) {
      // 产线字典挂了也要能看列表：下拉留空，列表照常（否则整块面板变空白）。
      paintFilters();
      return;
    }
    state.productLines = Array.isArray(result.data?.items) ? result.data.items : [];
    paintFilters();
    if (state.form !== null && state.form.mode === "create" && state.form.product_line === "") {
      state.form.product_line = defaultProductLine();
      paintForm();
    }
  }

  async function loadList() {
    const seq = ++state.listSeq;
    setListStatus("正在加载…", "loading");
    const result = await request(`/api/admin/faults?${buildListQuery(state.filters, state.page)}`, { method: "GET" });
    if (!state.alive || seq !== state.listSeq) return;
    if (!result.ok) {
      state.rows = [];
      state.total = 0;
      paintList();
      setListStatus(errorText(result.error), "error");
      return;
    }
    const items = Array.isArray(result.data?.items) ? result.data.items : [];
    state.rows = items;
    state.total = Number(result.data?.total ?? items.length);
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    if (state.page > pages) {
      // 筛选之后总数变少：回到最后一页，而不是停在一个空页上（"没有数据"与"翻过头了"要分开）。
      state.page = pages;
      void loadList();
      return;
    }
    paintList();
    setListStatus("", "");
  }

  async function openRow(key) {
    const { code, productLine } = parseFaultKey(key);
    if (code === "" || productLine === "") return;
    state.selected = key;
    paintList();
    const seq = ++state.detailSeq;
    setListStatus("正在读取故障卡…", "loading");
    const result = await request(
      `/api/admin/faults/${encodeURIComponent(code)}?product_line=${encodeURIComponent(productLine)}`,
      { method: "GET" },
    );
    if (!state.alive || seq !== state.detailSeq) return;
    if (!result.ok) {
      setListStatus(errorText(result.error), "error");
      return;
    }
    state.form = formFromDetail(result.data);
    setListStatus("", "");
    paintForm();
  }

  function selectTab(lang) {
    const form = state.form;
    const formHost = find('[data-af="form"]');
    if (form === null || formHost === null || !LANGS.includes(lang)) return;
    form.activeTab = lang;
    for (const button of formHost.querySelectorAll("[data-af-tab]")) {
      button.setAttribute("aria-selected", String(button.getAttribute("data-af-tab") === lang));
    }
    for (const pane of formHost.querySelectorAll("[data-af-pane]")) {
      pane.hidden = pane.getAttribute("data-af-pane") !== lang;
    }
  }

  function setFilter(key, value) {
    state.filters = { ...state.filters, [key]: value };
    state.page = 1;
    state.selected = "";
    state.form = null;
    paintForm();
    void loadList();
  }

  function setBusy(on) {
    state.busy = on;
    syncFormChrome();
  }

  async function submitSave(form) {
    const creating = form.mode === "create";
    if (creating) {
      const code = String(form.code ?? "").trim().toUpperCase();
      if (!FAULT_CODE_RE.test(code)) {
        toast("故障码必须是字母 + 2~3 位数字，例如 E03");
        return;
      }
      if (String(form.product_line ?? "").trim() === "") {
        toast("请选择产品线");
        return;
      }
    }
    const path = creating
      ? "/api/admin/faults"
      : `/api/admin/faults/${encodeURIComponent(form.code)}?product_line=${encodeURIComponent(form.product_line)}`;
    const body = creating ? createBody(form) : patchBody(form);
    const before = form.status;
    setBusy(true);
    const result = await request(path, { method: creating ? "POST" : "PATCH", body });
    if (!state.alive) return;
    setBusy(false);
    if (!result.ok) return;
    if (creating) {
      state.form = formFromDetail(result.data);
      state.selected = faultKey(result.data);
      paintForm();
      paintList();
      void loadList();
      toast("已新建草稿（draft）；补齐五语后可发布。");
      return;
    }
    const changed = Array.isArray(result.data?.changed) ? result.data.changed : [];
    state.form = formFromDetail(result.data?.fault, form.activeTab);
    state.selected = faultKey(state.form);
    paintForm();
    paintList();
    void loadList();
    // 发布态被改过就落回草稿（`core/admin-store.ts` 的 updateFault）：这句话必须出现，
    // 否则人会以为"改完就上线了"，而用户看到的还是旧文案。
    if (changed.length === 0) toast("没有改动");
    else if (before === "published") toast("已保存；发布态落回草稿，需要重新发布");
    else toast("已保存");
  }

  async function submitStatus(form, action) {
    const path = `/api/admin/faults/${encodeURIComponent(form.code)}/${action}?product_line=${encodeURIComponent(form.product_line)}`;
    setBusy(true);
    const result = await request(path, { method: "POST" });
    if (!state.alive) return;
    setBusy(false);
    if (!result.ok) return;
    const changed = Array.isArray(result.data?.changed) ? result.data.changed : [];
    state.form = formFromDetail(result.data?.fault, form.activeTab);
    state.selected = faultKey(state.form);
    paintForm();
    paintList();
    void loadList();
    if (action === "publish") toast(changed.length === 0 ? "已经是发布态" : "已发布");
    else toast(changed.length === 0 ? "已经是归档态" : "已归档（对外不再可见）");
  }

  async function runAction(name) {
    if (name === "reload") {
      void loadProductLines();
      void loadList();
      return;
    }
    if (name === "new") {
      state.form = emptyForm(defaultProductLine());
      state.selected = "";
      paintList();
      paintForm();
      const input = find('[data-af-field="form-code"]');
      if (input !== null && typeof input.focus === "function") input.focus();
      return;
    }
    if (name === "close") {
      state.form = null;
      state.selected = "";
      paintList();
      paintForm();
      return;
    }
    const form = state.form;
    if (form === null || state.busy) return;
    if (name === "save") return submitSave(form);
    if (name === "publish" || name === "archive") return submitStatus(form, name);
  }

  function onClick(event) {
    const target = event.target;
    const tab = closestIn(target, "[data-af-tab]");
    if (tab !== null) {
      selectTab(String(tab.getAttribute("data-af-tab") ?? ""));
      return;
    }
    const action = closestIn(target, "[data-af-act]");
    if (action !== null) {
      if (action.disabled === true) return;
      const name = String(action.getAttribute("data-af-act") ?? "");
      if (name === "prev" || name === "next") {
        const next = name === "next" ? state.page + 1 : state.page - 1;
        if (next < 1 || state.page === next) return;
        state.page = next;
        void loadList();
        return;
      }
      void runAction(name);
      return;
    }
    const row = closestIn(target, "[data-af-row]");
    if (row !== null) void openRow(String(row.getAttribute("data-af-row") ?? ""));
  }

  function onChange(event) {
    const node = event.target;
    if (node === null || typeof node !== "object" || typeof node.getAttribute !== "function") return;
    const field = String(node.getAttribute("data-af-field") ?? "");
    const form = state.form;
    if (field === "filter-product-line") return setFilter("product_line", String(node.value ?? ""));
    if (field === "filter-severity") return setFilter("severity", String(node.value ?? ""));
    if (field === "filter-status") return setFilter("status", String(node.value ?? ""));
    if (field === "filter-missing") return setFilter("missing_lang", node.checked === true);
    if (form === null) return;
    if (field === "form-severity") {
      form.severity = String(node.value ?? "");
      syncFormChrome();
      return;
    }
    if (field === "form-product-line") {
      form.product_line = String(node.value ?? "");
      syncFormChrome();
    }
  }

  function onInput(event) {
    const node = event.target;
    if (node === null || typeof node !== "object" || typeof node.getAttribute !== "function") return;
    const form = state.form;
    if (form === null) return;
    const field = String(node.getAttribute("data-af-field") ?? "");
    if (field === "form-code") {
      form.code = String(node.value ?? "");
      syncFormChrome();
      return;
    }
    const kind = String(node.getAttribute("data-af-kind") ?? "");
    const lang = String(node.getAttribute("data-af-lang") ?? "");
    if ((kind !== "desc" && kind !== "act") || !LANGS.includes(lang)) return;
    form[kind][lang] = String(node.value ?? "");
    // 只更新圆点与按钮，**不重画正文**：重画会把光标与正在输入的 IME 组合串一起扔掉。
    syncFormChrome();
  }

  function onKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = closestIn(event.target, "[data-af-row]");
    if (row === null || event.target !== row) return;
    event.preventDefault();
    void openRow(String(row.getAttribute("data-af-row") ?? ""));
  }

  host.addEventListener("click", onClick);
  host.addEventListener("change", onChange);
  host.addEventListener("input", onInput);
  host.addEventListener("keydown", onKeyDown);

  paintAll();
  void (async () => {
    await loadProductLines();
    if (!state.alive) return;
    await loadList();
  })();

  return function unmount() {
    state.alive = false;
    // 让在途请求的回填全部落空（`loadList`/`openRow` 在 await 之后都会看 `alive` 与序号）。
    state.listSeq += 1;
    state.detailSeq += 1;
    host.removeEventListener("click", onClick);
    host.removeEventListener("change", onChange);
    host.removeEventListener("input", onInput);
    host.removeEventListener("keydown", onKeyDown);
    host.classList.remove("af");
    host.innerHTML = "";
  };
}
