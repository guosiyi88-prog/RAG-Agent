# 05 · HTTP 接口（as-built）

> 端点清单以 `src/routes.ts:77` 的注册顺序为准。响应一律是 `{ ok: true, data }` 或
> `{ ok: false, error: { code, message, trace_id } }`，没有第三种形状。
> 错误码只有 `src/errors.ts` 那 14 个，本章不新增。

---

## 1. 端点总表

### 1.1 对外（浏览器可直达）

| # | 方法 | 路径 | 鉴权 | 关键限制 | 证据 |
|---|---|---|---|---|---|
| 1 | GET | `/` | 无 | 常量路径 | `api/assets.ts:156` |
| 2 | GET | `/console` | 无（页面本身不含数据） | 常量路径 | `api/assets.ts:168` |
| 3 | GET | `/assets/*` | 无 | MIME 白名单 + 目录穿越守卫 | `api/assets.ts:174` |
| 4 | GET | `/healthz` | 无 | 四项全真才 200 | `routes.ts:78` |
| 5 | POST | `/api/session` | 无 | **10 次/分钟/IP** | `api/session.ts:37` |
| 6 | POST | `/api/chat` | 用户 | `text` ≤ 2000；并发 5 | `api/chat.ts:327` |
| 7 | POST | `/api/ticket` | 用户 | 配额 **3 张/小时/令牌**；幂等窗 300s | `api/ticket.ts:75` |
| 8 | GET | `/api/ticket/:no` | 用户 | `email` 必填 | `api/ticket.ts:96` |
| 9 | GET | `/api/fault/:code` | **无** | 判形 `^[A-Za-z]\d{2,3}$` | `api/fault.ts:106` |
| 10 | GET | `/api/i18n/:lang` | 无 | 五语之一，否则 400 | `api/i18n.ts:55` |
| 11 | POST | `/api/auth/login` | 无（尚未有身份） | **5 次/分钟/IP**；失败与"账号不存在"逐字节同形 | `api/auth.ts:86` |
| 12 | POST | `/api/auth/logout` | 无（票据可缺） | 幂等；删 Redis `staff_session:*` + 记 `revoked_at` | `api/auth.ts:123` |
| 13 | GET | `/api/console/me` | 坐席 | 前端登录后第一件事（D31 回落的判据） | `api/auth.ts:133` |
| 14 | GET | `/api/console/tickets` | 坐席 | 分页 ≤ 100；`q` ≤ 100 | `api/console.ts:227` |
| 15 | GET | `/api/console/tickets/:id` | 坐席 | id 必须是十进制 | `api/console.ts:233` |
| 16 | PATCH | `/api/console/tickets/:id` | 坐席 | 关单必须带 ≥10 字结论 | `api/console.ts:241` |
| 17 | GET | `/api/console/stats` | 坐席 | — | `api/console.ts:253` |
| 18 | POST | `/api/console/tickets/:id/escalate` | 坐席 | 转 L2（`09#06`）：`status='escalated'` + `tags += escalate`，幂等 | `api/console.ts` |
| 19 | POST | `/api/console/draft` | 坐席 | 转 FAQ 草稿（`09#06`，原 501 转正）：写一条待审 `kb_drafts`；重复 → 409 | `api/console.ts` |
| 20 | GET | `/api/console/drafts` | 坐席 | 草稿列表（`status` 多选 + 分页） | `api/console.ts` |
| 21 | POST | `/api/console/drafts/:id/approve` | 坐席 **`admin`** | 审批通过：同步切块 embedding 写入 `chunks` | `api/console.ts` |
| 22 | POST | `/api/console/drafts/:id/reject` | 坐席 ≥ `lead` | 驳回：只改状态，不删行、不碰索引 | `api/console.ts` |
| 23 | GET | `/api/console/no-hit` | 坐席 ≥ `lead` | `v_no_hit` 前 N 条（`09#06`） | `api/console.ts` |
| 24–25 | POST | `/api/console/translate` `/export` | 坐席 | **仍固定 501** | `api/console.ts` |
| 21 | GET | `/api/admin/faults` | 坐席 ≥ `lead` | 全部状态；缺 `product_line` 不报错（不筛）；分页同 §5.1 | `api/admin.ts:267` |
| 22 | GET | `/api/admin/faults/:code` | 坐席 ≥ `lead` | **必须带 `?product_line=`**，缺 → 400 | `api/admin.ts:273` |
| 23 | POST | `/api/admin/faults` | 坐席 ≥ `lead` | **一律落 `draft`**；`code` 与公开接口同一判形；同主键 → 409 | `api/admin.ts:282` |
| 24 | PATCH | `/api/admin/faults/:code` | 坐席 ≥ `lead` | `published` 改完落回 `draft`；`archived` → 409 | `api/admin.ts:305` |
| 25 | POST | `/api/admin/faults/:code/publish` | 坐席 **`admin`** | 五语十列必须全非空，缺 → 409 `CONFLICT` | `api/admin.ts:327` |
| 26 | POST | `/api/admin/faults/:code/archive` | 坐席 **`admin`** | 只改 `status`，**不删行**；幂等 | `api/admin.ts:340` |
| 27 | GET | `/api/admin/product-lines` | 坐席 ≥ `lead` | 含停用项（`active` 原样下发） | `api/admin.ts:348` |
| 28 | POST | `/api/admin/product-lines` | 坐席 **`admin`** | `code` 冲突 → 409；`code` 必须小写短横线形状 | `api/admin.ts:368` |
| 29 | PATCH | `/api/admin/product-lines/:code` | 坐席 **`admin`** | 改名 / 停用（`active=false`）；无删除 | `api/admin.ts:387` |
| 30 | GET | `/api/admin/staff` | 坐席 ≥ `lead`（`09#05` 从 `admin` 降档） | 派发下拉数据源（消费者是 `lead`：`09#03` 的派发权本来就给了 lead/admin）；**不含 `password_hash` / `password_salt`** | `api/admin.ts:492` |
| 31 | GET | `/api/admin/documents` | 坐席 ≥ `lead` | `page/size/status/lang/product_line`；`status=all` 默认 | `api/admin-kb.ts` |
| 32 | GET | `/api/admin/documents/:id` | 坐席 ≥ `lead` | 详情 + `rebuild` 子对象（轮询句柄） | `api/admin-kb.ts` |
| 33 | GET | `/api/admin/documents/:id/rebuild` | 坐席 ≥ `lead` | `idle/running/succeeded/failed` + `error` + `chunk_count` | `api/admin-kb.ts` |
| 34 | POST | `/api/admin/documents` | 坐席 **`admin`** | 落 `pending`（待重建）；同正文 `sha256` → 409 | `api/admin-kb.ts` |
| 35 | PATCH | `/api/admin/documents/:id` | 坐席 **`admin`** | 改正文 → `status` 回 `pending`（旧索引继续可检索，直到重建成功）；`archived` → 409 | `api/admin-kb.ts` |
| 36 | POST | `/api/admin/documents/:id/rebuild` | 坐席 **`admin`** | **202** + `job_id`；切块/嵌入复用 `ingest.ts` 的 `indexPages`，换索引在一个事务里 | `api/admin-kb.ts` |
| 37 | POST | `/api/admin/documents/:id/rollback` | 坐席 **`admin`** | 装回上一版快照；没有上一版 → 409 | `api/admin-kb.ts` |
| 38 | POST | `/api/admin/documents/:id/archive` | 坐席 **`admin`** | 停用（终态）：`status='archived'`，行与快照都留，检索 SQL 排除 | `api/admin-kb.ts` |

