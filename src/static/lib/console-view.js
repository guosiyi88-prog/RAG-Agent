/**
 * 坐席端的 HTML 构造（**纯函数**：入参 → 字符串，不碰 DOM、不发请求）。
 *
 * 为什么从 `console.js` 拆出来：控制器里每一行都在改状态（轮询、路由、认领、草稿），
 * 而"把一条工单画成一行表格"是可以单独断言的 —— 尤其是**转义**：客户问题摘要里出现
 * `<script>`、`&`、引号都是常态，漏一个 `esc()` 就会把整张表的结构顶坏
 * （`tests/console-web.test.ts` 专门有一条转义用例盯着这里）。
 *
 * 派发那几件（`canDispatch` / `shouldDispatch` / `dispatchBody`）也住在这里而不是 `console.js`：
 * 它们是"画不画、发不发、发什么"的判据，与它画出来的那段 HTML 同源；放到控制器里就会变成
 * "HTML 在一边、判定在另一边"，两份口径迟早会分叉（按钮亮着、判定说不该发）。
 *
 * 形状对齐 `11-ui-console.md` §1–§3 的 DOM 契约（`.queue` / `.detail` 三栏 / `.t-msg`）。
 */
import { renderCitations } from "./cite.js";
import { formatClock, formatDayMinute } from "./console-time.js";

/** 原因枚举与文案（`05-api.md` §4.1 的 `reason` 取值 + 11 §2.3 的中文标签）。 */
export const REASONS = [
  ["", "全部原因"],
  ["no_citation", "无引用"],
  ["out_of_scope", "越界"],
  ["low_conf", "低置信"],
  ["user_request", "用户要求"],
];
export const REASON_LABEL = Object.fromEntries(REASONS.filter(([value]) => value !== ""));
export const STATUS_LABEL = { open: "待处理", claimed: "已认领", escalated: "已升级", closed: "已关闭" };
export const LANG_LABEL = { zh: "中文", en: "英语", de: "德语", nl: "荷兰语", es: "西班牙语" };

/**
 * 唯一的转义出口。用 `&#39;` 而不是 `&apos;`：后者是 XML 实体，HTML4 的解析器不认，
 * 虽然现代浏览器都没问题，但工单内容是别人填的，没必要在这种地方赌浏览器。
 */
export function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

/** 摘要列：40 个**字符**（不是 40 个 UTF-16 码元）；全文进 `title`。 */
export function summaryOf(question) {
  const text = String(question ?? "");
  const chars = Array.from(text);
  return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : text;
}

/* ───────────────────────── 队列 ───────────────────────── */

export function queueHtml({ status, reason, q, size, sizes }) {
  const reasonOptions = REASONS.map(
    ([value, label]) => `<option value="${esc(value)}"${reason === value ? " selected" : ""}>${esc(label)}</option>`,
  ).join("");
  const sizeOptions = sizes
    .map((value) => `<option value="${value}"${size === value ? " selected" : ""}>${value} 条/页</option>`)
    .join("");
  return `<section class="queue" aria-label="工单队列">
  <div class="queue-toolbar">
    <div class="tabs" role="tablist" aria-label="状态筛选">
      <button type="button" class="tab-btn" role="tab" data-status="open,claimed,escalated" aria-selected="${status !== "closed" && status !== "escalated"}">待处理</button>
      <!-- 已升级单独一页：升级上来的单在默认视图里被"置顶"了，但一旦积到十几张，
           混在待处理里就只能靠徽章一个个找。这一页是 L2 的接单口（09#06）。 -->
      <button type="button" class="tab-btn" role="tab" data-status="escalated" aria-selected="${status === "escalated"}">已升级</button>
      <button type="button" class="tab-btn" role="tab" data-status="closed" aria-selected="${status === "closed"}">已关闭</button>
    </div>
    <select class="input c-select" id="filter-reason" aria-label="按原因筛选">${reasonOptions}</select>
    <input class="input c-search" id="filter-q" type="search" placeholder="搜单号或问题摘要" aria-label="搜单号或问题摘要" value="${esc(q)}">
    <!-- 排序由后端固定（due_at asc nulls last, created_at desc，05 §4.1）。
         这里必须写出来：列头没有排序箭头时，人会以为"点一下就能换排序"。 -->
    <span class="queue-hint">按截止时间升序（无截止排最后）</span>
    <select class="input c-select" id="size" aria-label="每页条数">${sizeOptions}</select>
  </div>
  <div class="queue-status" id="queue-status" role="status"></div>
  <div class="grid-wrap">
    <table class="grid">
      <!-- SLA 列 128px：最需要被看见的那一格在 100px 下会被省略号吃掉尾巴，
           而「超时 1h 5…」和「超时 1h 59m」截断后看起来一样长 —— 坐席分不出紧急程度。 -->
      <colgroup><col style="width:140px"><col><col style="width:64px"><col style="width:110px"><col style="width:84px"><col style="width:128px"><col style="width:116px"></colgroup>
      <thead><tr>
        <th scope="col">单号</th><th scope="col">摘要</th><th scope="col">语言</th>
        <th scope="col">原因</th><th scope="col">指派</th>
        <th scope="col" aria-sort="ascending">SLA</th><th scope="col">创建</th>
      </tr></thead>
      <tbody id="queue-body"></tbody>
    </table>
    <div class="empty" id="queue-empty" hidden>暂无工单</div>
  </div>
  <div class="pager">
    <button class="btn btn-ghost" type="button" data-act="prev-page">上一页</button>
    <button class="btn btn-ghost" type="button" data-act="next-page">下一页</button>
    <span class="pager-info" id="page-info"></span>
  </div>
</section>`;
}

