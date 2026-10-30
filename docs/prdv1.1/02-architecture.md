# 02 · 架构与目标文件树

## 1. 进程模型

**单进程 Node，不做微服务。** 一个 Fastify 实例承担 HTTP + SSE + Agent，Pi SDK 同进程内嵌。

```
┌─────────────────────────────────────────────────────────┐
│ Node 22 进程                                             │
│                                                          │
│  Fastify 5  :8000                                        │
│   ├─ /               静态：index.html + user.js          │
│   ├─ /console        静态：console.html + console.js     │
│   ├─ /api/*          业务 API（SSE 流式）                 │
│   ├─ /internal/*     仅 127.0.0.1，供 Pi 工具回调          │
│   └─ /healthz        四项探活                             │
│                                                          │
│  Pi SDK（in-process）                                    │
│   └─ AgentSession Map: conv_id → session（上限 5）        │
└───────┬──────────────┬──────────────┬───────────────────┘
        ▼              ▼              ▼
   PostgreSQL       Redis          MinIO
   :5432            :6379          :9000
   数据/向量         租约/限流/缓存   原件/导出
```

### 1.1 端口

| 服务 | 容器内 | 宿主 | 归属 |
|---|---|---|---|
| api | 8000 | 8000 | 应用层（根 `docker-compose.app.yml`） |
| postgres | 5432 | 5432 | **数据层（`data/`）** |
| redis | 6379 | 6379 | **数据层（`data/`）** |
| minio | 9000 / 9001 | 9000 / 9001 | **数据层（`data/`）** |

> 三个数据服务**不归本项目 compose 管**。它们由 `data/docker-compose.yml` 启动（project `wt-infra`），连接参数由 `./data/scripts/db.sh env` 输出。详见 `13-ops.md` §2。
> 关键事实：PostgreSQL 镜像是 `pgvector/pgvector:pg16`（必须）、Redis **有密码**、MinIO bucket 是 `wt-dev`。

### 1.2 一次提问的数据流

```
1. 浏览器 POST /api/chat  {conv_id?, text, lang}
2. 中间件：校验 X-User-Session → 限流 → 取/建 conversation
3. 路由 chat.ts：
   a. 若 text 匹配 ^[A-Za-z]\d{2,3}$ → 走故障码快路（不经模型）
   b. 取 session（池内复用，无则 createAgentSession）
   c. session.subscribe(...) → 转 SSE
   d. session.prompt(text) 或 steer(text)
4. 模型决定调用 kb_search
5. support.ts 的 tool 实现 → POST /internal/search
6. retrieval.ts：向量 top20 + 全文 top20 → RRF → top5
7. 返回带 idx 的 chunks → 模型生成带 [n] 的答案
8. tool_result hook → citations 落库
9. 后端校验：无引用或含 NO_ANSWER → 拒答替换 + 建单
10. SSE done
```

---

## 2. 目标仓库文件树（**开发必须严格按此创建**）