**"坐席"这一列自 `09#03` 起指服务端会话**：`x-staff-session` 命中 Redis `staff_session:{ticket}`，
没票据 / 票据失效都是 `401 AUTH_REQUIRED`。旧的 `X-Admin-Token` + `ADMIN_TOKEN` 与 `X-Admin-Staff`
**已退场**（`docs/output/boundary-change-R2.md` §3 B5，§6 明确不做双轨），带上它们等于没登录。

**第 21–30 行（`09#04`）的"≥ `lead`"与"`admin`"是两张不同的东西**：先认证（`requireAdmin` → 401），
再按 `src/api/roles.ts` 的 `ROUTE_MIN_ROLE` 判角色（`requireRole` → 403），顺序不能反。
最低角色只有表里那一份，`api/admin.ts` 不写第二份字面量。

### 1.2 内部（回环 + 令牌，否则一律 404）

| 方法 | 路径 | 说明 | 证据 |
|---|---|---|---|
| GET | `/internal/retrieval/recall` | 分层调试：两路候选**原样**摊开（不融合） | `api/internal.ts:113` |
| POST | `/internal/search` | 正式检索：融合+归一化+截断，返回 `topScore`/`fallback` | `api/internal.ts:163` |
| GET / POST | `/internal/fault` | 故障码直查（GET 出参数、POST 出 body，两个别名） | `api/internal-fault.ts:115` |
| POST | `/internal/ticket` | 建单（Agent 工具用） | `api/internal-ticket.ts:128` |
| POST | `/internal/ticket/lookup` | 查单（规范形态） | `api/internal-ticket.ts:155` |
| GET | `/internal/ticket/:no` | 查单（同一份形状的别名） | `api/internal-ticket.ts:169` |
| POST | `/internal/citations` | 引用快照落库（**只写不校验**） | `api/internal-citations.ts:117` |

