/**
 * 管理端 HTTP 接口（`09#04` · `docs/prdv1.3/scope-delta.md` S4 · 工单 `.scratch/09-admin-console/issues/04-admin-panels.md`）。
 *
 *   GET    /api/admin/faults                    故障卡列表（**全部状态** + 筛选 + 分页）  `lead`
 *   GET    /api/admin/faults/:code              单条全量（十列 + status + 更新时间）      `lead`
 *   POST   /api/admin/faults                    新建（**一律 draft**）                      `lead`
 *   PATCH  /api/admin/faults/:code              编辑（published 改完落回 draft；archived 409）`lead`
 *   POST   /api/admin/faults/:code/publish      发布（五语十列必须全非空）                 `admin`
 *   POST   /api/admin/faults/:code/archive      归档（只改 status，不删行）                `admin`
 *   GET    /api/admin/product-lines             产品线字典（含 active）                    `lead`
 *   POST   /api/admin/product-lines             新增产线（code 冲突 → 409）                `admin`
 *   PATCH  /api/admin/product-lines/:code       改名 / 停用                                 `admin`
 *   GET    /api/admin/staff                     人员列表（派发下拉；绝不含口令列）          `admin`
 *   GET    /api/admin/fault-reports             待审反馈（`status=new`，分页）              `lead`
 *   PATCH  /api/admin/fault-reports/:id         处置（merge → merged / reject → rejected）  `lead`
 *
 * **角色从表里取，不在路由里写第二份**：每条路由的处理器都用 `guard(request, ROUTES.x)`
 * 从 `src/api/roles.ts` 的 `ROUTE_MIN_ROLE` 读最低角色 —— 那张表是唯一真源，
 * 而 `src/routes.ts` 末尾的启动断言保证"注册过的路由一定在表里"。路由里再写一遍 `"lead"`
 * 就会有两份口径，改一处漏一处的那天没人发现（正是 `09#03` 做那张表要解决的问题）。
 *
 * **先认证、后授权**（顺序不能反）：`requireAdmin` 读会话票据 → 401；拿到身份再 `requireRole`
 * → 403。反过来会出现"没登录却被告知权限不足"，前端的分流（401 回登录页 / 403 只提示不清票据，
 * D31）就全错了。两件事都发生在解析 body **之前**：未授权的请求不该触发任何校验分支。
 *
 * 本文件只做传输层：鉴权 → 入参形状 → 调 `core/admin-store.ts` → 套统一信封。
 * 状态机（draft/published/archived 的迁移规则）、五语齐全的校验、审计留痕都在 core 里，
 * 因为那些规则将来还会有第二个调用方（批量导入 / CLI），而"发布要不要五语齐全"只能有一个答案。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { actorOf, guard, minRoleOf, requireBodyRecord } from "./admin-guard.ts";
import {
  FAULT_REPORT_ACTION_VALUES,
  FAULT_REPORT_STATUS_VALUES,
  FAULT_SEVERITY_VALUES,
  FAULT_STATUS_VALUES,
  FAULT_TEXT_LANGS,
  archiveFault,
  createFault,
  createProductLine,
  getFault,
  listFaultReports,
  listFaults,
  listProductLines,
  listStaff,
  publishFault,
  resolveFaultReport,
  updateFault,
  updateProductLine,
  type FaultDetail,
  type FaultListFilter,
  type FaultReport,
  type FaultReportAction,
  type FaultReportListFilter,
  type FaultSeverity,
  type FaultSummary,
  type FaultText,
  type FaultTextLang,
} from "../core/admin-store.ts";
import { FAULT_CODE_RE } from "../core/fastpath.ts";
import { QUEUE_PAGE_SIZE_DEFAULT, QUEUE_PAGE_SIZE_MAX } from "../core/ticket-queue.ts";
import { AppError } from "../errors.ts";
import { PAGE_MAX, firstString, parseEnumList, parseIntInRange } from "./params.ts";

/**
 * 路径常量。注册用的字面量与 `minRole` 查表用的字面量**是同一个变量** ——
 * 两处各写一遍字符串，改一个漏一个时查表会 miss（miss 是 500 而不是放行，但仍是个 bug）。
 */
