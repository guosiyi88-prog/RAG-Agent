/**
 * 管理端数据通路（`09#04` / `docs/prdv1.3/scope-delta.md` S4）：故障卡全状态读写 + 产品线字典 + 人员列表。
 *
 * **为什么不复用 `core/fault-codes.ts`**：那个文件是**对外**路径（`/api/fault/:code` + 对话快路），
 * 它的 `LOOKUP_SQL` 只认 `status = 'published'`（D15）—— 那条条件是"用户只能看到审过的码"的
 * 唯一实现，动它等于把草稿放进公开接口。管理端要看到 draft / archived，所以这里另开一条读路径：
 * **同一张表、不同的可见性口径**，两条路各自只有一处条件，谁都不会误用另一条的。
 *
 * 三条写入口径：
 *   1. **管理端写入一律 `draft`**（D15）：`createFault` 的 SQL 里 `status` 是字面量 `'draft'`，
 *      调用方即使把 `status: "published"` 塞进 body 也改不动它 —— 发布只有 `publishFault` 一条路。
 *   2. **归档只改 `status`，永不删行**（D25）：`tickets` / `qa_gold` 可能引用这个码，删了之后
 *      `make ingest` 会把它重新插进来，而且"删掉"这件事没有审计可读。所以 `archiveFault` 只写
 *      `status = 'archived'`，行与十列文案一个字都不动。
 *   3. **`published` 的码改一个字就落回 `draft`**：改完要重新发布（admin 点头），否则"谁最后改的"
 *      与"谁批准上线"会变成同一个人 —— 发布态的意义就在于这两步分开。
 *
 * 写操作都留 `audit_log`：`actor` 来自会话（`requireAdmin` 给出的真实登录人），`payload` 只记
 * **状态与字段名**，不记整段文案 —— 那张表保留两年，往里塞五语长文就是"另存一份 PII"。
 *
 * 事务边界与 `core/ticket-queue.ts` 的 `updateTicket` 一致：`select ... for update` → 判状态 →
 * update → 审计，全在一个事务里。先锁行是为了让"判状态"与"写状态"之间没有竞态
 * （两个 admin 同时点发布/归档，最终只会有一个顺序，而不是各自基于旧状态做出决定）。
 */
import { one, query, tx } from "../db.ts";
import type { PoolClient } from "pg";
import { AppError } from "../errors.ts";

/* ────────────────────────── 枚举与类型 ────────────────────────── */

/** 发布态（`09#02` / D15）。顺序即"生命周期顺序"，报错文案与前端下拉都按它排。 */
export const FAULT_STATUS_VALUES = ["draft", "published", "archived"] as const;
export type FaultStatus = (typeof FAULT_STATUS_VALUES)[number];

/** 严重度。库里允许 NULL（历史数据），所以是"取值之一或没有"。 */
export const FAULT_SEVERITY_VALUES = ["info", "warn", "fatal"] as const;
export type FaultSeverity = (typeof FAULT_SEVERITY_VALUES)[number];

/**
 * 五语十列的语言维度（`12-i18n.md`）。**这里的顺序就是语言菜单的顺序**，
 * 也是"缺哪些语"列表的顺序 —— 前端不用自己再排一遍。
 */
export const FAULT_TEXT_LANGS = ["zh", "en", "de", "nl", "es"] as const;
export type FaultTextLang = (typeof FAULT_TEXT_LANGS)[number];

/** 一门语言的文案：`desc`（含义）与 `act`（处理步骤）各一列。`null` = 这门语还没写。 */
export type FaultText = Record<FaultTextLang, string | null>;

/** 审计要的人。`role` 不进 core：谁能做哪件事由 `src/api/roles.ts` 的表 + 路由决定。 */
export type AdminActor = { staffId: string; staffName: string };

/** 列表行：不含任何一段文案（表格只显示"语言完整度"，不显示正文）。 */
export type FaultSummary = {
  code: string;
  productLine: string;
  severity: string | null;
  status: FaultStatus;
  /** 含义与步骤都写全了的语言，按 `FAULT_TEXT_LANGS` 的顺序。 */
  completeLangs: FaultTextLang[];
  /** 还缺语的语言（两者互补，长度相加恒为 5）。 */
  missingLangs: FaultTextLang[];
  /** `completeLangs.length`（0–5）。前端要显示 `5/5` / `2/5`，让它自己数会数出两种口径。 */
  langCount: number;
  createdAt: string;
  updatedAt: string;
};

/** 详情：列表行 + 十列全文。 */
export type FaultDetail = FaultSummary & { desc: FaultText; act: FaultText };

/* ────────────────────────── SQL 片段 ────────────────────────── */

/**
 * 「这门语言写全了」的判据：两列都非空**且不是空白串**。
 *
 * 为什么连空白串一起算缺语：`desc_en = '   '` 在管理端表格里会显示成"英文已填"，
 * 而在对外路径上 `core/fault-codes.ts` 的 `pickText` 会跳过它、回退到别的语言 ——
 * 两处口径必须一致，否则会出现"面板说五语齐全、用户看到的却是回退文本"。
 */
function langCompleteSql(lang: FaultTextLang): string {
  return `(nullif(btrim(desc_${lang}), '') is not null and nullif(btrim(act_${lang}), '') is not null)`;
}

