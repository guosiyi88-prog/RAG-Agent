/**
 * 坐席队列与详情处置的**数据层**（`05-api.md` §4.1–§4.3、`11-ui-console.md`、`07` spec T08）。
 *
 * 四件事：列表（筛选/分页/排序）、详情（对话 + 引用 + 工具轨迹）、补丁（认领/关单/写结论）、
 * 统计聚合。传输层（`api/console.ts`）只做鉴权、入参形状与信封，所有判定都在这里 ——
 * 两处各判一半的话，将来加一个入口（比如导出）就会漏掉"已关单不可改"。
 *
 * 五条硬约束，逐条对应 G5 的审查项：
 *   1. **SQL 全参数化**：占位符由 `placeholder()` 顺序分配，没有任何字符串拼接进 where/set；
 *      连 `limit` / `offset` 也走参数（它们同样是可被前端影响的数字）。
 *   2. **列表查询有上限**：`size` 夹在 [1, 100]（`QUEUE_PAGE_SIZE_MAX`），分页本身也受
 *      `page` 的整数校验约束 —— 没有上限的 `limit` 是一次请求就能拉走全库的口子。
 *   3. **聚合在 SQL 里做**：`count(*)`、`avg(...)`、`count(*) filter (...)` 全部由 Postgres 算，
 *      不把行拉进进程再 `reduce`（那既慢又会在库变大后突然变成 OOM）。
 *   4. **不取向量列**：本文件只碰 `tickets` / `conversations` / `staff` / `messages` / `citations` /
 *      `audit_log` / `ai_runs` 的标量列，`chunks.embedding` 一次都不出现。业务代码拿到 1024 维向量
 *      除了内存与日志泄漏之外没有任何用途。
 *   5. **不把 PII 复制第二份**：审计 payload 只存变更前后的状态/指派/结论，**不存**问题原文与
 *      联系方式（`audit_log` 保留两年，见 `04-db.md` §7）。
 *
 * 两处规格没写、但必须自己定的口径（都写在对应位置）：
 *   - 列表的 `lang` 来自 `conversations` 的连接（`tickets` 表**没有** lang 列）；
 *   - `sla_seconds_left` 由 SQL 算，且**不夹到 0**（超时给负数，前端要显示"超时 xx 分钟"）。
 */

