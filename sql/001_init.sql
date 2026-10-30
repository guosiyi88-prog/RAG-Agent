-- ============================================================
-- 沃泰储能多语种客服 Agent · 初始化（结构）
-- 要求：PostgreSQL 16 + pgvector 0.7+
--
-- 权威内容来源：docs/prdv1.1/04-db.md §2。本文件与之一致，差异只有三处，
-- 都写在对应位置并说明原因：
--   1) 开头先 drop 本文件负责的全部对象 —— 本文件同时是 `make reset` 的重放脚本，
--      语义必须是"恢复干净库"。用 create ... if not exists 只能保证不报错，
--      旧结构漂移和脏数据都会留下，那不是 reset。
--   2) 所有 char(2) 语言列都带取值约束，不只 documents.lang。
--   3) 已关闭工单的保护更严：closed 行的任何 UPDATE 都 raise。
-- ============================================================

-- 重放时 drop / create ... if not exists 会刷一屏 NOTICE，压到 warning，
-- 让 `make reset` 的输出里只剩真正的错误和警告
set client_min_messages = warning;

-- 扩展装在 public（默认），不要为了"干净"去 drop schema public cascade：
-- 那会连带删掉 vector 的类型与函数，扩展记录却还在，库会变成用完不能重建的状态
create extension if not exists vector;
create extension if not exists pg_trgm;

-- ── 清理（顺序：视图 → 表 → 函数 → 序列）─────────────────
drop view if exists v_no_hit;
drop view if exists v_health;
drop table if exists
  fault_reports,
  document_rebuild_jobs, document_version_chunks, document_versions,
  exports, audit_log, settings, skills, ai_runs, eval_runs, qa_gold,
  attachments, kb_drafts, feedback, tickets, staff_sessions, staff, citations,
  messages, conversations, fault_codes, product_lines, org_units, chunks, documents
  cascade;
drop function if exists guard_ticket_status() cascade;
drop function if exists gen_ticket_no() cascade;
drop sequence if exists ticket_seq;

-- ── 1. 文档 ──────────────────────────────────────────────
create table documents (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  lang         char(2) not null check (lang in ('zh','en','de','nl','es')),
  product_line text,                          -- balcony|residential|cni
  -- 正文（`09#05`）：管理端录入的文档以**库为真源**，重建索引只依赖 body + lang。
  -- 从语料目录灌进来的文档这一列是 NULL（真源仍是 corpus/ 里的文件）：入库流水线从不读它，
  -- 谁想"把文件正文回填进库"是另一件事，别指望这里自动同步。
  body         text,
  bucket       text not null default 'wt-dev',   -- 与 data/.env.example 的 MINIO_BUCKET 一致
  -- 管理端录入的文档没有 MinIO 对象，这一列只是 NOT NULL 的占位（用 `kb:<uuid>` 前缀，
  -- 与语料相对路径（`warranty.zh.md`）不会撞）。判"这篇是 API 录入的还是文件灌进来的"看 body 是否为 NULL。
  object_key   text not null,
  sha256       text not null unique,
  pages        int,
  chunk_count  int not null default 0,
  -- 索引版本（`09#05`）：每次重建 +1，第 N 版 = `document_versions` 里 (doc_id, N) 那一行。
  -- 0 = 从未重建过（语料目录灌进来的文档停在这里）。
  version      int not null default 0,
  -- `archived`（`09#05`）：管理端"停用"一篇文档。只改状态不删行 —— 引用快照要还能打开，
  -- 而且删了行之后 `make ingest` 会把同一份文件重新插进来（D25 的同一条理由）。
  -- 停用的文档仍然留着 chunks（重建/回滚都还要用），检索侧靠 `d.status <> 'archived'` 排除。
  status       text not null default 'pending'
               check (status in ('pending','indexed','failed','archived')),
  err          text,
  created_at   timestamptz not null default now(),
  -- 更新时间（`09#05`）：管理端列表按它排序（"刚改过的在最上面"）。
  -- 维护方：管理端四类写操作（新建/编辑/重建/回滚/停用）显式 `set updated_at = now()`；
  -- 入库流水线不碰它（文件灌进来的行按 created_at 看）。
  updated_at   timestamptz not null default now()
);
create index documents_lang_idx    on documents (lang);
create index documents_status_idx  on documents (status);
create index documents_updated_idx on documents (updated_at desc);

