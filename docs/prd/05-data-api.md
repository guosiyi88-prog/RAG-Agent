# 05 · 数据模型与 API

## 1. 实体关系

```
documents 1─┬─n chunks ──n citations
            │
fault_codes │
            │
conversations 1─n messages 1─n citations
      │            │
      │            └─n attachments
      └─n tickets ──1 agents(assignee)
              │
              └─n kb_drafts ──1 agents(reviewer)

qa_gold ──1 documents(expect_doc_id)
eval_runs（独立）

skills / settings / audit_log / agent_runs / feedback / exports（旁挂）
```

共 18 张表。`chunks` 是检索核心，`tickets` 是运营核心。

---

## 2. 建表 DDL

```sql
create extension if not exists vector;
create extension if not exists pg_trgm;

-- ── 1. 文档 ──────────────────────────────────────────────
create table documents (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  lang         char(2) not null check (lang in ('zh','en','de','nl','es','mu')),
  product_line text,                          -- balcony|residential|cni
  bucket       text not null default 'knowledge',
  object_key   text not null,
  sha256       text not null unique,          -- 去重
  pages        int,
  chunk_count  int default 0,
  status       text not null default 'pending' check (status in ('pending','indexed','failed')),
  err          text,
  created_at   timestamptz default now()
);
create index on documents (lang, product_line);
create index on documents (status);

-- ── 2. 分块（检索核心） ──────────────────────────────────
create table chunks (
  id        bigserial primary key,
  doc_id    uuid not null references documents(id) on delete cascade,
  seq       int not null,
  lang      char(2) not null,
  section   text,                             -- 章节标题，用于引用展示
  content   text not null,
  page      int,
  embedding vector(1024),
  tsv       tsvector generated always as (to_tsvector('simple', content)) stored
);
create index chunks_emb_idx on chunks using hnsw (embedding vector_cosine_ops);
create index chunks_tsv_idx on chunks using gin (tsv);
create index chunks_lang_idx on chunks (lang);
create index chunks_doc_idx  on chunks (doc_id, seq);

-- ── 3. 故障码（精确匹配，绕开模型） ──────────────────────
create table fault_codes (
  code         text not null,
  product_line text not null,
  severity     text check (severity in ('info','warn','fatal')),
  desc_zh text, desc_en text, desc_de text, desc_nl text, desc_es text,
  act_zh  text, act_en  text, act_de  text, act_nl  text, act_es  text,
  primary key (code, product_line)
);

-- ── 4. 会话 ──────────────────────────────────────────────
create table conversations (
  id             uuid primary key default gen_random_uuid(),
  token_id       uuid,                        -- 匿名用户 token
  channel        text default 'web',
  lang           char(2),
  product_line   text,
  title          text,
  total_tokens   int default 0,
  total_cost_usd numeric(10,6) default 0,
  resolved       boolean,                     -- 24h 后回填
  created_at     timestamptz default now(),
  last_active_at timestamptz default now()
);
create index on conversations (token_id);
create index on conversations (created_at desc);

-- ── 5. 消息 ──────────────────────────────────────────────
create table messages (
  id              bigserial primary key,
  conv_id         uuid not null references conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant','system')),
  content         text not null,
  lang            char(2),
  intent          text,
  citations_count int default 0,
  tool_names      text[] default '{}',
  refused         boolean default false,
  confidence      real,
  latency_ms      int,
  trace_id        uuid,
  created_at      timestamptz default now()
);
create index on messages (conv_id, created_at);

-- ── 6. 引用快照（溯源） ──────────────────────────────────
create table citations (
  id         bigserial primary key,
  message_id bigint not null references messages(id) on delete cascade,
  chunk_id   bigint references chunks(id) on delete set null,
  doc_title  text,
  page       int,
  snippet    text,                            -- ≤300 字
  score      real,
  idx        int not null,                    -- 角标编号 1..n
  created_at timestamptz default now()
);
create index on citations (message_id);

-- ── 7. 工单 ──────────────────────────────────────────────
create sequence ticket_seq;
create table tickets (
  id         bigserial primary key,
  no         text unique not null,            -- WT-YYYY-NNNN
  conv_id    uuid references conversations(id) on delete set null,
  message_id bigint,
  reason     text not null check (reason in ('no_citation','out_of_scope','low_conf','user_request')),
  question   text not null,
  requester  text,                            -- 邮箱 / WhatsApp
  priority   text default 'normal' check (priority in ('low','normal','high','urgent')),
  status     text default 'open' check (status in ('open','claimed','escalated','closed')),
  assignee   uuid references agents(id),
  tags       text[] default '{}',
  due_at     timestamptz,
  resolution text,
  created_at timestamptz default now(),
  closed_at  timestamptz
);
create index on tickets (status, due_at);
create index on tickets (reason);
create index on tickets (assignee);

-- 工单号生成
create or replace function gen_ticket_no() returns text as $$
  select 'WT-' || to_char(now(),'YYYY') || '-' || lpad(nextval('ticket_seq')::text, 4, '0');
$$ language sql;
alter table tickets alter column no set default gen_ticket_no();

-- ── 8. 坐席 ──────────────────────────────────────────────
create table agents (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text unique not null,
  role       text default 'agent' check (role in ('agent','lead','admin')),
  active     boolean default true,
  created_at timestamptz default now()
);

-- ── 9. 反馈 ──────────────────────────────────────────────
create table feedback (
  id         bigserial primary key,
  message_id bigint references messages(id) on delete cascade,
  score      smallint check (score in (-1, 1)),
  comment    text,
  created_at timestamptz default now()
);

-- ── 10. 知识草稿 ─────────────────────────────────────────
create table kb_drafts (
  id         bigserial primary key,
  question   text not null,
  answer     text not null,
  lang       char(2) not null,
  source     text default 'no_hit' check (source in ('no_hit','manual','ticket')),
  status     text default 'draft' check (status in ('draft','approved','rejected')),
  reviewer   uuid references agents(id),
  chunk_id   bigint,                          -- 通过后写入的 chunk
  created_at timestamptz default now()
);
create index on kb_drafts (status);

-- ── 11. 附件 ─────────────────────────────────────────────
create table attachments (
  id         bigserial primary key,
  message_id bigint references messages(id) on delete cascade,
  bucket     text not null,
  object_key text not null,
  mime       text,
  size_bytes int,
  created_at timestamptz default now()
);

-- ── 12. 评测集 ───────────────────────────────────────────
create table qa_gold (
  id            bigserial primary key,
  lang          char(2) not null,
  question      text not null,
  expect_doc_id uuid references documents(id) on delete set null,
  expect_doc    text,                         -- 人读备注
  should_refuse boolean default false,
  note          text
);

-- ── 13. 评测结果 ─────────────────────────────────────────
create table eval_runs (
  id         uuid primary key default gen_random_uuid(),
  total      int, hit int, cite_ok int, refuse_ok int,
  hit_rate numeric(5,4), cite_rate numeric(5,4), refuse_rate numeric(5,4),
  detail     jsonb,
  created_at timestamptz default now()
);

-- ── 14. Agent 运行轨迹 ───────────────────────────────────
create table agent_runs (
  id            bigserial primary key,
  conv_id       uuid references conversations(id) on delete cascade,
  message_id    bigint,
  model         text,
  intent        text,
  tool_calls    jsonb default '[]',           -- [{name, ms, ok}]
  input_tokens  int, output_tokens int,
  cost_usd      numeric(10,6),
  latency_ms    int,
  refused       boolean default false,
  created_at    timestamptz default now()
);
create index on agent_runs (conv_id);

-- ── 15. SOP Skills ───────────────────────────────────────
create table skills (
  name        text primary key,
  description text not null,
  object_key  text not null,
  enabled     boolean default true,
  updated_by  uuid references agents(id),
  updated_at  timestamptz default now()
);

-- ── 16. 运行参数 ─────────────────────────────────────────
create table settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references agents(id),
  updated_at timestamptz default now()
);
-- 预置：retrieval.top_k / retrieval.min_score / refusal.enabled /
--       prompt.version / safe_mode / night_autoreply

-- ── 17. 审计 ─────────────────────────────────────────────
create table audit_log (
  id         bigserial primary key,
  actor      text,
  action     text not null,                   -- kb.upload|ticket.claim|draft.approve|setting.update|export
  target     text,
  payload    jsonb,
  created_at timestamptz default now()
);

-- ── 18. 导出件 ───────────────────────────────────────────
create table exports (
  id         bigserial primary key,
  conv_id    uuid references conversations(id) on delete set null,
  object_key text not null,
  size_bytes int,
  created_by uuid references agents(id),
  created_at timestamptz default now()
);

-- ── 视图：未命中池 ───────────────────────────────────────
create view v_no_hit as
  select t.question,
         c.lang,
         count(*)          as hits,
         max(t.created_at) as last_at,
         (select count(*) from kb_drafts d
           where d.question = t.question and d.status <> 'rejected') as draft_count
  from tickets t
  left join conversations c on c.id = t.conv_id
  where t.reason in ('no_citation','out_of_scope')
    and t.status <> 'closed'
  group by t.question, c.lang
  order by hits desc, last_at desc;
```

