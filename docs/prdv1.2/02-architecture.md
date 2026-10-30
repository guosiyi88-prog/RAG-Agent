# 02 · 架构（as-built）

> 本章描述**代码真实的形状**：一个 Node 进程 + 三个数据服务，没有构建链、没有中间件目录、
> 没有 ORM。所有"必须/禁止"都来自代码里已经生效的约束，不是建议。

---

## 1. 运行形态

```
浏览器 ──HTTP/SSE──┐
                   │
            ┌──────▼──────────────────────────────┐
            │  node src/server.ts  (单进程)        │
            │  Fastify 5 · 无构建 · 直接跑 .ts     │
            └──┬───────────┬───────────┬──────────┘
               │           │           │
        ┌──────▼──┐  ┌─────▼────┐  ┌───▼──────┐
        │Postgres │  │  Redis   │  │  MinIO   │
        │16+pgvec │  │  7(密码)  │  │ bucket   │
        └─────────┘  └──────────┘  └──────────┘
```

| 项 | 事实 | 证据 |
|---|---|---|
| 进程数 | **1 个 Node 进程**（无 worker、无集群） | `src/server.ts:157` |
| 端口 | `PORT`（默认 8000），`host: 0.0.0.0` | `src/server.ts:114`、`src/config.ts:54` |
| 构建 | 无。Node 22 的类型剥离直接跑 `.ts` | `package.json`（无 build 脚本）、`Dockerfile` |
| 前端 | 无构建链：原生 ES module 从 `/assets/*` 直接加载 | `src/api/assets.ts:174` |
| 数据服务 | 独立 compose project `wt-infra`（`data/`），应用层**不合并**进去 | `data/docker-compose.yml`、`docker-compose.app.yml` |
| 两种跑法 | ① 宿主直跑（开发/演示默认）② 容器（`make build`，接入 `wt-infra_default` 网络） | `Makefile:39`、`docker-compose.app.yml:41` |

**为什么单进程够**：并发上限只有 5 个会话（`PARALLEL_LIMIT`），演示与单机内网场景下多进程只会带来
"会话池各算各的"和"限流额度 ×N"两个假象（`src/api/session.ts:8`）。

---

## 2. 分层与依赖方向

```
api/  ──►  core/  ──►  db.ts / redis.ts / storage.ts
  │          ▲
  └──────────┴── ext/support.ts 只 import core/retrieval.ts（kb_search 进程内），
                 其余三个工具经内部 HTTP 回主进程
server.ts ──► routes.ts ──► api/*.ts        （server.ts 不 import core）
```

四条硬规则（违反任一条都会在评审闸门被拦）：

| 规则 | 理由 | 证据 |
|---|---|---|
| `server.ts` **不 import `core/`** | 避免 `core/agent → routes → api/chat → core/agent` 成环 | `src/server.ts:16` 注释 |
| `ext/support.ts` **只 import `core/retrieval.ts`**（`kb_search` 必须进程内），其余三个工具走内部 HTTP；**不许** import `api/` 或 `core/agent.ts` | 直接 import `core/ticket-store` / `core/fault-codes` 会形成 `agent → ext → core → agent` 的环；HTTP 让工具与主进程只剩一份契约 | `src/ext/support.ts:36` |
| `api/` 不直接 `new Pool` / 不拼 Redis 客户端 | 连接唯一入口在 `db.ts` / `redis.ts`，否则超时与池上限各写一份 | `src/db.ts:5` |
| 错误码只从 `errors.ts` 取 | 路由里散落字符串会让错误码表与实现分叉 | `src/errors.ts:1` |

依赖注入不需要框架：模块间用直接 `import` + 少量注册函数回调（`onShutdown`、`markPiReady`）。

---

## 3. 完整文件树（64 个 `src` 文件）