```
wt-agent/
├── docker-compose.app.yml      # 应用层编排，见 13-ops.md §3.2（数据层 compose 在 data/，不要动）
├── Dockerfile                  # node:22-alpine，仅用于 compose 的 api 服务
├── .env.example                # 见 13-ops.md（完整内容）
├── .dockerignore
├── .gitignore                  # 忽略 .env / node_modules / docs/output 产物
├── Makefile                    # up / down / reset / demo / eval / logs
├── package.json                # 见 03-tech-stack.md（完整内容）
├── tsconfig.json               # strict, ES2022, module: nodenext
├── README.md                   # 复现步骤 + 已知限制
│
├── sql/
│   ├── 001_init.sql            # 见 04-db.md（完整内容）
│   └── 002_seed.sql            # 坐席、settings 默认值、故障码示例
│
├── src/
│   ├── server.ts               # Fastify 装配、插件、静态托管、优雅退出
│   ├── config.ts               # 全部常量 + env 读取 + 启动时校验（缺项直接退出）
│   ├── db.ts                   # pg Pool、query<T>() 泛型封装、事务辅助
│   ├── redis.ts                # ioredis 客户端、滑动窗口限流、会话租约
│   ├── storage.ts              # MinIO 客户端、putObject/getObject/presignedUrl
│   ├── logger.ts               # pino，脱敏（邮箱打码、不记消息原文）
│   ├── errors.ts               # AppError 类 + ERROR_CODES 常量（见 05-api.md §6）
│   ├── auth.ts                 # 签发/校验用户 token；校验 admin token
│   │
│   ├── api/
│   │   ├── routes.ts           # 统一注册所有路由（唯一 import 点）
│   │   ├── session.ts          # POST /api/session
│   │   ├── chat.ts             # POST /api/chat（SSE，核心）
│   │   ├── fault.ts            # GET /api/fault/:code
│   │   ├── ticket.ts           # POST /api/ticket、GET /api/ticket/:no
│   │   ├── feedback.ts         # POST /api/feedback
│   │   ├── i18n.ts             # GET /api/i18n/:lang
│   │   ├── console.ts          # /api/console/tickets*（列表/详情/补丁）
│   │   └── internal.ts         # /internal/*（供 agent 工具回调）
│   │
│   ├── core/
│   │   ├── retrieval.ts        # 混合检索 + RRF（见 07-retrieval.md）
│   │   ├── embed.ts            # embedding 客户端：DashScope text-embedding-v3 + 超时降级（见 08 §5）
│   │   ├── hash-embed.ts       # FNV-1a 兜底向量（EMBED_BACKEND=hash，见 08 §5.3）
│   │   ├── ingest.ts           # PDF/TXT → chunk → embed → pg（见 08-ingestion.md）
│   │   ├── agent.ts            # createAgentSession 装配 + 会话池 + 事件桥
│   │   ├── refusal.ts          # 拒答判定 + 五语话术常量（见 06-agent.md §5）
│   │   ├── citations.ts        # 引用落库 + 合法性校验
│   │   └── ticket.ts           # 建单、关单、SLA 计算
│   │
│   ├── ext/
│   │   └── support.ts          # Pi extension：4 个 tool + 2 个 hook
│   │
│   └── static/
│       ├── index.html          # 用户端 9:16（见 10-ui-user.md）
│       ├── console.html        # 坐席端 16:9（见 11-ui-console.md）
│       ├── app.css             # 设计令牌 + 组件样式（见 09-ui-tokens.md）
│       ├── user.js             # 用户端逻辑（SSE 消费、抽屉、故障码）
│       ├── console.js          # 坐席端逻辑（队列轮询、详情、采纳）
│       └── i18n.json           # 127 key × 5 语（见 12-i18n.md）
│
├── scripts/
│   ├── ingest.ts               # CLI：批量导入 corpus/ 下所有文件
│   ├── eval.ts                 # CLI：跑 30 题评测，输出 markdown 报告
│   ├── demo.ts                 # CLI：灌演示数据（语料 + 工单 + 评测集）
│   ├── mock-embed.ts           # CLI：调 core/hash-embed.ts 打印向量（自检用）
│   ├── check-corpus.ts         # CLI：语料质量自检（片段数/空向量/超长块/空块/文档状态/语种纯度/故障码，见 08 §10.1）
│   ├── check-terms.ts          # CLI：术语表对齐 + de/nl/es 无残中文（见 08 §10.2）
│   ├── check-i18n.ts           # CLI：五语 key 集合 / 占位符 / 长度校验（见 12 §6.1）
│   ├── perf-fault.ts           # CLI：故障码快路延迟压测（npm run perf:fault）
│   └── verify.sh               # 提交前 L1–L5 断言脚本（见 14-verification.md §2）
│
├── corpus/                     # 语料与评测夹具（**不属于 data/ 数据层**；清单见 08 §9）
│   ├── warranty.zh.md
│   ├── warranty.en.md
│   ├── warranty.de.md
│   ├── warranty.nl.md
│   ├── warranty.es.md
│   ├── install.zh.md
│   ├── install.en.md
│   ├── install.de.md
│   ├── install.nl.md
│   ├── install.es.md
│   ├── spec.zh.md              # 产品参数只有 zh/en/de 三语，不设 nl/es（16 §6 的 L3）
│   ├── spec.en.md
│   ├── spec.de.md
│   ├── fault_codes.json        # 结构化语料 → fault_codes 表，不进 documents/chunks（08 §9.1）
│   ├── .fixtures/              # 测试夹具（`.` 开头 → 入库与术语检查都跳过）
│   └── qa_gold.json            # 30 题评测集（见 14 §4）
│
├── data/                       # 数据层（已存在，**不归本文件树管**；见 13-ops.md §2）
│
└── docs/                       # 文档目录，不参与构建
```

### 2.1 文件职责硬约束

| 约束 | 说明 |
|---|---|
| `config.ts` 是唯一读 `process.env` 的地方 | 其他文件只能 `import { config }` |
| `routes.ts` 是唯一注册路由的地方 | `server.ts` 不直接 import 具体路由文件 |
| `db.ts` 是唯一创建 PG Pool 的地方 | 业务代码不得 new Pool |
| `errors.ts` 的 `ERROR_CODES` 是唯一错误码来源 | 不得散落字符串 |
| `static/` 内只允许本地 `.js` 相互 `import`，禁止任何 npm 依赖与构建步骤 | 纯静态，浏览器原生 ES module 直接跑；同目录本地 import 是为了把事件流分帧、角标替换、语言回落抽成可断言的纯逻辑模块 |
| `ext/support.ts` 不得 import `src/core/*` | 工具只通过 HTTP 调 `/internal/*`（避免循环依赖） |

---

## 3. 模块依赖方向（禁止反向）

```
server.ts
  ↓
api/*  ──→ core/*  ──→ db.ts / redis.ts / storage.ts
  ↓            ↓
errors.ts   config.ts
  ↓
logger.ts

ext/support.ts ──HTTP──→ api/internal.ts
```

**禁止**：`core/*` 反向 import `api/*`；`db.ts` import `core/*`；`ext/*` import `src/*`。