---

## 3. 数据保留与清理

| 数据 | 保留 | 清理方式 |
|---|---|---|
| `messages` / `citations` | 90 天 | 每日定时任务 |
| `attachments` | 90 天 | 同步删 MinIO 对象 |
| `tickets` | 2 年 | 归档表 |
| `agent_runs` | 30 天 | 聚合进日表后删 |
| `audit_log` | 2 年 | 只归档 |
| Pi session | 不落盘 | — |

---

## 4. API 契约

统一前缀 `/api`。响应体 `{ ok: boolean, data?: T, error?: {code, message, trace_id} }`。

### 4.1 用户端（Header `X-User-Session`）

| 方法 | 路径 | 入参 | 出参 | 限流 |
|---|---|---|---|---|
| POST | `/session` | — | `{token}` | 10/min/IP |
| POST | `/chat` | `{conv_id?, text, lang?}` | SSE | 20/min/token |
| GET | `/fault/:code` | `?lang=` | `{found, severity, meaning, actions[], citations[]}` | 60/min |
| POST | `/feedback` | `{message_id, score, comment?}` | `{ok}` | 30/min |
| POST | `/ticket` | `{conv_id, email, question}` | `{no}` | 3/hour/token |
| GET | `/ticket/:no` | `?email=` | `{status, created_at, due_at, resolution?}` | 20/min |
| GET | `/conversations` | `?limit=20` | `[{id, title, lang, last_at}]` | 60/min |
| GET | `/conversations/:id` | — | `{messages:[...]}` | 60/min |
| POST | `/quick-questions` | `{lang}` | `[{key, title}]` | — |
| GET | `/i18n/:lang` | — | 文案字典 | — |