---

## 2. 统一信封与错误码

```json
{ "ok": true, "data": { ... } }
{ "ok": false, "error": { "code": "SESSION_BUSY", "message": "前面还有几位正在咨询，请稍后再试", "trace_id": "…" } }
```

| 码 | HTTP | 何时 | 前端文案 key |
|---|---|---|---|
| `AUTH_REQUIRED` | 401 | 头里没带令牌 / 坐席票据不存在或已失效（**我还没认出你是谁**） | `chat.err.auth` |
| `AUTH_INVALID` | 401 | 用户令牌过期 / 形状不对 | 同上 |
| `FORBIDDEN` | 403 | 已登录但角色不足（**知道你是谁，但这件事不是你能做的**） | 内联（坐席端"权限不足"） |
| `RATE_LIMITED` | 429 | 会话签发超限 | `chat.err.rate` |
| `QUOTA_TICKET` | 429 | 建单配额超限 | `ticket.quota` |
| `VALIDATION` | 400 | 入参形状/取值不对（含 Fastify schema 与 413/415 的折并） | 内联 |
| `NOT_FOUND` | 404 | 资源不存在（含"会话不属于你"） | 内联 |
| `NOT_IMPLEMENTED` | 501 | 两个预留端点（`translate` / `export`） | 内联 |
| `SESSION_BUSY` | 503 | 会话池满（**开流之前**） | `chat.busy` |
| `LLM_TIMEOUT` | 504 | 单轮超时（开流后只能 `error` 帧） | `chat.err.timeout` |
| `LLM_UNAVAILABLE` | 503 | 模型不可用 / 解析不到模型对象 | `chat.err.model` |
| `EMBED_UNAVAILABLE` | 503 | 嵌入不可用（`/internal/retrieval/recall`） | — |
| `STORAGE_UNAVAILABLE` | 503 | 对象存储不可用 | `chat.err.model` |
| `TICKET_IMMUTABLE` | 409 | 对 `closed` 工单做更新 | 内联 |
| `CONFLICT` | 409 | 资源当前状态不允许这个动作（`09#04`：发布缺五语的码 / 改或发布已归档的码 / 新建已存在的码或产线） | 内联 |
| `INTERNAL` | 500 | 未捕获异常（堆栈只进日志） | 内联 |

**三个必须知道的映射规则**（`src/server.ts:34`）：

1. Fastify 的 schema 校验失败、坏 JSON（400）、body 超限（413）、content-type 不认识（415）—
   **全部折成 `400 VALIDATION`**。理由：错误码表只允许一处来源，且 5xx 率不该被垃圾 body 打红。
2. 未匹配路由 → `404 NOT_FOUND`，文案固定 `Not found`。
3. 非 `AppError` 的异常 → `500 INTERNAL`，响应体里**没有**任何内部细节。

---

## 3. 三档鉴权（唯一口径 `src/auth.ts`）

| 档 | 头 | 失败形状 | 为什么 |
|---|---|---|---|
| 用户 | `X-User-Session`（uuid，Redis `sess:{uuid}` 存在即有效） | `401 AUTH_REQUIRED`（没带）/ `AUTH_INVALID`（过期或非 uuid） | 前端要能区分"该刷新"与"服务坏了" |
| 坐席 | `X-Staff-Session`（登录签发的 64 位 hex 票据，Redis `staff_session:{ticket}` 存身份快照） | 一律 `401 AUTH_REQUIRED`（没带 / 过期 / 已登出 / 已吊销，四者同码） | 区分开等于回答"这个票据存不存在"——一台会话存在性预言机 |
| 内部 | `X-Internal-Token` **且** 来源回环 | 一律 `404`，与"路径不存在"逐字同形 | 401 等于告诉扫描器端点存在 |

**回环判定认三种形态**：`127.0.0.0/8`（不是只有 `.0.1`）、`::1`、`::ffff:127.x.x.x`（dual-stack 最常见形态）。
不认 `X-Forwarded-For`——认了等于让请求方自己声明来源。

**坐席身份 100% 来自会话**（`09#03`）：`requireAdmin` 读票据 → 返回 `{ staffId, staffName, role, email }`，
认领时的"我"就是会话里的 `staffId`。旧的 `X-Admin-Staff`（客户端自称坐席，缺省取 `staff` 表第一条）
**已退场**，`defaultStaff()` 也随之删除 —— 客户端无法再指定自己是谁。

