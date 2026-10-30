/**
 * 知识库面板（`09#05` / `docs/prdv1.3/scope-delta.md` S5 / `.scratch/09-admin-console/issues/05-kb-crud.md`）。
 *
 * 这块面板解决的是"知识库只能靠 `scripts/ingest.ts` 从 corpus/ 整目录灌"：改一篇文档要上机器、
 * 跑一遍全量入库。在界面上这条通路等于不存在，于是"文档能不能改"取决于谁手上有那台服务器。
 *
 * 一个模块、一个出口：`mount(host, ctx) → unmount`（契约与 `console-admin-shell.js` 文件头逐字一致）。
 * 父容器只给一个空 `<div>`；所有网络都走 `ctx.api`（票据、401 清场、403 只提示都在那一层，本模块看不见票据）。
 *
 * 三条设计约束，与 `console-admin-faults.js` 同一套（为了能在 node 里直接断言）：
 *   1. **顶层零副作用**：不发请求、不碰宿主全局对象；可测的判定全部是导出纯函数，DOM 只活在 `mount()` 里。
 *   2. **写权限写成纯函数（`canWrite`）**：`lead` 进知识库是**只读** —— 按钮禁用、页面上写明"编辑需要 admin"，
 *      而不是藏起来等人点了才发现 403。接口层（`ROUTE_MIN_ROLE` + `requireRole`）仍然会再判一次；
 *      前端这一层只负责省掉那次白点。
 *   3. **保存 ≠ 生效**：改写正文只落库，检索读的是 `chunks`。所以保存后一律提示"需重建才生效"，
 *      重建进度靠轮询 `GET .../rebuild` 拿，失败时把后端 `error` **原文**显示出来 ——
 *      吞掉它等于让人对着"重建失败"四个字猜原因。
 *
 * 与后端（另一条并行流在实现，本文件按冻结契约写，字段名一个不改）：
 *   GET    /api/admin/documents?page&size&status&lang&product_line   （lead）
 *   GET    /api/admin/documents/:id                                  （lead）
 *   POST   /api/admin/documents       { title, lang, body, product_line? }   → 201，落 `pending`（admin）
 *   PATCH  /api/admin/documents/:id   { title?, body?, lang?, product_line? }（admin）
 *   POST   /api/admin/documents/:id/rebuild   → 202 { job_id, status:"running" }（admin）
 *   GET    /api/admin/documents/:id/rebuild   → { job_id, status, error, chunk_count, ... }（admin）
 *   POST   /api/admin/documents/:id/rollback  → 200（admin）
 *   POST   /api/admin/documents/:id/archive   → 200（admin，停用，行不删）
 *
 * 语言名**不在这里抄第二份**：`LANG_NAMES` 的唯一真源是 `lib/lang.js`（用户端顶部语言菜单也用它）。
 */

import { LANG_NAMES, SUPPORTED_LANGS } from "./lang.js";

/* ───────────────────────── 常量 ───────────────────────── */

/** 五语种顺序 = `lib/lang.js` 的 `SUPPORTED_LANGS` = 后端 `documents.lang` 的 check 约束。 */
export const LANGS = SUPPORTED_LANGS;

/**
 * 一页多少条 = `api/params.ts` 的 `size` 缺省档（与待审反馈面板同一个数）。
 * 查询串里**显式**带 `size`：两处默认值将来各改一半时，面板至少还是自洽的。
 */
export const PAGE_SIZE = 20;

/** 重建轮询间隔：1.5 秒一次。入库是切块 + embedding，短于它只是把库按在地上摩擦。 */
export const REBUILD_POLL_MS = 1500;

/** 轮询上限 40 次 ≈ 60 秒。超时不是失败，只是"这一屏不再等"，结果仍可在列表里看到。 */
export const REBUILD_POLL_LIMIT = 40;

/**
 * 默认筛选 = 全部状态、全部语言。
 * 与故障卡面板的"默认不含已归档"不同：知识库的量级是几十篇，已停用的文档也要看得见 ——
 * 它是"停用"不是"删除"，人要能查到一份停了的历史文档还在不在。
 *
 * `product_line` 在契约里是一个可选筛选参数，界面上暂时没有控件（产线在表单里选，
 * "按产线筛文档"的需求还没出现）；先把参数留着，`buildListQuery` 已经有了它的口径。
 */
export const DEFAULT_FILTERS = Object.freeze({ status: "", lang: "", product_line: "" });

/** 文档状态（`documents.status`）→ 文案与色带。`archived` 是停用态（行不删）。 */
export const DOC_STATUS = Object.freeze({
  pending: Object.freeze({ label: "待建索引", tone: "warn" }),
  indexed: Object.freeze({ label: "已建索引", tone: "ok" }),
  failed: Object.freeze({ label: "建索引失败", tone: "error" }),
  archived: Object.freeze({ label: "已停用", tone: "muted" }),
});

/**
 * 重建作业状态（`GET .../rebuild` 的 `status`）→ 文案与色带。
 *
 * **`succeeded` 才是后端的真话**（`document_rebuild_jobs.status` 的 check 约束就是
 * `running|succeeded|failed`，加上没作业行时的 `idle`）；`ok` 只是这一版契约里写的别名，
 * 一直保留：两种写法都认，就不会因为某一侧先改而把"重建成功"显示成"尚未重建"。
 */
export const REBUILD_STATUS = Object.freeze({
  idle: Object.freeze({ label: "未重建", tone: "muted" }),
  running: Object.freeze({ label: "重建中", tone: "warn" }),
  succeeded: Object.freeze({ label: "重建完成", tone: "ok" }),
  ok: Object.freeze({ label: "重建完成", tone: "ok" }),
  failed: Object.freeze({ label: "重建失败", tone: "error" }),
});

/** 这一跳之后还要不要继续轮询："成功"与"失败"都是终态，两种写法都算。 */
const SUCCESS_STATUSES = new Set(["ok", "succeeded"]);

/** 状态是不是"建好了"。面板里所有"成功了没有"的判断都走这一处。 */
export function isRebuildDone(status) {
  return SUCCESS_STATUSES.has(String(status ?? "").trim().toLowerCase());
}

/** 状态筛选（顺序即下拉顺序，由 `DOC_STATUS` 推导，不另写一份清单）。 */
export const STATUS_OPTIONS = Object.freeze([
  Object.freeze(["", "全部状态"]),
  ...Object.entries(DOC_STATUS).map(([value, meta]) => Object.freeze([value, meta.label])),
]);

/**
 * 空态文案。`unavailable` 是"接口还没就绪"那一档 —— 后端此刻可能还没上线（并行开发），
 * 面板必须说清"是通路不在，不是你没有文档"，而不是留一片白。
 */
export const EMPTY_TEXT = Object.freeze({
  none: "没有符合条件的文档。新建一篇并「重建」后，它才会进入检索。",
  unavailable: "知识库接口暂时不可用（或还没就绪），这一屏没有数据。工单与故障卡不受影响。",
});

/* ───────────────────────── 小工具 ───────────────────────── */

/**
 * 唯一的转义出口。与故障卡 / 待审反馈面板各有一份同一个实现（那两块互不 import，
 * 谁被删掉都不影响别人）；正文是 markdown，`</textarea>`、`<script>` 出现在里面完全正常。
 */
export function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