/** 五语齐全（= 可以发布）。发布校验与列表筛选 `missing_lang` 共用这一句。 */
const ALL_LANGS_COMPLETE_SQL = FAULT_TEXT_LANGS.map(langCompleteSql).join(" and ");

/** 列表与详情共用的列：十列文案之外，再加五个"这语齐了没"的布尔。 */
const SUMMARY_COLUMNS = `
  code, product_line, severity, status, created_at, updated_at,
  ${FAULT_TEXT_LANGS.map((lang) => `${langCompleteSql(lang)} as has_${lang}`).join(",\n  ")}
`;

const TEXT_COLUMNS = ["desc_zh", "desc_en", "desc_de", "desc_nl", "desc_es", "act_zh", "act_en", "act_de", "act_nl", "act_es"] as const;

/** 详情 = 摘要列 + 十列正文（`has_*` 与正文同源，见 `DetailRow` 的注释）。 */
const DETAIL_COLUMNS = `
  ${SUMMARY_COLUMNS.trim()},
  ${TEXT_COLUMNS.join(", ")}
`;

/** 行形状（pg 出来的是 snake_case + Date）。 */
type SummaryRow = {
  code: string;
  product_line: string;
  severity: string | null;
  status: FaultStatus;
  created_at: Date;
  updated_at: Date;
} & Record<`has_${FaultTextLang}`, boolean>;

/**
 * 详情行 = 摘要行 + 十列正文。
 *
 * 详情查询**也把 `has_*` 一起选出来**，而不是在 TS 里重新判一遍"这门语齐了没"：
 * 判据只写一次（`langCompleteSql`），列表与详情永远是同一个结论。代价是多扫五行布尔表达式，
 * 收益是"面板显示 5/5、发布却报缺语"这种自相矛盾永远不会出现。
 */
type DetailRow = SummaryRow & Record<(typeof TEXT_COLUMNS)[number], string | null>;

/** 审计目标串的唯一拼法：`fault:E03@balcony` / `product_line:foo`。前缀让清理与检索不会撞。 */
export function faultTarget(code: string, productLine: string): string {
  return `fault:${code}@${productLine}`;
}

function productLineTarget(code: string): string {
  return `product_line:${code}`;
}