### 4.2 SSE 事件

| event | data | 时机 |
|---|---|---|
| `meta` | `{conv_id, message_id, trace_id}` | 立即 |
| `delta` | `{t}` | 逐字 |
| `tool` | `{name, ms}` | 工具结束 |
| `citations` | `[{idx, doc_title, page, snippet}]` | 回答结束前一次性 |
| `refusal` | `{ticket_no}` | 拒答时 |
| `done` | `{latency_ms, tokens, cost_usd}` | 结束 |
| `error` | `{code, message, trace_id}` | 异常 |

### 4.3 坐席端（Header `X-Admin-Token`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/console/tickets` | `?status=&reason=&assignee=&lang=&q=&page=` |
| GET | `/console/tickets/:id` | 详情（含 messages + citations + 当时工具轨迹） |
| PATCH | `/console/tickets/:id` | `{status?, assignee?, resolution?, tags?}` |
| POST | `/console/draft` | `{ticket_id, instruction?, target_lang?}` → 新 session 起草 |
| POST | `/console/translate` | `{text, target_lang}` |
| POST | `/console/adopt` | `{message_id}` → 写 audit |
| GET | `/console/documents` | `?status=&lang=&product_line=` |
| POST | `/console/documents` | multipart 上传 |
| PATCH | `/console/documents/:id` | 改标题/产品线 |
| DELETE | `/console/documents/:id` | 级联删 chunk + MinIO |
| POST | `/console/documents/:id/reindex` | 重索引 |
| GET | `/console/documents/:id/chunks` | `?limit=20` |
| POST | `/console/documents/paste` | 纯文本入库（扫描件兜底） |
| GET | `/console/no-hit` | `v_no_hit` 分页 |
| POST | `/console/drafts` | `{question, lang}` 生成草稿 |
| PATCH | `/console/drafts/:id` | `{status: approved|rejected, answer?}` |
| GET | `/console/stats` | 看板聚合 |
| POST | `/console/conversations/:id/export` | → `{url}` |
| GET | `/console/skills` · PUT `/console/skills/:name` | P1 |
| GET | `/console/settings` · PATCH | P1 |
| GET | `/console/audit` | 分页 |
| GET | `/healthz` | pg/redis/minio/pi 四项 |