/** 时间：本地 `YYYY-MM-DD HH:MM`（不用 Intl，免得同一串在不同环境给出不同形状）。 */
export function formatStamp(value) {
  const text = String(value ?? "");
  if (text === "") return "—";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function optionsHtml(options, current) {
  return options
    .map(
      ([value, label]) =>
        `<option value="${esc(value)}"${String(current) === String(value) ? " selected" : ""}>${esc(label)}</option>`,
    )
    .join("");
}

/* ───────────────────────── 状态与语言文案 ───────────────────────── */

/**
 * 文档状态 → `{ label, tone }`。未知值原样显示（`tone: "neutral"`）：
 * 后端加一个新状态时，面板该把那个词露出来让人报 bug，而不是悄悄吞成"—"。
 */
export function docStatus(status) {
  const key = String(status ?? "").trim();
  const found = DOC_STATUS[key];
  if (found !== undefined) return { label: found.label, tone: found.tone };
  return { label: key === "" ? "—" : key, tone: "neutral" };
}

/** 重建作业状态 → `{ label, tone }`；未知值同上（原样显示，不崩）。 */
export function rebuildStatus(status) {
  const key = String(status ?? "").trim().toLowerCase();
  const found = REBUILD_STATUS[key];
  if (found !== undefined) return { label: found.label, tone: found.tone };
  return { label: key === "" ? "—" : key, tone: "neutral" };
}

/** 语言码 → 母语名（`de` → `Deutsch`）。未知码原样显示，空给破折号。 */
export function langLabel(lang) {
  const raw = String(lang ?? "");
  const key = raw.trim().toLowerCase();
  return LANG_NAMES[key] ?? (raw === "" ? "—" : raw);
}

/** 语言下拉：`全部语言` 那一条只在筛选里出现；表单里必须是五选一。 */
export function langOptions(includeAll = false) {
  const list = LANGS.map((lang) => [lang, `${LANG_NAMES[lang] ?? lang}（${lang}）`]);
  return includeAll ? [["", "全部语言"], ...list] : list;
}

/** 块数：认不出的值给破折号（`0` 是真实的"重建过但没切出块"，要显示 0）。 */
export function chunkText(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(Math.trunc(number)) : "—";
}

/** 版本：`v3`；`0` / 缺失给破折号（版本 0 = 还没有可回滚的上一版）。 */
export function versionText(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? `v${Math.trunc(number)}` : "—";
}

/* ───────────────────────── 写权限 ───────────────────────── */

/**
 * 能不能写（新建 / 编辑 / 重建 / 回滚 / 停用）。返回 `{ enabled, reason }`。
 *
 * 判据与 `src/api/roles.ts` 的 `GET|POST|PATCH /api/admin/documents*` 最低角色同源：`admin`。
 * 未知角色按"不可写"处理 —— 与 `src/auth.ts` 的 `requireRole` 同口径（未知按最低档，不按最高档）。
 * 注意 `reason` 是要**显示在页面上**的：它是 `lead` 唯一的线索，不能写一句"无权限"了事。
 */
export function canWrite(role) {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "admin") return { enabled: true, reason: "" };
  if (normalized === "lead") {
    return { enabled: false, reason: "只读：知识库的新建 / 编辑 / 重建 / 回滚 / 停用需要管理员（admin）角色。" };
  }
  return { enabled: false, reason: "只读：知识库管理需要管理员（admin）角色。" };
}

/** 面板顶部那行角色说明（一行，说清"你现在能做什么"）。 */
export function roleNote(role) {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "admin") return "你是管理员（admin）：可以新建、编辑、重建索引、回滚与停用。";
  return "你是只读角色：能看文档与索引状态，编辑需要 admin。";
}

/* ───────────────────────── 表单校验与请求体 ───────────────────────── */

/**
 * 表单校验：标题空 / 语言不合五语 / 正文空 → 报错。
 * **在校验通过之前不发请求**：POST 一个空标题只会换回 400，用户还得猜是哪个字段。
 * `message` 只带第一条（界面上一行字就够），`errors` 给逐字段的高亮用。
 */
export function validateForm(form) {
  const source = form ?? {};
  const title = String(source.title ?? "").trim();
  const lang = String(source.lang ?? "").trim().toLowerCase();
  const body = typeof source.body === "string" ? source.body : "";
  const errors = {};
  if (title === "") errors.title = "标题不能为空。";
  if (!LANGS.includes(lang)) errors.lang = `语言必须是五语之一（${LANGS.join(" / ")}）。`;
  if (body.trim() === "") errors.body = "正文不能为空（空文档重建后切不出任何块）。";
  const message = errors.title ?? errors.lang ?? errors.body ?? "";
  return { ok: message === "", errors, message };
}

/**
 * 请求体：新建与编辑同形（`title` / `lang` / `body` 一律全发，`product_line` 非空才带）。
 *
 * 为什么编辑也全发：表单里本来就握着完整的一份文档（详情接口给了 `body`），
 * 传"只发改过的字段"需要在前端记一份 diff，而 diff 记错的结果是"界面上改了、库里没变"。
 * `product_line` 为空时不带 —— 契约里它是**可选**，发空串到底是"清空"还是"不改"契约没写，
 * 与其猜，不如不表态（面板上也就不提供"清空产线"，产线是文档归属，改归属是一次编辑而不是一次删除）。
 */
export function bodyOf(form) {
  const source = form ?? {};
  const body = {
    title: String(source.title ?? "").trim(),
    lang: String(source.lang ?? "").trim().toLowerCase(),
    body: typeof source.body === "string" ? source.body : "",
  };
  const line = String(source.product_line ?? "").trim();
  if (line !== "") body.product_line = line;
  return body;
}

export function createBody(form) {
  return bodyOf(form);
}

export function patchBody(form) {
  return bodyOf(form);
}

/** 空表单：语言默认第一门（`zh`），产线留空（"不指定"），状态是后端会给的 `pending`。 */
export function emptyForm(lang = LANGS[0]) {
  const value = LANGS.includes(String(lang)) ? String(lang) : LANGS[0];
  return {
    mode: "create",
    id: "",
    title: "",
    lang: value,
    product_line: "",
    body: "",
    status: "pending",
    chunk_count: 0,
    version: 0,
    updated_at: null,
    rebuild: normalizeRebuild(null),
  };
}

/**
 * 详情 → 表单状态。`row` 是列表里那一行：详情契约不含 `created_at` / `updated_at`，
 * 而"更新于什么时候"恰恰是这个面板最需要的一格，所以从列表行补（缺了也不编，显示破折号）。
 */
export function formFromDetail(detail, row) {
  const source = detail !== null && typeof detail === "object" ? detail : {};
  const listRow = row !== null && typeof row === "object" ? row : {};
  const lang = String(source.lang ?? "").trim().toLowerCase();
  return {
    mode: "edit",
    id: String(source.id ?? listRow.id ?? ""),
    title: typeof source.title === "string" ? source.title : String(listRow.title ?? ""),
    lang: LANGS.includes(lang) ? lang : LANGS[0],
    product_line: typeof source.product_line === "string" ? source.product_line : String(listRow.product_line ?? ""),
    body: typeof source.body === "string" ? source.body : "",
    status: String(source.status ?? listRow.status ?? "pending"),
    chunk_count: source.chunk_count ?? listRow.chunk_count ?? 0,
    version: source.version ?? listRow.version ?? 0,
    updated_at: source.updated_at ?? listRow.updated_at ?? listRow.created_at ?? null,
    rebuild: normalizeRebuild(source.rebuild),
  };
}

/**
 * 重建作业体归一：**不认识的 `status` 原样保留**（映射成 `idle` 会让面板显示"未重建"，
 * 而真相是"后端有个我没见过的状态"，那种谎话比破折号贵得多）。
 */