const ROUTES = {
  faults: "/api/admin/faults",
  fault: "/api/admin/faults/:code",
  publish: "/api/admin/faults/:code/publish",
  archive: "/api/admin/faults/:code/archive",
  productLines: "/api/admin/product-lines",
  productLine: "/api/admin/product-lines/:code",
  staff: "/api/admin/staff",
  faultReports: "/api/admin/fault-reports",
  faultReport: "/api/admin/fault-reports/:id",
} as const;

/** 与 `api/fault.ts` / `api/internal-fault.ts` 同一口径（表里最长是 `residential`，11 字符）。 */
const MAX_PRODUCT_LINE_CHARS = 32;
/** 产品线 code 的形状：小写字母开头 + 小写字母/数字/下划线/连字符。 */
const PRODUCT_LINE_CODE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const PRODUCT_LINE_NAME_MAX = 64;
/** 故障码路径参数的长度上限（形状校验之外的兜底，别让一段长文本进 SQL）。 */
const CODE_PARAM_MAX = 32;

/* ────────────────────────── 入参 ────────────────────────── */

function parseProductLine(raw: unknown, field: string): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION", `${field} 必须是字符串`);
  const value = raw.trim();
  if (value === "") throw new AppError("VALIDATION", `${field} 不能为空`);
  if (value.length > MAX_PRODUCT_LINE_CHARS) {
    throw new AppError("VALIDATION", `${field} 超过 ${MAX_PRODUCT_LINE_CHARS} 字符`);
  }
  return value;
}

/**
 * 路径里的 `product_line`（`?product_line=balcony`）。**主键是两列，缺一半就不是等值查询**：
 * 只按 `code` 查会把别的产品线的同名码（`F21` 只在 residential 存在）当成同一条。
 * 所以缺它直接 400，而不是"回落到默认产品线" —— 那会让一个漏参数的请求去改另一条产线的码。
 */
function requireProductLineQuery(raw: unknown): string {
  const source = (raw ?? {}) as Record<string, unknown>;
  const value = firstString(source.product_line);
  if (value === null || value.trim() === "") {
    throw new AppError("VALIDATION", "缺少 product_line：主键是 (code, product_line)，必须一起给");
  }
  return parseProductLine(value, "product_line");
}

/**
 * 路径里的码。这里只做**形状兜底**（非空、短、去掉首尾空白），不复用 `FAULT_CODE_RE`：
 * 表里可能有历史/手插的行不符合"一个字母 + 2~3 位数字"，那些行仍然要能被查、能改、能归档。
 * 对外可见性是另一件事，由 `publish` 时的 `FAULT_CODE_RE` 管（发布了却查不到的码就是假发布）。
 */
function parseCodeParam(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "" || value.length > CODE_PARAM_MAX) throw new AppError("VALIDATION", "code 不合法");
  return value.toUpperCase();
}

/** 新建时用严口径：能被 `/api/fault/:code` 查到的码必须过同一条判形（`api/fault.ts` 用的就是它）。 */
function parseCodeForCreate(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError("VALIDATION", "code 必填（字母 + 2~3 位数字）");
  const code = raw.trim().toUpperCase();
  if (!FAULT_CODE_RE.test(code)) {
    throw new AppError("VALIDATION", `code 必须是字母 + 2~3 位数字（与公开接口同一判形），收到 "${raw}"`);
  }
  return code;
}

function parseSeverity(raw: unknown): FaultSeverity {
  if (typeof raw !== "string" || !(FAULT_SEVERITY_VALUES as readonly string[]).includes(raw)) {
    throw new AppError("VALIDATION", `severity 取值必须是 ${FAULT_SEVERITY_VALUES.join("|")}`);
  }
  return raw as FaultSeverity;
}