/** 一行工单。`sla` 由调用方用 `formatSla` 算好（那一格每 30 秒会被就地改写）。 */
export function rowHtml(item, { sla, assignee, fresh }) {
  const question = String(item.question ?? "");
  const summary = summaryOf(question);
  const lang = typeof item.lang === "string" && item.lang !== "" ? item.lang : "";
  const reason = REASON_LABEL[item.reason] ?? item.reason ?? "—";
  return `<tr class="q-row${fresh ? " is-new" : ""}" data-id="${esc(item.id)}" data-sla="${esc(sla.level)}" tabindex="-1" aria-selected="false">
  <td class="col-no"><button class="q-no" type="button" data-act="copy-no" data-no="${esc(item.no)}" title="点击复制单号">${esc(item.no ?? "—")}</button></td>
  <td class="col-q" title="${esc(question)}">${esc(summary)}</td>
  <td class="col-lang">${lang === "" ? "—" : `<span class="badge badge-lang">${esc(lang.toUpperCase())}</span>`}</td>
  <td class="col-reason"><span class="badge badge-reason" data-reason="${esc(item.reason ?? "")}">${esc(reason)}</span></td>
  <td class="col-assignee">${assignee === "" ? "—" : esc(assignee)}</td>
  <td class="col-sla"><span class="sla-text">${esc(sla.text)}</span></td>
  <td class="col-created">${esc(formatDayMinute(item.created_at))}</td>
</tr>`;
}

/* ───────────────────────── 派发选人（lead / admin） ───────────────────────── */

/**
 * 「未分配」的选项值 = 空串。提交时映射成 `assignee_id: null`（后端的显式清空，
 * `api/console.ts` 里 `null` 与"没给这个字段"是两件事：前者清空，后者不改）。
 */
export const UNASSIGNED = "";

/**
 * 派发下拉的数据门槛：`lead` / `admin` 才有（`PATCH /api/console/tickets/:id` 的派发权在
 * `core/ticket-queue.ts` 的 `updateTicket` 里判：`agent` 只能把单派给自己）。
 *
 * 返回 `{ visible, enabled, reason }` —— 与两个管理面板的 `capability()` 同一套口径：
 * `visible` 决定画不画，`enabled` 决定能不能改，`reason` 是"为什么不能"。
 * 已关单是终态（后端 409 `TICKET_IMMUTABLE`），所以连下拉都不画成可改的样子。
 */
export function canDispatch(ticket, role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  const closed = String(ticket?.status ?? "") === "closed";
  if (normalized !== "lead" && normalized !== "admin") {
    return { visible: false, enabled: false, reason: "派发给他人需要坐席主管（lead）或管理员角色。" };
  }
  if (closed) return { visible: true, enabled: false, reason: "已关单，不能再改指派人。" };
  return { visible: true, enabled: true, reason: "" };
}

/**
 * 人员下拉的选项：第一项永远是「未分配」（值空串）。`current` 是这张单此刻的 `assignee_id`。
 * 人员列表可能还没回来（`loading`）、也可能 403/404（`error`）—— 那时只画「未分配」，
 * 绝不显示一个空下拉让人以为"没有同事"。
 */