export function normalizeRebuild(job) {
  const source = job !== null && typeof job === "object" ? job : {};
  const raw = String(source.status ?? "idle").trim().toLowerCase();
  const count = Number(source.chunk_count);
  return {
    job_id: source.job_id ?? null,
    status: raw === "" ? "idle" : raw,
    error: typeof source.error === "string" && source.error.trim() !== "" ? source.error.trim() : null,
    chunk_count: Number.isFinite(count) ? count : null,
    started_at: source.started_at ?? null,
    finished_at: source.finished_at ?? null,
  };
}

/** 重建状态 → 面板上那一行字。`failed` 必须把后端原文带出来（不许只说"失败"）。 */
export function rebuildResultText(job) {
  const status = String(job?.status ?? "idle").trim().toLowerCase();
  const chunk = job?.chunk_count;
  const chunkPart = chunk === null || chunk === undefined ? "" : `：索引 ${chunkText(chunk)} 块`;
  if (status === "running") return "重建中…（切走面板会停止轮询，结果仍可在列表里看到）";
  // `job_id: null` + 成功 = 这篇的索引不是"点重建"点出来的（FAQ 审批直通建索引，后端合成一条 succeeded）
  if (isRebuildDone(status)) {
    const direct = job?.job_id === null || job?.job_id === undefined ? "（审批直通建索引）" : "";
    return chunkPart === "" ? `重建完成${direct}。` : `重建完成${direct}${chunkPart}。`;
  }
  if (status === "failed") {
    const error = typeof job?.error === "string" ? job.error.trim() : "";
    return error === "" ? "重建失败（后端没有给出原因）。" : `重建失败：${error}`;
  }
  return "尚未重建：改动保存后要点「重建」才会进检索。";
}

/* ───────────────────────── 轮询决策 ───────────────────────── */

/**
 * 一次轮询之后该怎么办 —— **纯函数，不真的 setTimeout**。
 *
 * 返回 `{ action, delayMs?, tone, message }`：
 *   `ok` / `succeeded` → `stop`（重建成功，刷新列表与详情）
 *   `failed`  → `stop`（把 `error` 原文显示出来；再轮询一万次也还是这个错）
 *   其他（`running` / `idle` / 没见过的状态）→ 到上限前 `continue`，到上限 `timeout`
 *
 * `attempt` 是**已经发过的 GET 次数**：调用方先 `attempt += 1` 再判，于是 `limit` 就是总请求数上限。
 * 超时不是错误（`tone: "warn"`）：后端可能真的在跑一次很大的入库，前端只是不再等了。
 */
export function pollDecision(status, attempt, limit = REBUILD_POLL_LIMIT) {
  const key = String(status ?? "").trim().toLowerCase();
  const tried = Math.max(0, Math.trunc(Number(attempt) || 0));
  const cap = Math.max(1, Math.trunc(Number(limit) || 0) || REBUILD_POLL_LIMIT);
  if (isRebuildDone(key)) return { action: "stop", tone: "ok", message: "重建完成。" };
  if (key === "failed") return { action: "stop", tone: "error", message: "重建失败。" };
  if (tried >= cap) {
    const seconds = Math.round((cap * REBUILD_POLL_MS) / 1000);
    return {
      action: "timeout",
      tone: "warn",
      message: `重建仍在进行（已等待约 ${seconds} 秒），稍后刷新或再点一次「重建」查看结果。`,
    };
  }
  return { action: "continue", delayMs: REBUILD_POLL_MS, tone: "warn", message: "正在重建…" };
}

/* ───────────────────────── 查询、分页与错误文案 ───────────────────────── */

/** 筛选 → 查询串。空值不发（少一个参数就少一次看错的机会）；`size` 一律显式带。 */
export function buildListQuery(filters, page = 1) {
  const merged = { ...DEFAULT_FILTERS, ...(filters ?? {}) };
  const params = new URLSearchParams();
  const status = String(merged.status ?? "").trim();
  if (status !== "") params.set("status", status);
  const lang = String(merged.lang ?? "").trim().toLowerCase();
  if (lang !== "") params.set("lang", lang);
  const line = String(merged.product_line ?? "").trim();
  if (line !== "") params.set("product_line", line);
  const wanted = Math.trunc(Number(page));
  params.set("page", String(Number.isFinite(wanted) && wanted > 1 ? wanted : 1));
  params.set("size", String(PAGE_SIZE));
  return params.toString();
}

/**
 * 分页信息：`{ total, page, pages, hasPrev, hasNext, text }`。
 * `page` 先夹在 `[1, pages]` 再交给调用方，按钮禁用与"第 x / y 页"就用同一个数 ——
 * 否则会出现"显示第 3 页、上一页还是灰的"。
 */
export function pageInfo(total, page) {
  const count = Math.max(0, Math.trunc(Number(total) || 0));
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const wanted = Math.trunc(Number(page) || 1);
  const current = Math.min(Math.max(1, wanted), pages);
  return {
    total: count,
    page: current,
    pages,
    hasPrev: current > 1,
    hasNext: current < pages,
    text: `第 ${current} / ${pages} 页 · 共 ${count} 条`,
  };
}

/** 错误码 → 面板上能直接显示的一句话（后端 message 是英文给日志看的）。 */
export function errorText(error) {
  const code = String(error?.code ?? "");
  const message = typeof error?.message === "string" ? error.message : "";
  if (code === "FORBIDDEN") return "权限不足：知识库的写操作需要管理员（admin）角色。";
  if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID") return "登录状态已失效，请重新登录。";
  if (code === "NETWORK") return "连不上服务端，请确认服务已启动。";
  if (code === "NOT_FOUND") return "知识库接口还没就绪（404），或这篇文档已不存在。";
  if (code === "CONFLICT") return message === "" ? "文档已变化，请刷新后重试。" : message;
  if (code === "VALIDATION") return message === "" ? "参数不合法。" : message;
  if (/^HTTP_5\d\d$/.test(code)) return "服务端出错了，这一屏的数据可能不是最新。";
  return message === "" ? "请求失败。" : message;
}

/**
 * 把 `ctx.api` 的返回值归一成 `{ ok, data } | { ok: false, error }`。
 * 两种挂载都认：契约上的信封（`{ ok, data }`）与坐席端现有的 `api()`（成功回 data、失败抛）。
 * 一份适配代码，胜过让两侧各记住一种约定。
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

/* ───────────────────────── HTML 片段（纯字符串） ───────────────────────── */

/** 列表体的两种常见包装都认（契约是 `data.items`）：形状差一层不该把面板打成空白。 */
export function listItems(data) {
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.documents)) return data.documents;
  return [];
}

/** 详情体：契约是 `data` 本体；`data.document` 这种包装也认。 */
export function pickDocument(data) {
  const source = data?.document ?? data;
  return source !== null && typeof source === "object" ? source : {};
}

export function filtersHtml(filters, role) {
  const merged = { ...DEFAULT_FILTERS, ...(filters ?? {}) };
  const write = canWrite(role);
  return `<label class="ak-field"><span class="ak-label">状态</span>
    <select class="ak-select" data-ak-field="filter-status" aria-label="按状态筛选">${optionsHtml(STATUS_OPTIONS, merged.status)}</select></label>
  <label class="ak-field"><span class="ak-label">语言</span>
    <select class="ak-select" data-ak-field="filter-lang" aria-label="按语言筛选">${optionsHtml(langOptions(true), merged.lang)}</select></label>
  <span class="ak-spacer"></span>
  <button class="ak-btn ak-btn-primary" type="button" data-ak-act="new"${write.enabled ? "" : ` disabled title="${esc(write.reason)}"`}>新建文档</button>`;
}