```
src/
├── server.ts            进程入口：七步启动、错误处理器、404、优雅关闭
├── routes.ts            路由总装 + /healthz + pi 探针状态
├── config.ts            **唯一读 env 的地方**；系统提示词常量也在这里
├── errors.ts            错误码表（14 个）+ AppError + 对外信封
├── logger.ts            pino + 脱敏路径 + maskEmail
├── db.ts                唯一 Pool（max 10 / 3s 超时）+ query/one/tx
├── redis.ts             ioredis + 滑动窗口限流 + 会话租约
├── storage.ts           MinIO 客户端 + ensureBucket/put/get/presign
├── auth.ts              三档鉴权唯一口径 + sendNotFound
├── api/
│   ├── assets.ts        GET / 、GET /console、GET /assets/*（白名单 + 拒目录穿越）
│   ├── session.ts       POST /api/session（10 次/分钟/IP）
│   ├── chat.ts          POST /api/chat（SSE 编排、故障码快路、拒答四步）
│   ├── ticket.ts        POST /api/ticket、GET /api/ticket/:no
│   ├── fault.ts         GET /api/fault/:code（无令牌门禁）
│   ├── i18n.ts          GET /api/i18n/:lang
│   ├── console.ts       /api/console/*（队列/详情/补丁/统计 + 三个 501）
│   ├── internal.ts      POST /internal/search、GET /internal/retrieval/recall
│   ├── internal-fault.ts     GET|POST /internal/fault
│   ├── internal-ticket.ts    /internal/ticket、/internal/ticket/lookup、/internal/ticket/:no
│   └── internal-citations.ts POST /internal/citations
├── core/
│   ├── agent.ts         Pi 装配、会话池、事件桥、runTurn（675 行，最重）
│   ├── retrieval.ts     双路召回 + 语言过滤 + 融合 + 后处理（647 行）
│   ├── ingest.ts        入库流水线：解析→清洗→分块→嵌入→落库（645 行）
│   ├── ticket-queue.ts  坐席队列/详情/补丁/统计（614 行）
│   ├── terms.ts         术语一致性机检
│   ├── chunk.ts         分块规则与长度口径
│   ├── ticket-public.ts 公开建单/查单（幂等、配额、枚举防护）
│   ├── embed.ts         嵌入后端（dashscope / hash）与维度校验
│   ├── ticket-store.ts  内部建单/查单（工具用）
│   ├── fault-codes.ts   故障码主键查询（五语列 → 单语输出）
│   ├── refusal.ts       拒答判定（纯函数）+ 固定话术
│   ├── citations.ts     引用校验（纯函数）
│   ├── citation-store.ts 引用快照落库 + 回填计数
│   ├── i18n-table.ts    五语文案表读取 + 回落链（core 侧唯一读取点）
│   ├── clean.ts         文本清洗（去页眉页脚、合并断行）
│   ├── fuse.ts          RRF + 归一化
│   ├── run-log.ts       记账（ai_runs + conversations 累加，吞异常）
│   ├── fastpath.ts      故障码快路（判形 + 直答文本）
│   ├── hash-embed.ts    FNV-1a 兜底向量（无 Key 时可用）
│   ├── query.ts         多轮查询构建
│   └── citations/refusal 之外的判定都不做 I/O（便于单测）
├── ext/
│   └── support.ts       四个业务工具 + 白名单钩子 + 候选入缓冲（kb_search 进程内、其余三个经内部 HTTP）
└── static/
    ├── index.html       用户端 9:16 单页（四个 section：chat/fault/ticket/me）
    ├── app.css          用户端设计令牌与组件（174 行）
    ├── user.js          对话页控制器（状态机 + 发送 + 流式渲染）
    ├── views.js         故障码/工单/我的三视图
    ├── i18n.json        五语 127 key **唯一真源**
    ├── console.html     坐席端 1440×810 骨架（gate 令牌门 + 三栏）
    ├── console.css      坐席端样式
    ├── console.js       坐席端控制器（948 行：队列轮询、详情、键盘、动作）
    └── lib/
        ├── stream.js        SSE 分帧
        ├── cite.js          角标编号与替换
        ├── sheet.js         底部抽屉的数学（高度/位移/回弹）
        ├── cite-sheet.js    引用抽屉 DOM
        ├── lang.js          语言切换与 `<html lang>`
        ├── i18n-chrome.js   文案表失败时的离线兜底
        ├── i18n-de.js       德语文案的离线快照
        ├── fault-recent.js  最近查询（localStorage，去重+上限）
        ├── console-view.js      详情三栏 DOM（283 行）
        ├── console-sla.js       SLA 计算与倒计时文案
        ├── console-route.js     路由（#/tickets/:id）
        ├── console-draft.js     每单草稿（防抖落盘）
        ├── console-keys.js      键盘映射
        ├── console-resolution.js 关单结论阈值/计数
        └── console-time.js      时间格式化
```