function toSummary(row: SummaryRow): FaultSummary {
  const completeLangs = FAULT_TEXT_LANGS.filter((lang) => row[`has_${lang}`]);
  const missingLangs = FAULT_TEXT_LANGS.filter((lang) => !row[`has_${lang}`]);
  return {
    code: row.code,
    productLine: row.product_line,
    severity: row.severity,
    status: row.status,
    completeLangs,
    missingLangs,
    langCount: completeLangs.length,
    // 时间一律 ISO 字符串进 HTTP：Date 的 JSON 形状是同一串，但显式的 `toISOString()`
    // 让"这一层给的是什么"不依赖 JSON 序列化的实现细节。
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toDetail(row: DetailRow): FaultDetail {
  const desc = Object.fromEntries(FAULT_TEXT_LANGS.map((lang) => [lang, row[`desc_${lang}`]])) as FaultText;
  const act = Object.fromEntries(FAULT_TEXT_LANGS.map((lang) => [lang, row[`act_${lang}`]])) as FaultText;
  return { ...toSummary(row), desc, act };
}

/* ────────────────────────── 故障码：读 ────────────────────────── */

export type FaultListFilter = {
  productLine: string | null;
  severities: FaultSeverity[] | null;
  statuses: FaultStatus[] | null;
  /** `true` = 只看缺语的；`false` = 只看五语齐的；`null` = 不筛（三态，别用 `??`）。 */
  missingLang: boolean | null;
  page: number;
  size: number;
};

/**
 * 列表：**全部状态**（这正是与 `core/fault-codes.ts` 的区别），筛选与分页在 SQL 里做。
 *
 * `total` 与列表用**同一段 where**：两个口径分开算，翻到最后一页时会发现总数比能翻到的行多。
 * 排序按"最近改动在前"（`updated_at desc`）—— 管理端第一眼要看的是刚被改过的那几条；
 * 同时间戳的按主键排，保证翻页不会出现同一行两次（`updated_at` 不是唯一的）。
 */
export async function listFaults(filter: FaultListFilter): Promise<{ total: number; items: FaultSummary[] }> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.productLine !== null) {
    params.push(filter.productLine);
    where.push(`product_line = $${params.length}`);
  }
  if (filter.severities !== null) {
    params.push(filter.severities);
    where.push(`severity = any($${params.length}::text[])`);
  }
  if (filter.statuses !== null) {
    params.push(filter.statuses);
    where.push(`status = any($${params.length}::text[])`);
  }
  if (filter.missingLang === true) where.push(`not (${ALL_LANGS_COMPLETE_SQL})`);
  if (filter.missingLang === false) where.push(`(${ALL_LANGS_COMPLETE_SQL})`);

  const whereSql = where.length === 0 ? "" : `where ${where.join(" and ")}`;

  const totalRow = await one<{ n: string }>(`select count(*)::text as n from fault_codes ${whereSql}`, params);
  const total = Number(totalRow?.n ?? "0");

  params.push(filter.size, (filter.page - 1) * filter.size);
  const rows = await query<SummaryRow>(
    `select ${SUMMARY_COLUMNS}
       from fault_codes
       ${whereSql}
      order by updated_at desc, code, product_line
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { total, items: rows.map(toSummary) };
}

/**
 * 单条全量（任意状态）。`productLine` 是必需的：主键是 `(code, product_line)`，
 * 只按 `code` 查会拿到别的产品线同名码（`F21` 只在 residential 存在就是例子）。
 */
export async function getFault(code: string, productLine: string): Promise<FaultDetail | null> {
  const row = await one<DetailRow>(
    `select ${DETAIL_COLUMNS} from fault_codes where code = $1 and product_line = $2`,
    [code, productLine],
  );
  return row === null ? null : toDetail(row);
}

/* ────────────────────────── 故障码：写 ────────────────────────── */

/** 在同一个事务里读回完整行（写完要回给前端，读的是库里真正的值而不是拼出来的）。 */
async function readDetailForUpdate(
  client: PoolClient,
  code: string,
  productLine: string,
): Promise<DetailRow | null> {
  const result = await client.query<DetailRow>(
    `select ${DETAIL_COLUMNS} from fault_codes
      where code = $1 and product_line = $2
      for update`,
    [code, productLine],
  );
  return result.rows[0] ?? null;
}

async function writeAudit(
  client: PoolClient,
  input: { action: string; target: string; actor: AdminActor; payload: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `insert into audit_log (actor, action, target, payload) values ($1, $2, $3, $4::jsonb)`,
    // jsonb：`pg` 会把对象序列化成 Postgres 数组字面量，必须自己 JSON.stringify（同 `ticket-queue`）。
    [input.actor.staffName, input.action, input.target, JSON.stringify(input.payload)],
  );
}

/**
 * 新建：**一律落 `draft`**（D15）。
 *
 * `status` 不进参数列表 —— SQL 里写死 `'draft'`。不写成"读 body 的 status 再取默认值"，
 * 是因为那样将来任何一次"顺手支持一下 status"的改动都会变成一个发布后门；
 * 而"发布必须走 `publishFault`"这件事只有写死在 SQL 里才守得住。
 *
 * 已存在同 `(code, product_line)` → 409 `CONFLICT`。不是 400：请求本身没错，是这行已经在了；
 * 也不是静默覆盖 —— 覆盖会绕过"编辑 published 要落回 draft"这条口径。
 */
export async function createFault(input: {
  code: string;
  productLine: string;
  severity: FaultSeverity | null;
  desc: Partial<FaultText>;
  act: Partial<FaultText>;
  actor: AdminActor;
}): Promise<FaultDetail> {
  const { code, productLine, severity, desc, act, actor } = input;

  return tx(async (client) => {
    const inserted = await client.query<{ code: string }>(
      `insert into fault_codes
         (code, product_line, severity,
          desc_zh, desc_en, desc_de, desc_nl, desc_es,
          act_zh,  act_en,  act_de,  act_nl,  act_es,
          status)
       values ($1, $2, $3,
               $4, $5, $6, $7, $8,
               $9, $10, $11, $12, $13,
               'draft')
       on conflict (code, product_line) do nothing
       returning code`,
      [
        code,
        productLine,
        severity,
        desc.zh ?? null,
        desc.en ?? null,
        desc.de ?? null,
        desc.nl ?? null,
        desc.es ?? null,
        act.zh ?? null,
        act.en ?? null,
        act.de ?? null,
        act.nl ?? null,
        act.es ?? null,
      ],
    );
    if (inserted.rowCount === 0) {
      throw new AppError("CONFLICT", `故障码 ${code}（${productLine}）已存在，请改用编辑`);
    }

    const row = await readDetailForUpdate(client, code, productLine);
    if (row === null) throw new AppError("INTERNAL", "故障码新建后读不回来");

    await writeAudit(client, {
      action: "fault.create",
      target: faultTarget(code, productLine),
      actor,
      // payload 只放状态与"填了哪几门语"，不放正文。
      payload: {
        staff_id: actor.staffId,
        code,
        product_line: productLine,
        status: "draft",
        severity,
        filled_langs: toDetail(row).completeLangs,
      },
    });

    return toDetail(row);
  });
}

/**
 * 编辑（`lead` 起）。
 *
 * 三条状态规则：
 *   - `draft` 随便改，改完还是 `draft`；
 *   - `published` 改完**自动落回 `draft`** —— 要重新点发布。否则一次错字修正就悄悄改了
 *     用户正在看的答复，而"谁批准的"这一步被跳过；
 *   - `archived` 不许改（409 `CONFLICT`）：归档态的定义是"这行只做历史留档"。
 *
 * **`severity` 是三态**（`09#04` 未做第 5 条）：`undefined` = 不改；`null` = **清空为 NULL**；
 * `FaultSeverity` = 写入。`desc` / `act` 仍是"`undefined` = 不改、`null`/空串 = 清空这一门语"，
 * 两套语义各自清楚，不互相套（理由见 `api/admin.ts` 的 PATCH 处理器）。
 *
 * 没有任何实际变化时**不写库、不写审计**（与 `updateTicket` 同口径）：审计保留两年，
 * "点了一下但什么都没改"的流水会让它读不下去。前端从 `changed: []` 就能看出这是一次空操作。
 * 对 `severity` 而言，"变化"以**值**判：本来就 NULL 时再传 `null` 不是变化（`changed: []`），
 * 否则一次"清空"会被记成一次修改，而审计里 before/after 一模一样。
 */
export async function updateFault(input: {
  code: string;
  productLine: string;
  /** 三态：`undefined` 不改、`null` 清空、有值则写入。 */
  severity?: FaultSeverity | null;
  desc?: Partial<FaultText>;
  act?: Partial<FaultText>;
  actor: AdminActor;
}): Promise<{ fault: FaultDetail; changed: string[] }> {
  const { code, productLine, severity, desc, act, actor } = input;

  return tx(async (client) => {
    const before = await readDetailForUpdate(client, code, productLine);
    if (before === null) throw new AppError("NOT_FOUND", "故障码不存在");
    if (before.status === "archived") {
      throw new AppError("CONFLICT", "已归档的故障码不能再修改（归档只做历史留档）");
    }

    const changed: string[] = [];
    const sets: string[] = [];
    const params: unknown[] = [code, productLine];

    // 三态在 SQL 上的落法：`severity === null` 会进参数列表，于是 `set severity = $n` 的值是 NULL ——
    // 这正是"清空"。`undefined` 走不进这个分支，所以"没传"不会碰这一列。
    // 比较用**值**（`severity !== before.severity`）而不是 `!== undefined`：本来就 NULL 的行再传
    // `null` 不算变化，不进 `changed`、不写审计（否则审计里 before/after 一模一样）。
    if (severity !== undefined && severity !== before.severity) {
      params.push(severity);
      sets.push(`severity = $${params.length}`);
      changed.push("severity");
    }

    for (const kind of ["desc", "act"] as const) {
      const patch = kind === "desc" ? desc : act;
      if (patch === undefined) continue;
      for (const lang of FAULT_TEXT_LANGS) {
        const next = patch[lang];
        if (next === undefined) continue;
        const column = `${kind}_${lang}` as (typeof TEXT_COLUMNS)[number];
        if (next === before[column]) continue;
        params.push(next);
        sets.push(`${column} = $${params.length}`);
        changed.push(`${kind}.${lang}`);
      }
    }

    if (changed.length === 0) return { fault: toDetail(before), changed };

    // 发布态一经修改就落回 draft（见函数头第 2 条）。这不是"顺手"，是"改完必须重新发布"。
    const nextStatus: FaultStatus = before.status === "published" ? "draft" : before.status;
    if (nextStatus !== before.status) {
      params.push(nextStatus);
      sets.push(`status = $${params.length}`);
      changed.push("status");
    }
    sets.push("updated_at = now()");

    await client.query(
      `update fault_codes set ${sets.join(", ")} where code = $1 and product_line = $2`,
      params,
    );

    const after = await readDetailForUpdate(client, code, productLine);
    if (after === null) throw new AppError("INTERNAL", "故障码更新后读不回来");

    await writeAudit(client, {
      action: "fault.update",
      target: faultTarget(code, productLine),
      actor,
      payload: {
        staff_id: actor.staffId,
        code,
        product_line: productLine,
        changed,
        before: { status: before.status },
        after: { status: nextStatus },
      },
    });

    return { fault: toDetail(after), changed };
  });
}

/**
 * 发布（`admin` 起，`boundary-change-R2.md` §7 第 2 格）。
 *
 * **五语十列必须全非空**（D14）：`published` 是"用户能看到的"，而对外路径的回退链
 * （`core/fault-codes.ts` 的 `request → en → zh`）只解决"某一语缺了"的观感问题，
 * 解决不了"德语用户永远读到英文"的产品问题 —— 那等于发布了一条三语的码。
 *
 * 缺语 → **409 `CONFLICT`**（不是 400）：请求形状没问题、资源也在，是这行的**状态**
 * 不允许发布。400 会让人去查请求体，而真正要做的动作是"把缺的那几语补上"，
 * 所以 message 里直接点名缺哪几门语。
 *
 * 已经是 `published` → 200 且 `changed: []`（幂等）：双击发布按钮不该报错。
 * `archived` → 409：归档是本卡定义的终点，恢复不在本卡范围（要恢复走数据层并留记录）。
 */
export async function publishFault(input: {
  code: string;
  productLine: string;
  actor: AdminActor;
}): Promise<{ fault: FaultDetail; changed: string[] }> {
  const { code, productLine, actor } = input;

  return tx(async (client) => {
    const before = await readDetailForUpdate(client, code, productLine);
    if (before === null) throw new AppError("NOT_FOUND", "故障码不存在");
    if (before.status === "archived") {
      throw new AppError("CONFLICT", "已归档的故障码不能发布");
    }

    const detail = toDetail(before);
    if (detail.missingLangs.length > 0) {
      throw new AppError(
        "CONFLICT",
        `发布要求五语齐全，还缺 ${detail.missingLangs.join("、")}（含义与处理步骤都要写）`,
      );
    }
    if (before.status === "published") return { fault: detail, changed: [] };

    await client.query(
      `update fault_codes set status = 'published', updated_at = now()
        where code = $1 and product_line = $2`,
      [code, productLine],
    );
    const after = await readDetailForUpdate(client, code, productLine);
    if (after === null) throw new AppError("INTERNAL", "故障码发布后读不回来");

    await writeAudit(client, {
      action: "fault.publish",
      target: faultTarget(code, productLine),
      actor,
      payload: {
        staff_id: actor.staffId,
        code,
        product_line: productLine,
        changed: ["status"],
        before: { status: before.status },
        after: { status: "published" },
        langs: detail.completeLangs,
      },
    });

    return { fault: toDetail(after), changed: ["status"] };
  });
}

/**
 * 归档（`admin` 起）：**只改 `status`，不删行**（D25）。
 *
 * 不删行的三个理由（都写在这里，因为"归档不就是删掉吗"是最常见的手滑）：
 *   ① `tickets` / `qa_gold` 可能引用这个码，行没了引用就悬空；
 *   ② 删了之后 `make ingest` / 种子会把它重新插进来，于是"归档"在下一次入库后自动复活；
 *   ③ 归档要能回答"谁在什么时候下的架" —— 删除只留下一条审计，行的内容再也查不回来。
 *
 * 已归档 → 200 且 `changed: []`（幂等）。归档本身不校验语言：一个写了一半的 draft 也可以归档
 * （下架不需要它完整）。
 */
export async function archiveFault(input: {
  code: string;
  productLine: string;
  actor: AdminActor;
}): Promise<{ fault: FaultDetail; changed: string[] }> {
  const { code, productLine, actor } = input;

  return tx(async (client) => {
    const before = await readDetailForUpdate(client, code, productLine);
    if (before === null) throw new AppError("NOT_FOUND", "故障码不存在");
    if (before.status === "archived") return { fault: toDetail(before), changed: [] };

    await client.query(
      `update fault_codes set status = 'archived', updated_at = now()
        where code = $1 and product_line = $2`,
      [code, productLine],
    );
    const after = await readDetailForUpdate(client, code, productLine);
    if (after === null) throw new AppError("INTERNAL", "故障码归档后读不回来");

    await writeAudit(client, {
      action: "fault.archive",
      target: faultTarget(code, productLine),
      actor,
      payload: {
        staff_id: actor.staffId,
        code,
        product_line: productLine,
        changed: ["status"],
        before: { status: before.status },
        after: { status: "archived" },
      },
    });

    return { fault: toDetail(after), changed: ["status"] };
  });
}

/* ────────────────────────── 产品线字典 ────────────────────────── */

export type ProductLine = {
  code: string;
  name: string;
  active: boolean;
  createdAt: string;
};

type ProductLineRow = { code: string; name: string; active: boolean; created_at: Date };

function toProductLine(row: ProductLineRow): ProductLine {
  return { code: row.code, name: row.name, active: row.active, createdAt: row.created_at.toISOString() };
}

/** 列表：**含停用**。停用的产线要从故障卡下拉里消失，但管理端要能看到并重新启用。 */
export async function listProductLines(): Promise<ProductLine[]> {
  const rows = await query<ProductLineRow>(
    `select code, name, active, created_at from product_lines order by created_at, code`,
  );
  return rows.map(toProductLine);
}

/** 新增（`admin`）。`code` 冲突 → 409（不静默改名、不静默覆盖）。 */
export async function createProductLine(input: {
  code: string;
  name: string;
  actor: AdminActor;
}): Promise<ProductLine> {
  const { code, name, actor } = input;
  return tx(async (client) => {
    const inserted = await client.query<ProductLineRow>(
      `insert into product_lines (code, name) values ($1, $2)
       on conflict (code) do nothing
       returning code, name, active, created_at`,
      [code, name],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new AppError("CONFLICT", `产品线 ${code} 已存在`);

    await writeAudit(client, {
      action: "product_line.create",
      target: productLineTarget(code),
      actor,
      payload: { staff_id: actor.staffId, code, name, active: true },
    });
    return toProductLine(row);
  });
}

/**
 * 改名 / 停用（`admin`）。`active=false` 是**停用而不是删除**：
 * 历史故障码仍挂在这个产线上（没有外键），删行会让字典与数据对不上。
 */
export async function updateProductLine(input: {
  code: string;
  name?: string;
  active?: boolean;
  actor: AdminActor;
}): Promise<{ productLine: ProductLine; changed: string[] }> {
  const { code, name, active, actor } = input;
  return tx(async (client) => {
    const current = await client.query<ProductLineRow>(
      `select code, name, active, created_at from product_lines where code = $1 for update`,
      [code],
    );
    const before = current.rows[0];
    if (before === undefined) throw new AppError("NOT_FOUND", "产品线不存在");

    const changed: string[] = [];
    const sets: string[] = [];
    const params: unknown[] = [code];
    if (name !== undefined && name !== before.name) {
      params.push(name);
      sets.push(`name = $${params.length}`);
      changed.push("name");
    }
    if (active !== undefined && active !== before.active) {
      params.push(active);
      sets.push(`active = $${params.length}`);
      changed.push("active");
    }
    if (changed.length === 0) return { productLine: toProductLine(before), changed };

    const updated = await client.query<ProductLineRow>(
      `update product_lines set ${sets.join(", ")} where code = $1
       returning code, name, active, created_at`,
      params,
    );
    const row = updated.rows[0];
    if (row === undefined) throw new AppError("INTERNAL", "产品线更新后读不回来");

    await writeAudit(client, {
      action: "product_line.update",
      target: productLineTarget(code),
      actor,
      payload: {
        staff_id: actor.staffId,
        code,
        changed,
        // 只记名字与启停，不记别的（字典就这几列，但口径要一致：payload 只放状态与字段名）。
        before: { name: before.name, active: before.active },
        after: { name: row.name, active: row.active },
      },
    });
    return { productLine: toProductLine(row), changed };
  });
}

/* ────────────────────────── 人员列表 ────────────────────────── */

export type StaffListItem = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  orgUnit: string | null;
};

/**
 * 人员列表（`admin`）：派发下拉与人员管理的数据源。
 *
 * **列名逐个写死，绝不用 `select *`**：`staff` 表有 `password_hash` / `password_salt`，
 * 一次 `select *` 加上一次"把行原样下发"就会把口令哈希送进浏览器。这里连类型都不含这两列，
 * 所以将来谁想把行直接 spread 进响应体，也得先改这个类型 —— 类型是第一道闸。
 *
 * 含停用账号：停用的人不该出现在派发下拉里，但管理端要能看到并能重新启用（与产品线同口径）。
 * 排序：在用的在前，其次按姓名。
 */
export async function listStaff(): Promise<StaffListItem[]> {
  const rows = await query<{
    id: string;
    name: string;
    email: string;
    role: string;
    active: boolean;
    org_unit: string | null;
  }>(
    `select id, name, email, role, active, org_unit
       from staff
      order by active desc, name`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active,
    orgUnit: row.org_unit,
  }));
}