**401 与 403 的分工**（`src/errors.ts`、D31）：401 = "还没认出你是谁" → 前端回登录页换票据；
403 `FORBIDDEN` = "认出你了，但角色不够 / 这件事不是你能做的" → 前端只提示，**不清**登录态。
角色门本体是 `src/auth.ts` 的 `requireRole(principal | null, min)`（纯函数，`agent < lead < admin`），
最低角色表是 `src/api/roles.ts` 的 `ROUTE_MIN_ROLE`（启动时双向核对，表外无门即进程起不来）。
路由级角色之外还有**资源级**的 403（`09#03` 第三段）：队列可见性（§5.1）与派发权（§5.3）由
`src/core/ticket-queue.ts` 判定，路由层只把会话身份（`{ staffId, role }`）传下去 —— 两处各判一半，
将来多一个入口就漏一处。

---

## 4. 用户端端点

### 4.1 `POST /api/session`

请求：无 body。响应 200：

```json
{ "ok": true, "data": { "token": "<uuid>", "expires_at": "2026-11-03T…Z" } }
```

- Redis `SETEX sess:{token} 604800 "1"`（7 天，**无续期**）。
- 限流键 `rl:session:{ip}`（ZSET 滑动窗口，60s/10 次）。用 `request.ip`（socket 地址），不信转发头。

### 4.2 `POST /api/chat`（SSE）

请求：

| 字段 | 必填 | 规则 |
|---|---|---|
| `text` | ✅ | trim 后 1–2000 字符（**字段名是 `text`，不是 `message`**） |
| `lang` | — | `zh|en|de|nl|es`；缺省读 `Accept-Language` 的第一个已知主标签，再缺省 `en` |
| `conv_id` | — | uuid；**必须属于本令牌**，否则 404（不存在与不属于你同形） |

响应：`200` + `text/event-stream`。三个响应头固定：`cache-control: no-cache, no-transform`、
`connection: keep-alive`、`x-accel-buffering: no`。

帧契约：

| 帧 | 载荷 | 时机 |
|---|---|---|
| `meta` | `{ conv_id, message_id, trace_id }` | 开流第一帧；`message_id` 是**用户消息** id |
| `tool` | `{ name, ms }` | 每次工具执行结束（快路不发） |
| `delta` | `{ t }` | 文本增量（快路只发一帧） |
| `citations` | `[{ idx, doc_title, page, snippet, doc_lang }]` | 校验通过且落库成功后（**只发被引用到的**，不发候选全集） |
| `refusal` | `{ ticket_no }` | 拒答且建单成功才发 |
| `done` | `{ latency_ms, tokens, cost_usd }` | 收尾；**`error` 之后不再发** |
| `error` | `{ code, message, trace_id }` | 开流后唯一的失败表达 |

**开流前后是两套语义**：开流前失败用 HTTP 状态码（401/400/404/503）；`reply.hijack()` 之后状态码写不动了，
只剩 `error` 帧。所以池满必须在开流前判（`chat.ts:366`）。

**同会话连发**：用户在流式过程中再发一条，不算池满，会在 `record.tail` 链上排队——
此时 `SESSION_BUSY` **不发** `error` 帧（`shouldEmitErrorFrame` 只在跨会话时为 true）。

### 4.3 `POST /api/ticket` 与 `GET /api/ticket/:no`

建单请求：

| 字段 | 必填 | 规则 |
|---|---|---|
| `email` | ✅ | 正则 + ≤254 字符，是唯一回访与查单凭据 |
| `question` | — | 4–500 字符；缺省时回落到会话里的最后一条用户消息 |
| `conv_id` | — | uuid，且必须属于本令牌（否则 404） |
| `reason` | — | **传了也不采信**，恒为 `user_request`（只留一条 warn） |

响应：`{ no, due_at, status, idempotent }`。`idempotent=true` 表示命中了 300s 内的同一请求（不扣配额、不新建行）。

三条护栏：**配额 3 张/小时/令牌**（`quota:ticket:{token}`，超限 `QUOTA_TICKET`）、**幂等窗 300s**、
**查单不区分"单号不存在"与"邮箱不匹配"**（同一个 404，防枚举）。

查单：`GET /api/ticket/:no?email=…` → `{ found, no, status, created_at }`；`no` 不做形状校验
（text 列，任何串都能安全查一遍；先判形状反而泄露"格式对所以可能存在"）。

### 4.4 `GET /api/fault/:code`

| 参数 | 缺省 | 规则 |
|---|---|---|
| `code`（path） | — | `^[A-Za-z]\d{2,3}$`，否则 **400**（`X1`/`E1234` 是坏输入，不是未命中） |
| `lang` | `en` | 五语之一；显式空串按非法处理 |
| `product_line` | `balcony` | 非空、≤32 字符 |