`src/` 之外：

```
sql/001_init.sql     18 表 + 2 视图 + 触发器 + 索引（先 drop 后建，可重放）
sql/002_seed.sql     幂等 seed：2 坐席 / 10 settings / 3 故障码
scripts/             ingest / check-corpus / check-terms / check-i18n / eval / demo / verify.sh / preflight.sql
corpus/              五语语料 13 篇 + fault_codes.json；.fixtures/ 放评测集（ingest 跳过 `.` 开头）
data/                数据层 compose + db.sh（独立 project wt-infra）
tests/               37 个 node:test 文件
```

---

## 4. 启动七步（顺序不可调整）

`src/server.ts:88` 的 `start()`：

| # | 步骤 | 失败后果 |
|---|---|---|
| 1 | 配置校验（`config.ts` 在 import 期完成，缺必填项直接 `exit(1)`） | 进程退出，stderr 列出缺哪几项 |
| 2 | PostgreSQL 探活（`select 1`） | `[startup] PostgreSQL 探活 失败` → exit 1 |
| 3 | Redis `PING` | 同上 |
| 4 | MinIO `ensureBucket` | 同上 |
| 5 | 注册路由（`registerRoutes`） | 抛错 → exit 1 |
| 6 | `listen` | 端口占用 → exit 1 |
| 7 | 装 SIGTERM/SIGINT 处理器 | — |

**为什么先探活再 listen**：让"能接流量"等价于"依赖都在位"，而不是上线后被第一条请求发现
（`src/server.ts:84`）。

**优雅关闭**（`src/server.ts:122`）：`SIGTERM`/`SIGINT` → 停止收新请求（`app.close()` 等在途 SSE）
→ 跑 `onShutdown` 钩子（释放进程内会话）→ 关 Redis / Pool → `exit(0)`；超过 `gracefulShutdownMs`
（10s）强制 `exit(1)`。

---

## 5. 横切关注点（五个"唯一口径"）

| 关注点 | 唯一口径 | 体现 |
|---|---|---|
| 环境变量 | `config.ts` | 8 个必填项缺失即启动失败；模型 Key 缺失只降级（不退出） |
| 错误码 | `errors.ts` | 14 个码 + HTTP 状态内联；未捕获异常一律 `INTERNAL`，堆栈只进日志 |
| 日志 | `logger.ts` | 统一脱敏（token/email/requester/authorization…）；邮箱先打码再进日志 |
| 数据库访问 | `db.ts` | 唯一 Pool；`query`/`one`/`tx`；`statement_timeout=3s` |
| 鉴权 | `auth.ts` | 三档失败形状刻意不同；内部一律 404；令牌常数时间比较 |

---

## 6. 请求生命周期

```
请求 → genReqId（沿用 X-Trace-Id，否则随机 uuid）
     → 路由处理器（鉴权在第一行）
     → 正常：reply.send({ ok: true, data })
     → 异常：AppError → toErrorBody → { ok:false, error:{code,message,trace_id} }
             非 AppError → 500 INTERNAL（堆栈只进日志）
     → 未匹配路由：setNotFoundHandler → 404 NOT_FOUND（与内部接口失败逐字同形）
```