export function staffOptionsHtml(staff, current) {
  const list = Array.isArray(staff) ? staff : [];
  const value = typeof current === "string" ? current : "";
  const head = `<option value="${esc(UNASSIGNED)}"${value === "" ? " selected" : ""}>未分配</option>`;
  return (
    head +
    list
      .map((item) => {
        const id = String(item?.id ?? "");
        if (id === "") return "";
        const name = String(item?.name ?? item?.email ?? id);
        // 停用的账号仍然可选：历史工单上可能就派给了他，这里只是把状态标出来。
        const label = item?.active === false ? `${name}（已停用）` : name;
        return `<option value="${esc(id)}"${id === value ? " selected" : ""}>${esc(label)}</option>`;
      })
      .join("")
  );
}

/**
 * 选中值变了才发 PATCH：`lead` 把下拉重新选成同一个人（或把「未分配」再点一次）
 * 不该产生一次写操作 —— 那会在 `audit_log` 里留下一串没有意义的派发记录。
 */
export function shouldDispatch(currentId, nextId) {
  const current = typeof currentId === "string" ? currentId : "";
  const next = typeof nextId === "string" ? nextId : "";
  return current !== next;
}

/** 下拉的值 → 请求体。空串是"取消指派"，必须发 `null` 而不是空串（空串不是 uuid，后端会 400）。 */
export function dispatchBody(nextId) {
  const value = typeof nextId === "string" ? nextId : "";
  return { assignee_id: value === "" ? null : value };
}

/**
 * 派发控件那一块（纯字符串）。`dispatch` 由调用方给：
 *   `{ role, staff, currentId, busy, loaded, error }`
 *
 * - `agent` 不画（它只有"认领"，`canDispatch` 已经判过）；
 * - 人员列表还在路上 / 拿不到：下拉禁用 + 一句 `title`/说明，不做"看起来能选但选了没反应"；
 * - `busy`（一次 PATCH 正在进行）：整块禁用 —— 连点会重复派发。
 */
export function dispatchHtml(ticket, dispatch) {
  const config = dispatch ?? {};
  const permission = canDispatch(ticket, config.role);
  if (!permission.visible) return "";
  const list = Array.isArray(config.staff) ? config.staff : [];
  const busy = config.busy === true;
  const loaded = config.loaded === true;
  const error = typeof config.error === "string" ? config.error : "";
  const disabled = !permission.enabled || busy || !loaded || error !== "";
  const reason = busy
    ? "正在派发…"
    : !permission.enabled
      ? permission.reason
      : error !== ""
        ? // 调用方给的就是一句能读的话（`console.js` 的 `staffErrorHint`）：不在这里二次包装，
          // 否则会出现"人员列表加载失败：人员列表接口还没就绪（404）"这种复读。
          error
        : !loaded
          ? "正在加载人员列表…"
          : "";
  return `<label class="meta-dispatch">
    <span class="meta-dispatch-label">指派人</span>
    <select class="input c-select" data-dispatch="assignee" aria-label="指派给"${disabled ? " disabled" : ""}${
      reason === "" ? "" : ` title="${esc(reason)}"`
    }>${staffOptionsHtml(list, config.currentId)}</select>
  </label>${reason === "" ? "" : `<p class="meta-note">${esc(reason)}</p>`}`;
}

/* ───────────────────────── 详情三栏 ───────────────────────── */

export function detailHtml() {
  return `<section class="detail">
  <div class="detail-col detail-left">
    <button class="btn btn-ghost btn-sm" type="button" data-act="back" aria-label="返回队列">← 返回队列</button>
    <div class="detail-meta" id="detail-meta"></div>
    <div class="meta-actions" id="detail-actions"></div>
  </div>
  <div class="detail-col detail-main">
    <div class="detail-state" id="detail-state" role="status"></div>
    <div class="thread" id="thread"></div>
    <div class="replier">
      <textarea class="input" id="reply" rows="4" maxlength="2000" placeholder="输入回复…" aria-label="回复内容"></textarea>
      <div class="replier-bar">
        <span class="replier-hint">Ctrl/Cmd + Enter 发送</span>
        <button class="btn btn-ghost" type="button" data-act="translate">翻译</button>
        <button class="btn btn-primary" type="button" data-act="send">发送</button>
        <button class="btn btn-ghost" type="button" data-act="close">关单</button>
      </div>
      <div class="replier-meta" id="reply-meta"></div>
    </div>
  </div>
  <aside class="detail-col detail-side">
    <div class="side-block"><h3>AI 候选</h3><div class="empty-sm">本期不提供（A3 预留）</div></div>
    <div class="side-block"><h3>引用</h3><ul id="side-cites"></ul></div>
  </aside>
</section>`;
}