/* ────────────────────────── 故障码反馈（待审） ────────────────────────── */

/**
 * 反馈面（`09#04` / D16 / D26 / R26，表在 `sql/001_init.sql` 第 19 节）。
 *
 * **收什么、不收什么**（D26 的原话"范围必须说小"）：只收**码级反馈** —— 用户在故障码页
 * 查了一个不存在的码（`/api/fault/:code` 的 `found:false`）。"用户描述了一个故障"
 * （"我的机器嗡嗡响"）要对话/工单抽取，是第二条模型路径，排 backlog。所以本节的入参里
 * **没有** `question` / `description` 之类的字段，只有 `quote`（短摘录，200 字硬上限）。
 *
 * **为什么这张表必须有处置动作 + 看板计数才不算白做**（R26）：`v_no_hit` 是现成的反例 ——
 * 有数据、没消费，一个月后就是第二个死池子。所以两条配套一起落地：
 *   ① 每条上报有 `merge` / `reject` 两个动作，处置后从默认（`new`）列表消失；
 *   ② `readFaultReportCounts` 给看板三个数（new / 24h 新增 / 合并率）。
 */
export const FAULT_REPORT_SOURCE_VALUES = ["page", "chat", "ticket"] as const;
export type FaultReportSource = (typeof FAULT_REPORT_SOURCE_VALUES)[number];