### 4.4 内部接口（Header `X-Internal-Token`，仅工具调用）

| 方法 | 路径 |
|---|---|
| POST | `/internal/search` |
| POST | `/internal/fault` |
| POST | `/internal/ticket` |
| POST | `/internal/ticket/lookup` |
| POST | `/internal/cert` |
| POST | `/internal/quote` |
| POST | `/internal/escalate` |
| POST | `/internal/citations` |
| POST | `/internal/message` |

---

## 5. 错误码

| code | HTTP | 语义 | 前端表现 |
|---|---|---|---|
| `AUTH_REQUIRED` | 401 | 缺 token | 自动申请 token 后重试 |
| `AUTH_INVALID` | 401 | token 无效 | 清本地 token，回首页 |
| `RATE_LIMITED` | 429 | 超限 | 「操作太频繁，请 N 秒后重试」 |
| `QUOTA_TICKET` | 429 | 建单配额用尽 | 「今日建单已达上限，请邮件联系」 |
| `INPUT_TOO_LONG` | 400 | 输入 >2000 字 | 就近提示 |
| `NOT_FOUND` | 404 | 资源不存在 | 空态 |
| `SESSION_BUSY` | 503 | 并发满 | 「前面还有 N 位，已排队」 |
| `LLM_TIMEOUT` | 504 | 模型超 30s | 「响应超时」+ 转人工 |
| `LLM_UNAVAILABLE` | 503 | 模型不可用 | 自动切 mock，提示「降级模式」 |
| `EMBED_UNAVAILABLE` | 503 | embedding 不可用 | 自动切 hash |
| `STORAGE_UNAVAILABLE` | 503 | MinIO 不可用 | 切本地，导出暂不可用 |
| `INTERNAL` | 500 | 未捕获 | 「系统繁忙」+ trace_id 后 6 位 |

所有错误带 `trace_id`，前端展示后 6 位，便于对日志。

---

## 6. 工单号规则

- 格式 `WT-YYYY-NNNN`
- `NNNN` 来自全局 `ticket_seq`，**不按年重置**（避免跨年冲突）
- 数据库 `unique` 约束兜底
- 展示用等宽字体，一键复制

---

## 7. 状态机

见 `03-agent-console.md` 第 9 节（工单 4 态、草稿 3 态）。数据层约束：

```sql
-- closed 不可逆
create or replace function guard_ticket_status() returns trigger as $$
begin
  if old.status = 'closed' and new.status <> 'closed' then
    raise exception 'closed ticket is immutable';
  end if;
  return new;
end $$ language plpgsql;

create trigger trg_guard_ticket before update on tickets
  for each row execute function guard_ticket_status();
```