/**
 * 一门语言的一段文案：字符串（去首尾空白，空串当"没写"）或 `null`（清空）。
 *
 * 空串归一成 `null` 是刻意的：库里"缺语"的表示只有一种（NULL），如果同时允许 `''`，
 * `langCompleteSql` 与 `core/fault-codes.ts` 的 `pickText` 就得各判一次"是不是空白"。
 * 归一之后，缺语只有 NULL 一种形状。
 */
function parseTextValue(raw: unknown, field: string): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new AppError("VALIDATION", `${field} 必须是字符串或 null`);
  const value = raw.trim();
  return value === "" ? null : value;
}

/** 五语文案对象；未识别的键忽略（前端可能顺手套上 `code` / `id`）。返回 undefined = 没给这块。 */
function parseTextBlock(raw: unknown, kind: "desc" | "act"): Partial<FaultText> | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError("VALIDATION", `${kind} 必须是对象（键为 zh|en|de|nl|es）`);
  }
  const source = raw as Record<string, unknown>;
  const patch: Partial<FaultText> = {};
  for (const lang of FAULT_TEXT_LANGS) {
    const value = source[lang];
    if (value === undefined) continue;
    patch[lang as FaultTextLang] = parseTextValue(value, `${kind}.${lang}`);
  }
  return patch;
}

/**
 * 列表查询（`09#04` 的四个筛选）。
 *
 * 分页复用 `api/params.ts`（从 `console.ts` 抽出来的那一份）：超界夹住、只有"不是整数"是 400。
 * 枚举与三态都在这里挡：`status=pubished` 静默忽略的话，坐席会以为自己在看"已发布"，
 * 实际看到的是全部状态 —— 一次误改生产数据的起点。
 */
function parseFaultQuery(raw: unknown): FaultListFilter {
  const source = (raw ?? {}) as Record<string, unknown>;

  const rawProductLine = (firstString(source.product_line) ?? "").trim();
  if (rawProductLine.length > MAX_PRODUCT_LINE_CHARS) {
    throw new AppError("VALIDATION", `product_line 超过 ${MAX_PRODUCT_LINE_CHARS} 字符`);
  }

  const rawMissing = (firstString(source.missing_lang) ?? "").trim().toLowerCase();
  let missingLang: boolean | null = null;
  if (rawMissing !== "") {
    if (rawMissing !== "true" && rawMissing !== "false") {
      throw new AppError("VALIDATION", `missing_lang 取值必须是 true|false，收到 "${rawMissing}"`);
    }
    missingLang = rawMissing === "true";
  }

  return {
    productLine: rawProductLine === "" ? null : rawProductLine,
    severities: parseEnumList(firstString(source.severity), FAULT_SEVERITY_VALUES, "severity"),
    statuses: parseEnumList(firstString(source.status), FAULT_STATUS_VALUES, "status"),
    missingLang,
    page: parseIntInRange(firstString(source.page), "page", 1, 1, PAGE_MAX),
    size: parseIntInRange(firstString(source.size), "size", QUEUE_PAGE_SIZE_DEFAULT, 1, QUEUE_PAGE_SIZE_MAX),
  };
}

/* ────────────────────────── 待审反馈：入参 ────────────────────────── */

/**
 * 待审反馈的 id 形状（`bigserial` 的十进制表示）。形状不对不进 SQL —— 与 `api/console.ts`
 * 的 `parseTicketId` 同口径：URL 里的 id 来自前端列表渲染，一个失效的 id 对坐席的意思就是
 * "这条没了"，所以 `NOT_FOUND` 而不是 400（`"abc"` 进 SQL 会变成 22P02 的 500）。
 */
const REPORT_ID_RE = /^\d{1,18}$/;

