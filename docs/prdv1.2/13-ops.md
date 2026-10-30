# 13 · 运维契约（as-built）

> 本章只写**运行期事实**：env 的唯一口径、数据层归属、日志与探活、备份、runbook。
> 面向人的操作手册在根 `README.md` §6（启动/停止/排障/备份的逐条命令），本章不重复命令细节。

---

## 1. 环境变量：唯一读取点 `src/config.ts`

### 1.1 必填（缺失即 `exit(1)`，stderr 列出缺哪几项）

| 变量 | 用途 | 来源 |
|---|---|---|
| `INTERNAL_TOKEN` | 内部接口令牌 | 人工填 |
| `DATABASE_URL` | PG 连接串 | `./data/scripts/db.sh env` 派生 |
| `REDIS_URL` | Redis 连接串（**必须带密码** `:pwd@`） | 同上 |
| `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` | MinIO | 同上 |

> `ADMIN_TOKEN` **已退场**（`09#03` / `docs/output/boundary-change-R2.md` §3 B5）：坐席端改服务端会话
> （`POST /api/auth/login` 签发 `x-staff-session` 票据），不再有共享静态令牌。`.env` 里留着那一行
> **无害也无用**（没人读它），新部署不必写。缺它不再挡启动 —— `tests/healthz.test.ts` 有一条断言守着。
> 密钥**一律不给默认值**：默认值会让"忘了配"在演示现场变成静默失败，而不是启动失败（`config.ts:6`）。

### 1.2 可选（有默认值，默认值与 `.env.example` 一致）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8000` | 监听端口（`host: 0.0.0.0`） |
| `NODE_ENV` | `development` | `production` 时日志级别升到 `info` |
| `S3_REGION` | `us-east-1` | 可缺省（**不在必填表里**） |
| `DEEPSEEK_API_KEY` | — | 缺失不退出；模型调用失败 → `LLM_UNAVAILABLE` |
| `DASHSCOPE_API_KEY` | — | 缺失不退出；嵌入回落 hash（质量断崖） |
| `LLM_PROVIDER` | `deepseek` | `mock` = 不调模型（检索+摘句） |
| `MODEL_ID` | `deepseek-flash` | — |
| `MODEL_PROVIDER` | `deepseek` | 与 `MODEL_ID` **两段一起**解析模型 |
| `THINKING_LEVEL` | `off` | 默认关；开到 `medium` 会破首字预算 |
| `EMBED_BACKEND` | `dashscope` | `hash` 仅用于无 Key/离线 |
| `EMBED_DIM` | `1024` | 与 DDL 的 `vector(1024)` 必须一致 |
| `RETRIEVAL_TOP_K` | `5` | 最终片段数 |
| `RETRIEVAL_MIN_SCORE` | `0.30` | 拒答阈值（与归一化分比） |
| `RETRIEVAL_VEC_WEIGHT` / `RETRIEVAL_FTS_WEIGHT` | `0.8` / `0.2` | RRF 权重（改了分母自动跟着算） |
| `RRF_K` | `60` | RRF 平滑常数 |
| `PARALLEL_LIMIT` | `5` | 进程内 AgentSession 上限 |
| `SESSION_IDLE_MS` | `600000`（10 分钟） | 闲置回收 |
| `SESSION_TTL_HOURS` | `12` | **坐席会话票据**有效期（Redis `staff_session:*` 的 TTL，`core/auth-login.ts`）。改它只影响新签发的票据 |
| `CHAT_TIMEOUT_MS` | `30000` | 单轮总超时 |
| `SAFE_MODE` | `false` | 保留位 |
| `PI_TELEMETRY` | 强制 `"0"` | 缺失时在 import 期钉死，避免容器里回落到用户家目录配置 |

**写死的两个常量**（不是 env）：`healthCheckTimeoutMs = 1000`、`gracefulShutdownMs = 10000`。

### 1.3 `.env` 怎么来（不要手写连接串）

```bash
cp .env.example .env
./data/scripts/db.sh env | grep -oE '(DATABASE_URL|REDIS_URL|S3_[A-Z_]+)=[^[:space:]]+' >> .env
grep -E '^(POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB|REDIS_PASSWORD)=' data/.env >> .env
```

`db.sh env` 的输出是带缩进的表格，只能 `grep -oE` 抽片段；`.env` 与 `data/.env` 都被 `.gitignore` 忽略。

---

## 2. 数据层归属（`data/`，独立 project `wt-infra`）

| 服务 | 容器 | 镜像 | 端口 | 备注 |
|---|---|---|---|---|
| PostgreSQL | `wt-postgres` | **`pgvector/pgvector:pg16`** | 5432 | 库 `wt_dev`；`postgres:16-alpine` 没有 vector 扩展 |
| Redis | `wt-redis` | `redis:7-alpine` | 6379 | **有密码**（`--requirepass`），AOF everysec |
| MinIO | `wt-minio` | `minio/minio:latest` | 9000/9001 | bucket `wt-dev` |
| mc | `wt-infra-minio-init-1`（一次性） | `minio/mc:latest` | — | 建桶 + 连通性探测；跑完退出是正常的 |

卷：`wt-infra_pgdata` / `wt-infra_redisdata` / `wt-infra_miniodata`。
`db.sh down` 保留卷；`db.sh destroy`（交互输入 `yes`）连卷删除。

**应用层不合并进数据层 compose**：`docker-compose.app.yml` 用 `external: true` 接入 `wt-infra_default` 网络。

---

## 3. 日志