未命中是 **200 + `found:false`**（不是 404）：对页面来说"没有这个码"是正常结果，要渲染"没找到 + 问 AI"。

**这一路没有令牌门禁**（`10-ui-user` 要求故障码页在拿到令牌之前就能出卡）：`auth.ts` 之外的唯一公开读取端点。

### 4.5 `GET /api/i18n/:lang`

响应 `{ lang, messages }`，`messages` 是**已合并回落链**的结果（请求语言 → `en` → key 原文）。
未知语种 400（不静默回落 `en`：否则"五语"永远无法证伪）。`de-DE` 由浏览器侧 `normalizeLang` 先归一到 `de`。

---

## 5. 坐席端端点

### 5.1 `GET /api/console/tickets`

| 参数 | 语义 |
|---|---|
| `status` | 逗号多选；缺省 = **除 `closed` 之外全部**（不是硬编码三个状态） |
| `reason` | 逗号多选 |
| `q` | 关键词，trim 后 ≤100；空白等价于没给 |
| `page` | 整数，**超界夹到** `1..10000`（不报错） |
| `size` | 整数，超界夹到 `1..100`，缺省 20 |

响应 `{ total, items }`，`items` 按 SLA 排序。**拼错枚举值是 400**（`status=opne` 会让坐席误判优先级，
静默忽略比报错危险）。

**按角色过滤（`09#03` 第三段，`boundary-change-R2.md` §7 第 1 格）**：`role=agent` 的视野 =
`assignee = 自己` **或** `assignee is null`（未分配池）；`lead`/`admin` 看全部。条件并进**同一段
where**，所以 `total` 与列表永远同口径（不会出现"总数 30、翻页只有 4 条"）；他人工单连标题
（`question`）都不下发。判定在 `src/core/ticket-queue.ts` 的 `listTickets`（入参 `viewer`），
`src/api/console.ts` 只把会话身份传下去。未知角色按最低档处理（失败方向安全）。

### 5.2 `GET /api/console/tickets/:id`

响应 `{ ticket, conversation, messages }`。`messages` 里助手消息额外带
`refused` / `citations_count` / `tool_names` / `citations[]` / **`no_evidence`**（= 助手消息 + 未拒答 + 引用实际行数为 0）。

`no_evidence` 用真实行数而不是 `messages.citations_count`：那一列由快照回填，写失败会停在默认 0，
把"有引用但没刷上计数"误标成"无证据"。

**`agent` 查他人工单 → 403 `FORBIDDEN`**（`09#03` 第三段；不是 404）。口径是"看不到标题"，
不是"这单不存在"：404 会让坐席以为 `#/ticket/<id>` 锚点失效而反复刷新重试，而"单子在不在"
本来就由队列的 `total` 回答。未分配的单对 `agent` 可见 —— 那是等待认领的池子，点不开就认领不了。
403 的响应体不回显单号与标题（`tests/queue-visibility.test.ts` 断言）。判定在 `getTicketDetail`。

### 5.3 `PATCH /api/console/tickets/:id`

| 字段 | 语义 |
|---|---|
| `status` | 四态之一 |
| `assignee_id` | uuid → 指派；**显式 `null` → 清空**；不给 → 不动（三态） |
| `resolution` | trim 后 ≤2000 字符，非空 |

规则：
- 至少给一个可识别字段，否则 400（拼错字段名的"认领"不能被当成功）。
- `status: "closed"` **必须同一次补丁里带 ≥10 字结论**；不复用库里已有 `resolution`（审计要记"关单时写了什么"）。
- 字符数按**码点**算（`Array.from(s).length`），与前端 `console-resolution.js` 同一口径——emoji 不能算 2。
- 响应 `{ ticket, changed }`。`changed` 为空数组 = 空操作（没写审计）。
- 对 `closed` 行的任何更新 → 触发器 `raise` → 翻译成 **409 `TICKET_IMMUTABLE`**。

**派发权限（`09#03` 第三段，`boundary-change-R2.md` §7）**：`assignee_id` 指向**他人**或**显式
`null`（清空）** → 只有 `lead`/`admin` 能发，`agent` 拿 **403 `FORBIDDEN`**；`assignee_id` =
自己 → 允许（认领）；`{status:"claimed"}` 不写 `assignee_id` 时的自动指派给"我"**不算派发**，
`agent` 照常可用。判定在 `updateTicket`（`PatchPrincipal.role`），路由层不写第二份。