/**
 * 列表入参。**默认 `status=new`**（工单 04 的原话："`status=new` 的列表"）：
 * 默认视图是"还没处置的",处置过的靠显式 `?status=merged` / `?status=rejected` 去翻 ——
 * 与队列"默认只看待处理"是同一条设计（默认视图应该随时间自动变短，而不是越堆越长）。
 *
 * 枚举照 `parseEnumList` 一律 400：`status=pendding` 静默忽略会让坐席以为自己在看历史处置，
 * 实际看到的却是待审清单，于是同一条被点第二遍。
 */
function parseReportQuery(raw: unknown): FaultReportListFilter {
  const source = (raw ?? {}) as Record<string, unknown>;
  const statuses = parseEnumList(firstString(source.status), FAULT_REPORT_STATUS_VALUES, "status");
  return {
    statuses: statuses ?? ["new"],
    page: parseIntInRange(firstString(source.page), "page", 1, 1, PAGE_MAX),
    size: parseIntInRange(firstString(source.size), "size", QUEUE_PAGE_SIZE_DEFAULT, 1, QUEUE_PAGE_SIZE_MAX),
  };
}

function parseReportId(raw: unknown): number {
  const value = typeof raw === "string" ? raw : "";
  if (!REPORT_ID_RE.test(value)) throw new AppError("NOT_FOUND", "待审反馈不存在");
  return Number(value);
}

/**
 * 处置动作只认 `merge` / `reject` 两个字符串（工单 04 的表格）。不认 `status:"merged"` 这种写法：
 * 让调用方直接写终态等于把状态机交出去，将来多一个中间态时前端得跟着改。
 */
function parseReportAction(raw: unknown): FaultReportAction {
  if (typeof raw !== "string" || !(FAULT_REPORT_ACTION_VALUES as readonly string[]).includes(raw)) {
    throw new AppError("VALIDATION", `action 取值必须是 ${FAULT_REPORT_ACTION_VALUES.join("|")}`);
  }
  return raw as FaultReportAction;
}

/* ────────────────────────── 出参 ────────────────────────── */

/** snake_case 只出现在 HTTP 这一层（`api/fault.ts` 的同一口径）；核心模块内部一律 camelCase。 */
function faultBody(fault: FaultDetail): Record<string, unknown> {
  return {
    code: fault.code,
    product_line: fault.productLine,
    severity: fault.severity,
    status: fault.status,
    desc: fault.desc,
    act: fault.act,
    lang_count: fault.langCount,
    complete_langs: fault.completeLangs,
    missing_langs: fault.missingLangs,
    created_at: fault.createdAt,
    updated_at: fault.updatedAt,
  };
}

/** 列表行不带正文（十列长文 × 一页 20 条是白搬的流量），只带"语言完整度"。 */
function faultSummaryBody(fault: FaultSummary): Record<string, unknown> {
  return {
    code: fault.code,
    product_line: fault.productLine,
    severity: fault.severity,
    status: fault.status,
    lang_count: fault.langCount,
    complete_langs: fault.completeLangs,
    missing_langs: fault.missingLangs,
    created_at: fault.createdAt,
    updated_at: fault.updatedAt,
  };
}

/* ────────────────────────── 路由 ────────────────────────── */

/**
 * 待审反馈的一行。**不含 `conv_id` / `ticket_id`**：本期唯一捕获点（`/api/fault`）既没有会话
 * 也不建单，两列恒为 `null`；把它们下发只会让前端长出一个永远空着的列。将来接对话/工单捕获时
 * 再一起加上（那时前端才需要链接到会话）。
 *
 * `quote` 是短摘录（≤200 字），不是问题原文 —— 库里的 check 与 `clampQuote` 各守一道。
 */
