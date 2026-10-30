# 05 · HTTP API 契约

> 所有响应统一外层：`{ ok: true, data: T }` 或 `{ ok: false, error: { code, message, trace_id } }`。
> 所有请求带 `X-Trace-Id`（前端生成 UUID），后端回写日志。

## 1. 鉴权

| 域 | Header | 校验方式 |
|---|---|---|
| 用户端 | `X-User-Session: <uuid>` | 命中 Redis `sess:{uuid}` 且未过期 |
| 坐席端 | `X-Admin-Token: <token>` | 全等比较 `config.ADMIN_TOKEN` |
| 坐席端（可选） | `X-Admin-Staff: <staff uuid>` | 仅用于「认领」时确定默认 assignee；缺失则取 `staff` 表第一条 |
| 内部 | `X-Internal-Token: <token>` | 全等 + 来源 IP 必须是 127.0.0.1 |

---

## 2. 端点总表

| # | 方法 | 路径 | 鉴权 | 任务卡 |
|---|---|---|---|---|
| 1 | POST | `/api/session` | 无 | T05 |
| 2 | POST | `/api/chat` | User | T05/T06 |
| 3 | GET | `/api/fault/:code` | User | T05 |
| 4 | POST | `/api/ticket` | User | T06 |
| 5 | GET | `/api/ticket/:no` | User | T06 |
| 6 | POST | `/api/feedback` | User | T11(预留) |
| 7 | GET | `/api/i18n/:lang` | 无 | T09 |
| 8 | GET | `/api/console/tickets` | Admin | T08 |
| 9 | GET | `/api/console/tickets/:id` | Admin | T08 |
| 10 | PATCH | `/api/console/tickets/:id` | Admin | T08 |
| 11 | GET | `/healthz` | 无 | T01 |
| 12 | POST | `/api/console/draft` | Admin | 预留：固定返回 `501 NOT_IMPLEMENTED` |
| 13 | POST | `/api/console/translate` | Admin | 预留：固定返回 `501 NOT_IMPLEMENTED` |
| 14 | POST | `/api/console/export` | Admin | 预留：固定返回 `501 NOT_IMPLEMENTED` |
| 15 | GET | `/api/console/stats` | Admin | 预留：真实聚合（返工单数 / 拒答率 / 平均 SLA），不做图表 |
| — | POST | `/internal/search` | Internal | T04 |
| — | POST | `/internal/fault` | Internal | T05 |
| — | POST | `/internal/ticket` | Internal | T06 |
| — | POST | `/internal/ticket/lookup` | Internal | T06 |
| — | POST | `/internal/citations` | Internal | T06 |

---

## 3. 用户端端点

### 3.1 `POST /api/session`

签发匿名令牌。

**请求**：无 body。

**响应 200**
```json
{ "ok": true, "data": { "token": "3f2b8c1e-...", "expires_at": "2026-11-03T10:00:00Z" } }
```

**规则**
- Redis `SETEX sess:{token} 604800 "1"`（7 天）
- 同一 IP 每分钟最多 10 次

---

### 3.2 `POST /api/chat`（SSE，核心）

**请求**
```json
{ "conv_id": "uuid|null", "text": "Wechselrichter zeigt E03", "lang": "de" }
```

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `conv_id` | string(uuid) \| null | 否 | 空则新建会话 |
| `text` | string | 是 | 1–2000 字符，trim 后非空 |
| `lang` | enum | 否 | `zh/en/de/nl/es`，缺省按 Accept-Language 猜，再缺省 `en` |

**响应**：`Content-Type: text/event-stream`，逐条事件。

| event | data | 出现时机 |
|---|---|---|
| `meta` | `{"conv_id":"...","message_id":123,"trace_id":"..."}` | 立即，一次 |
| `delta` | `{"t":"片段"}` | 0..n 次 |
| `tool` | `{"name":"kb_search","ms":420}` | 每次工具结束 |
| `citations` | `[{"idx":1,"doc_title":"...","page":12,"snippet":"...","doc_lang":"de"}]` | 回答结束前一次；**只含被引用的** |
| `refusal` | `{"ticket_no":"WT-2026-0031"}` | 拒答时（此时无 citations） |
| `done` | `{"latency_ms":3120,"tokens":4210,"cost_usd":0.0041}` | 结束，一次 |
| `error` | `{"code":"LLM_TIMEOUT","message":"...","trace_id":"..."}` | 异常，一次后关闭 |