import { one, query, tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { logger } from "../logger.ts";
import type { TicketReason } from "./ticket-store.ts";

/** `tickets.status` 的四个取值（`sql/001_init.sql` 的 check 约束，顺序按生命周期）。 */
export const TICKET_STATUS_VALUES = ["open", "claimed", "escalated", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUS_VALUES)[number];

/**
 * `tickets.reason` 的四个取值。类型从 `ticket-store.ts` 取（那里是建单方，口径以它为准），
 * 这里只补一份**运行时**数组用于入参校验 —— 两处各写一个 union 迟早会分叉成两个集合。
 */
export const TICKET_REASON_VALUES: readonly TicketReason[] = [
  "no_citation",
  "out_of_scope",
  "low_conf",
  "user_request",
];

/** 05 §4.1：`size` 默认 20、上限 100。 */
export const QUEUE_PAGE_SIZE_DEFAULT = 20;
export const QUEUE_PAGE_SIZE_MAX = 100;

/**
 * `q` 的长度上限。上限不是安全边界（参数化之后注入不成立），而是成本边界：
 * 一个 1MB 的 `q` 会让 `ilike` 在两个 text 列上做 1MB 的模式匹配，而它永远匹配不到东西。
 */
export const QUEUE_Q_MAX_CHARS = 100;

/** 05 §4.3：关单结论 ≥10 字符。 */
export const RESOLUTION_MIN_CHARS = 10;
/** 结论落 `tickets.resolution`（text），上限只为挡住"把整份文件塞进一列"这一种情况。 */
export const RESOLUTION_MAX_CHARS = 2000;

/**
 * 列表与详情共用的列清单 —— **一处**定义，两个入口就不会出现"详情比列表少一个字段"的漂移。
 *
 * 三处值得单独解释：
 *   - `c.lang`：`tickets` 表没有 lang 列（05 §4.1 的坑）。语言只在会话上，取不到（`conv_id` 为空
 *     或会话已删）就是 `null` —— 给 `'en'` 之类的默认值会让坐席按错误语言回复。
 *   - `sla_seconds_left`：`due_at - now()` 在 SQL 里算成秒。**不写 `greatest(..., 0)`**：超时的单子
 *     必须能算出负数，前端要显示"超时 34 分钟"；夹到 0 等于把所有超时单说成"刚好到期"。
 *   - `demo`：`08#03` 的演示数据靠 `tags` 里的 `'demo'` 打标。工单表不能加列（那是数据层），
 *     所以这个布尔只能在这里由 `tags` 派生 —— 字段名就叫 `demo`，前端按它决定是否显示"演示数据"。
 */
const TICKET_COLUMNS = `
        t.id,
        t.no,
        t.reason,
        t.status,
        t.question,
        t.assignee as assignee_id,
        s.name as assignee_name,
        c.lang,
        t.due_at,
        floor(extract(epoch from (t.due_at - now())))::int as sla_seconds_left,
        ('demo' = any(t.tags)) as demo,
        t.resolution,
        t.closed_at,
        t.created_at`;

/** `TICKET_COLUMNS` 的查询结果行。`id` / `assignee_id` 是 uuid/bigint，pg 给字符串。 */
type TicketRow = {
  id: string;
  no: string;
  reason: string;
  status: string;
  question: string;
  assignee_id: string | null;
  assignee_name: string | null;
  lang: string | null;
  due_at: Date | null;
  sla_seconds_left: number | null;
  demo: boolean;
  resolution: string | null;
  closed_at: Date | null;
  created_at: Date;
};

/** 05 §4.1 的列表项。字段名逐字照契约，`07#02` 之后不许改名（前端照同一份文档写）。 */
export interface TicketListItem {
  id: number;
  no: string;
  reason: string;
  status: string;
  question: string;
  lang: string | null;
  /** 指派列显示的是**姓名**（`11-ui-console.md` §2.1「无则 —」）。 */
  assignee: string | null;
  /**
   * 指派的坐席 id（契约之外的补充字段）。列表项只有姓名的话，前端要判断"这单是不是我认领的"
   * 就得拿姓名和自己手上的 uuid 猜；`PATCH` 收的又恰恰是 `assignee_id`。多给一列比多一次请求便宜。
   */
  assignee_id: string | null;
  due_at: string | null;
  sla_seconds_left: number | null;
  /** `08#03` 的演示标记：`tags` 里含 `'demo'`。 */
  demo: boolean;
  created_at: string;
}

/** 详情里的工单对象：列表项 + 结论（05 §4.2 的 `resolution`）。`closed_at` 是给"已关闭"视图用的。 */
export type TicketDetailItem = TicketListItem & {
  resolution: string | null;
  closed_at: string | null;
};

/** 05 §4.2 的引用快照（`doc_title` / `page` / `snippet` 落库即冻结，见 `citation-store.ts`）。 */
export interface TicketCitation {
  idx: number;
  doc_title: string | null;
  page: number | null;
  doc_lang: string | null;
  snippet: string | null;
}

/**
 * 05 §4.2 的一条消息。
 *
 * `refused` / `citations_count` / `tool_names` / `citations` / `no_evidence` **只有 assistant 消息才有** ——
 * 不是懒得填，而是这五个字段在用户消息上恒为空值，填上去会让前端多一条"用户消息也能标拒答"的
 * 假分支。类型里做成可选，正是为了让"有没有"可以被断言。
 */
export interface TicketMessage {
  id: number;
  role: string;
  content: string;
  created_at: string;
  refused?: boolean;
  citations_count?: number;
  tool_names?: string[];
  /**
   * AI 那一轮**没有任何检索证据**（工单要求：坐席据此决定能不能直接采纳）。
   *
   * 定义：assistant 消息 **且** 未拒答 **且** `citations` 实际行数为 0。
   * 为什么不看 `messages.citations_count`：那一列由 `citation-store` 回填，写入失败时会停在默认 0，
   * 于是"有引用但计数没刷上"会被误标成"无证据"。真实行数是同一份快照里的另一个视图，更硬。
   * 为什么不把拒答也算进来：拒答本身就是"没有证据"的**另一种显式表达**（`refused: true`），
   * 两个标记同时为真只会让前端在"⚠ 本轮无检索证据"和"已转人工"之间二选一。
   */
  no_evidence?: boolean;
  /** 只有 assistant 消息有；按 `idx` 升序，没有引用时是空数组（不是缺字段）。 */
  citations?: TicketCitation[];
}

export interface TicketDetail {
  ticket: TicketDetailItem;
  /** 会话已删（`on delete set null`）或建单时就没有会话 → `null`。 */
  conversation: { id: string; lang: string | null } | null;
  messages: TicketMessage[];
}

/**
 * 队列/详情的**观察者**（`09#03` 第三段，`docs/output/boundary-change-R2.md` §7 第 1 格）。
 *
 * `docs/output/boundary-change-R2.md` §7 的三格默认值里，与队列有关的那一条是
 * 「客服（agent）看不到同事工单的**标题** → 不能，队列里直接看不到他人工单，详情也不给看」。
 *
 * **为什么是入参而不是在 core 里读请求头**：本文件是数据层，不认识 Fastify，也不该认识
 * `requireAdmin`。可见性是一条**判定**，判定放 core（一处口径），身份从哪来（Redis 会话、
 * 将来的 SSO）留给传输层。`undefined` = 不做可见性过滤 —— 保持既有调用方（脚本、内部工具）
 * 的行为不变；路由层必须显式传，见 `api/console.ts`。
 */
export interface QueueViewer {
  staffId: string;
  role: QueueViewerRole;
}

/** 本文件用到的角色取值，与 `core/auth-login.ts` 的 `StaffRole` 同口径（不 import 它：那会拉进 redis+pg）。 */
export type QueueViewerRole = "agent" | "lead" | "admin";

/**
 * 能不能看全部工单。**只有显式的 lead/admin 算特权** —— 认不出的角色按最低处理，
 * 与 `auth.ts` 的 `rankOf`（未知角色 = `-1`）方向一致：`role` 在运行时是 Redis 里的一段
 * JSON，一个被手改成 `root` 的账号不该因此看得见全部工单。
 */
function isPrivilegedViewer(viewer: { role: QueueViewerRole }): boolean {
  return viewer.role === "lead" || viewer.role === "admin";
}

/**
 * 可见性判定的**唯一实现**：`agent` 看不到归别人的单，未分配（`null`）的单人人都能看
 * （那是等待认领的池子）。三处入口共用它 —— 详情（`getTicketDetail`）、补丁（`updateTicket`）、
 * 转 L2（`escalateTicket`）—— 将来多一个入口（转 FAQ 草稿）也调这一个，
 * 文案与 HTTP 码因此不会分叉成"同一个情况两句话"。
 */
export function assertTicketVisible(assignee: string | null, viewer: QueueViewer): void {
  if (!isPrivilegedViewer(viewer) && assignee !== null && assignee !== viewer.staffId) {
    throw new AppError("FORBIDDEN", "该工单已由他人处理");
  }
}

/**
 * 读一张单的指派人（只此一列）。给"不是读详情、但要知道这单归谁"的入口用
 * （今天只有转 FAQ 草稿）。返回 `null` = 工单不存在，由调用方决定回 400 还是 404。
 */
export async function readTicketAssignee(id: number): Promise<{ assignee: string | null } | null> {
  return one<{ assignee: string | null }>(`select assignee from tickets where id = $1::bigint`, [id]);
}

/** 列表筛选条件。`null` = 不筛（而不是"空数组也要拼一个 `= any('{}')`"）。 */
export interface QueueFilter {
  /** `null` = 05 §4.1 的默认：除 closed 之外全部。 */
  statuses: TicketStatus[] | null;
  reasons: TicketReason[] | null;
  q: string | null;
  page: number;
  size: number;
  /** 可见性（见 `QueueViewer`）。`undefined` = 不过滤。 */
  viewer?: QueueViewer;
}

function toListItem(row: TicketRow): TicketListItem {
  return {
    // bigint 在 node-postgres 里是字符串，契约（05 §4.1 示例）写的是数字。
    id: Number(row.id),
    no: row.no,
    reason: row.reason,
    status: row.status,
    question: row.question,
    lang: row.lang,
    assignee: row.assignee_name,
    assignee_id: row.assignee_id,
    due_at: row.due_at === null ? null : row.due_at.toISOString(),
    // 已经是整数秒；`null` 表示没有截止时间（这类单排最后，见 order by）。
    sla_seconds_left: row.sla_seconds_left,
    demo: row.demo,
    created_at: row.created_at.toISOString(),
  };
}

function toDetailItem(row: TicketRow): TicketDetailItem {
  return {
    ...toListItem(row),
    resolution: row.resolution,
    closed_at: row.closed_at === null ? null : row.closed_at.toISOString(),
  };
}

/**
 * `ilike` 的模式转义。
 *
 * `q` 是**用户输入的一段文字**，其中 `%` 与 `_` 对 `ilike` 是通配符：坐席搜 `100_` 时如果不过滤，
 * `_` 会变成"任意一个字符"，结果里混进一堆不相干的单。反斜杠本身是转义符（PG 的 `like` 默认
 * escape），必须先转义它，否则 `\%` 这种输入会把下一个字符吃掉。
 *
 * 注意这不涉及 SQL 注入：模式始终是**参数值**，注入早已被参数化挡住；这里修的是"搜不到/搜错"。
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 队列列表（05 §4.1）。
 *
 * 排序固定 `已升级 → due_at asc nulls last, created_at desc`，末尾再加 `t.id desc`：
 * 前两个键相同（同一秒建的两张演示单很常见）时，没有第三个键结果顺序就依赖查询计划，
 * 分页会出现"同一行在第二页又出现一次"。加一个唯一键是让翻页可重复。
 *
 * 第一个键是 `escalated` **置顶**（`docs/prd/03-agent-console.md` §操作与状态「转 L2 →
 * 队列置顶」）：升级到二线的单在等人接手，而默认视图里它们会按 due_at 沉到中段，
 * 那正是这个动作白做的方式。其余状态之间仍按时间排，行为与从前一致。
 */
export async function listTickets(filter: QueueFilter): Promise<{ total: number; items: TicketListItem[] }> {
  const params: unknown[] = [];
  /** 顺序分配占位符：这是本文件唯一的"拼 SQL"入口，值永远只经参数进去。 */
  const placeholder = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const where: string[] = [];
  // 默认"除 closed 之外"用 `<> 'closed'` 而不是 `in ('open','claimed','escalated')`：
  // 将来新增一个中间状态（比如 `waiting_user`）时，默认视图应该自动包含它，而不是悄悄把它藏起来。
  where.push(
    filter.statuses === null
      ? "t.status <> 'closed'"
      : `t.status = any(${placeholder(filter.statuses)}::text[])`,
  );
  if (filter.reasons !== null) where.push(`t.reason = any(${placeholder(filter.reasons)}::text[])`);
  // 可见性（`09#03` 第三段）：`agent` 只看"指派给自己"与"未分配池"，`lead`/`admin` 看全部。
  // 这一条必须并进**同一段** where —— `total` 与列表共用它，否则会出现"总数 30、翻页只有 4 条"
  // 这种在后台最典型的错位。未分配（`assignee is null`）必须留：那是等待认领的池子，
  // 藏起来等于让 agent 无单可干。
  if (filter.viewer !== undefined && !isPrivilegedViewer(filter.viewer)) {
    where.push(`(t.assignee = ${placeholder(filter.viewer.staffId)}::uuid or t.assignee is null)`);
  }
  if (filter.q !== null) {
    // 同一个模式给两列用：同一个 `$n` 出现两次即可，不必占两个参数位。
    const pattern = placeholder(`%${escapeLike(filter.q)}%`);
    where.push(`(t.no ilike ${pattern} or t.question ilike ${pattern})`);
  }
  const whereSql = `where ${where.join(" and ")}`;

  // total 与列表共用同一段 where（同一批参数）：分开写两份条件，翻页翻到空页而 total 说还有 30 条
  // 是这类后台最常见的 bug。count 不 join conversations/staff —— 筛选条件全在 tickets 上，
  // 多 join 两张表只会让这一次全表计数变慢。
  const totalRow = await one<{ total: number }>(`select count(*)::int as total from tickets t ${whereSql}`, [
    ...params,
  ]);
  const total = totalRow?.total ?? 0;

  const limitSql = placeholder(filter.size);
  const offsetSql = placeholder((filter.page - 1) * filter.size);

  const rows = await query<TicketRow>(
    `select ${TICKET_COLUMNS}
       from tickets t
       left join conversations c on c.id = t.conv_id
       left join staff s on s.id = t.assignee
       ${whereSql}
      order by (t.status = 'escalated') desc, t.due_at asc nulls last, t.created_at desc, t.id desc
      limit ${limitSql} offset ${offsetSql}`,
    params,
  );

  return { total, items: rows.map(toListItem) };
}

/**
 * 详情（05 §4.2）：工单 + 会话 + 全部消息 + 每条 AI 消息的引用快照。
 *
 * 返回 `null` 表示"工单不存在"，由路由翻成 404 —— 数据层不抛 HTTP 语义的错误码，
 * 除了 `AppError`（那本来就是全仓统一的错误形状）。
 *
 * **`viewer`（`09#03` 第三段）**：`agent` 查一张指派给他人的工单 → 抛 `FORBIDDEN`（403）。
 * 为什么是 403 而不是 404（`docs/output/boundary-change-R2.md` §7 的原话是"看不到标题"，
 * 不是"这单不存在"）：
 *   - 404 会让坐席以为锚点失效（`#/ticket/<id>` 是我们自己下发过的链接），于是反复重试、
 *     反复刷新，而真相是"这单归别人"；
 *   - 403 + 明确文案能直接告诉人"已由他人处理"，与队列里那行"已由他人处理"是同一种语义；
 *   - 单子在不在这件事本来就由队列的 `total` 回答了，用 404 去遮只会遮住我们自己人。
 * 未分配（`assignee is null`）的单对 `agent` 可见：那是等待认领的池子，点开才认领得了。
 *
 * 三条查询而不是一条大 join：消息 × 引用是 1:N，join 会让同一条消息按引用数重复，
 * 再去重就是自己造一个更容易错的合并。三次小查询各自走索引（`messages_conv_idx`、
 * `citations_msg_idx`），总量是一个会话几十行。
 */
export async function getTicketDetail(id: number, viewer?: QueueViewer): Promise<TicketDetail | null> {
  const row = await one<TicketRow & { conv_id: string | null }>(
    `select ${TICKET_COLUMNS}, t.conv_id
       from tickets t
       left join conversations c on c.id = t.conv_id
       left join staff s on s.id = t.assignee
      where t.id = $1::bigint`,
    [id],
  );
  if (row === null) return null;

  // 可见性判定紧跟"存在性"之后、取消息之前：不可见的单不该让本进程去读它的对话与引用，
  // 哪怕那些行一个字节都不会进响应体。规则只在 `assertTicketVisible` 里写一遍。
  if (viewer !== undefined) assertTicketVisible(row.assignee_id, viewer);

  const ticket = toDetailItem(row);
  // 没有会话（匿名单、或会话已被删）就没有消息可看：返回空数组而不是 `null`，
  // 前端的 `renderThread` 只需处理"空列表"一种情况。
  if (row.conv_id === null) return { ticket, conversation: null, messages: [] };

  const messageRows = await query<{
    id: string;
    role: string;
    content: string;
    refused: boolean;
    tool_names: string[] | null;
    citations_count: number;
    created_at: Date;
  }>(
    // 引用计数在 SQL 里数（G5：聚合在库里做）。`cross join lateral` 让每行只数一次，
    // 比在 select 里连写两遍同样的子查询（一次给 count 一次给 no_evidence）少一次扫描。
    `select m.id,
            m.role,
            m.content,
            m.refused,
            m.tool_names,
            k.n::int as citations_count,
            m.created_at
       from messages m
       cross join lateral (
         select count(*) as n from citations ci where ci.message_id = m.id
       ) k
      where m.conv_id = $1::uuid
      order by m.created_at asc, m.id asc`,
    [row.conv_id],
  );

  const messageIds = messageRows.map((message) => message.id);
  const citeRows =
    messageIds.length === 0
      ? []
      : await query<{
          message_id: string;
          idx: number;
          doc_title: string | null;
          doc_lang: string | null;
          page: number | null;
          snippet: string | null;
        }>(
          // `idx` 升序是契约（05 §4.2 末行）：前端按角标编号渲染，顺序错了列表会乱。
          `select message_id, idx, doc_title, doc_lang, page, snippet
             from citations
            where message_id = any($1::bigint[])
            order by message_id, idx asc`,
          [messageIds],
        );

  const citationsByMessage = new Map<string, TicketCitation[]>();
  for (const cite of citeRows) {
    const list = citationsByMessage.get(cite.message_id) ?? [];
    list.push({
      idx: cite.idx,
      doc_title: cite.doc_title,
      page: cite.page,
      doc_lang: cite.doc_lang,
      snippet: cite.snippet,
    });
    citationsByMessage.set(cite.message_id, list);
  }

  const messages: TicketMessage[] = messageRows.map((message) => {
    const base: TicketMessage = {
      id: Number(message.id),
      role: message.role,
      content: message.content,
      created_at: message.created_at.toISOString(),
    };
    if (message.role !== "assistant") return base;

    const citations = citationsByMessage.get(message.id) ?? [];
    return {
      ...base,
      refused: message.refused,
      citations_count: message.citations_count,
      // `tool_names` 是 text[] not null，理论上有值；`?? []` 只挡老数据里的 null。
      // 工具耗时（ms）**不在这里**：`ai_runs.tool_calls` 有 ms 但没有 message_id
      // （`run-log.ts` 明说那两个可空列不填），用它按顺序猜配会把耗时贴到别的一轮上。
      tool_names: message.tool_names ?? [],
      no_evidence: !message.refused && message.citations_count === 0,
      citations,
    };
  });

  return {
    ticket,
    conversation: { id: row.conv_id, lang: row.lang },
    messages,
  };
}

/** 补丁的三种字段，`undefined` 一律表示"这一次不动它"。 */
export interface TicketPatch {
  status?: TicketStatus;
  /** 传了就改；`{ set: null }` = 清空指派（转回未认领）。 */
  assignee?: { set: string | null };
  resolution?: string;
}

/**
 * 05 §4.3 的补丁作用于谁 —— 认领时"我"是谁由 `requireAdmin` 决定，这里只接结果。
 *
 * `role` 是 `09#03` 第三段加的：派发（把单给别人 / 清空指派）是 `lead`/`admin` 的权力
 * （`docs/output/boundary-change-R2.md` §7 与 §3 的那一格），判定在 `updateTicket` 里，
 * 不散在路由 —— 将来多一个批量入口就少一处漏判。
 *
 * 同一份身份也做**可见性**判定（`09#04` 收口）：`agent` 改他人的单直接 403，
 * 与 `getTicketDetail` 同一口径 —— 读得到的才写得动，否则"看不见"只是一句界面上的话。
 */
export interface PatchPrincipal {
  staffId: string;
  staffName: string;
  role: QueueViewerRole;
}

/**
 * 把补丁写进库，并留一条 `audit_log`（05 §4.3）。
 *
 * 顺序是刻意的：`select ... for update` → 判不可变 → 判可见性 → 判派发权 → 校验指派
 * → update → 审计，全在一个事务里。**判定顺序本身就是契约**，逐条理由：
 *   1. **404（不存在）**：路径里的 id 来自前端锚点 `#/ticket/<id>`，失效的 id 意思是"这单不见了"，
 *      而不是"你参数写错了"；也因为它最先答，后面的 403/409 才谈得上"对这单的判断"。
 *   2. **409（已关闭）**：不可改变的状态先答。一张已关的单，坐席最需要知道的是"这单不能改了"，
 *      换个身份也过不去；把 403 放在前面等于让人去找主管重试一件注定失败的事。
 *   3. **403（可见性）**：`agent` 看不到他人工单（`listTickets` 已把他人工单滤掉、`getTicketDetail`
 *      已 403），写路径若不判，这条缺口就是"看不见标题，但拿得到 id 就能改状态/结论"。
 *      判在派发权之前：可见性是更基本的"这单归不归你管"，派发权是"你能不能把它挪给别人"；
 *      两句话都回 403，但先答更基本的那条，文案才不会误导。
 *   4. **403（派发权）**：只有 `lead`/`admin` 能把单派给**他人**或**清空**指派。
 *   5. **400（指派对象不存在）**：最后才查 uuid。权限先于存在性 —— `agent` 拿着一串 uuid 试探时
 *      得不到"这个 id 存在/不存在"的答案。
 *
 *   - **为什么先 select for update**：审计 payload 要存"改之前是什么样"，而 `update ... returning`
 *     只给改之后的值。锁住这一行同时也消掉了"读完到写之间的竞态"（两个人同时认领会互相覆盖，
 *     但至少审计里的前后差异不会是假的）。
 *   - **为什么应用层判 closed**：不是为了替代触发器（`guard_ticket_status` 才是权威，见下面的
 *     `P0001` 翻译），而是为了让 409 成为**可预测**的结果 —— 触发器抛的是 SQL 层异常，
 *     一次 `catch` 写漏就会变成 500。
 *
 * 返回 `changed` 让路由/前端知道这次到底动了哪些字段：一个"只改了 resolution 文本"的补丁
 * 不该被审计记成一次状态变更。
 */
export async function updateTicket(input: {
  id: number;
  patch: TicketPatch;
  principal: PatchPrincipal;
}): Promise<{ ticket: TicketDetailItem; changed: string[] }> {
  const { id, patch, principal } = input;

  const changed = await tx(async (client) => {
    const current = await client.query<{
      id: string;
      no: string;
      status: string;
      assignee: string | null;
      resolution: string | null;
    }>("select id, no, status, assignee, resolution from tickets where id = $1::bigint for update", [id]);
    const before = current.rows[0];
    // 不存在就是 404（不是 400）：路径里的 id 来自前端的锚点 `#/ticket/<id>`，
    // 一个失效的 id 对坐席的意思是"这单不见了"，而不是"你参数写错了"。
    if (before === undefined) throw new AppError("NOT_FOUND", "工单不存在");
    if (before.status === "closed") throw new AppError("TICKET_IMMUTABLE", "工单已关闭，不能再修改");

    // 可见性（`09#04` 收口，`AGENTS.md`「已知缺口」第 1 条 / `09#03` 遗留 1）：读路径早已判
    // （`listTickets` 滤掉他人工单、`getTicketDetail` 403），写路径此前没判，于是
    // "看不见标题"只挡住了眼睛，没挡住拿着 id 直接 PATCH 的手。
    //
    // 四条取舍：
    //   - **判在 409 之后**：先给不可改变的结论（这单已关，谁都改不了），再谈身份。
    //   - **判在派发权之前**：可见性比派发权更基本（"这单归不归你管" vs "你能不能挪给别人"）。
    //   - **文案与 `getTicketDetail` 逐字一致**（"该工单已由他人处理"）：同一种情况说同一句话，
    //     前端不需要为"改不动"和"看不见"维护两套解释。
    //   - **未分配（`assignee is null`）必须放行**：认领是 `agent` 的正当动作，认领的前提正是
    //     "这是池子里没人要的单"。放行的是**可见性**这一层，认领本身仍要过派发权（派给自己 = 允许）。
    //     同理，`assignee = 我` 的单调状态/写结论必须继续放行 —— 那是坐席的日常工作。
    // 规则与文案只写在 `assertTicketVisible`（与 `getTicketDetail` / `escalateTicket` 共用）。
    assertTicketVisible(before.assignee, principal);

    // 派发权限（`09#03` 第三段 / `boundary-change-R2.md` §7）：只有 `lead`/`admin` 能把单派给
    // **他人**或**清空**指派；`agent` 只能把单派给自己（= 认领）。
    //
    // 三条取舍：
    //   - 判在 closed 之后：一张已关的单再改指派，坐席最需要知道的答案是"这单不能改了"（409），
    //     而不是"你没权限"（403）—— 前者不可改变，后者换个身份就能过。
    //   - 判在"指派对象存不存在"之前：先 403 再 400，agent 拿着一串 uuid 试探时不会得到
    //     "这个 id 存在/不存在"的答案。
    //   - 只看**显式**下发的 `assignee`：`{status:"claimed"}` 不写 assignee，随后的自动指派
    //     给"我"不是一次派发。`{assignee_id: null}` 是显式清空 —— 哪怕同时把状态设成 claimed，
    //     它表达的仍是"把单从某人手上摘下来"，那是派发权。
    if (patch.assignee !== undefined) {
      const target = patch.assignee.set;
      const isSelf = target !== null && target === principal.staffId;
      if (!isSelf && !isPrivilegedViewer(principal)) {
        throw new AppError("FORBIDDEN", "权限不足：只有 lead/admin 可以把工单派给他人或取消指派");
      }
    }

    const nextStatus = patch.status ?? before.status;
    let nextAssignee = patch.assignee !== undefined ? patch.assignee.set : before.assignee;
    const nextResolution = patch.resolution ?? before.resolution;

    // 05 §4.3：认领但没指定人 → 落到"我"（登录会话里的 staffId，`09#03` 起不再有客户端自称）。
    // 这一条必须在写库前算完：放到路由层就等于"认领"这个语义有两个实现。
    if (nextStatus === "claimed" && nextAssignee === null) nextAssignee = principal.staffId;

    // 指派的坐席必须真实存在且有 `active` 语义可言。查一次而不是让外键 23503 抛出来：
    // 外键错误信息里带表名与约束名，翻成 500 之后调用方只会以为服务崩了。
    if (nextAssignee !== null) {
      const staff = await client.query("select 1 from staff where id = $1::uuid", [nextAssignee]);
      if (staff.rowCount === 0) throw new AppError("VALIDATION", "assignee_id 不存在");
    }

    const changedFields: string[] = [];
    if (nextStatus !== before.status) changedFields.push("status");
    if (nextAssignee !== before.assignee) changedFields.push("assignee");
    if (nextResolution !== before.resolution) changedFields.push("resolution");

    try {
      await client.query(
        `update tickets
            set status = $2::text,
                assignee = $3::uuid,
                resolution = $4::text
          where id = $1::bigint`,
        [id, nextStatus, nextAssignee, nextResolution],
      );
    } catch (err) {
      const translated = translateTicketWriteError(err);
      if (translated !== null) throw translated;
      throw err;
    }

    // 没有实际变化就不写审计：审计表保留两年，"点了一下但什么都没改"的噪音会把它变成
    // 一份读不下去的流水账。前端拿到的 `changed: []` 已经足够表达"这次是空操作"。
    if (changedFields.length > 0) {
      await client.query(
        `insert into audit_log (actor, action, target, payload)
         values ($1, 'ticket.update', $2, $3::jsonb)`,
        [
          principal.staffName,
          before.no,
          // jsonb：`pg` 会把对象序列化成 Postgres 数组字面量，必须自己 JSON.stringify。
          // payload 只放状态/指派/结论的**前后值**与操作者 id；问题原文与联系方式不进审计
          // ——那张表保留两年，是"另存一份 PII"最容易发生的地方。
          JSON.stringify({
            staff_id: principal.staffId,
            ticket_no: before.no,
            changed: changedFields,
            before: { status: before.status, assignee: before.assignee, resolution: before.resolution },
            after: { status: nextStatus, assignee: nextAssignee, resolution: nextResolution },
          }),
        ],
      );
    }

    return changedFields;
  });

  // 事务提交后再读一次带 join 的完整行（lang / assignee_name 是跨表值）。
  const row = await one<TicketRow>(
    `select ${TICKET_COLUMNS}
       from tickets t
       left join conversations c on c.id = t.conv_id
       left join staff s on s.id = t.assignee
      where t.id = $1::bigint`,
    [id],
  );
  if (row === null) throw new AppError("INTERNAL", "工单更新后读不回来");

  return { ticket: toDetailItem(row), changed };
}

/* ────────────────────────── 转 L2（升级） ────────────────────────── */

/**
 * 「转 L2」写进 `tags` 的标记。`docs/prd/03-agent-console.md` §操作与状态的原话是
 * `tags += escalate`，而这张表从第一版就有 `tags text[]`（`sql/001_init.sql` 的 `tickets`）。
 *
 * 为什么状态与标签两个都要写：状态位（`escalated`）是**当前在哪一档**，队列筛选、看板计数、
 * 徽章文案都认它；标签是**发生过什么**（一单可以既 `escalated` 又带 `demo`），
 * 而且 `status` 在关单后不可逆，标签是唯一能说明"这单是被升级过的"的痕迹。
 */
export const ESCALATE_TAG = "escalate";

/**
 * 转 L2：把工单标记为已升级（`09#06` / A5 的姊妹动作；`docs/prd/03-agent-console.md` §操作与状态）。
 *
 * 为什么不复用 `updateTicket({ patch: { status: "escalated" } })`：那个入口的语义是
 * "改状态/改指派/写结论"的通用补丁，它不会写 `tags`、不区分"升级"与"别的状态变更"、
 * 也不可能幂等（同一个 status 再发一次是空操作，但标签的追加需要另判）。
 * 更实际的一点：将来 L2 会有自己的动作（E2 接单、退回一线），那些都不该塞进通用补丁里。
 *
 * 判定顺序与 `updateTicket` **逐条一致**（404 → 409 → 403 可见性）：
 *   - 404：路径 id 来自前端锚点，失效 id 的意思是"这单不见了"；
 *   - 409：已关单先答"这单不能改"（换身份也过不去）；
 *   - 403：`agent` 看不到他人工单，写路径同样不许（否则"看不见标题、拿得到 id 就能升级"）。
 * 派发权与 400 不存在：这个动作不碰 `assignee`。
 *
 * 幂等：已经是 `escalated` 且标签也在 → `changed: []`，**不写审计**（双击不该留两条流水）。
 */
export async function escalateTicket(input: {
  id: number;
  principal: PatchPrincipal;
}): Promise<{ ticket: TicketDetailItem; changed: string[] }> {
  const { id, principal } = input;

  const changed = await tx(async (client) => {
    const current = await client.query<{
      no: string;
      status: string;
      assignee: string | null;
      tags: string[];
    }>("select no, status, assignee, tags from tickets where id = $1::bigint for update", [id]);
    const before = current.rows[0];
    if (before === undefined) throw new AppError("NOT_FOUND", "工单不存在");
    if (before.status === "closed") throw new AppError("TICKET_IMMUTABLE", "工单已关闭，不能再修改");

    assertTicketVisible(before.assignee, principal);

    const hasTag = before.tags.includes(ESCALATE_TAG);
    if (before.status === "escalated" && hasTag) return [];
    const nextTags = hasTag ? before.tags : [...before.tags, ESCALATE_TAG];

    const changedFields: string[] = [];
    if (before.status !== "escalated") changedFields.push("status");
    if (!hasTag) changedFields.push("tags");

    try {
      await client.query(
        `update tickets set status = 'escalated', tags = $2::text[] where id = $1::bigint`,
        [id, nextTags],
      );
    } catch (err) {
      const translated = translateTicketWriteError(err);
      if (translated !== null) throw translated;
      throw err;
    }

    await client.query(
      `insert into audit_log (actor, action, target, payload)
       values ($1, 'ticket.escalate', $2, $3::jsonb)`,
      [
        principal.staffName,
        before.no,
        // payload 与 `ticket.update` 同口径：只存前后状态与标签，**不存问题原文**（PII）。
        JSON.stringify({
          staff_id: principal.staffId,
          ticket_no: before.no,
          changed: changedFields,
          before: { status: before.status, tags: before.tags },
          after: { status: "escalated", tags: nextTags },
        }),
      ],
    );

    return changedFields;
  });

  const row = await one<TicketRow>(
    `select ${TICKET_COLUMNS}
       from tickets t
       left join conversations c on c.id = t.conv_id
       left join staff s on s.id = t.assignee
      where t.id = $1::bigint`,
    [id],
  );
  if (row === null) throw new AppError("INTERNAL", "工单升级后读不回来");

  return { ticket: toDetailItem(row), changed };
}

/**
 * 写工单失败的翻译表（只认两种，其余原样抛给上层变 500 —— 那才是真的内部错误）。
 *
 *   - `P0001` + "immutable" = `guard_ticket_status` 触发器（`sql/001_init.sql`）。理论上
 *     `select ... for update` 已经挡住了并发，但**触发器是权威**：未来任何一条绕过本函数的
 *     写路径也会撞上它，把它翻成 409 只是让"绕过接口也改不了"在 HTTP 上也可见。
 *   - `23503` = 外键。指派在事务里已经查过存在性，能走到这里只剩"查完到写之间被删"，
 *     对调用方仍然是"你给的 assignee_id 不存在"。
 */
function translateTicketWriteError(err: unknown): AppError | null {
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : "";
  if (code === "P0001" && /immutable/i.test(message)) {
    logger.warn({ code }, "console: 已关闭工单的更新被触发器拦下，翻成 409");
    return new AppError("TICKET_IMMUTABLE", "工单已关闭，不能再修改");
  }
  if (code === "23503") return new AppError("VALIDATION", "assignee_id 不存在");
  return null;
}

/**
 * 看板时间窗（`09#01`，决策 R1-5）。`today` = 本地当天 0 点起；`week` = 最近 7 天（滚动）；
 * `all` = 不设下界。
 *
 * 这份清单是**唯一**来源：`api/console.ts` 拿它校验入参，`windowStart` 拿它算下界 ——
 * 路由里再抄一份允许值，两处迟早分叉成两个集合。
 */
export const STATS_WINDOW_VALUES = ["today", "week", "all"] as const;
export type StatsWindow = (typeof STATS_WINDOW_VALUES)[number];

/**
 * 看板口径（`09#01`）。两个维度都由调用方显式给出，**本文件不写默认值** ——
 * 默认值只活在路由的入参解析里，这样"默认排除演示数据、默认全时段"只有一个出处。
 */
export interface StatsFilter {
  /** `true` = 排除 `tags` 含 `'demo'` 的演示工单（`08#03` 造的 8 张）。 */
  excludeDemo: boolean;
  window: StatsWindow;
}

/**
 * 时间窗下界。`all` 给 `null`（不设下界）。
 *
 * 起点在 **Node 侧按进程本地时区**算好，再作为参数传进 SQL，而不是用 `date_trunc('day', now())`：
 * 后者的"今天"取决于**数据库会话的 TimeZone**（`data/docker-compose.yml` 从 `TZ` 注入），
 * 一句 `set timezone` 就能把看板上的"今天"挪走八小时；而坐席看到的"今天"应该跟服务进程的
 * 本地时钟一致。`week` 是滚动 7×24h 而不是自然周：周一早上打开看板不该只剩一天的数据。
 */
function windowStart(window: StatsWindow): Date | null {
  if (window === "all") return null;
  if (window === "today") {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return midnight;
  }
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

/** 坐席端统计（`05-api.md` §2 第 15 行：真实聚合，不做图表）。 */
export interface ConsoleStats {
  tickets_total: number;
  /** 未关闭的单（open + claimed + escalated）。坐席最关心的那个数。 */
  tickets_pending: number;
  tickets_by_status: { open: number; claimed: number; escalated: number; closed: number };
  /**
   * `ai_runs` 的轮数（拒答率的分母），与工单侧用**同一**时间窗和**同一** demo 口径。
   *
   * **已知差异（`09#01`，别当 bug 修）**：`ai_runs` 自己没有 `demo` 标记（`sql/001_init.sql`
   * 第 260 行起，无 `tags` 列），排除演示会话只能靠"`ai_runs.conv_id` → `tickets.conv_id`
   * → `tags` 含 `'demo'`"反查。而 `08#03` 造的 8 张演示工单 `conv_id` 全是 `null`（演示工单
   * 没有真实会话），所以这条反查**当前恒为空集**：演示会话真跑出 run 的话，它仍留在分母里。
   * 反查不到任何工单的 run（`conv_id` 为 null）同理留在分母。要让这条口径真正生效，
   * 得先给演示工单接一个真会话 —— 那是数据层的事，不在这张卡的范围。
   */
  runs_total: number;
  runs_refused: number;
  /** 拒答率 0–1，三位小数。没有运行记录时是 0（配合 `runs_total: 0` 区分"没数据"与"零拒答"）。 */
  refusal_rate: number;
  /** 未关闭且有截止时间的单的平均剩余秒数（可为负）。没有这样的单时是 `null`。 */
  sla_seconds_left_avg: number | null;
  /** 本次口径回显：看板卡片要能写清"哪段时间、含不含演示数据"，不靠前端记自己发过什么。 */
  window: StatsWindow;
  exclude_demo: boolean;
}

/**
 * 统计聚合。两条查询各自把聚合做完再回来，进程里不做 `reduce`。
 *
 * 拒答率用 `ai_runs` 而不是 `messages`：`ai_runs` 是"每一轮 LLM 运行"的账（`06-agent.md` §9），
 * 故障码快路（不调模型）本来就没有运行记录，把它算进分母会把拒答率稀释成好看的数字。
 *
 * `avg(...)::float8`：`avg` 返回 numeric，`pg` 会把它当字符串交出来；`::float8` 之后才是 JSON 数字。
 *
 * 过滤条件在 SQL 里拼：工单侧是一条 where 同时管"时间窗"与"demo"（`count(*)` 与各个
 * `filter (...)` 共用同一段条件 —— 分开写两份，就会出现"总数 40、各状态加起来 32"）；
 * `ai_runs` 侧用 `not exists` 反查，**反查不到就留在分母**（见 `runs_total` 的注释）。
 */
export async function readStats(filter: StatsFilter): Promise<ConsoleStats> {
  const since = windowStart(filter.window);

  const ticketParams: unknown[] = [];
  const ticketWhere: string[] = [];
  if (since !== null) {
    ticketParams.push(since);
    ticketWhere.push(`created_at >= $${ticketParams.length}::timestamptz`);
  }
  // `tags` 是 `not null default '{}'`，不用挡 null；`not ('demo' = any('{}'))` 为 true，空标签照常计入。
  if (filter.excludeDemo) ticketWhere.push(`not ('demo' = any(tags))`);
  const ticketWhereSql = ticketWhere.length === 0 ? "" : `where ${ticketWhere.join(" and ")}`;

  const ticketRow = await one<{
    total: number;
    pending: number;
    open: number;
    claimed: number;
    escalated: number;
    closed: number;
    sla_avg: number | null;
  }>(
    `select count(*)::int as total,
            count(*) filter (where status <> 'closed')::int as pending,
            count(*) filter (where status = 'open')::int as open,
            count(*) filter (where status = 'claimed')::int as claimed,
            count(*) filter (where status = 'escalated')::int as escalated,
            count(*) filter (where status = 'closed')::int as closed,
            (avg(extract(epoch from (due_at - now())))
               filter (where status <> 'closed' and due_at is not null))::float8 as sla_avg
       from tickets
       ${ticketWhereSql}`,
    ticketParams,
  );

  const runParams: unknown[] = [];
  const runWhere: string[] = [];
  if (since !== null) {
    runParams.push(since);
    runWhere.push(`r.created_at >= $${runParams.length}::timestamptz`);
  }
  if (filter.excludeDemo) {
    // 反查**不带时间窗**：demo 标记在工单上，一个会话是演示会话就永远是 —— 演示工单 3 天前建、
    // 其会话今天还在跑，那么今天的 run 也必须排除。`conv_id` 为 null 的 run 匹配不到任何工单，
    // `not exists` 为真 → 留在分母（与 `runs_total` 注释里写明的差异一致）。
    runWhere.push(
      `not exists (select 1 from tickets t where t.conv_id = r.conv_id and 'demo' = any(t.tags))`,
    );
  }
  const runWhereSql = runWhere.length === 0 ? "" : `where ${runWhere.join(" and ")}`;

  const runRow = await one<{ runs: number; refused: number }>(
    `select count(*)::int as runs,
            count(*) filter (where r.refused)::int as refused
       from ai_runs r
       ${runWhereSql}`,
    runParams,
  );

  const runsTotal = runRow?.runs ?? 0;
  const runsRefused = runRow?.refused ?? 0;
  const slaAvg = ticketRow?.sla_avg ?? null;

  return {
    tickets_total: ticketRow?.total ?? 0,
    tickets_pending: ticketRow?.pending ?? 0,
    tickets_by_status: {
      open: ticketRow?.open ?? 0,
      claimed: ticketRow?.claimed ?? 0,
      escalated: ticketRow?.escalated ?? 0,
      closed: ticketRow?.closed ?? 0,
    },
    runs_total: runsTotal,
    runs_refused: runsRefused,
    refusal_rate: runsTotal === 0 ? 0 : Math.round((runsRefused / runsTotal) * 1000) / 1000,
    // 平均剩余秒数给整数：前端只显示"平均 2h14m"，小数秒是噪声。
    sla_seconds_left_avg: slaAvg === null ? null : Math.round(slaAvg),
    window: filter.window,
    exclude_demo: filter.excludeDemo,
  };
}

/* ────────────────────────── 看板时间序列（图表用，`09#04` 看板 A 方案） ────────────────────────── */

/** 图表只支持两个窗口：7 天与 30 天。再长没有意义（演示环境的数据量撑不起"季度趋势"）。 */
export const SERIES_WINDOW_VALUES = ["7d", "30d"] as const;
export type SeriesWindow = (typeof SERIES_WINDOW_VALUES)[number];

export const SERIES_DAYS: Record<SeriesWindow, number> = { "7d": 7, "30d": 30 };

export type SeriesPoint = {
  /** `YYYY-MM-DD`，**本地时区**的日期（`created_at::date` 走库的时区，与 `windowStart` 同口径）。 */
  day: string;
  tickets: number;
  runs: number;
  refused: number;
  /** 0–1，三位小数；`runs = 0` 的日期给 0（与 `readStats` 的 `refusal_rate` 同口径）。 */
  refusal_rate: number;
};

/**
 * 按天的时间序列。**必须补零**：没有单子的日子也要出现在结果里，否则折线会把两个不相邻的
 * 日期连成一条直线，看图的人会以为那几天"没有波动"而不是"没有数据"。
 *
 * 口径与 `readStats` 保持一致：排除 `tags` 含 `'demo'` 的工单（演示数据不算业务量），
 * 拒答率用 `ai_runs` 而不是 `messages`（快路不调模型，进分母会稀释）。
 * 时间窗以外的行不参与，`generate_series` 负责给出完整的日期骨架。
 */
export async function readTicketSeries(window: SeriesWindow): Promise<SeriesPoint[]> {
  const days = SERIES_DAYS[window];
  const rows = await query<{ day: string; tickets: number; runs: number; refused: number }>(
    `with span as (
       select generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date as day
     ),
     tk as (
       select created_at::date as day, count(*)::int as n
         from tickets
        where not ('demo' = any(tags))
          and created_at >= current_date - ($1::int - 1)
        group by 1
     ),
     rn as (
       select created_at::date as day,
              count(*)::int as runs,
              count(*) filter (where refused)::int as refused
         from ai_runs
        where created_at >= current_date - ($1::int - 1)
        group by 1
     )
     select to_char(s.day, 'YYYY-MM-DD') as day,
            coalesce(tk.n, 0)::int as tickets,
            coalesce(rn.runs, 0)::int as runs,
            coalesce(rn.refused, 0)::int as refused
       from span s
       left join tk on tk.day = s.day
       left join rn on rn.day = s.day
      order by s.day`,
    [days],
  );

  return rows.map((row) => ({
    day: row.day,
    tickets: row.tickets,
    runs: row.runs,
    refused: row.refused,
    refusal_rate: row.runs === 0 ? 0 : Math.round((row.refused / row.runs) * 1000) / 1000,
  }));
}