判定顺序也是契约：**409（已关单不可改）→ 403（派发权）→ 400（`assignee_id` 不存在）**。
先给不可改变的结论（换谁来做都过不去）；权限先于存在性检查，`agent` 拿一串 uuid 试探时拿不到
"这个 id 在不在"的答案。审计的 `actor` 是**登录人姓名**、`payload.staff_id` 是登录人 id —— 不再是
"staff 表第一条"，`agent` 的认领记的是他自己，`lead` 的派发记的是李娜。

### 5.4 `GET /api/console/stats`

`{ tickets_total, tickets_pending, tickets_by_status, runs_total, runs_refused, refusal_rate, sla_seconds_left_avg, window, exclude_demo }`。
真实聚合，不做图表。

两个 query 参数（`09#01`，2026-10-27）：

| 参数 | 取值 | 默认 | 语义 |
|---|---|---|---|
| `exclude_demo` | `true` / `false` | `true` | 排除 `tags` 含 `'demo'` 的演示工单；`ai_runs` 侧按"demo 工单的 `conv_id` 集合"反查排除，`conv_id` 为 null 的 run 留在分母 |
| `window` | `today` / `week` / `all` | `all` | 按 `created_at` 过滤；`today` = 本地当天 0 点起，`week` = 最近 7 天 |

取值非法（`window=month`、`exclude_demo=yes`）→ **400**，不静默回落成默认值；空串（`?window=`）当"没给"处理（前端清空筛选时发的是空值）。响应回显 `window` 与 `exclude_demo`，让卡片能写清"哪段时间、含不含演示数据"。

### 5.5 预留端点：两个仍是 501，一个已转正

`POST /api/console/translate|export`：**路径与鉴权都真实存在**，令牌不对照样 401，令牌对则
`501 NOT_IMPLEMENTED`。前端对应的按钮存在（`data-act="translate"`），点了会提示"本期未开放"。

`POST /api/console/draft`（`09#06` 起）**不再是 501**：它是「转 FAQ 草稿」的真接口 ——
写一条待审 `kb_drafts`（同问题同语言已有未驳回草稿 → 409），审批走 §5.5.1。详见
`src/api/console.ts` 的 `ROUTES.draft` 处理器与 `src/core/faq-store.ts`。

#### 5.5.1 转 L2 与 FAQ 草稿（`09#06`）

| 方法 · 路径 | 最低角色 | 要点 |
|---|---|---|
| `POST /api/console/tickets/:id/escalate` | `agent` | `status='escalated'` + `tags += escalate`；幂等（`changed: []`，不写审计）；404 → 409（已关单）→ 403（可见性） |
| `GET /api/console/drafts?status=&page=&size=` | `agent` | `status` 逗号多选；缺省不筛 |
| `POST /api/console/drafts/:id/approve` | **`admin`** | 同步 `buildIndex` + 一个事务写 `documents`/第一版快照/`chunks`/草稿；已通过幂等、已驳回 409 |
| `POST /api/console/drafts/:id/reject` | `lead` | 只改状态与审批人；已通过 409 |
| `GET /api/console/no-hit?limit=` | `lead` | `v_no_hit` 前 N 条（默认 20，上限 100） |

审批是**同步**的（一份答案一次 embedding，约 0.3–0.5s）：它必须"要么进索引、要么什么都不变"，
所以 embedding 在事务外算、写库在一张事务里。想做成异步就照知识库重建那条路（202 + job）走。

### 5.6 管理端端点（`/api/admin/*`，`09#04`）

坐席端与管理端共用一个入口、一套凭据（D12）：都是 `x-staff-session`，差别只在**最低角色**。
角色矩阵来自 `docs/output/boundary-change-R2.md` §7（已签字）+ `docs/prdv1.3/scope-delta.md` S4：

| 动作 | 最低角色 | 为什么是这一档 |
|---|---|---|
| 故障卡查看、新建 draft、编辑 | `lead` | 补语改措辞是客服主管的日常活；要求 admin 才能改一个错字会让一个人变成瓶颈 |
| 发布 / 归档 | `admin` | 发布是"这条答复可以给用户了"的签字。与编辑同权则"谁改的"与"谁批的"是同一个人，这道门就没意义（D15） |
| 产品线字典 CRUD | `admin` | 增删产线改变的是全平台的下拉选项，不是一次内容编辑 |
| 人员列表 | `admin` | 邮箱与角色的全量清单属管理面，不是客服面 |

**故障码状态机**（三个状态、四条路径，别自己发明第五条）：