/** 左栏元信息（11 §3.1 的四行 + 单号/复制/链接）。 */
export function metaHtml(ticket, { assignee, sla, closed }) {
  const lang =
    typeof ticket.lang === "string" && ticket.lang !== ""
      ? `${ticket.lang.toUpperCase()} ${LANG_LABEL[ticket.lang] ?? ""}`.trim()
      : "—";
  const rows = [
    ["原因", esc(REASON_LABEL[ticket.reason] ?? ticket.reason ?? "—")],
    [
      "状态",
      `<span class="badge badge-status" data-status="${esc(ticket.status ?? "")}">${esc(STATUS_LABEL[ticket.status] ?? ticket.status ?? "—")}</span>`,
    ],
    ["语言", esc(lang)],
    ["指派人", esc(assignee === "" ? "—" : assignee)],
    ["创建", esc(formatDayMinute(ticket.created_at))],
    ["截止", esc(ticket.due_at ? formatDayMinute(ticket.due_at) : "—")],
    ["SLA", `<span id="detail-sla" data-sla="${esc(sla.level)}">${esc(sla.text)}</span>`],
  ];
  const list = rows.map(([key, value]) => `<div class="meta-row"><dt>${esc(key)}</dt><dd>${value}</dd></div>`).join("");
  return `<div class="meta-no">
    <span class="ticket-no">${esc(ticket.no ?? "—")}</span>
    <button class="btn btn-ghost btn-sm" type="button" data-act="copy-no">复制</button>
    <button class="btn btn-ghost btn-sm" type="button" data-act="copy-link" title="复制这一单的链接">链接</button>
  </div>
  <dl class="meta-list">${list}</dl>
  ${closed && ticket.resolution ? `<div class="meta-resolution">关单结论：${esc(ticket.resolution)}</div>` : ""}
  ${ticket.question ? `<div class="meta-note">问题摘要：${esc(ticket.question)}</div>` : ""}`;
}

/**
 * 左栏操作按钮。已关单全部 `disabled`（后端也会回 409，这里是第一道门）。
 *
 * `dispatch` 是可选第三参（`{ role, staff, currentId, busy, loaded, error }`）：
 * `lead` / `admin` 会多出一块派发下拉，`agent` 什么都不多（它只能"认领"自己）。
 * 保持"不传就与从前一字不差"，是因为这块 HTML 还有别的调用点与断言。
 *
 * 「转 L2」（`09#06`）在已升级时**按钮变文案并禁用**，而不是藏起来：
 * 藏起来会让人以为"这单从来没升级过"，而这单的状态徽章正写着"已升级"。
 */
export function actionsHtml(ticket, assignee, dispatch) {
  const closed = ticket.status === "closed";
  const escalated = ticket.status === "escalated";
  const claimed = assignee !== "";
  return `<button class="btn btn-primary" type="button" data-act="claim"${closed || claimed ? " disabled" : ""}>${claimed ? "已认领" : "认领"}</button>
  ${dispatchHtml(ticket, dispatch)}
  <button class="btn btn-ghost" type="button" data-act="l2"${closed || escalated ? " disabled" : ""}>${escalated ? "已升级 L2" : "转 L2"}</button>
  <button class="btn btn-ghost" type="button" data-act="faq"${closed ? " disabled" : ""}>转 FAQ 草稿</button>
  <p class="meta-note">${closed ? "已关单，所有操作已停用。" : escalated ? "已升级到二线：队列置顶，等 L2 接手。" : "转 L2 会把单标为已升级并置顶队列；转 FAQ 草稿会写一条待主管审批的知识草稿。"}</p>`;
}

/* ───────────────────────── 转 FAQ 草稿 ───────────────────────── */

/** 答案下限：与后端 `FAQ_ANSWER_MIN_CHARS`（`core/faq-store.ts`）**必须同值**，否则前端放行、后端 400。 */
export const FAQ_ANSWER_MIN_CHARS = 10;
/** 问题上限：与后端 `FAQ_QUESTION_MAX_CHARS` 同值。 */
export const FAQ_QUESTION_MAX_CHARS = 500;