**`citations` 的语义（易错，务必按此实现）**

`citations` 里放的是**答案正文实际引用到的那些片段**，不是 `kb_search` 的全部候选。

| 概念 | 含义 | 出现位置 |
|---|---|---|
| **候选（candidate）** | 本轮 `kb_search` 返回的 top5 chunk | 只在 `tool_result` 的 `details` 里，不下发前端 |
| **引用（citation）** | 答案正文里出现了 `[n]` 且 `n` 落在候选集内的那些 | `citations` 事件 + `citations` 表 |

规则：

1. `idx` 集合 = `text.matchAll(/\[(\d+)\]/g)` 取出且存在于候选集
2. 若一个都没有（无 `[n]`，或全是非法编号）→ **不发 `citations`**，改走 `refusal`
3. 前端只渲染 `citations` 里出现过的编号，其余 `[n]` 按纯文本显示
4. 顺序按 `idx` 升序，与正文首次出现顺序无关

> 为什么不做成"候选全集"：前端会把没用到的角标也画出来，客户点开发现"这段没支持那句话"，信任直接崩。

**故障码快路**：若 `text` 匹配 `^[A-Za-z]\d{2,3}$`，不建 AgentSession，直接查表：
- 命中 → 发 `meta` + `delta`（结果文本，末行固定为"来源：故障码表"）+ `done`。**不发 `citations`**：故障码来自 `fault_codes` 表，没有 chunk，前端也不给它画角标
- 未命中 → 正常走模型

**超时**：单轮 30s（`config.CHAT_TIMEOUT_MS`），超时发 `error` + 关闭。

**示例（curl）**
```bash
curl -N -X POST http://localhost:8000/api/chat \
  -H 'Content-Type: application/json' \
  -H "X-User-Session: $TOKEN" \
  -d '{"text":"Wechselrichter zeigt E03","lang":"de"}'
```

---

### 3.3 `GET /api/fault/:code`

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `code` | path | 是 | `^[A-Za-z]\d{2,3}$`，不匹配 400 |
| `lang` | query | 否 | 默认 `en` |
| `product_line` | query | 否 | 默认 `balcony` |

**响应 200（命中）**
```json
{ "ok": true, "data": {
  "found": true,
  "code": "E03",
  "severity": "warn",
  "meaning": "Netzspannung außerhalb des Bereichs",
  "actions": ["1. Netzspannung messen", "2. Klemmen prüfen", "3. Zurücksetzen und 10 Min. beobachten"],
  "doc_lang": "de"
}}
```

**响应 200（未命中）**
```json
{ "ok": true, "data": { "found": false, "code": "E99" } }
```

**性能**：单条主键查询，P95 < 20ms。**禁止**在此路径调用模型或 embedding。

---

### 3.4 `POST /api/ticket`

> **先分清两个词，否则工单原因会写错**：
> **拒答（refusal）** = 系统判定"没有证据"，自动发生，用户没得选，`reason ∈ {no_citation, low_conf}`。
> **转人工（handoff）** = 用户主动点按钮要求人工，`reason = user_request`。
> 两者都会建单、都会出现在坐席队列，但**原因不同、SLA 优先级不同、统计口径不同**。UI 只有一个「转人工」按钮，`reason` 由后端按触发路径写入，前端不得传。

**请求**
```json
{ "conv_id": "uuid", "email": "installer@example.com", "question": "E03 反复出现" }
```

| 字段 | 约束 |
|---|---|
| `email` | 正则 `^[^@\s]+@[^@\s]+\.[a-z]{2,}$`（大小写不敏感） |
| `question` | 4–500 字符 |
| `conv_id` | 必须存在且属于当前 token |

**响应 200**
```json
{ "ok": true, "data": { "no": "WT-2026-0031", "due_at": "2026-10-27T18:20:00Z" } }
```

**规则**
- `reason` 固定 `user_request`，`priority` 默认 `normal`
- `due_at = now() + sla.hours`（默认 4 小时）
- 限流：每 token 每小时 3 张，超限 `QUOTA_TICKET`
- 同一 `conv_id` 5 分钟内重复提交返回已有单号（幂等）