**SSE 的特殊约束**（`src/api/chat.ts:410`）：`reply.hijack()` 一旦调用，**HTTP 状态码就写不动了**。
因此凡是需要非 200 的失败（池满、模型不可用）都必须在 `hijack` **之前**决定；开流之后只剩 `error` 帧。
另外三个响应头是固定的：`content-type: text/event-stream`、`cache-control: no-cache, no-transform`、
`x-accel-buffering: no`（少一个就会被反代攒成一坨）。

---

## 7. 会话与并发模型

| 对象 | 位置 | 生命周期 | 证据 |
|---|---|---|---|
| 对话（`conversations`） | Postgres | 永久 | `sql/001_init.sql:90` |
| 匿名令牌（`sess:{uuid}`） | Redis | 7 天，无续期 | `src/api/session.ts:22` |
| 会话租约（`conv:{id}:lease`） | Redis | 600 秒 | `src/redis.ts:39` |
| AgentSession（上下文） | **进程内存 Map** | 闲置 10 分钟回收；进程重启即丢 | `src/core/agent.ts` |
| 检索候选缓冲（`TurnBuffer`） | 单轮请求内存 | 一轮结束即弃 | `src/api/chat.ts:580` |
| 限流窗口（`rl:session:{ip}`） | Redis ZSET | 60 秒滑窗 | `src/redis.ts:21` |

**并发上限的语义**：`PARALLEL_LIMIT=5` 限制的是**进程内同时活跃的 AgentSession 数**，不是 HTTP 连接数；
第 6 个会话拿到 `503 SESSION_BUSY`（前端显示"前面还有几位"）。同一会话在流式过程中再发一条不算池满，
它会在 `record.tail` 链上排队（`src/api/chat.ts:98`）。

---

## 8. 健康检查语义

`GET /healthz` 返回四项布尔，**四项全真才 200**，否则 503（`src/routes.ts:78`）：

| 项 | 探测方式 | 说明 |
|---|---|---|
| `pg` | `select 1` + `pg_extension` 里 `vector` 有版本号 | 一条查询同时证明连接与扩展 |
| `redis` | `PING` | 半死时靠 `healthCheckTimeoutMs=1000` 兜住，不让探活自己挂住 |
| `minio` | `bucketExists(bucket)` | 只证明认证与桶在，不写对象 |
| `pi` | 本进程是否**至少装配过一次 AgentSession** | 冷启动为 false；跑一轮真实对话后转 true。**不是故障** |

`pi` 的设计取舍：它不是"SDK 能不能加载"，而是"这个进程到底能不能答话"。所以宁可冷启动 503 一次，
也不让装不出会话的进程对外宣称健康。

---

## 9. 与 v1.1 的差异（本章）

| # | 差异 | 说明 |
|---|---|---|
| 1 | 依赖禁令被写成可执行的规则：`ext/support.ts` 只许 import `core/retrieval.ts`（`kb_search` 进程内），其余三个工具走内部 HTTP，且不许 import `api/` 或 `core/agent.ts` | v1.1 §3 只说"工具经内部 HTTP"，未写成依赖禁令；不写清就会有人为了省一跳直接 import `core/ticket-store`，把环引进来 |
| 2 | `config.ts` 兼放系统提示词常量 | v1.1 把提示词放在 06，实现把它钉在代码里（`config.ts:153`），因为"逐字照抄"只能靠常量 |
| 3 | 健康检查的四项语义被写实 | v1.1 §7 只说四项；"pi = 装配过至少一次会话"是实现层的定义 |
| 4 | 优雅关闭 10s 上限 | v1.1 未规定，`05-api`/`07` 都没写；实现取 `gracefulShutdownMs=10000` |
| 5 | 文件树多出 `lib/console-*.js` 六个纯逻辑模块 | v1.1 只要求坐席端"队列+详情"；为实现键盘连续处理与草稿隔离而拆分 |