| 当前 | 动作 | 结果 |
|---|---|---|
| — | `POST /faults`（新建） | `draft`。**body 里写 `status:"published"` 也落 `draft`**（SQL 里是字面量） |
| `draft` | `PATCH` | 仍是 `draft`，随便改 |
| `draft` | `POST /publish` | 五语十列全非空 → `published`；缺任一 → **409 `CONFLICT`**（message 点名缺哪几门语） |
| `published` | `PATCH` | **自动落回 `draft`**，要重新发布（否则一次错字修正就悄悄改了用户正在看的答复） |
| `published` / `draft` | `POST /archive` | `archived`。**只改 status、不删行**（`tickets`/`qa_gold` 可能引用；删了 `make ingest` 会重新插进来） |
| `archived` | `PATCH` / `POST /publish` | **409 `CONFLICT`**：归档是终点，恢复不在本卡范围 |

两条幂等：`publish` 一个已发布的码、`archive` 一个已归档的码，都回 **200 且 `changed: []`**
（双击按钮不该报错），也不写审计。

**语言门槛分两层**（D14）：`draft` 允许只有 `zh`+`en`（中英是公共底稿，先落一条能改的草稿）；
`published` 必须五语十列全非空 —— 判据是"两列都非空**且不是空白串**"，与对外路径
`core/fault-codes.ts` 的 `pickText` 同口径。

**`product_line` 是主键的一半**：`GET/PATCH /faults/:code`、`POST .../publish|archive` 都必须带
`?product_line=...`，缺 → **400 `VALIDATION`**（不回落默认产物线 —— 那会让漏参数的请求去改另一条线的同名码）。

**响应形状**：

```jsonc
// GET /api/admin/faults → data
{ "total": 7, "items": [{ "code": "E03", "product_line": "balcony", "severity": "warn",
  "status": "published", "lang_count": 5, "complete_langs": ["zh","en","de","nl","es"],
  "missing_langs": [], "created_at": "…", "updated_at": "…" }] }   // 列表不带正文（十列长文不进列表）

// GET /api/admin/faults/:code → data.fault：上面那行 + "desc": {"zh":"…"}, "act": {"zh":"…"}（十列全文）

// PATCH / publish / archive → data
{ "fault": { …全量… }, "changed": ["desc.de", "act.de", "status"] }   // 空操作 = []

// GET /api/admin/product-lines → { total, items: [{ code, name, active, created_at }] }
// PATCH /api/admin/product-lines/:code → { product_line: {…}, changed: ["name"] }
// GET /api/admin/staff → { total, items: [{ id, name, email, role, active, org_unit }] }
```

`updated_at` 是真实列（`sql/001_init.sql` 的 `fault_codes`，`09#04` 新增），由四类管理端写操作
显式维护；ingest 与种子走列默认值。**没有用 `created_at` 冒充它** —— 编辑过的 draft
若显示成"从没动过"，管理端就没法回答"这条最后一次是谁什么时候改的"。

### 5.7 故障反馈待审（`/api/admin/fault-reports`，`09#04` / D16·D26·R26）

只收**码级反馈**（用户查了一个不存在的码），**不做**描述型故障抽取（"机器嗡嗡响"要第二条模型
抽取链路，排 backlog，D26）。演示被问就照这句答。

| 方法 | 路径 | 最低角色 | 语义 |
|---|---|---|---|
| GET | `/api/admin/fault-reports?status=new\|merged\|rejected&page&size` | `lead` | 待审列表，默认 `status=new`，按 `created_at desc` |
| PATCH | `/api/admin/fault-reports/:id` | `lead` | `{action:"merge"\|"reject"}`；`merge` 只改状态，**不自动生成故障码**（前端引导去 `POST /api/admin/faults` 建 draft）；已处置的行再 `merge` → 409 |

**捕获**：`/api/fault` 的 miss 分支（`src/api/fault.ts`）异步写入，**不阻塞响应**；按
`(code, product_line, 24h)` **存在就不插**（不加 `hits` 计数器——这张表是待审清单，不是热度榜）。
`quote` 只存 ≤200 字短摘录，**不存问题原文**（工单里常带邮箱/电话，PII 不复制第二份）。
数据源 `source ∈ page|chat|ticket`；对话快路的 miss 不接。

**`GET /api/console/stats` 多一个 `reports`**（R26 的上线门槛：没有这三个数，这张表一个月后
就是第二个 `v_no_hit`）：

```jsonc
"reports": { "new": 0, "last24h": 1, "merge_rate": 0 }   // merge_rate = merged/(merged+rejected)，分母 0 时给 0
```

**口径固定全量**：这三个数**不受** `window` / `exclude_demo` 影响（它们是待审队列的健康度，
不是看板筛选的结果）；响应里回显的那两个参数只描述工单侧。这条决定写在代码注释里，别当 bug 修。