/**
 * 表格行：`标题 | 语言 | 状态 | 块数 | 版本 | 更新时间`。
 * 停用行挂 `is-archived`（标题加删除线）：它还在库里，但用户已经检索不到它了。
 */
export function rowsHtml(rows, selectedId = "") {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((row) => {
      const id = String(row?.id ?? "");
      const status = docStatus(row?.status);
      const archived = String(row?.status ?? "") === "archived";
      const selected = id !== "" && id === String(selectedId ?? "");
      return `<tr class="ak-row${selected ? " is-selected" : ""}${archived ? " is-archived" : ""}" data-ak-row="${esc(id)}" tabindex="0" aria-selected="${selected}">
  <td class="ak-doc-title" title="${esc(row?.title ?? "")}">${esc(row?.title ?? "")}</td>
  <td><span class="ak-lang">${esc(langLabel(row?.lang))}</span></td>
  <td><span class="ak-badge" data-tone="${esc(status.tone)}">${esc(status.label)}</span></td>
  <td class="ak-num">${esc(chunkText(row?.chunk_count))}</td>
  <td class="ak-num">${esc(versionText(row?.version))}</td>
  <td class="ak-time">${esc(formatStamp(row?.updated_at ?? row?.created_at))}</td>
</tr>`;
    })
    .join("");
}

/** 产线下拉：字典里的全部产线（含已停用，标出来）+ 当前值兜底 + "不指定"。 */
export function productLineOptions(lines, current) {
  const list = Array.isArray(lines) ? lines : [];
  const options = [["", "（不指定产线）"]];
  for (const line of list) {
    const code = String(line?.code ?? "");
    if (code === "") continue;
    const name = String(line?.name ?? code);
    options.push([code, line?.active === false ? `${name}（已停用）` : name]);
  }
  const value = String(current ?? "");
  // 文档上已有的产线不在字典里（历史数据 / 字典还没建）：补一个选项，
  // 否则下拉会落到第一项，保存一次就把归属悄悄抹掉了。
  if (value !== "" && !options.some(([code]) => code === value)) options.push([value, `${value}（字典里没有）`]);
  return options;
}

/** 表单的输入区（标题 / 语言 / 产线 / markdown 正文）。只在这一篇文档换了或保存成功后重画。 */
export function formFieldsHtml(form, productLines) {
  const source = form ?? {};
  const creating = source.mode === "create";
  const status = docStatus(source.status);
  const lang = LANGS.includes(String(source.lang ?? "")) ? String(source.lang) : LANGS[0];
  const stamp = source.updated_at === null || source.updated_at === undefined ? "" : ` · 更新于 ${esc(formatStamp(source.updated_at))}`;
  return `<div class="ak-form-head">
    <div class="ak-form-title">
      <span class="ak-form-name">${creating ? "新建文档" : esc(source.title === "" ? "（无标题）" : source.title)}</span>
      <span class="ak-badge" data-tone="${esc(status.tone)}">${esc(status.label)}</span>
    </div>
    <p class="ak-note">${
      creating
        ? "新建后状态是「待建索引」；保存只落库，点「重建」才进检索。"
        : `${esc(versionText(source.version))} · ${esc(chunkText(source.chunk_count))} 块${stamp}`
    }</p>
  </div>
  <div class="ak-form-fields">
    <label class="ak-field ak-field-wide"><span class="ak-label">标题</span>
      <input class="ak-input" type="text" data-ak-field="form-title" value="${esc(source.title ?? "")}" maxlength="200" autocomplete="off" spellcheck="false" aria-label="文档标题"></label>
    <label class="ak-field"><span class="ak-label">语言</span>
      <select class="ak-select" data-ak-field="form-lang" aria-label="文档语言">${optionsHtml(langOptions(false), lang)}</select></label>
    <label class="ak-field"><span class="ak-label">产线</span>
      <select class="ak-select" data-ak-field="form-product-line" aria-label="所属产线">${optionsHtml(
        productLineOptions(productLines, source.product_line),
        source.product_line,
      )}</select></label>
  </div>
  <label class="ak-field ak-field-block"><span class="ak-label">正文（markdown）</span>
    <textarea class="ak-input ak-textarea" rows="16" data-ak-field="form-body" aria-label="文档正文（markdown）" spellcheck="false">${esc(
      source.body ?? "",
    )}</textarea></label>`;
}

/**
 * 表单底部那句"该做什么"。一次只说最该做的那件事（与故障卡面板的 `formNote` 同一套语法）。
 */
export function formNote(form, role) {
  const source = form ?? {};
  const status = String(source.status ?? "");
  const write = canWrite(role);
  if (!write.enabled) return write.reason;
  if (source.mode === "create") return "填好标题与正文后保存；保存只落库，还要点「重建」才会进检索。";
  if (status === "archived") return "已停用：保留历史引用，但不再参与检索，也不能再编辑或重建。";
  if (status === "failed") return "上一次建索引失败了。改完正文后再点「重建」重试。";
  if (status === "pending") return "还没建索引：点「重建」后才会进入检索。";
  return "改动保存后需要重新「重建」才会生效。";
}

/* ───────────────────────── 样式（只在本模块的 `.ak` 前缀下生效） ───────────────────────── */