-- ── 2. 分块（检索核心） ──────────────────────────────────
-- 双索引是刻意的：向量做跨语种语义召回，全文只做术语精确召回（型号、故障码）。
-- tsv 必须 generated stored —— 生成列不能是 virtual，且 gin 索引要读实体列。
create table chunks (
  id        bigserial primary key,
  doc_id    uuid not null references documents(id) on delete cascade,
  seq       int  not null,
  lang      char(2) not null check (lang in ('zh','en','de','nl','es')),
  section   text,
  content   text not null,
  page      int,
  token_len int,
  embedding vector(1024),
  tsv       tsvector generated always as (to_tsvector('simple', content)) stored,
  created_at timestamptz not null default now()
);
-- hnsw + cosine：与 embedding 的归一化口径绑定，换距离算子会让召回分数不可比
create index chunks_emb_idx  on chunks using hnsw (embedding vector_cosine_ops);
create index chunks_tsv_idx  on chunks using gin  (tsv);
-- 语言过滤索引：检索 SQL 必须写 lang = any($n::char(2)[])，缺 cast 会退化成 text[] 比较而放弃本索引
create index chunks_lang_idx on chunks (lang);
create index chunks_doc_idx  on chunks (doc_id, seq);

-- ── 3. 故障码（精确匹配，不经模型） ──────────────────────
-- 主键带 product_line：同一个码在不同产品线含义不同，不能只按 code 唯一
create table fault_codes (
  code         text not null,
  product_line text not null,
  severity     text check (severity in ('info','warn','fatal')),
  desc_zh text, desc_en text, desc_de text, desc_nl text, desc_es text,
  act_zh  text, act_en  text, act_de  text, act_nl  text, act_es  text,
  -- 发布态（09#02 / D15）：`/api/fault/:code` 是无令牌公开接口，没有这一列就是"误录即上线"。
  -- 两个入口两种权力是刻意的：语料入库写进来的码是 published（入库已强制五语，属审过的
  -- 源稿），管理端写入一律 draft，admin 点发布才对外。
  -- 归档只能走 status，不能删行：行没了就不冲突，`make ingest` 会把它重新插进来（D25）。
  status       text not null default 'draft'
               check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  -- 更新时间（09#04）：管理端的列表与详情都要显示"这行最后一次改动是什么时候"（工单 04 的
  -- 列表列之一）。没有这一列就只能拿 `created_at` 冒充，等于给管理端一个假的更新时间 ——
  -- 编辑过的 draft 会看起来"从没动过"。写入方各自维护：管理端四类写操作（新建/编辑/发布/归档）
  -- 显式 `set updated_at = now()`；ingest 与种子走列默认值（它们的 `do nothing` 不改既有行）。
  updated_at timestamptz not null default now(),
  primary key (code, product_line)
);
-- 管理端列表与门禁都按状态过滤；主键查询（code+product_line）用不到它，但全表扫描用得到
create index fault_codes_status_idx on fault_codes (status);