---

### 3.5 `GET /api/ticket/:no`

| 参数 | 说明 |
|---|---|
| `no` | 工单号 `WT-YYYY-NNNN` |
| `email` | query，必填，须与 `requester` 匹配 |

**响应 200**
```json
{ "ok": true, "data": {
  "no": "WT-2026-0031", "status": "claimed",
  "created_at": "2026-10-27T14:20:00Z",
  "due_at": "2026-10-27T18:20:00Z",
  "resolution": null
}}
```

**错误**：单号不存在或邮箱不匹配，统一返回 `NOT_FOUND`（不区分，避免枚举）。

---

### 3.6 `POST /api/feedback`（预留，本期 UI 不做但接口实现）

```json
{ "message_id": 123, "score": 1, "comment": "有用" }
```
`score` 只能是 `1` 或 `-1`。

---

### 3.7 `GET /api/i18n/:lang`

返回该语言完整文案字典（扁平 key）。

```json
{ "ok": true, "data": { "chat.send": "Senden", "chat.placeholder": "Frage eingeben…" } }
```

**实现**：服务启动时读 `static/i18n.json` 到内存；请求时 `merge(en, lang)` 做回落。

---

## 4. 坐席端端点

### 4.1 `GET /api/console/tickets`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `status` | `open,claimed,escalated,closed` | 全部非 closed | 逗号分隔多选 |
| `reason` | 同上枚举 | 全部 | |
| `q` | string | — | 对 `no` 和 `question` 模糊匹配 |
| `page` | int | 1 | |
| `size` | int | 20 | 上限 100 |

**排序**：`due_at asc nulls last, created_at desc`

> `items[].lang` 不来自 `tickets` 表（该表**没有** lang 列）：一律 `left join conversations c on c.id = t.conv_id` 取 `c.lang`，取不到就给 `null`。

**响应 200**
```json
{ "ok": true, "data": {
  "total": 12,
  "items": [{
    "id": 31, "no": "WT-2026-0031",
    "reason": "no_citation", "status": "open",
    "question": "E03 反复出现",
    "lang": "de",
    "assignee": null,
    "due_at": "2026-10-27T18:20:00Z",
    "sla_seconds_left": 8040,
    "created_at": "2026-10-27T14:20:00Z"
  }]
}}
```

---

### 4.2 `GET /api/console/tickets/:id`

**响应 200**
```json
{ "ok": true, "data": {
  "ticket": { "...同列表项字段...", "resolution": null },
  "conversation": { "id": "uuid", "lang": "de" },
  "messages": [
    { "id": 11, "role": "user", "content": "Wechselrichter zeigt E03", "created_at": "..." },
    { "id": 12, "role": "assistant", "content": "E03 bedeutet … [1]",
      "refused": false, "citations_count": 1, "tool_names": ["kb_search"],
      "citations": [
        { "idx": 1, "doc_title": "Installationshandbuch 600W", "page": 12,
          "doc_lang": "de", "snippet": "Die Netzspannung muss …" }
      ]}
  ]
}}
```

> **注意**：`messages[].citations` 只有 assistant 消息才有，且仅 `idx` 升序。

---

### 4.3 `PATCH /api/console/tickets/:id`

**请求**（字段全可选，至少有 1 个）
```json
{ "status": "claimed", "assignee_id": "uuid", "resolution": "已电话指导复位，问题解决" }
```

**规则**
- `status=closed` 时 `resolution` 必填且 ≥10 字符，否则 `VALIDATION`
- `claimed` 时若 `assignee` 为空，自动设为请求头 `X-Admin-Staff`（坐席 id，默认取 seed 第一个坐席）
- 每次变更写 `audit_log`（`action='ticket.update'`，`payload` 存前后差异）
- `closed` 后再改任何字段 → DB 触发器抛错 → 转 `TICKET_IMMUTABLE`

---

## 5. 内部端点（仅工具调用，127.0.0.1）

### 5.1 `POST /internal/search`