/** 处置态。`new` 是唯一"待办"态，另两个都是终态（行永远留着，合并率要读）。 */
export const FAULT_REPORT_STATUS_VALUES = ["new", "merged", "rejected"] as const;
export type FaultReportStatus = (typeof FAULT_REPORT_STATUS_VALUES)[number];

/** 两个处置动作。`"merge"` 只把状态改成 `merged`；真正"生成 draft 故障码"是前端引导编辑，不在这里。 */
export const FAULT_REPORT_ACTION_VALUES = ["merge", "reject"] as const;
export type FaultReportAction = (typeof FAULT_REPORT_ACTION_VALUES)[number];

/** `quote` 的硬上限：与库里的 check 同值（两边都截一次，应用层先截是为了不靠异常兜底）。 */
export const FAULT_REPORT_QUOTE_MAX = 200;

/**
 * 去重窗口（小时）：同一 `(code, product_line)` 在窗口内只留一条。
 *
 * 口径是**"存在就不插"，不是"计数 +1"** —— 理由见 `sql/001_init.sql` 第 19 节的注释：
 * 这张表是坐席的待审清单，不是热度榜。窗口条件通过 `make_interval(hours => $n)` 传进来，
 * 于是"24"这个数只在 TS 里出现一次，SQL 里没有第二份。
 */