所有写操作都留 `audit_log`：`actor` = 会话里的真实登录人姓名，`target` = `fault:E03@balcony`
或 `product_line:foo`，`payload` 只记 `staff_id` / 状态前后值 / **字段名**，不记整段文案
（那张表保留两年，塞五语长文就是"另存一份 PII"）。

---

## 6. 内部端点

两道门：来源回环 **且** `X-Internal-Token` 全等；任一不满足 → `404`（与真 404 逐字同形，只差 `trace_id`）。

### 6.1 `POST /internal/search`

```json
{ "query": "E03 Netzspannung", "lang": "de", "top_k": 5, "prev_user": "上一轮问题" }
```

| 字段 | 规则 |
|---|---|
| `query` | 必填，trim 后 ≤2000 |
| `lang` | **必填**（机器对机器接口，缺 lang 是调用方 bug；悄悄按 en 会把英文片段返给德语用户） |
| `top_k` | 可选整数 `1..20`；**不收字符串数字**，超界明确 400（不夹取） |
| `prev_user` | 可选，同样 ≤2000，会被拼进检索语句 |

响应 `{ lang, topScore, fallback, chunks, timings_ms }`。`fallback` 取值见 `07`（正常 `none`，嵌入失败 `fts_only`）。
`topScore` 是**归一化后**的最高分，上层拿它和 `0.30` 比才成立。

### 6.2 `GET /internal/retrieval/recall`

参数 `q`（必填）、`lang`（缺省 `en`）、`lane`（`vec|fts|both`，缺省 `both`）。
响应把两路**原样**摊开：各最多 20 条、各自原始分，**不融合、不归一化、不截断**。
嵌入失败在这里不降级：`EMBED_UNAVAILABLE` 翻成 503，维度错误翻成 500。

### 6.3 故障码 / 工单 / 引用

| 端点 | 入参 | 响应 |
|---|---|---|
| `GET|POST /internal/fault` | `code` `lang`（缺省 en）`product_line`（缺省 balcony） | 与 `GET /api/fault/:code` **同一份 `data`**（含 `product_line`） |
| `POST /internal/ticket` | `question`（4–500）`conv_id?` `requester?` | `{ no, due_at, status }`；`reason` 同样不采信 |
| `POST /internal/ticket/lookup` | `{ no }` | `{ found, no, status, reason, created_at }`（**`reason`/`created_at` 是规格外附加字段**） |
| `GET /internal/ticket/:no` | path | 同上，逐字同一份形状（两个入口一个构造点） |
| `POST /internal/citations` | `{ message_id, citations[] }` | `{ inserted }`；**只写不校验**——校验在对话收尾流程里，顺序不能反 |

---

## 7. 静态资源

| 规则 | 行为 |
|---|---|
| MIME | 只发白名单里的扩展名（html/css/js/json/svg/png…）；表外扩展名 → 404 |
| 缓存 | `.html` → `no-cache`；其余 → `public, max-age`（无内容哈希，所以**不做进程内缓存**） |
| 安全头 | 每个成功响应带 `x-content-type-options: nosniff` |
| 穿越防护 | `/assets/*` 解析后必须仍在 `static/` 内，否则 404（意图只进日志） |
| 读法 | `readFile` 而不是流式：失败发生在任何字节发出之前，能干净变成 404/500 |
| HEAD | 由 Fastify `exposeHeadRoutes` 自动提供，**不要**手写（会 `FST_ERR_DUPLICATED_ROUTE`） |

---

## 8. 与 v1.1 的差异（本章）

| # | v1.1 | 实际 | 编号 |
|---|---|---|---|
| 1 | 内部接口失败一处写 401、一处写 404 | 统一 **404**（已裁定，`auth.ts:224` 有完整理由） | E1 |
| 2 | 端点表把 `/api/fault/:code` 标为 `User` | **无鉴权**（`routes.ts:102` 记了这处冲突） | E2 |
| 3 | 有 `POST /api/feedback`（"接口实现，UI 不做"） | **完全没实现** | E3 |
| 4 | `/api/fault` 响应无 `product_line` | 多了 `product_line`（否则与 `/internal/fault` 两套形状） | E5 |
| 5 | 未规定快路的帧集合 | 快路只发 `meta`/`delta`/`done`，**不发** `tool`/`citations` | E20 |
| 6 | 未规定 `X-Trace-Id` 的形态 | 沿用前端 `X-Trace-Id`；非 uuid 形状时 `messages.trace_id` 不落（列是 uuid） | E21 |
| 7 | 未规定分页超界行为 | 夹取而不是 400 | E22 |