const STYLE = `
.ak{display:flex;flex-direction:column;gap:var(--s3,12px);box-sizing:border-box;min-height:100%;font-size:var(--t-sm,13px);line-height:1.5;color:var(--c-text,#0f172a);background:var(--c-bg,#f8fafc)}
.ak *{box-sizing:border-box}
.ak-list,.ak-form{display:flex;flex-direction:column;gap:var(--s2,8px);padding:var(--s4,16px);border:1px solid var(--c-border,#e2e8f0);border-radius:var(--r-md,8px);background:var(--c-surface,#fff)}
.ak-form[hidden]{display:none}
.ak-toolbar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--s2,8px)}
.ak-field{display:flex;flex-direction:column;gap:2px}
.ak-field-wide{min-width:240px;flex:1 1 240px}
.ak-field-block{gap:4px}
.ak-label{font-size:var(--t-cap,11px);font-weight:600;color:var(--c-muted,#64748b);text-transform:uppercase;letter-spacing:.02em}
.ak-select,.ak-input{font:inherit;color:inherit;background:var(--c-surface,#fff);border:1px solid var(--c-border,#e2e8f0);border-radius:var(--r-sm,6px);padding:6px 8px;min-height:34px}
.ak-select{min-width:130px}
.ak-input:focus-visible,.ak-select:focus-visible,.ak-btn:focus-visible,.ak-row:focus-visible{outline:2px solid var(--c-cta,#0369a1);outline-offset:1px}
.ak-textarea{width:100%;resize:vertical;min-height:280px;font-family:var(--font-mono,ui-monospace,monospace);font-size:var(--t-sm,13px);line-height:1.55}
.ak-spacer{flex:1 1 auto}
.ak-btn{font:inherit;font-weight:600;min-height:34px;padding:0 12px;border:1px solid var(--c-border,#e2e8f0);border-radius:var(--r-sm,6px);background:var(--c-surface,#fff);color:inherit;cursor:pointer}
.ak-btn:disabled{opacity:.5;cursor:not-allowed}
.ak-btn-primary{background:var(--c-cta,#0369a1);border-color:transparent;color:#fff}
.ak-btn-go{background:var(--c-st-closed,#22c55e);border-color:transparent;color:#08240f}
.ak-btn-danger{color:var(--c-st-sla,#ef4444);border-color:color-mix(in srgb,var(--c-st-sla,#ef4444) 45%,transparent)}
.ak-btn-ghost{background:transparent}
.ak-actions{display:flex;flex-wrap:wrap;gap:8px}
.ak-status{font-size:var(--t-sm,13px)}
.ak-status:empty{display:none}
.ak-status[data-tone="error"]{padding:6px 10px;border-left:3px solid var(--c-st-sla,#ef4444);background:color-mix(in srgb,var(--c-st-sla,#ef4444) 8%,transparent)}
.ak-status[data-tone="ok"]{padding:6px 10px;border-left:3px solid var(--c-st-closed,#16a34a);background:color-mix(in srgb,var(--c-st-closed,#16a34a) 8%,transparent)}
.ak-status[data-tone="warn"]{color:var(--c-st-open,#b45309)}
.ak-status[data-tone="loading"]{color:var(--c-muted,#64748b)}
.ak-table-wrap{overflow:auto;border:1px solid var(--c-border,#e2e8f0);border-radius:var(--r-sm,6px)}
.ak-table{width:100%;border-collapse:collapse;table-layout:fixed}
.ak-table th,.ak-table td{height:40px;padding:0 10px;text-align:left;vertical-align:middle;border-bottom:1px solid var(--c-border,#e2e8f0);font-size:var(--t-sm,13px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ak-table thead th{position:sticky;top:0;z-index:1;height:32px;background:var(--c-bg,#f8fafc);color:var(--c-muted,#64748b);font-size:var(--t-cap,11px);font-weight:600}
.ak-row{cursor:pointer}
.ak-row:hover{background:color-mix(in srgb,var(--c-cta,#0369a1) 6%,transparent)}
.ak-row.is-selected{background:color-mix(in srgb,var(--c-cta,#0369a1) 12%,transparent);box-shadow:inset 3px 0 0 var(--c-cta,#0369a1)}
.ak-row.is-archived .ak-doc-title{color:var(--c-muted,#64748b);text-decoration:line-through}
.ak-doc-title{font-weight:600}
.ak-lang{color:var(--c-muted,#64748b)}
.ak-num{font-variant-numeric:tabular-nums}
.ak-time{color:var(--c-muted,#64748b)}
.ak-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:var(--t-cap,11px);font-weight:700;border:1px solid currentColor}
.ak-badge[data-tone="ok"]{color:var(--c-st-closed,#16a34a)}
.ak-badge[data-tone="warn"]{color:var(--c-st-open,#b45309)}
.ak-badge[data-tone="error"]{color:var(--c-st-sla,#ef4444)}
.ak-badge[data-tone="muted"]{color:var(--c-muted,#64748b);background:color-mix(in srgb,var(--c-muted,#64748b) 12%,transparent)}
.ak-badge[data-tone="neutral"]{color:var(--c-text,#0f172a)}
.ak-empty{padding:16px;color:var(--c-muted,#64748b)}
.ak-empty[hidden]{display:none}
.ak-pager{display:flex;align-items:center;gap:8px}
.ak-page{font-size:var(--t-cap,12px);color:var(--c-muted,#64748b)}
.ak-form-head{display:flex;flex-direction:column;gap:6px;padding-bottom:8px;border-bottom:1px solid var(--c-border,#e2e8f0)}
.ak-form-title{display:flex;align-items:center;gap:8px}
.ak-form-name{font-family:var(--font-display,inherit);font-size:var(--t-title,15px);font-weight:700;overflow-wrap:anywhere}
.ak-form-fields{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
.ak-note{margin:0;font-size:var(--t-cap,12px);color:var(--c-muted,#64748b);overflow-wrap:anywhere}
`;

/* ───────────────────────── 挂载 ───────────────────────── */

/**
 * `host` 是一个空 `<div>`；`ctx` 见文件头。返回卸载函数（摘监听、停轮询、清内容）。
 * 这里才开始碰 DOM —— 文件顶层一个宿主对象都没有，所以在 node 里加载本模块是安全的。
 *
 * 额外认一个 `ctx.timers = { setTimeout, clearTimeout }`（**只为测试注入**，默认取宿主全局对象）：
 * 与骨架的 `importPanel` / `document` 同一个理由 —— "卸载时把重建轮询停掉"这件事，
 * 只有把定时器捏在手里才断言得出来，否则得真等 1.5 秒。
 */