/** 语言选项（母语名自显，与用户端顶部语言菜单、故障卡 Tab 同一套写法）。 */
export const FAQ_LANG_OPTIONS = [
  ["zh", "中文"],
  ["en", "English"],
  ["de", "Deutsch"],
  ["nl", "Nederlands"],
  ["es", "Español"],
];

/** 按**码点**数（不是 UTF-16 码元）：与后端 `charCount` 同口径，emoji 只算一个字。 */
export function faqCharCount(value) {
  return Array.from(String(value ?? "")).length;
}

/**
 * 转草稿的请求体。**不合格一律回 `null`**，绝不给一个"看起来合理"的默认语言：
 * 猜错语言会让答案被切到另一路召回里（`chunks.lang` 决定它被谁检索到），而症状是
 * "审批通过了但用户问同样的问题还是答不出"。
 *
 * `ticketId` 为空/非法时不带这个字段 —— 后端据此写 `source='no_hit'`（未命中池起稿）。
 */
export function faqDraftBody({ ticketId, question, answer, lang } = {}) {
  const text = String(question ?? "").trim();
  const body = String(answer ?? "").trim();
  const code = String(lang ?? "").trim().toLowerCase();
  if (text === "" || faqCharCount(text) > FAQ_QUESTION_MAX_CHARS) return null;
  if (faqCharCount(body) < FAQ_ANSWER_MIN_CHARS) return null;
  if (!FAQ_LANG_OPTIONS.some(([value]) => value === code)) return null;
  const payload = { question: text, answer: body, lang: code };
  const id = Number(ticketId);
  if (Number.isInteger(id) && id > 0) payload.ticket_id = id;
  return payload;
}

/** 弹窗里的提示语：缺什么说什么（按同一份阈值判，不另写一套）。 */
export function faqHint(question, answer) {
  if (String(question ?? "").trim() === "") return "问题不能为空";
  if (faqCharCount(String(question ?? "").trim()) > FAQ_QUESTION_MAX_CHARS) {
    return `问题最多 ${FAQ_QUESTION_MAX_CHARS} 字`;
  }
  const chars = faqCharCount(String(answer ?? "").trim());
  if (chars < FAQ_ANSWER_MIN_CHARS) return `答案至少 ${FAQ_ANSWER_MIN_CHARS} 字（还差 ${FAQ_ANSWER_MIN_CHARS - chars}）`;
  return `答案 ${chars} 字 · 通过后会切块进索引`;
}

/** 正文 + 角标：只有 citations 里真有这个 idx 才变角标（复用工单侧同一份 `renderCitations`）。 */
function segmentsHtml(text, citations, messageId) {
  const known = new Set(
    citations
      .filter((cite) => cite !== null && typeof cite === "object" && Number.isInteger(Number(cite.idx)))
      .map((cite) => Number(cite.idx)),
  );
  return renderCitations(String(text ?? ""), citations)
    .map((segment) => {
      if (segment.type !== "cite") return esc(segment.value);
      const idx = Number(segment.idx);
      if (!known.has(idx)) return esc(`[${idx}]`);
      return `<button class="cite" type="button" data-act="cite" data-msg="${esc(String(messageId ?? ""))}" data-idx="${idx}" aria-label="查看引用 ${idx} 原文">${idx}</button>`;
    })
    .join("");
}

/**
 * 工具轨迹：`05-api.md` §4.2 只保证 `tool_names`（字符串数组），**没有耗时**。
 * 所以：后端将来补 `tools: [{name, ms}]` 就直接显示毫秒，只有名字时显示"耗时未记录"——
 * 绝不编一个看起来合理的数字（坐席会拿它判断卡在检索还是模型上）。
 */
function toolsHtml(message) {
  const detailed = Array.isArray(message.tools) ? message.tools : null;
  const list =
    detailed !== null && detailed.length > 0
      ? detailed.map((tool) => ({ name: String(tool?.name ?? ""), ms: Number(tool?.ms ?? NaN) }))
      : Array.isArray(message.tool_names)
        ? message.tool_names.map((name) => ({ name: String(name ?? ""), ms: NaN }))
        : [];
  if (list.length === 0) return "";
  const items = list
    .map(
      (tool) =>
        `<li>${esc(tool.name)} · ${Number.isFinite(tool.ms) ? `${Math.round(tool.ms)}ms` : "耗时未记录"}</li>`,
    )
    .join("");
  return `<details class="t-tools"><summary>工具轨迹 ${list.length}</summary><ul>${items}</ul></details>`;
}