---

## 4. 会话池设计

| 项 | 规格 |
|---|---|
| 数据结构 | `Map<conv_id, {session, lastActive}>` |
| 上限 | `config.PARALLEL_LIMIT`（默认 5） |
| 获取 | `getSession(convId)`：命中且未过期则复用，续租约；否则新建 |
| 过期 | 10 分钟无活动 → `session.dispose()` + delete |
| 租约 | Redis `conv:{id}:lease` TTL 600s，用于跨请求存活判断 |
| 回收 | 每 60s 扫描一次，回收超期与 RSS 超限时最旧的 |
| 并发满 | 返回 `SESSION_BUSY`（503），前端显示排队 |

### 4.1 session 创建参数（唯一正确写法）

```ts
// src/core/agent.ts
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { supportExtension } from "../ext/support.ts";
import { config } from "../config.ts";
import { AppError } from "../errors.ts";

// 进程级单例：只 create 一次
let runtimePromise: Promise<ModelRuntime> | null = null;
function getModelRuntime(): Promise<ModelRuntime> {
  runtimePromise ??= (async () => {
    const rt = await ModelRuntime.create();          // 默认读 ~/.pi/agent 的 auth.json / models-store.json
    await rt.setRuntimeApiKey(config.MODEL_PROVIDER, config.DEEPSEEK_API_KEY);  // 容器内靠这一行拿凭据
    return rt;
  })();
  return runtimePromise;
}

export async function createSupportSession() {
  const modelRuntime = await getModelRuntime();
  const model = modelRuntime.getModel(config.MODEL_PROVIDER, config.MODEL_ID);
  if (!model) {
    throw new AppError("LLM_UNAVAILABLE", `model not found: ${config.MODEL_PROVIDER}/${config.MODEL_ID}`);
  }

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => config.SUPPORT_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    extensionFactories: [supportExtension],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    modelRuntime,
    model,                            // ← 传 Model 对象，**不是** "deepseek-flash" 字符串
    thinkingLevel: "off",             // ← 关思考（deepseek-flash 默认开），否则首字必超 3s
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    tools: ["kb_search", "fault_code_lookup", "ticket_create", "ticket_lookup"],
  });
  return session;
}
```

五条不可违反（前三条依据官方 SDK 文档，后两条由 1.4.0 的 `.d.ts` 实测）：
1. 自定义工具**只能**经 extension 的 `pi.registerTool()` 注册，`tools:[]` 只做选择
2. **必须** `systemPromptOverride` + `appendSystemPromptOverride: () => []`
3. `SessionManager` 是上下文权威，**禁止**给 `session.agent.state.messages` 赋值
4. `model` 的类型是 `Model<any>`（`core/sdk.d.ts:19`）。传字符串过不了 `tsc --noEmit`，必须走 `modelRuntime.getModel(provider, id)`
5. **必须** `thinkingLevel: "off"`。`deepseek-flash` 默认开思考模式，首字延迟会破 `01-scope.md` §2 的 P95 < 3s

---

## 5. 静态资源与路由约定

| 路径 | 行为 |
|---|---|
| `GET /` | 返回 `static/index.html` |
| `GET /console` | 返回 `static/console.html` |
| `GET /assets/*` | `static/` 下其余文件 |
| `GET /healthz` | 四项探活 JSON |
| 其他 404 | JSON `{ok:false,error:{code:"NOT_FOUND"}}` |

**不做 SPA 路由**。坐席端详情用 `#/ticket/{id}` 哈希，前端自己解析。

---

## 6. 错误处理约定

- 所有路由 `try/catch` → `throw new AppError(code, message)` 
- 全局 errorHandler 转成统一响应体，附 `trace_id`
- 未捕获异常：记 error 日志 + 返回 `INTERNAL`，**不泄露堆栈**
- SSE 路由：错误必须以 `event: error` 发出后关闭，不能直接断连

---

## 7. 启动顺序（server.ts 必须遵守）

```
1. 加载并校验 config（缺关键项直接 process.exit(1)）
2. 连接 PG → SELECT 1 探活
3. 连接 Redis → PING
4. 连接 MinIO → bucketExists / makeBucket
5. 注册插件与路由
6. listen(8000)
7. 注册 SIGTERM/SIGINT：先停止接受新请求，再 dispose 所有 session，再关连接池
```

任一步失败：打印明确错误 + 退出码 1。**不允许带病启动**。

---

## 8. 安全边界

| 边界 | 规则 |
|---|---|
| `/internal/*` | 只允许 `127.0.0.1` 访问 + 校验 `X-Internal-Token` |
| `/api/console/*` | 校验 `X-Admin-Token` |
| `/api/*` 其余 | 校验 `X-User-Session` |
| `GET /healthz` | 公开，但不返回敏感信息（只返回 ok/error 布尔） |
| 静态资源 | 公开 |

---

## 9. 环境隔离

只有一套环境（本地 compose + 演示机）。**不做 dev/staging/prod 区分**，用 `.env` 切换。