export function mount(host, ctx) {
  if (host === null || typeof host !== "object" || typeof host.appendChild !== "function") return () => {};
  const doc = host.ownerDocument;
  if (doc === null || doc === undefined || typeof doc.createElement !== "function") return () => {};

  const config = ctx ?? {};
  const api = typeof config.api === "function" ? config.api : null;
  const role = typeof config.role === "string" && config.role !== "" ? config.role : "agent";
  const toast = typeof config.toast === "function" ? config.toast : () => {};
  const onSignOut = typeof config.onSignOut === "function" ? config.onSignOut : null;
  const injected = config.timers !== null && typeof config.timers === "object" ? config.timers : null;

  const state = {
    productLines: [],
    filters: { ...DEFAULT_FILTERS },
    page: 1,
    total: 0,
    rows: [],
    form: null,
    busy: false,
    saveHint: "",
    formError: "",
    rebuildAttempt: 0,
    rebuildTimer: 0,
    alive: true,
    listSeq: 0,
    detailSeq: 0,
  };

  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const schedule = (fn, ms) =>
    (injected?.setTimeout ?? globalThis.setTimeout).call(injected ?? globalThis, fn, ms);
  const unschedule = (id) => {
    if (id === 0 || id === null || id === undefined) return;
    (injected?.clearTimeout ?? globalThis.clearTimeout).call(injected ?? globalThis, id);
  };

  /* ── 骨架：标题 + 角色说明 + 筛选 + 状态行 + 表格 + 分页 + 表单 ── */

  const styleNode = make("style");
  styleNode.textContent = STYLE;
  host.appendChild(styleNode);

  const root = make("div", "ak");
  host.appendChild(root);

  const head = make("div", "admin-head");
  head.appendChild(make("h2", "admin-title", "知识库"));
  root.appendChild(head);
  root.appendChild(
    make(
      "p",
      "admin-note",
      `${roleNote(role)}文档正文是 markdown；「重建」= 切块 + embedding + 入库，重建前改动的正文对检索不可见。`,
    ),
  );

  const listSection = make("section", "ak-list");
  listSection.setAttribute("aria-label", "文档列表");
  root.appendChild(listSection);

  const filterHost = make("div", "ak-toolbar");
  listSection.appendChild(filterHost);

  const listStatus = make("div", "ak-status");
  listStatus.setAttribute("role", "status");
  listSection.appendChild(listStatus);

  const tableWrap = make("div", "ak-table-wrap");
  const table = make("table", "ak-table");
  const colgroup = make("colgroup");
  colgroup.innerHTML =
    '<col style="width:auto"><col style="width:120px"><col style="width:110px"><col style="width:80px"><col style="width:80px"><col style="width:140px">';
  const thead = make("thead");
  thead.innerHTML =
    "<tr><th scope=\"col\">标题</th><th scope=\"col\">语言</th><th scope=\"col\">状态</th><th scope=\"col\">块数</th><th scope=\"col\">版本</th><th scope=\"col\">更新时间</th></tr>";
  const rowsNode = make("tbody");
  rowsNode.setAttribute("data-ak", "rows");
  table.appendChild(colgroup);
  table.appendChild(thead);
  table.appendChild(rowsNode);
  const emptyNode = make("p", "ak-empty", EMPTY_TEXT.none);
  emptyNode.hidden = true;
  tableWrap.appendChild(table);
  tableWrap.appendChild(emptyNode);
  listSection.appendChild(tableWrap);

  const pager = make("div", "ak-pager");
  const prevButton = make("button", "ak-btn ak-btn-ghost", "上一页");
  prevButton.type = "button";
  prevButton.dataset.akAct = "prev";
  const pageNode = make("span", "ak-page");
  const nextButton = make("button", "ak-btn ak-btn-ghost", "下一页");
  nextButton.type = "button";
  nextButton.dataset.akAct = "next";
  const reloadButton = make("button", "ak-btn ak-btn-ghost", "刷新");
  reloadButton.type = "button";
  reloadButton.dataset.akAct = "reload";
  for (const node of [prevButton, pageNode, nextButton, reloadButton]) pager.appendChild(node);
  listSection.appendChild(pager);

  const formSection = make("section", "ak-form");
  formSection.setAttribute("aria-label", "文档编辑");
  formSection.hidden = true;
  root.appendChild(formSection);

  /* 表单拆成"输入区（整块重画）"与"动作条（逐节点更新）"两截：
     轮询重建状态时只改文字，绝不动 textarea —— 重画一次就把人正在写的正文连光标一起扔掉。 */
  const fieldsHost = make("div");
  formSection.appendChild(fieldsHost);

  const actionBar = make("div", "ak-actions");
  const button = (act, label, className) => {
    const node = make("button", className, label);
    node.type = "button";
    node.dataset.akAct = act;
    actionBar.appendChild(node);
    return node;
  };
  const saveButton = button("save", "保存", "ak-btn ak-btn-primary");
  const rebuildButton = button("rebuild", "重建", "ak-btn ak-btn-go");
  const rollbackButton = button("rollback", "回滚", "ak-btn ak-btn-ghost");
  const archiveButton = button("archive", "停用", "ak-btn ak-btn-danger");
  const closeButton = button("close", "关闭", "ak-btn ak-btn-ghost");
  formSection.appendChild(actionBar);

  const noteNode = make("p", "ak-note");
  noteNode.setAttribute("data-ak", "form-note");
  const saveHintNode = make("p", "ak-status");
  saveHintNode.setAttribute("data-ak", "save-hint");
  const rebuildNode = make("p", "ak-status");
  rebuildNode.setAttribute("data-ak", "rebuild-state");
  const formStatus = make("div", "ak-status");
  formStatus.setAttribute("role", "status");
  for (const node of [noteNode, saveHintNode, rebuildNode, formStatus]) formSection.appendChild(node);

  /* ── 渲染 ── */

  function setListStatus(text, tone) {
    listStatus.textContent = text;
    listStatus.dataset.tone = tone ?? "";
  }

  function setFormStatus(text, tone) {
    formStatus.textContent = text;
    formStatus.dataset.tone = tone ?? "";
  }

  function paintFilters() {
    filterHost.innerHTML = filtersHtml(state.filters, role);
  }

  function paintRows() {
    rowsNode.innerHTML = rowsHtml(state.rows, state.form?.id ?? "");
    const info = pageInfo(state.total, state.page);
    emptyNode.hidden = state.rows.length > 0;
    pageNode.textContent = info.text;
    prevButton.disabled = !info.hasPrev;
    nextButton.disabled = !info.hasNext;
    reloadButton.disabled = state.busy;
  }

  /**
   * 动作条的禁用与理由：写权限（`canWrite`）是主门槛，其次是"这一步现在有没有意义"
   * （新建态没有可重建的旧索引；已停用的文档不能改也不能重建）。
   */
  function syncFormChrome() {
    const form = state.form;
    formSection.hidden = form === null;
    if (form === null) {
      fieldsHost.innerHTML = "";
      for (const node of [saveButton, rebuildButton, rollbackButton, archiveButton, closeButton]) {
        node.disabled = false;
        node.removeAttribute("title");
      }
      noteNode.textContent = "";
      saveHintNode.textContent = "";
      rebuildNode.textContent = "";
      setFormStatus("", "");
      return;
    }

    const write = canWrite(role);
    const editing = form.mode === "edit";
    const archived = String(form.status ?? "") === "archived";
    const running = String(form.rebuild?.status ?? "") === "running";
    const blocked = state.busy ? "操作进行中，请稍候。" : write.reason;

    saveButton.disabled = state.busy || !write.enabled || archived;
    saveButton.title = archived ? "已停用的文档不能再编辑。" : write.enabled ? "" : blocked;
    // 重建与回滚都是 admin 的签字动作；`archived` / 新建态没有可重建的目标
    rebuildButton.disabled = state.busy || !write.enabled || !editing || archived || running;
    rebuildButton.title = running
      ? "重建正在进行。"
      : !editing
        ? "先保存这篇文档，再点重建。"
        : archived
          ? "已停用的文档不再重建。"
          : write.enabled
            ? "切块 + embedding 入库：只有重建过的正文才会进检索。"
            : blocked;
    // 回滚的目标是 `version - 1`，而版本从 1 开始 → **只有 version > 1 才有可回滚的上一版**。
    // 写成 `> 0` 时，`v1`（FAQ 审批直通建索引的文档就是这样）会给一个点了必然 409 的按钮。
    const hasPrevVersion = Number(form.version) > 1;
    const canRollback = editing && hasPrevVersion && !archived;
    rollbackButton.disabled = state.busy || !write.enabled || !canRollback;
    rollbackButton.title = !write.enabled
      ? blocked
      : !editing
        ? "先保存这篇文档。"
        : archived
          ? "已停用的文档没有可回滚的索引。"
          : hasPrevVersion
            ? "把索引退回上一版（正文不动）。这是破坏性动作，会二次确认。"
            : "还没有可回滚的上一版：重建成功一次之后才有。";
    archiveButton.disabled = state.busy || !write.enabled || !editing || archived;
    archiveButton.title = archived
      ? "已经停用。"
      : !editing
        ? "先保存这篇文档。"
        : write.enabled
          ? "停用（不是删除）：保留历史引用，但不再参与检索。会二次确认。"
          : blocked;
    closeButton.disabled = false;

    noteNode.textContent = formNote(form, role);
    saveHintNode.textContent = state.saveHint;
    saveHintNode.dataset.tone = state.saveHint === "" ? "" : "ok";
    rebuildNode.textContent = editing ? rebuildResultText(form.rebuild) : "";
    const rebuildTone = rebuildStatus(form.rebuild?.status).tone;
    rebuildNode.dataset.tone = editing ? (rebuildTone === "neutral" ? "" : rebuildTone) : "";
    setFormStatus(state.formError, state.formError === "" ? "" : "error");
  }

  function paintForm(paintFields) {
    if (paintFields === true) {
      fieldsHost.innerHTML = state.form === null ? "" : formFieldsHtml(state.form, state.productLines);
    }
    syncFormChrome();
  }

  /* ── 请求 ── */

  async function request(path, init) {
    const result = await callApi(api, path, init);
    if (result.ok) return result;
    // 卸载之后回来的失败既不该提示也不该回登录页：那块界面已经不在页面上了。
    if (!state.alive) return result;
    const code = String(result.error?.code ?? "");
    if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID") {
      if (onSignOut !== null) onSignOut();
    }
    toast(errorText(result.error));
    return result;
  }

  async function loadProductLines() {
    const result = await request("/api/admin/product-lines", { method: "GET" });
    if (!state.alive) return;
    // 产线字典挂了也要能看文档列表：下拉只剩「不指定」，列表照常。
    if (result.ok) state.productLines = Array.isArray(result.data?.items) ? result.data.items : [];
    paintFilters();
  }

  async function loadList() {
    const seq = ++state.listSeq;
    setListStatus("正在加载…", "loading");
    const result = await request(`/api/admin/documents?${buildListQuery(state.filters, state.page)}`, { method: "GET" });
    if (!state.alive || seq !== state.listSeq) return;
    if (!result.ok) {
      state.rows = [];
      state.total = 0;
      // 空态也要说清"是接口不在，不是你没有文档"（后端此刻可能还没上线）。
      emptyNode.textContent = EMPTY_TEXT.unavailable;
      paintRows();
      setListStatus(errorText(result.error), "error");
      return;
    }
    const items = listItems(result.data);
    const total = Number(result.data?.total);
    state.rows = items;
    state.total = Number.isFinite(total) ? total : items.length;
    emptyNode.textContent = EMPTY_TEXT.none;
    const info = pageInfo(state.total, state.page);
    if (state.page > info.pages) {
      // 换筛选之后总数变少：回到最后一页，而不是停在一个空页上。
      state.page = info.pages;
      void loadList();
      return;
    }
    paintRows();
    setListStatus("", "");
  }

  function rowById(id) {
    return state.rows.find((row) => String(row?.id ?? "") === id) ?? null;
  }

  function cancelRebuildPoll() {
    unschedule(state.rebuildTimer);
    state.rebuildTimer = 0;
  }

  async function openRow(id) {
    if (id === "") return;
    const seq = ++state.detailSeq;
    cancelRebuildPoll(); // 换文档就停掉上一篇的重建轮询：回填会落到别人的表单上
    setListStatus("正在读取文档…", "loading");
    const result = await request(`/api/admin/documents/${encodeURIComponent(id)}`, { method: "GET" });
    if (!state.alive || seq !== state.detailSeq) return;
    if (!result.ok) {
      setListStatus(errorText(result.error), "error");
      return;
    }
    state.form = formFromDetail(pickDocument(result.data), rowById(id));
    state.saveHint = "";
    state.formError = "";
    state.rebuildAttempt = 0;
    setListStatus("", "");
    paintRows();
    paintForm(true);
  }

  function closeForm() {
    cancelRebuildPoll();
    state.form = null;
    state.saveHint = "";
    state.formError = "";
    state.rebuildAttempt = 0;
    paintRows();
    paintForm(true);
  }

  function setFilter(key, value) {
    state.filters = { ...state.filters, [key]: value };
    state.page = 1;
    closeForm();
    void loadList();
  }

  function setBusy(on) {
    state.busy = on;
    paintRows();
    syncFormChrome();
  }

  /* ── 保存 / 重建 / 回滚 / 停用 ── */

  /**
   * 保存 / 刷新详情之后的新表单：**响应优先，缺的字段回落到屏幕上这一份**。
   *
   * 为什么不是直接 `formFromDetail(result.data)`：契约没写 PATCH/POST 的响应体一定带 `body`，
   * 万一只回 `{ id, status }`，直接重建表单会把用户刚写的正文清空 —— 屏幕上的内容是用户财产，
   * 只有服务端明确给了新值才覆盖它。
   */
  function mergeSaved(form, data) {
    const saved = pickDocument(data);
    const merged = {
      id: saved.id ?? form.id,
      title: typeof saved.title === "string" ? saved.title : form.title,
      lang: typeof saved.lang === "string" ? saved.lang : form.lang,
      product_line: typeof saved.product_line === "string" ? saved.product_line : form.product_line,
      body: typeof saved.body === "string" ? saved.body : form.body,
      status: saved.status ?? form.status,
      chunk_count: saved.chunk_count ?? form.chunk_count,
      version: saved.version ?? form.version,
      updated_at: saved.updated_at ?? form.updated_at,
      rebuild: saved.rebuild ?? form.rebuild,
    };
    return formFromDetail(merged, rowById(String(merged.id ?? "")));
  }

  async function submitSave(form) {
    const check = validateForm(form);
    if (!check.ok) {
      // 校验没过就不发请求：POST 一个空标题只会换回 400，用户还得猜是哪个字段。
      state.formError = check.message;
      syncFormChrome();
      toast(check.message);
      return;
    }
    const creating = form.mode === "create";
    const path = creating
      ? "/api/admin/documents"
      : `/api/admin/documents/${encodeURIComponent(form.id)}`;
    const body = creating ? createBody(form) : patchBody(form);
    state.formError = "";
    setBusy(true);
    const result = await request(path, { method: creating ? "POST" : "PATCH", body });
    if (!state.alive) return;
    setBusy(false);
    if (!result.ok) {
      state.formError = errorText(result.error);
      syncFormChrome();
      return;
    }
    const next = mergeSaved(form, result.data);
    if (creating && String(next.id) === "") {
      // 后端 201 没带 id（契约只说了状态码与 `pending`）：**不假装拿到了新文档**。
      // 留一个 id 为空的编辑态，下一次保存会 PATCH 到 `/api/admin/documents/` 上去 —— 那是 404，
      // 而人以为自己保存的是本篇。回列表让人自己点，比编一个 id 安全。
      state.form = null;
      state.saveHint = "";
      state.rebuildAttempt = 0;
      paintForm(true);
      void loadList();
      toast("已新建（待建索引）。响应里没带文档 id，请从列表里选中它再点「重建」。");
      return;
    }
    state.form = next;
    state.saveHint = "已保存，需重建才生效。";
    state.rebuildAttempt = 0;
    paintForm(true);
    // 保存后立刻重拉列表：状态（pending）与"更新于"只有服务端说了算。
    void loadList();
    toast(creating ? "已新建文档（待建索引）；点「重建」后进检索。" : "已保存，需重建才生效。");
  }

  async function refreshDetail(form) {
    const id = String(form.id ?? "");
    if (id === "") return;
    const result = await request(`/api/admin/documents/${encodeURIComponent(id)}`, { method: "GET" });
    if (!state.alive || state.form !== form) return;
    if (!result.ok) return;
    state.form = mergeSaved(form, result.data);
    paintForm(true);
    void loadList();
  }

  /**
   * 轮询一跳。`attempt` 先自增再判，于是 `REBUILD_POLL_LIMIT` 就是总请求数上限
   * （决策本身在 `pollDecision` 里，纯函数，测试直接喂状态）。
   */
  async function tickRebuild() {
    state.rebuildTimer = 0;
    const form = state.form;
    if (!state.alive || form === null || form.mode !== "edit") return;
    state.rebuildAttempt += 1;
    const result = await request(`/api/admin/documents/${encodeURIComponent(form.id)}/rebuild`, { method: "GET" });
    if (!state.alive || state.form !== form) return;
    if (!result.ok) {
      // 轮询失败（网络 / 5xx / 403）就停下：每 1.5 秒弹一次同样的 toast 是噪音，不是信息。
      state.formError = errorText(result.error);
      syncFormChrome();
      return;
    }
    form.rebuild = normalizeRebuild(result.data);
    const decision = pollDecision(form.rebuild.status, state.rebuildAttempt);
    if (decision.action === "continue") {
      state.rebuildTimer = schedule(() => void tickRebuild(), decision.delayMs ?? REBUILD_POLL_MS);
      syncFormChrome();
      return;
    }
    if (decision.action === "timeout") toast(decision.message);
    state.formError = "";
    syncFormChrome();
    if (isRebuildDone(form.rebuild.status)) {
      toast("重建完成");
      await refreshDetail(form); // 块数 / 版本 / 状态都以服务端为准
    }
  }

  function scheduleRebuildPoll() {
    cancelRebuildPoll();
    const form = state.form;
    if (!state.alive || form === null) return;
    const decision = pollDecision(form.rebuild?.status, state.rebuildAttempt);
    if (decision.action !== "continue") {
      if (decision.action === "timeout") toast(decision.message);
      syncFormChrome();
      return;
    }
    state.rebuildTimer = schedule(() => void tickRebuild(), decision.delayMs ?? REBUILD_POLL_MS);
    syncFormChrome();
  }

  async function startRebuild(form) {
    if (state.busy) return;
    const write = canWrite(role);
    if (!write.enabled) {
      toast(write.reason);
      return;
    }
    state.formError = "";
    state.saveHint = "";
    state.rebuildAttempt = 0;
    setBusy(true);
    const result = await request(`/api/admin/documents/${encodeURIComponent(form.id)}/rebuild`, { method: "POST" });
    if (!state.alive) return;
    setBusy(false);
    if (!result.ok) {
      state.formError = errorText(result.error);
      syncFormChrome();
      return;
    }
    // 202 的 body 就是第一份作业快照（`{ job_id, status:"running" }`）：拿它当第 0 跳，不额外多发一次 GET。
    form.rebuild = normalizeRebuild(result.data);
    toast("已开始重建，正在等待结果…");
    scheduleRebuildPoll();
  }

  async function submitStatus(form, action) {
    if (state.busy) return;
    const write = canWrite(role);
    if (!write.enabled) {
      toast(write.reason);
      return;
    }
    // 回滚与停用都会改变"用户能检索到什么"：二次确认是刻意的摩擦，不是啰嗦。
    const question =
      action === "rollback"
        ? "回滚会让检索退回上一版索引（正文不动）。确定回滚？"
        : "停用后这份文档不再参与检索（历史引用仍能打开），确定停用？";
    if (globalThis.confirm?.(question) === false) return;
    state.formError = "";
    setBusy(true);
    const result = await request(`/api/admin/documents/${encodeURIComponent(form.id)}/${action}`, { method: "POST" });
    if (!state.alive) return;
    setBusy(false);
    if (!result.ok) {
      state.formError = errorText(result.error);
      syncFormChrome();
      return;
    }
    toast(action === "rollback" ? "已回滚到上一版索引" : "已停用（不再参与检索）");
    state.saveHint = "";
    await refreshDetail(form);
  }

  async function runAction(name) {
    if (name === "reload") {
      void loadProductLines();
      void loadList();
      return;
    }
    if (name === "new") {
      const write = canWrite(role);
      if (!write.enabled) {
        toast(write.reason);
        return;
      }
      cancelRebuildPoll();
      state.form = emptyForm(LANGS[0]);
      state.saveHint = "";
      state.formError = "";
      state.rebuildAttempt = 0;
      paintRows();
      paintForm(true);
      // 新建之后光标直接落在标题上：这一步只有一次输入是有意义的，让人再点一下纯属摩擦。
      const input =
        typeof fieldsHost.querySelector === "function" ? fieldsHost.querySelector('[data-ak-field="form-title"]') : null;
      if (input !== null && input !== undefined && typeof input.focus === "function") input.focus();
      return;
    }
    if (name === "close") {
      closeForm();
      return;
    }
    if (name === "prev" || name === "next") {
      const info = pageInfo(state.total, state.page);
      const next = name === "next" ? info.page + 1 : info.page - 1;
      if (next < 1 || next > info.pages) return;
      state.page = next;
      void loadList();
      return;
    }
    const form = state.form;
    if (form === null || state.busy) return;
    if (name === "save") return submitSave(form);
    if (name === "rebuild") {
      if (form.mode !== "edit") {
        toast("先保存这篇文档，再点重建。");
        return;
      }
      return startRebuild(form);
    }
    if (name === "rollback" || name === "archive") {
      if (form.mode !== "edit") {
        toast("先保存这篇文档。");
        return;
      }
      return submitStatus(form, name);
    }
  }

  /* ── 事件 ── */

  function closestIn(node, selector) {
    return node !== null && node !== undefined && typeof node.closest === "function" ? node.closest(selector) : null;
  }

  function onClick(event) {
    const target = event?.target;
    const row = closestIn(target, "[data-ak-row]");
    if (row !== null) {
      void openRow(String(row.getAttribute("data-ak-row") ?? ""));
      return;
    }
    const action = closestIn(target, "[data-ak-act]");
    if (action === null) return;
    if (action.disabled === true) return;
    void runAction(String(action.getAttribute("data-ak-act") ?? ""));
  }

  function onChange(event) {
    const node = event?.target;
    if (node === null || node === undefined || typeof node.getAttribute !== "function") return;
    const field = String(node.getAttribute("data-ak-field") ?? "");
    if (field === "filter-status") return setFilter("status", String(node.value ?? ""));
    if (field === "filter-lang") return setFilter("lang", String(node.value ?? ""));
    const form = state.form;
    if (form === null) return;
    // 下拉只改状态，**不重画**输入区：重画会拿走焦点，也丢人正在写的正文。
    if (field === "form-lang") {
      form.lang = String(node.value ?? "");
      syncFormChrome();
    } else if (field === "form-product-line") {
      form.product_line = String(node.value ?? "");
      syncFormChrome();
    }
  }

  function onInput(event) {
    const node = event?.target;
    if (node === null || node === undefined || typeof node.getAttribute !== "function") return;
    const form = state.form;
    if (form === null) return;
    const field = String(node.getAttribute("data-ak-field") ?? "");
    if (field !== "form-title" && field !== "form-body") return;
    if (field === "form-title") form.title = String(node.value ?? "");
    else form.body = String(node.value ?? "");
    // 输入时只清掉上一次的报错（改完还挂着"标题不能为空"会让人以为没生效）。
    if (state.formError !== "") {
      state.formError = "";
      setFormStatus("", "");
    }
  }

  function onKeyDown(event) {
    if (event?.key !== "Enter" && event?.key !== " ") return;
    const row = closestIn(event.target, "[data-ak-row]");
    if (row === null || event.target !== row) return;
    event.preventDefault();
    void openRow(String(row.getAttribute("data-ak-row") ?? ""));
  }

  host.addEventListener("click", onClick);
  host.addEventListener("change", onChange);
  host.addEventListener("input", onInput);
  host.addEventListener("keydown", onKeyDown);

  paintFilters();
  paintRows();
  paintForm(true);
  void (async () => {
    await loadProductLines();
    if (!state.alive) return;
    await loadList();
  })();

  return function unmount() {
    state.alive = false;
    // 让在途请求的回填全部落空（每个 await 之后都会看 `alive` 与序号）
    state.listSeq += 1;
    state.detailSeq += 1;
    cancelRebuildPoll();
    host.removeEventListener("click", onClick);
    host.removeEventListener("change", onChange);
    host.removeEventListener("input", onInput);
    host.removeEventListener("keydown", onKeyDown);
    if (typeof host.replaceChildren === "function") host.replaceChildren();
    else host.innerHTML = "";
  };
}

export default mount;