-- 产品线字典（09#02 / D21）：管理端下拉的唯一来源。
-- 不加外键：`fault_codes.product_line` 是历史自由文本，先靠应用层校验；加外键会把现有
-- 数据与 ingest 的写入顺序绑在一起，收益为零、失败面变大。
-- 为什么必须早于故障卡 UI：原方案"下拉取 select distinct product_line"是死循环 ——
-- 没有字典就没有新选项，没有新选项就永远新增不了产线。
create table product_lines (
  code       text primary key,
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ── 4. 会话 ──────────────────────────────────────────────
create table conversations (
  id             uuid primary key default gen_random_uuid(),
  token_id       uuid,
  channel        text not null default 'web',
  lang           char(2) check (lang in ('zh','en','de','nl','es')),
  product_line   text,
  total_tokens   int not null default 0,
  total_cost_usd numeric(10,6) not null default 0,
  created_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);
create index conversations_token_idx   on conversations (token_id);
create index conversations_created_idx on conversations (created_at desc);

-- ── 5. 消息 ──────────────────────────────────────────────
-- 只做记录/回放，不作为会话上下文来源（ADR-0002：上下文只活在进程内存里）
create table messages (
  id              bigserial primary key,
  conv_id         uuid not null references conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant','system')),
  content         text not null,
  lang            char(2) check (lang in ('zh','en','de','nl','es')),
  intent          text,
  citations_count int not null default 0,
  tool_names      text[] not null default '{}',
  refused         boolean not null default false,
  confidence      real,
  latency_ms      int,
  trace_id        uuid,
  created_at      timestamptz not null default now()
);
create index messages_conv_idx on messages (conv_id, created_at);

-- ── 6. 引用快照 ──────────────────────────────────────────
-- 快照语义：doc_title/doc_lang/page/snippet 落库即冻结，chunk 被删（set null）
-- 也不影响历史回答的可追溯性
create table citations (
  id         bigserial primary key,
  message_id bigint not null references messages(id) on delete cascade,
  chunk_id   bigint references chunks(id) on delete set null,
  doc_title  text,
  doc_lang   char(2) check (doc_lang in ('zh','en','de','nl','es')),
  page       int,
  snippet    text,
  score      real,
  idx        int not null,
  created_at timestamptz not null default now()
);
create index citations_msg_idx on citations (message_id);

-- ── 7. 坐席（人。不要与 LLM 的 "Agent" 混用） ────────────
create table staff (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text unique not null,
  role       text not null default 'agent' check (role in ('agent','lead','admin')),
  active     boolean not null default true,
  -- 09#03 / D8：真登录。scrypt（Node 内置，不引依赖）派生，盐每账号独立 16 字节。
  -- 两列可空是刻意的：`active` 的存量坐席与"还没发口令"的演示账号都允许为空，
  -- 登录时按"该账号不可登录"处理（统一 401，不区分"没设口令"与"口令错"）。
  password_hash text,
  password_salt text,
  -- 09#03 / D9：单层组织，不做多级树。SLA 仍按工单 due_at，不随组织变
  org_unit   text,
  created_at timestamptz not null default now()
);

-- 服务端会话（09#03 / D8）：Redis 存热会话，这张表只做可审计的登录记录与吊销。
-- 存的是 ticket 的 sha256，不存明文 —— 库被读走也无法伪造会话。
create table staff_sessions (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references staff(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index staff_sessions_staff_idx on staff_sessions (staff_id);
create index staff_sessions_expiry_idx on staff_sessions (expires_at);

-- 组织架构（09#03 / D9）：单层。`staff.org_unit` 不加外键，理由同 product_lines：
-- 人员录入先于组织建档是常态，加外键会把"先建人还是先建部门"变成硬约束。
create table org_units (
  code       text primary key,
  name       text not null,
  created_at timestamptz not null default now()
);

-- ── 8. 工单 ──────────────────────────────────────────────
-- 序列而非 max()+1：并发建单不撞号；号段跨年不重置，由 YYYY 前缀区分年度
create sequence ticket_seq;

create or replace function gen_ticket_no() returns text as $$
  select 'WT-' || to_char(now(),'YYYY') || '-' ||
         lpad(nextval('ticket_seq')::text, 4, '0');
$$ language sql;

create table tickets (
  id         bigserial primary key,
  no         text unique not null default gen_ticket_no(),
  conv_id    uuid references conversations(id) on delete set null,
  message_id bigint,
  reason     text not null
             check (reason in ('no_citation','out_of_scope','low_conf','user_request')),
  question   text not null,
  requester  text,
  priority   text not null default 'normal'
             check (priority in ('low','normal','high','urgent')),
  status     text not null default 'open'
             check (status in ('open','claimed','escalated','closed')),
  assignee   uuid references staff(id) on delete set null,
  tags       text[] not null default '{}',
  due_at     timestamptz,
  resolution text,
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);
create index tickets_status_idx   on tickets (status, due_at);
create index tickets_reason_idx   on tickets (reason);
create index tickets_assignee_idx on tickets (assignee);

-- closed 不可逆：closed 行上任何 UPDATE 都 raise。
-- 比 04-db.md 的 closed→非 closed 版本更严 —— 否则"闭单后补写 resolution / tags"
-- 仍然能改内容，只是改不了状态，绕过接口照样篡改历史。
-- 需要补充信息时新开一张关联工单，不是回写旧单。
create or replace function guard_ticket_status() returns trigger as $$
begin
  if old.status = 'closed' then
    raise exception 'closed ticket is immutable (ticket no=%)', old.no;
  end if;
  if new.status = 'closed' and old.status <> 'closed' then
    new.closed_at := now();
  end if;
  return new;
end $$ language plpgsql;

create trigger trg_ticket_guard before update on tickets
  for each row execute function guard_ticket_status();

-- ── 9. 反馈 ──────────────────────────────────────────────
-- 只允许 -1 / 1：不做 5 星打分，避免正负样本之间出现无法归类的中间态
create table feedback (
  id         bigserial primary key,
  message_id bigint not null references messages(id) on delete cascade,
  score      smallint not null check (score in (-1, 1)),
  comment    text,
  created_at timestamptz not null default now()
);

-- ── 10. 知识草稿（A5 预留） ──────────────────────────────
create table kb_drafts (
  id         bigserial primary key,
  question   text not null,
  answer     text not null,
  lang       char(2) not null check (lang in ('zh','en','de','nl','es')),
  source     text not null default 'no_hit'
             check (source in ('no_hit','manual','ticket')),
  status     text not null default 'draft'
             check (status in ('draft','approved','rejected')),
  reviewer   uuid references staff(id) on delete set null,
  chunk_id   bigint references chunks(id) on delete set null,
  created_at timestamptz not null default now()
);
create index kb_drafts_status_idx on kb_drafts (status);

-- ── 11. 附件 ─────────────────────────────────────────────
create table attachments (
  id         bigserial primary key,
  message_id bigint not null references messages(id) on delete cascade,
  bucket     text not null,
  object_key text not null,
  mime       text,
  size_bytes int,
  created_at timestamptz not null default now()
);

-- ── 12. 评测集 ───────────────────────────────────────────
create table qa_gold (
  id            bigserial primary key,
  lang          char(2) not null check (lang in ('zh','en','de','nl','es')),
  question      text not null,
  expect_doc_id uuid references documents(id) on delete set null,
  expect_doc    text,
  should_refuse boolean not null default false,
  note          text,
  created_at    timestamptz not null default now()
);

-- ── 13. 评测结果 ─────────────────────────────────────────
create table eval_runs (
  id          uuid primary key default gen_random_uuid(),
  total       int, hit int, cite_ok int, refuse_ok int,
  hit_rate    numeric(5,4), cite_rate numeric(5,4), refuse_rate numeric(5,4),
  detail      jsonb,
  created_at  timestamptz not null default now()
);

-- ── 14. AI 运行轨迹（注意：这里指 LLM 每次运行，不是坐席） ──
create table ai_runs (
  id            bigserial primary key,
  conv_id       uuid references conversations(id) on delete cascade,
  message_id    bigint,
  model         text,
  intent        text,
  tool_calls    jsonb not null default '[]',
  input_tokens  int,
  output_tokens int,
  cost_usd      numeric(10,6),
  latency_ms    int,
  refused       boolean not null default false,
  created_at    timestamptz not null default now()
);
create index ai_runs_conv_idx on ai_runs (conv_id);

-- ── 15. SOP Skills（P1 预留） ────────────────────────────
create table skills (
  name        text primary key,
  description text not null,
  object_key  text not null,
  enabled     boolean not null default true,
  updated_by  uuid references staff(id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- ── 16. 运行参数 ─────────────────────────────────────────
-- 运行时覆盖层：默认值只在 src/config.ts 常量与环境变量，本表没有的键就回落到代码值。
-- 除这两个来源之外不允许出现第三份值（04-db.md §3 唯一口径）
create table settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references staff(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ── 17. 审计 ─────────────────────────────────────────────
create table audit_log (
  id         bigserial primary key,
  actor      text,
  action     text not null,
  target     text,
  payload    jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on audit_log (created_at desc);

-- ── 18. 导出件（A7 预留） ────────────────────────────────
create table exports (
  id         bigserial primary key,
  conv_id    uuid references conversations(id) on delete set null,
  object_key text not null,
  size_bytes int,
  created_by uuid references staff(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ── 19. 故障码反馈（`09#04` / D16 / D26 / R26） ──────────
-- 反馈回路的第一环：用户在故障码页查了一个**不存在的码**。捕获点只有一处
-- （`src/api/fault.ts` 的 `found:false` 分支），写入在响应之后异步发生，不阻塞出卡。
--
-- **只收码级反馈（D26）**：一条记录说的是"有人在 `(code, product_line)` 上扑空了"，
-- 不是"用户描述了一个故障"（"我的机器嗡嗡响"）。后者要对话/工单抽取，是第二条模型路径，
-- 明确排 backlog —— 表结构也就刻意不带任何"故障描述"字段，免得将来被拿来当那个用。
--
-- **`quote` 只存短摘录，200 字硬上限**（PII 口径，`docs/output/boundary-change-R2.md` §5）：
-- 这一列是给坐席"一眼看出上下文"的，不是问题原文的备份。上限写在**库的 check 里**，
-- 因为"应用层记得截断"这种约定在第一个不经过应用层的写入方出现时就会破。
--
-- **去重口径：同一 `(code, product_line)` 24 小时内只留一条**（`src/core/admin-store.ts`
-- 的 `recordFaultReport` 用 `insert ... where not exists` 实现，不建唯一索引 —— 窗口条件
-- 进不了唯一索引）。选择"存在就不插"而不是"计数 +1"的理由：本表的用途是**待审清单**
-- （坐席要一条一条处置），不是用量统计。同一个错码一天被查 50 次，坐席要做的动作还是
-- 那一件；而一个 `hits` 计数器会诱使人把它当成热度榜，然后发现它既没有分母也没有样本量。
-- 换言之：**重复反馈被折叠成一行，而不是被累加成一列**。要看"这个码被查了多少次"是另一张
-- 事件表的事（不在本卡）。
--
-- `source` 现在只会是 `page`（对话快路的 miss 按本卡范围不接），另两个取值先留在约束里：
-- 加值时不用改 DDL，也就不会有人为了加一个取值去动这张表的 check。
create table fault_reports (
  id           bigserial primary key,
  code         text not null,
  product_line text not null,
  source       text not null default 'page'
               check (source in ('page','chat','ticket')),
  lang         char(2) not null check (lang in ('zh','en','de','nl','es')),
  -- 短摘录（可为空）：只够坐席看懂"当时问的是什么"，不是问题原文的备份。
  quote        text check (quote is null or char_length(quote) <= 200),
  conv_id      uuid references conversations(id) on delete set null,
  ticket_id    bigint references tickets(id) on delete set null,
  -- 处置态：`new`（待审）→ `merged`（已并进总故障卡）/ `rejected`（忽略）。
  -- 处置后从默认列表消失，但**行永远在**：合并率这个指标要读它（R26），删行等于把分母删了。
  status       text not null default 'new'
               check (status in ('new','merged','rejected')),
  created_at   timestamptz not null default now()
);
create index fault_reports_status_idx on fault_reports (status, created_at desc);
-- 去重检查（`code + product_line + 24h`）走的索引：不带 status，因为窗口去重不看处置态。
create index fault_reports_dedup_idx  on fault_reports (code, product_line, created_at desc);

-- ── 20. 文档索引版本（`09#05` 知识库 CRUD 与重建索引） ────
-- 管理端能改一篇文档的正文并重建索引，于是必须能回答"上一版索引长什么样"。
-- 回滚**不是**再切一次块：切块与 embedding 的结果必须能原样装回去，否则回滚之后库里那份向量
-- 与重建时生成的不是同一批（同一条文本在两次调用里得到的向量不保证逐位相同），
-- "回滚"就变成了"用同一份正文再猜一次"。
--
-- 为什么快照落在库里而不是对象存储：这是索引（每块一行 1024 维向量），不是用户文件；
-- 放外部存储会让"回滚"变成一次跨系统事务，而它必须在**一个**数据库事务里完成。
--
-- 为什么 `documents.body` 也进库（见第 1 节）：正文是唯一真源，重建只依赖它 + lang。
-- 这里再存一份 title/pages/chunk_count，是为了回滚时能连元数据一起还原。
create table document_versions (
  doc_id      uuid not null references documents(id) on delete cascade,
  version     int  not null,
  lang        char(2) not null check (lang in ('zh','en','de','nl','es')),
  title       text not null,
  pages       int,
  chunk_count int  not null,
  created_at  timestamptz not null default now(),
  primary key (doc_id, version)
);

-- 一版索引的全部块。列与 `chunks` 一一对应（除了 id），因为回滚就是
-- `insert into chunks (...) select ... from document_version_chunks`。
create table document_version_chunks (
  doc_id    uuid not null,
  version   int  not null,
  seq       int  not null,
  lang      char(2) not null check (lang in ('zh','en','de','nl','es')),
  section   text,
  content   text not null,
  page      int,
  token_len int,
  embedding vector(1024),
  primary key (doc_id, version, seq),
  foreign key (doc_id, version) references document_versions (doc_id, version) on delete cascade
);

-- 重建任务（异步）：`POST /api/admin/documents/:id/rebuild` 落一行 running 就返回 202，
-- 前端拿这个 id 轮询 `GET .../rebuild`。为什么单独一张表而不是 documents 上的几个列：
-- 几列只留得住"最后一次"，而"这次重建"与"上一次"必须能区分 —— 失败后重试时，
-- 前端要能看见失败的是哪一次、错在哪个阶段。
create table document_rebuild_jobs (
  id          uuid primary key default gen_random_uuid(),
  doc_id      uuid not null references documents(id) on delete cascade,
  status      text not null default 'running'
              check (status in ('running','succeeded','failed')),
  -- 失败原因（`documents.err` 的同一套取值：no_text_layer / empty_after_clean / embed_* / db_failed ...）
  error       text,
  chunk_count int,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index document_rebuild_jobs_doc_idx on document_rebuild_jobs (doc_id, started_at desc);

-- ── 视图：未命中池 ───────────────────────────────────────
-- 只读聚合，不写入；给坐席端看"哪些问题反复没答案、是否已有草稿"
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

-- ── 健康检查用的最小视图（/healthz 不查业务表） ──────────
-- 存在的意义：探活只证明"能连库、能找到这个视图"，不暴露任何业务数据与表结构
create view v_health as select 1 as ok;