function faultReportBody(report: FaultReport): Record<string, unknown> {
  return {
    id: report.id,
    code: report.code,
    product_line: report.productLine,
    source: report.source,
    lang: report.lang,
    quote: report.quote,
    status: report.status,
    created_at: report.createdAt,
  };
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get(ROUTES.faults, async (request, reply) => {
    await guard(request, "GET", ROUTES.faults);
    const { total, items } = await listFaults(parseFaultQuery(request.query));
    return reply.code(200).send({ ok: true, data: { total, items: items.map(faultSummaryBody) } });
  });

  app.get<{ Params: { code?: unknown } }>(ROUTES.fault, async (request, reply) => {
    await guard(request, "GET", ROUTES.fault);
    const code = parseCodeParam(request.params.code);
    const productLine = requireProductLineQuery(request.query);
    const fault = await getFault(code, productLine);
    if (fault === null) throw new AppError("NOT_FOUND", "故障码不存在");
    return reply.code(200).send({ ok: true, data: faultBody(fault) });
  });

  app.post(ROUTES.faults, async (request, reply) => {
    const principal = await guard(request, "POST", ROUTES.faults);
    const body = requireBodyRecord(request);
    const code = parseCodeForCreate(body.code);
    const productLine = parseProductLine(body.product_line, "product_line");

    // `severity` 可缺省（列允许 NULL）。给了就必须是三个取值之一：拼错的 `warning` 静默变成
    // NULL 会让"这条是 fatal"这个判断凭空消失，而严重度决定用户看到的提示语气。
    // 这里是**两态**（没给 / 给了值）而不是 PATCH 那种三态：新建时"没给"与"显式 null" 落到
    // 库里是同一个 NULL，两种写法没有可观察的差别，也就不需要区分（PATCH 才有"清空"这个动作）。
    const severity = body.severity === undefined || body.severity === null ? null : parseSeverity(body.severity);

    // `status` 一律忽略：新建只落 draft（`core/admin-store.ts` 的 SQL 里写死）。
    // body 里写 `status:"published"` 也发不出去 —— 发布只有下面那个端点一条路。
    const fault = await createFault({
      code,
      productLine,
      severity,
      desc: parseTextBlock(body.desc, "desc") ?? {},
      act: parseTextBlock(body.act, "act") ?? {},
      actor: actorOf(principal),
    });
    return reply.code(200).send({ ok: true, data: faultBody(fault) });
  });

  app.patch<{ Params: { code?: unknown } }>(ROUTES.fault, async (request, reply) => {
    const principal = await guard(request, "PATCH", ROUTES.fault);
    const code = parseCodeParam(request.params.code);
    const productLine = requireProductLineQuery(request.query);
    const body = requireBodyRecord(request);

    // `severity` 是**三态**（`09#04` 未做第 5 条）：没传 = 不改；显式 `null` = 清空为 NULL；
    // 给了值 = 校验后写入。
    //
    // 为什么必须用"键是否出现"而不是 `body.severity === undefined || body.severity === null`：
    // 用 `??` / `||` 的写法会把"显式 null"与"没传"折成同一件事，于是管理面板的"（未设置）"
    // 选项在已有值上一按就变成空操作 —— 用户看到的是"选了未设置、保存成功、值还在"。
    // 三态在这里唯一能表达清楚的办法就是 `hasOwnProperty`：JSON 里没有 `undefined`，
    // 所以"键在且值为 null"就是调用方能说出的唯一一句"我要清空"。
    const hasSeverity = Object.prototype.hasOwnProperty.call(body, "severity");
    const severity: FaultSeverity | null | undefined = hasSeverity
      ? body.severity === null
        ? null
        : parseSeverity(body.severity)
      : undefined;
    // 为什么**不**把三态推广到 `desc` / `act`：那两块是"按语言分列的十列文案"的补丁集，
    // 它们的 `undefined`（这门外语没给）与 `null`/空串（这门外语清空）已经在
    // `parseTextBlock` + `parseTextValue` 里各自有含义，而且是**逐语言**的三态；
    // 给整块再套一层"键出现了没有"只会造出第四种状态（"desc 给了空对象"），
    // 而它的语义与"desc 没给"完全一样。语义不同，别为了对称硬凑。
    const desc = parseTextBlock(body.desc, "desc");
    const act = parseTextBlock(body.act, "act");

    // 一个可识别字段都没有就 400（与 console 补丁同口径）：一次拼错字段名的保存如果被当成成功，
    // 坐席看到的是"点了没反应"，而他以为已经改完了。
    // 注意 `{severity: null}` 是**有**字段：它表达"清空严重度"，是一次真实修改。
    if (severity === undefined && desc === undefined && act === undefined) {
      throw new AppError("VALIDATION", "至少提供 severity / desc / act 之一（发布与归档各有一个端点）");
    }

    const { fault, changed } = await updateFault({ code, productLine, severity, desc, act, actor: actorOf(principal) });
    return reply.code(200).send({ ok: true, data: { fault: faultBody(fault), changed } });
  });

  // 发布/归档**不读 body**：它们只表达"把这一行迁到某个状态"，请求体里没有任何字段能影响结果，
  // 所以也没有解析分支（少一个分支就少一次可以观察的信息泄露面）。
  app.post<{ Params: { code?: unknown } }>(ROUTES.publish, async (request, reply) => {
    const principal = await guard(request, "POST", ROUTES.publish);
    const code = parseCodeParam(request.params.code);
    const productLine = requireProductLineQuery(request.query);
    // 发布是"让它出现在用户面前"的那一步，所以这里补一次判形：不符合对外判形的码即使五语齐全，
    // 用户也查不到（`/api/fault/:code` 会用 400 挡掉它），那叫假发布。
    if (!FAULT_CODE_RE.test(code)) {
      throw new AppError("VALIDATION", `code 不符合对外接口判形（字母 + 2~3 位数字），发布了用户也查不到`);
    }
    const { fault, changed } = await publishFault({ code, productLine, actor: actorOf(principal) });
    return reply.code(200).send({ ok: true, data: { fault: faultBody(fault), changed } });
  });

  app.post<{ Params: { code?: unknown } }>(ROUTES.archive, async (request, reply) => {
    const principal = await guard(request, "POST", ROUTES.archive);
    const code = parseCodeParam(request.params.code);
    const productLine = requireProductLineQuery(request.query);
    const { fault, changed } = await archiveFault({ code, productLine, actor: actorOf(principal) });
    return reply.code(200).send({ ok: true, data: { fault: faultBody(fault), changed } });
  });

  app.get(ROUTES.productLines, async (request, reply) => {
    await guard(request, "GET", ROUTES.productLines);
    // 含停用项：停用的产线不该出现在故障卡下拉里，但管理端要能看到并重新启用。
    const items = await listProductLines();
    return reply
      .code(200)
      .send({
        ok: true,
        data: {
          total: items.length,
          items: items.map((item) => ({
            code: item.code,
            name: item.name,
            active: item.active,
            created_at: item.createdAt,
          })),
        },
      });
  });

  app.post(ROUTES.productLines, async (request, reply) => {
    const principal = await guard(request, "POST", ROUTES.productLines);
    const body = requireBodyRecord(request);

    if (typeof body.code !== "string" || !PRODUCT_LINE_CODE_RE.test(body.code.trim())) {
      throw new AppError("VALIDATION", "code 必须是 1–32 位小写字母/数字/下划线/连字符，且以字母开头");
    }
    if (typeof body.name !== "string") throw new AppError("VALIDATION", "name 必须是字符串");
    const name = body.name.trim();
    if (name === "") throw new AppError("VALIDATION", "name 不能为空");
    if (name.length > PRODUCT_LINE_NAME_MAX) throw new AppError("VALIDATION", `name 最多 ${PRODUCT_LINE_NAME_MAX} 字符`);

    const item = await createProductLine({ code: body.code.trim(), name, actor: actorOf(principal) });
    return reply.code(200).send({
      ok: true,
      data: { code: item.code, name: item.name, active: item.active, created_at: item.createdAt },
    });
  });

  app.patch<{ Params: { code?: unknown } }>(ROUTES.productLine, async (request, reply) => {
    const principal = await guard(request, "PATCH", ROUTES.productLine);
    const code = typeof request.params.code === "string" ? request.params.code.trim() : "";
    if (code === "") throw new AppError("VALIDATION", "code 不合法");
    const body = requireBodyRecord(request);

    let name: string | undefined;
    if (body.name !== undefined) {
      if (typeof body.name !== "string") throw new AppError("VALIDATION", "name 必须是字符串");
      const trimmed = body.name.trim();
      if (trimmed === "") throw new AppError("VALIDATION", "name 不能为空");
      if (trimmed.length > PRODUCT_LINE_NAME_MAX) {
        throw new AppError("VALIDATION", `name 最多 ${PRODUCT_LINE_NAME_MAX} 字符`);
      }
      name = trimmed;
    }

    let active: boolean | undefined;
    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") throw new AppError("VALIDATION", "active 必须是布尔值");
      active = body.active;
    }
    if (name === undefined && active === undefined) {
      throw new AppError("VALIDATION", "至少提供 name / active 之一");
    }

    const { productLine, changed } = await updateProductLine({ code, name, active, actor: actorOf(principal) });
    return reply.code(200).send({
      ok: true,
      data: {
        product_line: {
          code: productLine.code,
          name: productLine.name,
          active: productLine.active,
          created_at: productLine.createdAt,
        },
        changed,
      },
    });
  });

  app.get(ROUTES.staff, async (request, reply) => {
    await guard(request, "GET", ROUTES.staff);
    // `core/admin-store.ts` 的 `listStaff` 逐个写死列名，响应体里不存在 `password_hash` /
    // `password_salt` 这两列（`tests/admin-api.test.ts` 直接断言响应体不含 `password`）。
    const items = await listStaff();
    return reply.code(200).send({
      ok: true,
      data: {
        total: items.length,
        items: items.map((item) => ({
          id: item.id,
          name: item.name,
          email: item.email,
          role: item.role,
          active: item.active,
          org_unit: item.orgUnit,
        })),
      },
    });
  });

  // 待审反馈（`09#04` 反馈闭环 / D16 / D26 / R26）：两个动作都是 `lead` 起。
  //
  // 为什么不是 `admin`：处置一条待审 == "这批用户的扑空我已经看过了，合并或忽略"，
  // 这是客服主管每天在做的判断；要求 admin 会让 24 条待审堆到周五。真正对外生效的那一步
  // （生成/发布一条故障码）仍然分别在 `lead`（建 draft）与 `admin`（发布）后面。
  app.get(ROUTES.faultReports, async (request, reply) => {
    await guard(request, "GET", ROUTES.faultReports);
    const { total, items } = await listFaultReports(parseReportQuery(request.query));
    return reply.code(200).send({ ok: true, data: { total, items: items.map(faultReportBody) } });
  });

  // 处置**只读 body 的 `action`**：终态由 action 推导（`merge`→`merged` / `reject`→`rejected`），
  // 不接受调用方直接指定 `status` —— 状态机在 core，不在请求体里。
  //
  // "merge" 在本卡**只改状态**：真正"把它生成一条 draft 故障码"是前端引导坐席去故障卡面板新建
  // （`POST /api/admin/faults`），不在这一条端点里偷偷建 —— 一个 PATCH 顺手写 `fault_codes`
  // 会让"谁写的这条码"在审计里对不上（建码的审计在 `fault.create`，处置的审计在这里）。
  app.patch<{ Params: { id?: unknown } }>(ROUTES.faultReport, async (request, reply) => {
    const principal = await guard(request, "PATCH", ROUTES.faultReport);
    const id = parseReportId(request.params.id);
    const body = requireBodyRecord(request);
    const action = parseReportAction(body.action);

    const { report, changed } = await resolveFaultReport({ id, action, actor: actorOf(principal) });
    return reply.code(200).send({ ok: true, data: { report: faultReportBody(report), changed } });
  });
}