```json
{ "query": "Wechselrichter E03 Spannung", "lang": "de", "top_k": 5 }
```
**响应**
```json
{ "ok": true, "data": {
  "lang": "de",
  "topScore": 0.83,
  "fallback": "none",
  "chunks": [
    { "idx": 1, "doc_id": "uuid", "doc_title": "Installationshandbuch 600W",
      "doc_lang": "de", "page": 12, "section": "4.2 Netzanschluss",
      "content": "Die Netzspannung muss zwischen 195 und 253 V liegen …",
      "score": 0.83 }
  ]
}}
```

> `topScore` 是**归一化后**的最高分（`07-retrieval.md` §5.1），`fallback ∈ {none, fts_only, empty}`。这两个字段是 `14-verification.md` §2 反例断言的依据，**不可省**。

### 5.2 `POST /internal/fault`
```json
{ "code": "E03", "lang": "de", "product_line": "balcony" }
```
返回同 `GET /api/fault/:code` 的 `data`。

### 5.3 `POST /internal/ticket`
```json
{ "reason": "no_citation", "question": "…", "requester": null, "conv_id": "uuid" }
```
返回 `{ "no": "WT-2026-0031" }`。**无邮箱也可建单**（匿名单，`requester=null`）。

### 5.4 `POST /internal/ticket/lookup`
```json
{ "no": "WT-2026-0031" }
```
返回 `{ "found": true, "status": "claimed" }`。

### 5.5 `POST /internal/citations`
```json
{ "message_id": 12, "citations": [ { "idx":1, "chunk_id": 88, "doc_title":"…", "page":12, "snippet":"…", "score":0.83, "doc_lang":"de" } ] }
```
返回 `{ "inserted": 1 }`。

---

## 6. 错误码总表

| code | HTTP | 触发 | 前端文案 key |
|---|---|---|---|
| `AUTH_REQUIRED` | 401 | 缺 token | `chat.err.auth` |
| `AUTH_INVALID` | 401 | token 无效/过期 | `chat.err.auth` |
| `RATE_LIMITED` | 429 | 超限 | `chat.err.rate` |
| `QUOTA_TICKET` | 429 | 建单配额 | `ticket.quota` |
| `VALIDATION` | 400 | 参数不合法 | 具体字段：`fault.invalid` / `ticket.email.invalid` |
| `NOT_FOUND` | 404 | 资源不存在 | `chat.err.notfound` |
| `NOT_IMPLEMENTED` | 501 | 预留端点（draft/translate/export） | `toast.notopen` |
| `SESSION_BUSY` | 503 | 并发满 | `chat.err.busy` |
| `LLM_TIMEOUT` | 504 | 模型超 30s | `chat.err.timeout` |
| `LLM_UNAVAILABLE` | 503 | 模型不可用 | `chat.err.degraded` |
| `EMBED_UNAVAILABLE` | 503 | embedding 不可用 | `chat.err.degraded` |
| `STORAGE_UNAVAILABLE` | 503 | MinIO 不可用 | `chat.err.degraded` |
| `TICKET_IMMUTABLE` | 409 | 已关单再改 | `chat.err.immutable` |
| `INTERNAL` | 500 | 未捕获 | `chat.err.internal` |

> 右列的 key 必须能在 `12-i18n.md` §4 里逐字找到；`chat.err.notfound` 与 `chat.err.immutable` 是为本表新增的。

---

## 7. `/healthz`

```json
{ "ok": true, "checks": { "pg": true, "redis": true, "minio": true, "pi": true }, "version": "0.1.0" }
```

| 检查项 | 方法 |
|---|---|
| `pg` | `select 1` + `select extversion from pg_extension where extname='vector'`（无值视为失败），超时 1s |
| `redis` | `PING`（URL 已含密码），超时 1s |
| `minio` | `bucketExists(config.S3_BUCKET)`（= `wt-dev`），超时 1s。**只经 `config` 读**，禁止直接 `process.env`（`17-ai-brief.md` §3 第 4 条） |
| `pi` | 进程内标志位：至少成功创建过 1 次 AgentSession |

任一项 false → HTTP 503，`ok:false`。**不返回任何连接串或错误详情。**

---

## 8. CORS 与静态

- 只允许同源；开发期允许 `http://localhost:8000`
- 不给 `/api/*` 开 `Access-Control-Allow-Origin: *`
- SSE 响应头必须带：`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`