export const FAULT_REPORT_DEDUP_HOURS = 24;

export type FaultReport = {
  id: number;
  code: string;
  productLine: string;
  source: FaultReportSource;
  lang: string;
  /** 短摘录（可为空）。**不是**问题原文 —— 见文件头的 PII 口径。 */
  quote: string | null;
  convId: string | null;
  ticketId: string | null;
  status: FaultReportStatus;
  createdAt: string;
};

/** 行形状（pg 出来的是 snake_case + Date + bigint 字符串）。 */
type FaultReportRow = {
  id: string;
  code: string;
  product_line: string;
  source: FaultReportSource;
  lang: string;
  quote: string | null;
  conv_id: string | null;
  ticket_id: string | null;
  status: FaultReportStatus;
  created_at: Date;
};

const FAULT_REPORT_COLUMNS = `id, code, product_line, source, lang, quote, conv_id, ticket_id, status, created_at`;

function toFaultReport(row: FaultReportRow): FaultReport {
  return {
    // bigint 在 node-postgres 里是字符串，HTTP 契约要数字（与 `ticket-queue` 同口径）。
    id: Number(row.id),
    code: row.code,
    productLine: row.product_line,
    source: row.source,
    lang: row.lang,
    quote: row.quote,
    convId: row.conv_id,
    ticketId: row.ticket_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * 摘录截断。按**码点**切（`Array.from`），不用 `String.slice`：后者按 UTF-16 码元切，
 * 一个 emoji 占两位，结果可能是"前端说 200 字、库里存了 197 字"，更糟的是把代理对切成两半。
 * 空白摘录归一成 `null`：库里"没摘录"只有一种表示。
 */
function clampQuote(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const chars = Array.from(raw.trim());
  if (chars.length === 0) return null;
  return chars.length > FAULT_REPORT_QUOTE_MAX
    ? chars.slice(0, FAULT_REPORT_QUOTE_MAX).join("")
    : chars.join("");
}

/**
 * 记一条"查不到的码"。**返回 `true` = 真插了一行**，`false` = 24 小时内已有同一码的反馈（被折叠）。
 *
 * 单条 `insert ... select ... where not exists`：判断与写入是同一条语句，中间没有可插入的缝隙
 * （仍然不是绝对互斥 —— 两个同码请求在同一毫秒到达时都可能通过 `not exists`，代价是多一行
 * 待审记录，不影响任何正确性；为此建唯一索引反而表达不了"窗口内唯一"，且会让"24 小时后再来一次"
 * 变成冲突异常）。
 *
 * `quote` 在这里截断到 200 字（库里的 check 是第二道闸，见 `clampQuote`）。
 */
export async function recordFaultReport(input: {
  code: string;
  productLine: string;
  lang: string;
  source: FaultReportSource;
  quote?: string | null;
  convId?: string | null;
  ticketId?: number | null;
}): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `insert into fault_reports (code, product_line, source, lang, quote, conv_id, ticket_id)
     select $1::text, $2::text, $3::text, $4::char(2), $5::text, $6::uuid, $7::bigint
      where not exists (
        select 1 from fault_reports
         where code = $1::text
           and product_line = $2::text
           and created_at > now() - make_interval(hours => $8::int)
      )
     returning id`,
    [
      input.code,
      input.productLine,
      input.source,
      input.lang,
      clampQuote(input.quote),
      input.convId ?? null,
      input.ticketId ?? null,
      FAULT_REPORT_DEDUP_HOURS,
    ],
  );
  return rows.length > 0;
}