export function messageHtml(message) {
  const role = String(message.role ?? "");
  const assistant = role === "assistant";
  const cls = assistant ? "t-a" : role === "staff" ? "t-s" : "t-u";
  const citations = Array.isArray(message.citations) ? message.citations : [];
  const citationCount = Number(message.citations_count ?? citations.length);
  // 「本轮无检索证据」是最关键的标记：坐席据此决定能不能直接采纳 AI 那一段（工单 07#02）。
  // refused=true 是后端判定的拒答（已自动转人工）；`no_evidence` 是后端按 `citations` **行数**
  // 判的"答了但一条证据都没有"。
  //
  // 这里**优先读后端的 `no_evidence`**，只在它缺失（老响应）时退回数 `citations_count`：
  // 那一列由 `citation-store` 回填，写入失败时会停在默认 0，于是"有引用但计数没刷上"会被
  // 前端误标成"无证据"——把一个可信的答案说成不可采纳。后端已经用真实行数算好了，别重算。
  const noEvidence = message.no_evidence === true || (message.no_evidence === undefined && citationCount === 0);
  const warn = !assistant
    ? ""
    : message.refused === true
      ? `<div class="t-warn">⚠ 本轮无检索证据，已自动转人工</div>`
      : noEvidence
        ? `<div class="t-warn">⚠ 本轮无检索证据</div>`
        : "";
  const tag = message.local === true ? `<span class="t-tag">本地记录，未外发</span>` : "";
  return `<article class="t-msg ${cls}">
    <div class="t-head"><span class="t-role">${assistant ? "AI" : role === "staff" ? "坐席" : "用户"}</span>${tag}</div>
    <div class="t-text">${segmentsHtml(message.content, citations, message.id)}</div>
    ${warn}${toolsHtml(message)}
    <time class="t-time" datetime="${esc(message.created_at ?? "")}">${esc(formatClock(message.created_at))}</time>
  </article>`;
}

export function threadHtml(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return `<div class="empty-sm">本单没有对话记录。</div>`;
  return messages.map(messageHtml).join("");
}

/** 右栏：本单所有 AI 消息的引用聚合，点击展开原文片段（11 §3.4）。 */
export function citesHtml(messages) {
  const rows = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(message.citations)) continue;
    for (const cite of message.citations) {
      if (cite !== null && typeof cite === "object" && Number.isInteger(Number(cite.idx))) rows.push({ message, cite });
    }
  }
  if (rows.length === 0) return `<li class="empty-sm">本单暂无引用。</li>`;
  return rows
    .map(({ message, cite }) => {
      const page = cite.page === null || cite.page === undefined ? "" : `第 ${Number(cite.page)} 页`;
      const lang = typeof cite.doc_lang === "string" && cite.doc_lang !== "" ? cite.doc_lang.toUpperCase() : "";
      const meta = [page, lang].filter((part) => part !== "").join(" · ");
      return `<li><button class="cite-row" type="button" data-act="cite" data-msg="${esc(String(message.id ?? ""))}" data-idx="${Number(cite.idx)}">
  <span class="cite-doc">[${Number(cite.idx)}] ${esc(cite.doc_title ?? "未命名文档")}</span>
  <span class="cite-meta">${esc(meta)}</span>
</button></li>`;
    })
    .join("");
}

/** 引用原文（桌面用 modal，11 §3.2 明确"不是抽屉"）。 */
export function citeCardHtml(cite) {
  const page = cite.page === null || cite.page === undefined ? "" : `第 ${Number(cite.page)} 页`;
  const lang = typeof cite.doc_lang === "string" && cite.doc_lang !== "" ? cite.doc_lang.toUpperCase() : "";
  const meta = [page, lang].filter((part) => part !== "").join(" · ");
  return `<div class="cite-card">
    <div class="cite-doc">${esc(cite.doc_title ?? "未命名文档")}</div>
    <div class="cite-meta">${esc(meta)}</div>
    <p class="cite-text">${esc(cite.snippet ?? "（后端未提供原文片段）")}</p>
  </div>`;
}