| 项 | 事实 |
|---|---|
| 实现 | pino（`logger.ts`），全进程一个实例，request log 与业务 log 同一管道 |
| 级别 | `development` → `debug`；`production` → `info` |
| 脱敏 | `password` / `token` / `apiKey` / `authorization` / `x-staff-session` / `x-internal-token` / `email` / `requester`（含 `*.` 嵌套路径），替换为 `[redacted]` |
| 邮箱 | 进日志前先 `maskEmail`：`installer@example.com` → `i***@e***.com` |
| 堆栈 | **只在日志里**，响应体永远没有 |
| trace id | 沿用前端 `X-Trace-Id`（非空字符串即用），否则本地 uuid；日志与响应体共用同一个 |
| 关键可观测点 | 快路 `{ code, ms }`、拒答 `{ reason, marks, illegal, ticketNo, ms }`、装配 `{ conv_model, thinking }`、池回收 `reaping idle agent session` |

---

## 4. 探活

`GET /healthz` → 四项布尔 + `version`；**四项全真才 200**，否则 503。

| 项 | 探测 | 常见 false 原因 |
|---|---|---|
| `pg` | `select 1` + `pg_extension` 有 `vector` 版本 | 数据层没起 / 镜像不是 pgvector |
| `redis` | `PING` | 密码错 / 容器没起 |
| `minio` | `bucketExists` | 桶被删 / 认证错 |
| `pi` | 本进程至少装配过一次 AgentSession | 冷启动（问一句话即转真）/ 模型解析失败 |

探活自带 1s 超时：依赖半死时探活不能自己挂住。

---

## 5. 容量与并发

| 资源 | 上限 | 超限表现 |
|---|---|---|
| AgentSession | `PARALLEL_LIMIT=5`（含"装配中"） | `503 SESSION_BUSY`（前端"前面还有几位"） |
| PG 连接池 | 10；`connectionTimeoutMillis` / `statement_timeout` 均 3s | 慢查询被取消 → 检索降级 `empty` → 拒答 |
| 会话签发 | 10 次/分钟/IP | `429 RATE_LIMITED` |
| 建单 | 3 张/小时/令牌 | `429 QUOTA_TICKET` |
| HTTP body | 1MB | `400 VALIDATION`（413 折并） |
| 会话空闲 | 10 分钟回收 | 下一轮重新装配（历史仍在 DB，但上下文丢了） |

---

## 6. 备份与恢复

容器内自带 `pg_dump` / `pg_restore`（PostgreSQL 16.3），宿主机不用装客户端：

```bash
docker exec wt-postgres pg_dump -U wt -d wt_dev -Fc > "backup/wt_dev_$(date +%Y%m%d_%H%M).dump"
docker exec -i wt-postgres pg_restore -U wt -d wt_dev --clean --if-exists < backup/wt_dev_xxx.dump
```

| 数据 | 位置 | 丢了会怎样 |
|---|---|---|
| 文档/片段/工单/评测/引用 | PostgreSQL | **事实数据**，必须备份 |
| 会话令牌 / 限流窗口 / 租约 | Redis | 可重建（用户重签令牌） |
| 会话上下文 | 进程内存 | 重启即丢（ADR-0002，刻意） |
| 对象存储 | MinIO `wt-dev` | 当前业务不读对象（语料走仓库 `corpus/`） |

---

## 7. Runbook（症状 → 处置）

| 症状 | 先看 | 处置 |
|---|---|---|
| 启动即退出，stderr 列出缺项 | `[config] 配置校验失败` | 补齐 `.env` 必填项 |
| `[startup] PostgreSQL 探活 失败` | `db.sh check` | 起数据层；连接串只能由 `db.sh env` 派生 |
| `/healthz` 503 且 `pi:false` | 服务日志里 `agent session assembled` 有没有 | 冷启动正常；一直 false 查模型 Key / `MODEL_PROVIDER` |
| 对话全拒答 | `retrieval` 日志的 `topScore` / `fallback` | `fallback="fts_only"` = 嵌入挂了（查 DASHSCOPE）；`empty` = 检索空或库慢 |
| 引用为空 | 同上 + `citations` 帧 | 检索没命中 / 引用校验未过（查 `chat: 判定未拒答但引用校验不通过`） |
| 成本异常高 | `ai_runs.cost_usd` 与 `conversations.total_cost_usd` | 已知：输入 token 记 0、全算输出（成本偏高，`16` E6） |
| 会话池经常满 | `/healthz` 之后看 `poolStats()`（测试/诊断口） | 等回收或重启；这是容量现象不是故障 |
| 前端改了但页面没变 | 浏览器缓存 | `.html` 是 `no-cache`，资源是 `max-age`；硬刷新 |
| 三语文案出现汉字 | `check-i18n` 断言 c | 修正译文；脚本会指出具体 key |

---

## 8. 与 v1.1 的差异（本章）

| # | v1.1 | 实际 | 编号 |
|---|---|---|---|
| 1 | `.env.example` 列了 `EMBED_DIM` 等 | 还多出 `MODEL_PROVIDER` / `THINKING_LEVEL`（未进 example，但有默认值） | E48 |
| 2 | 未规定 `S3_REGION` 是否必填 | 可选，默认 `us-east-1` | E49 |
| 3 | 未规定两个"写死常量" | `healthCheckTimeoutMs=1000`、`gracefulShutdownMs=10000` | E50 |
| 4 | 备份未规定工具 | 容器内 `pg_dump`/`pg_restore`（宿主不装客户端） | E51 |