export type FaultReportListFilter = {
  /** `null` = 不筛（管理端默认给 `["new"]`，见 `api/admin.ts` 的入参解析）。 */
  statuses: FaultReportStatus[] | null;
  page: number;
  size: number;
};

/**
 * 待审列表。`total` 与列表用**同一段 where**（与 `listFaults` 同口径：分开算就会翻到空白页）。
 *
 * 排序 `created_at desc, id desc`：最新扑空的码在最上面 —— 待审清单的读法是"今天又冒出哪些码"；
 * 同秒的两条按 id 兜底，避免翻页时同一行出现两次。
 */
export async function listFaultReports(
  filter: FaultReportListFilter,
): Promise<{ total: number; items: FaultReport[] }> {
  const params: unknown[] = [];
  let whereSql = "";
  if (filter.statuses !== null) {
    params.push(filter.statuses);
    whereSql = `where status = any($${params.length}::text[])`;
  }

  const totalRow = await one<{ n: string }>(`select count(*)::text as n from fault_reports ${whereSql}`, params);
  const total = Number(totalRow?.n ?? "0");

  params.push(filter.size, (filter.page - 1) * filter.size);
  const rows = await query<FaultReportRow>(
    `select ${FAULT_REPORT_COLUMNS}
       from fault_reports
       ${whereSql}
      order by created_at desc, id desc
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { total, items: rows.map(toFaultReport) };
}

/**
 * 处置一条待审（`merge` → `merged` / `reject` → `rejected`）。
 *
 * 三条状态规则（与 `publishFault` 同风格：幂等成功 / 状态冲突 409）：
 *   - 已是目标态 → 200 且 `changed: []`（双击"忽略"不该报错）；
 *   - 已经被处置成**另一个**终态 → 409 `CONFLICT`：两个坐席同时点了"合并"和"忽略"，
 *     后到的那个不该悄悄改掉前一个人的结论（合并率的口径就指着这一列）;
 *   - 不存在 → 404 `NOT_FOUND`（前端列表里的 id 失效时该刷新，不是该重试）。
 *
 * `select ... for update` 先锁行：判状态与写状态之间不留竞态。
 * 审计只记状态与码，**不记 quote** —— 它是用户输入的一段摘录，没有进审计的理由。
 */
export async function resolveFaultReport(input: {
  id: number;
  action: FaultReportAction;
  actor: AdminActor;
}): Promise<{ report: FaultReport; changed: string[] }> {
  const { id, action, actor } = input;
  const target: FaultReportStatus = action === "merge" ? "merged" : "rejected";

  return tx(async (client) => {
    const current = await client.query<FaultReportRow>(
      `select ${FAULT_REPORT_COLUMNS} from fault_reports where id = $1 for update`,
      [id],
    );
    const before = current.rows[0];
    if (before === undefined) throw new AppError("NOT_FOUND", "待审反馈不存在");

    if (before.status === target) return { report: toFaultReport(before), changed: [] };
    if (before.status !== "new") {
      throw new AppError(
        "CONFLICT",
        `这条反馈已被处置为 ${before.status}，不能再改成 ${target}`,
      );
    }

    const updated = await client.query<FaultReportRow>(
      `update fault_reports set status = $2 where id = $1 returning ${FAULT_REPORT_COLUMNS}`,
      [id, target],
    );
    const row = updated.rows[0];
    if (row === undefined) throw new AppError("INTERNAL", "待审反馈处置后读不回来");

    await writeAudit(client, {
      action: action === "merge" ? "fault_report.merge" : "fault_report.reject",
      target: faultReportTarget(id),
      actor,
      payload: {
        staff_id: actor.staffId,
        id,
        code: before.code,
        product_line: before.product_line,
        changed: ["status"],
        before: { status: before.status },
        after: { status: target },
      },
    });

    return { report: toFaultReport(row), changed: ["status"] };
  });
}

/** 审计目标串：`fault_report:<id>`。前缀让"清理测试夹具"与检索都不会撞别的表的 id。 */
export function faultReportTarget(id: number): string {
  return `fault_report:${id}`;
}

/** 看板的三个反馈计数（R26：缺一不做这张表）。 */
export type FaultReportCounts = {
  /** 待审条数（`status = 'new'`）。这是坐席要干的活有多少。 */
  new: number;
  /** 24 小时内新增的条数（**不分状态**）：这是"这个回路还在动吗"。 */
  last24h: number;
  /**
   * 合并率 = `merged / (merged + rejected)`，0–1 三位小数。分母 0 时给 0
   * （与 `refusal_rate` 同口径：分母为 0 时前端该显示"还没有数据"，数字 0 不骗人）。
   */
  merge_rate: number;
};

/**
 * 三个计数的唯一读法。
 *
 * **口径刻意固定为全量：不受 `window`、也不受 `exclude_demo` 影响。**
 * 理由：这三个数是**队列健康度**，不是看板上的筛选结果 —— 它回答"积压了多少、回路还在不在动、
 * 处置倾向如何"，把一个 24 小时指标塞进 `window=today` 里会让"今天"这个词同时表示两件事
 * （今天的工单 / 今天的反馈），而 `merge_rate` 用时间窗切分后分母会小到没有统计意义。
 * 而 `fault_reports` 也**没有 demo 标记**：一条"用户查了不存在的码"的反馈是不是演示期间产生的，
 * 与坐席要不要处置它无关（演示数据也只可能来自演示脚本，本卡不造这类行）。
 * 所以：`GET /api/console/stats?window=today&exclude_demo=false` 里
 * `tickets_*` 跟着参数走，`reports.*` 恒定全量 —— 响应里 `window` / `exclude_demo` 两个回显
 * 只描述工单侧口径，这一点写在 `api/console.ts` 的注释里（前端不要把 `reports` 标成"今日"）。
 *
 * 一条 SQL 取三个分子：三次往返会让三个数来自三个瞬间（读的时候正好有人处置了一条，
 * 就会出现"new 是 5、合并率的分母是 3"这种自己都解释不通的组合）。
 */
export async function readFaultReportCounts(): Promise<FaultReportCounts> {
  const row = await one<{ new_count: number; last24h: number; merged: number; rejected: number }>(
    `select (count(*) filter (where status = 'new'))::int as new_count,
            (count(*) filter (where created_at > now() - make_interval(hours => $1::int)))::int as last24h,
            (count(*) filter (where status = 'merged'))::int as merged,
            (count(*) filter (where status = 'rejected'))::int as rejected
       from fault_reports`,
    [FAULT_REPORT_DEDUP_HOURS],
  );

  const merged = row?.merged ?? 0;
  const rejected = row?.rejected ?? 0;
  const resolved = merged + rejected;
  return {
    new: row?.new_count ?? 0,
    last24h: row?.last24h ?? 0,
    merge_rate: resolved === 0 ? 0 : Math.round((merged / resolved) * 1000) / 1000,
  };
}

/* ────────────────────────── 看板图表：故障码语言完整度（`09#04` A 方案） ────────────────────────── */

/**
 * `published` 故障码按"齐了几门语"分桶（0–5）。
 *
 * 为什么只统计 `published`：对外承诺是"用户看到的每条都五语齐全"（D14），draft 缺语是正常的
 * 录入中状态。把 draft 算进来，这张图会永远是"大部分不齐"，而它想回答的问题是
 * "**已经对外**的码里还有没有缺语的"（正常应全在 5 这一桶）。
 *
 * 判定与门禁同口径：一门语算"齐"要求 `desc_*` 与 `act_*` **都不为空**（只有含义没有处理步骤
 * 等于答不完整），空白串按空处理（`btrim`）。
 */
export async function readFaultLangHistogram(): Promise<{ langs: number; count: number }[]> {
  const rows = await query<{ langs: number; count: number }>(
    `select n as langs, count(*)::int as count
       from (
         select (case when coalesce(btrim(desc_zh), '') <> '' and coalesce(btrim(act_zh), '') <> '' then 1 else 0 end
               + case when coalesce(btrim(desc_en), '') <> '' and coalesce(btrim(act_en), '') <> '' then 1 else 0 end
               + case when coalesce(btrim(desc_de), '') <> '' and coalesce(btrim(act_de), '') <> '' then 1 else 0 end
               + case when coalesce(btrim(desc_nl), '') <> '' and coalesce(btrim(act_nl), '') <> '' then 1 else 0 end
               + case when coalesce(btrim(desc_es), '') <> '' and coalesce(btrim(act_es), '') <> '' then 1 else 0 end) as n
           from fault_codes
          where status = 'published'
       ) s
      group by n
      order by n`,
  );
  return rows.map((row) => ({ langs: Number(row.langs), count: Number(row.count) }));
}
