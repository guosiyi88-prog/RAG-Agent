<<<<<<< HEAD
# -RAG-Agent
客户用德、荷、西、英等不同语言咨询产品参数、安装、保修等问题。客服团队语言覆盖有限，常见问题重复应答占用大量人力，夜间与节假日咨询无人响应，客户体验受损。
=======
# wt-agent · 沃泰能源多语种客服 Agent

给欧洲安装商与终端业主的**自助客服**：五语种（zh / en / de / nl / es）、带引用溯源的流式回答、
答不了自动转人工（建单进坐席队列）。技术栈：Node 22.19 + Fastify 5 + Pi SDK + PostgreSQL 16/pgvector
+ Redis 7 + MinIO。

**两套规格，分工不同**：`docs/prdv1.2/`（**as-built**，19 个文件）描述代码**现在是什么样**，
每句都能指到 `文件:行`；`docs/prdv1.1/`（forward spec，已冻结）是**当初的设计意图**。冲突以代码为准，
冲突清单在 `docs/prdv1.2/16-risks-errata.md` §2（E 系列）。README 只讲"怎么跑起来"，不重复规格里的结论。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 22.19** | 直接跑 `.ts`（类型擦除），无构建步骤；`node --version` 确认 |
| Docker | Docker Desktop（含 `docker compose`） | 数据层是三个容器：postgres(pgvector) / redis / minio |
| curl / bash | Git Bash（Windows）或任意 bash | 门禁脚本与手工验收都用它 |
| make | **可选** | 本机已实测无 make 也能走完全部步骤，等价命令见下表 |
| pdftotext | 可选（poppler） | 只影响 PDF 入库；`.md` 语料不需要 |

> Windows + Git Bash 下没有 `make` 是常态。下文的每一步都给出**两条**命令：`make` 版与等价的原生命令。
> 所有 `node` 命令都带 `--env-file-if-exists=.env`（仓库约定，见 `03-tech-stack.md`）。

---

## 2. 五步复现（新机器从零到能用）

### 第 1 步：起数据层

```bash
make up
# 无 make：
./data/scripts/db.sh up
```

**预期现象**：三个容器起来并转 healthy。随后自检：

```bash
make check
# 无 make：
./data/scripts/db.sh check
```

**预期现象**：`✓ postgres (healthy) / ✓ redis (healthy) / ✓ minio (healthy)`，
端口映射四条 ✓，读写探测三条 ✓，末行 `✓ 自检通过`。

> 首次会拉镜像（`pgvector/pgvector:pg16`、`redis:7-alpine`、`minio`），耗时取决于网络。
> **镜像必须是 `pgvector/pgvector:pg16`**：`postgres:16-alpine` 没有 `vector` 扩展，检索链路整条不可用
> （`16-risks-errata.md` R0）。换过镜像要 `./data/scripts/db.sh destroy && ./data/scripts/db.sh up`。

### 第 2 步：生成 `.env`（不要手写连接串）

```bash
cp .env.example .env
# 填 DEEPSEEK_API_KEY / DASHSCOPE_API_KEY（其余保持模板值）
./data/scripts/db.sh env | grep -oE '(DATABASE_URL|REDIS_URL|S3_[A-Z_]+)=[^[:space:]]+' >> .env
grep -E '^(POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB|REDIS_PASSWORD)=' data/.env >> .env
```

**预期现象**：`.env` 里多出 `DATABASE_URL` / `REDIS_URL` / 七个 `S3_*`（`./db.sh env` 的输出是带缩进的
表格，所以只能用 `grep -oE` 抽片段，写成 `grep -E '^DATABASE_URL'` 一行都匹配不到）。

> 连接串一律由 `./data/scripts/db.sh env` 派生：库名 `wt_dev`、Redis **有密码**、bucket `wt-dev`。
> `.env` 与 `data/.env` 都被 `.gitignore` 忽略，**不要提交**。

### 第 3 步：建表（25 表 + 2 视图 + 触发器/索引）

```bash
make init
# 无 make：
cat sql/001_init.sql sql/002_seed.sql sql/003_faults_seed.sql | ./data/scripts/db.sh psql -v ON_ERROR_STOP=1
```

**预期现象**：无报错，末尾是三条 `INSERT 0 N`（坐席 2 行、settings 10 行、故障码 3 行）。核对：

```bash
./data/scripts/db.sh psql -tAc "select count(*) from pg_tables where schemaname='public'"
# 18
```

> SQL 必须走**标准输入**：`db.sh psql` 在容器里执行，`-f 路径` 在容器内找不到文件。
> `001_init.sql` 开头是 `drop ... cascade` —— 这一步与 `make reset` 等价，**会清掉同库里的所有数据**。

### 第 4 步：灌语料

```bash
make ingest
# 无 make：
node --env-file-if-exists=.env scripts/ingest.ts corpus
```

**预期现象**：`合计 14 个文件：ok=14 failed=0`，逐行打印 `chunks=5` / `chunks=8` 与语种。
语料是幂等的：文件没改时重跑不会产生重复片段（改过的文件会在同一事务里让旧版本退场）。

```bash
node --env-file-if-exists=.env scripts/check-corpus.ts   # 质量自检（make corpus-check）
```

**预期现象**：片段数、块质量、文档状态、语种纯度、故障码五项全绿，退出码 0。
当前口径：13 篇文档 / 74 个片段 / 五语齐（zh/en/de/nl/es）。

### 第 5 步：起服务

```bash
make dev
# 无 make：
node --env-file-if-exists=.env src/server.ts
```

**预期现象**：打印 `startup step ok`（pg / redis / minio 各一条）与
`Server listening at http://127.0.0.1:8000`。然后：

```bash
curl -s http://127.0.0.1:8000/healthz
```

**预期现象**：`{"ok":true,"checks":{"pg":true,"redis":true,"minio":true,"pi":true},"version":"0.1.0"}`。

> `pi` 探的是"本进程至少装配过一次 AgentSession"（`src/routes.ts`）。**刚起来的进程会是 `pi:false`**
> —— 跑一轮对话（或直接在页面上问一句）后即转 `true`，这不是故障。`scripts/verify.sh` 会先记待复检、
> 等 L4 跑完一轮再复检。

---

## 3. 演示数据与评测

```bash
make demo     # 无 make：node --env-file-if-exists=.env scripts/demo.ts
```

**预期现象**：

```
[demo] 语料：documents=13、chunks=74
[demo] qa_gold：新增 30 题、已有 0 题（夹具 version=1.0，共 30 题）
[demo] 新增 8 条 demo 工单（tags 含 'demo'：open/claimed/closed × 四种 reason）
[demo] 完成：documents=13、chunks=74、demo 工单=8。
```

demo 做两件事，都幂等：把 `corpus/.fixtures/qa_gold.json` 的 `expect_doc_hint` 解析成
`documents.id` 写进 `qa_gold`；插 8 张 `tags` 含 `demo` 的示例工单（其中 1 张 SLA 已超时、
1 张 1 小时内到期）。重复跑只打印"已存在 N 条"，**不清库、不 truncate**。
语料为空时退出码 1 并提示先跑 `make ingest` —— `make reset` 之后必须先 ingest 再 demo。

```bash
make eval     # 无 make：node --env-file-if-exists=.env scripts/eval.ts
```

30 题（含五类超纲反例）逐题走真实对话接口，输出 hit@5 / 引用合法率 / 拒答准确率三行指标，
写 `eval_runs` 表并落一份 markdown 到 `docs/output/`。多轮 5 题：`node ... scripts/eval.ts --multi`。

---

## 4. 提交前门禁

```bash
bash scripts/verify.sh          # 全量九项（提交前就跑这个）
bash scripts/verify.sh --fast   # 跳过全量测试与对话流（改前端/文档时用）
```

九项：G1 `tsc --noEmit` 零错误、G2 `node --test --test-concurrency=1`（**必须串行**）、
G3 五语文案校验、G4 `npm audit --omit=dev --audit-level=high`（只读，不自动 fix）、
L1 `/healthz` 四项为真、L2 五语片段/空向量/超长块、L3 检索正反例、L4 SSE 三帧、L5 拒答且工单 +1。

输出每条 `[ok]/[fail]/[skip]` 与总退出码（任一 fail → 1）。`[skip]` 表示**未验证，不等于通过**：
服务没起时 L1/L3/L4/L5 会明确跳过。不用装 `jq`，JSON 由 node 解析。
已知的门禁现状与处置见 `docs/output/gate.md`。

**完成定义（四项，缺一不算完成）**：类型检查零错误 · 断言脚本全过 · 无新增调试输出 ·
无硬编码用户可见文案（用户端文案一律走 `src/static/i18n.json`；坐席端只做中文是规格内的例外，
见 `16-risks-errata.md` §6 L11）。

---

## 5. 端点 → 页面

| 入口 | 地址 | 说明 |
|---|---|---|
| **用户端** | <http://127.0.0.1:8000/> | 9:16 手机框；对话 / 引用抽屉 / 故障码 / 转人工 / 语言切换。五语完整 i18n |
| **坐席端** | <http://127.0.0.1:8000/console> | 1440×810 内部工具；队列 / 详情 / 认领 / 回复 / 关单 |
| 探活 | `GET /healthz` | 四项为真才 200；任一项假 → 503 |
| 对外 API | `POST /api/session`、`POST /api/chat`（SSE）、`POST /api/ticket`、`GET /api/ticket/:no`、`GET /api/fault/:code`、`GET /api/i18n/:lang` | 匿名令牌 + 限流 |
| 内部 API | `POST /internal/search`、`GET /internal/retrieval/recall`、`/internal/ticket*`、`/internal/fault`、`/internal/citations` | **回环来源 + `X-Internal-Token`**，否则 404 |

**刻意的例外：坐席端只做中文。** 它不进用户端文案表（`src/static/i18n.json` 里没有也不许有
`console.*` 键，`scripts/check-i18n.ts` 会拦），理由是内部工具 + 时间预算——
完整说明见 `16-risks-errata.md` §6 的 L11 与 `11-ui-console.md` 顶部。

---

## 6. 日常操作手册

> 上面 2–5 节讲"怎么从零复现"，这一节讲"明天开机怎么用、改完东西怎么验、坏了怎么查"。
> 全部命令在仓库根目录执行；每步给 `make` 与原生两条（本机没装 make）。命令都在
> Windows 11 + Git Bash + Docker Desktop 上实跑过（本机：Node v22.23.1 / Docker 29.6.2）。

### 6.1 开机三步（数据层已初始化过的机器）

```bash
# ① 确认 Docker Desktop 已启动（托盘图标为 running；没开就先开，等 20–30 秒）
docker info >/dev/null 2>&1 && echo docker-ok

# ② 起数据层（幂等：容器已在跑就直接返回）
./data/scripts/db.sh up && ./data/scripts/db.sh check

# ③ 起应用（前台运行，Ctrl+C 停）
node --env-file-if-exists=.env src/server.ts
```

看到 `Server listening at http://127.0.0.1:8000` 即成功。**开机后 30 秒自检三连**：

```bash
curl -s http://127.0.0.1:8000/healthz                     # 期望 ok:true 四项为真
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/          # 200 用户端
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/console   # 200 坐席端
```

首启 `pi` 会是 `false`（本进程还没装配过 AgentSession），**问一句话就转 `true`**，不是故障。

> **最近一次实测（2026-10-27）**：`bash scripts/verify.sh` 九项全绿
> （`ok=9 fail=0 skip=0`，含 387 个用例）；`/healthz` 四项为真；语料 13 篇 / 74 片段 / 五语齐；
> demo 工单 8 张；SSE 正常流（`meta → tool → delta → citations → done`）与超纲拒答建单都已手验。

**后台起服务**（关掉终端也不停）：

```bash
nohup node --env-file-if-exists=.env src/server.ts > server.log 2>&1 &
echo $! > server.pid          # 记下 PID 便于后面停
tail -f server.log            # 看启动日志
kill "$(cat server.pid)"      # 停服务
```

> `server.log` / `server.pid` 是本地临时文件，`.gitignore` 已用 `*.log` / `*.pid` 覆盖，不要提交。

### 6.2 开 / 停 / 查 命令对照

| 动作 | make 版 | 原生（无 make） |
|---|---|---|
| 起数据层 | `make up` | `./data/scripts/db.sh up` |
| 停数据层（卷保留） | `make down` | `./data/scripts/db.sh down` |
| 看容器状态 | `make status` | `./data/scripts/db.sh status` |
| 数据层连通性自检 | `make check` | `./data/scripts/db.sh check` |
| 起应用（前台） | `make dev` | `node --env-file-if-exists=.env src/server.ts` |
| 探活 | `make health` | `curl -s http://127.0.0.1:8000/healthz` |
| 重建表（清数据） | `make init` | `cat sql/001_init.sql sql/002_seed.sql \| ./data/scripts/db.sh psql -v ON_ERROR_STOP=1` |
| 灌语料 | `make ingest` | `node --env-file-if-exists=.env scripts/ingest.ts corpus` |
| 语料质检 | `make corpus-check` | `node --env-file-if-exists=.env scripts/check-corpus.ts` |
| 术语一致性 | `make corpus-terms` | `node --env-file-if-exists=.env scripts/check-terms.ts corpus` |
| 五语文案校验 | `make check-i18n` | `node scripts/check-i18n.ts` |
| 演示数据 | `make demo` | `node --env-file-if-exists=.env scripts/demo.ts` |
| 评测跑分 | `make eval` | `node --env-file-if-exists=.env scripts/eval.ts` |
| 类型检查 | `make typecheck` | `npx tsc --noEmit` |
| 测试（**必须串行**） | `make test` | `node --test --test-concurrency=1` |
| 提交前门禁 | `make verify` | `bash scripts/verify.sh` |
| 应用进容器 | `make build` | `docker compose -f docker-compose.app.yml up -d --build` |
| 应用容器日志 | `make logs` | `docker compose -f docker-compose.app.yml logs -f` |

### 6.3 端口与入口

| 地址 | 谁在用 | 说明 |
|---|---|---|
| `127.0.0.1:8000` | 应用进程 | 用户端 `/`、坐席端 `/console`、`/healthz`、`/api/*`、`/internal/*` |
| `127.0.0.1:5432` | wt-postgres | PostgreSQL 16 + pgvector，库 `wt_dev` |
| `127.0.0.1:6379` | wt-redis | **有密码**；会话令牌、限流窗口、引用快照 |
| `127.0.0.1:9000` / `9001` | wt-minio | S3 兼容 API / Web 控制台（bucket `wt-dev`） |

`8000` 被占的典型现场是"上一轮服务没关"：先 `curl -s 127.0.0.1:8000/healthz` 看是不是自己的，
是就直接用；要强停：

```bash
netstat -ano | grep ':8000'          # 最后一列是 PID
taskkill //PID <PID> //F             # Git Bash 里要双斜杠
```

### 6.4 三种令牌：怎么拿、往哪个头里放

三档鉴权失败形状刻意不同（`src/auth.ts` 顶部有完整理由），照下表对号入座：

| 档位 | 请求头 | 值从哪来 | 失败形状 |
|---|---|---|---|
| 用户端 | `X-User-Session` | `POST /api/session` 返回的 `data.token`（UUID，7 天） | `401 AUTH_REQUIRED` / `AUTH_INVALID` |
| 坐席端 | `X-Staff-Session` | `POST /api/auth/login`（邮箱 + 口令）返回的 `data.ticket`；页面 `/console` 登录后只存 `localStorage` | 一律 `401 AUTH_REQUIRED`（`ADMIN_TOKEN` 已退场） |
| 内部 | `X-Internal-Token` | `.env` 的 `INTERNAL_TOKEN`，**且来源必须是回环地址** | 一律 `404`（不暴露"这里有个路由"） |

拿一个用户令牌并问一句（注意请求体字段是 `text`，不是 `message`）：

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:8000/api/session \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.token))")

curl -sN -X POST http://127.0.0.1:8000/api/chat \
  -H 'content-type: application/json' -H "X-User-Session: $TOKEN" \
  -d '{"text":"Was bedeutet Fehlercode E03?","lang":"de"}'
```

SSE 帧顺序：`meta`（conv_id / message_id）→ `tool`（命中了哪个工具）→ 若干 `delta`（正文增量）
→ `citations`（引用列表）→ `done`。超纲题没有正文，出 `refusal` 帧并带 `ticket_no`。

坐席接口（不经过页面，直接验队列）：先登录拿票据，再带 `X-Staff-Session`。

```bash
T=$(curl -s -X POST http://127.0.0.1:8000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"zhang.wei@wotai.demo","password":"wt-demo-2026"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.ticket))")
curl -s -H "X-Staff-Session: $T" http://127.0.0.1:8000/api/console/stats
curl -s -X POST -H "X-Staff-Session: $T" http://127.0.0.1:8000/api/auth/logout
```

> ⚠️ **上线前必改**：演示账号口令是 `wt-demo-2026`（三个账号见下表），部署前必须换；
> `.env` 里 `INTERNAL_TOKEN` 还是模板值 `change-me-*`。
> 登录限速同 IP 5 次/分钟，`.env` 的 `SESSION_TTL_HOURS`（默认 12）决定票据能活多久。
> `ADMIN_TOKEN` 已退场（`09#03`），`.env` 里留着那行无害但没人读它。

演示账号（`sql/002_seed.sql`，`09#04` 起三个角色各一个 —— 角色是真的会挡人，
缺一个就有一整组接口没人能验）：

| 邮箱 | 姓名 | 角色 | 能做什么 |
|---|---|---|---|
| `zhang.wei@wotai.demo` | 张伟 | `agent` | 工单队列（只看自己 + 未分配池）、认领、关单；管理端接口一律 403 |
| `li.na@wotai.demo` | 李娜 | `lead` | 以上 + 故障卡查看/建 draft/编辑、产品线只读；**不能**发布/归档/建产线/看人员 |
| `admin@wotai.demo` | 王强 | `admin` | 全部：发布 / 归档 / 产品线 CRUD / 人员列表 |

```bash
# admin 登录（管理端接口都需要 admin 或 lead）
curl -s -X POST http://127.0.0.1:8000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@wotai.demo","password":"wt-demo-2026"}'
```

### 6.5 数据层运维

容器与数据卷（`name: wt-infra`）：

| 对象 | 名称 | 备注 |
|---|---|---|
| 容器 | `wt-postgres` / `wt-redis` / `wt-minio` | `minio-init` 是一次性容器，建完 bucket 就退出，属正常 |
| 卷 | `wt-infra_pgdata` / `wt-infra_redisdata` / `wt-infra_miniodata` | `db.sh down` 保留，`db.sh destroy` 连卷删除 |

常用三条：

```bash
./data/scripts/db.sh psql                     # 进交互 psql（SQL 一律走标准输入）
./data/scripts/db.sh redis INFO server        # 单条 redis 命令
./data/scripts/db.sh logs postgres            # 跟日志（也可 redis / minio）
```

**备份 / 恢复**（容器内自带 `pg_dump` 16.3，宿主机不用装客户端）：

```bash
make backup                                  # 等价：bash scripts/backup.sh
# → backup/wt_dev_YYYYmmdd_HHMMSS.dump，保留最近 7 份，日志在 backup/backup.log
# 已注册 Windows 计划任务，每天 03:17 自动跑：
#   schtasks /Query  /TN "wt-agent-backup" /V /FO LIST     （Git Bash 里要加 MSYS_NO_PATHCONV=1）
#   schtasks /Delete /TN "wt-agent-backup" /F              （不再需要时删掉）
# 手工恢复（会把当前库覆盖回备份那一刻）：
docker exec -i wt-postgres pg_restore -U wt -d wt_dev --clean --if-exists < backup/wt_dev_20261028_014800.dump
```

**`make reset` 会删数据卷**（`db.sh destroy --yes`），跑它之前先 `make backup`。手工敲 `./data/scripts/db.sh destroy` 仍要求输入 `yes`，脚本里漏传 `--yes` 就会取消——失败方向是安全的。

**哪些数据丢了不影响业务**：Redis 里的会话令牌 / 限流窗口 / 引用快照都是可重建的；真正的事实数据在
PostgreSQL（`documents` / `chunks` / `tickets` / `qa_gold` / `eval_runs` …）与 MinIO 的 `wt-dev` bucket。

### 6.6 改内容之后的固定动作

| 改了什么 | 必须跟着跑 | 说明 |
|---|---|---|
| `corpus/**/*.md`、`corpus/fault_codes.json` | `ingest` → `corpus-check` | 幂等：改过的文件在同一事务里让旧版本退场，没改的不重复入库 |
| 新增语料文件 | 同上 | 放 `corpus/` 下即可；**以 `.` 开头的文件和目录会被跳过**（夹具放这里） |
| `src/static/i18n.json` | `check-i18n` | 五语 127 key 的唯一真源；`console.*` 键不许出现 |
| 德/荷/西语料措辞 | `corpus-terms` | 术语逐条对齐，且这三种语言不许有汉字 |
| `.env` 里任何键 | 重启服务 | 配置只在启动时读一次（`src/config.ts` 是唯一读取点） |
| `EMBED_DIM` / `EMBED_BACKEND` | **重建表 + 重灌语料** | 向量列是定长 `vector(1024)`，改维度必须 `make init` 后重新 `ingest` |

### 6.7 故障排查

| 现象 | 原因 | 处置 |
|---|---|---|
| `✗ Docker 守护进程未运行` | Docker Desktop 没起 | 启动 Docker Desktop，等托盘变 running，再跑 `db.sh up` |
| postgres 反复重启 / `type "vector" does not exist` | 镜像不是 `pgvector/pgvector:pg16` | `./data/scripts/db.sh destroy`（输 `yes`）→ `up` → `init` → `ingest` |
| `EADDRINUSE :8000` | 已有服务进程 | `curl 127.0.0.1:8000/healthz` 确认是本人 → 复用；否则 `taskkill //PID <pid> //F` |
| `/healthz` 里 `pi:false` | 冷启动，本进程还没装配过 AgentSession | 走一轮真实对话后复检；若一直 false，看服务日志有没有模型 Key 报错 |
| `/healthz` 里 `pg/redis/minio` 任一为 false | 数据层没起或连接串不对 | `db.sh check`；连接串只能由 `db.sh env` 派生 |
| `401 AUTH_REQUIRED` | 头里没带令牌 | 先 `POST /api/session`，再带 `X-User-Session` |
| `401 AUTH_INVALID` | 令牌过期 / 不是 UUID 形状 | 重新 `POST /api/session`；**刷新页面**即可 |
| `400 VALIDATION: text 必填` | 请求体字段写成了 `message` | 改成 `{"text":"…","lang":"de"}` |
| `429 RATE_LIMITED` | `/api/session` 每 IP 10 次/分钟 | 等一分钟；脚本里复用同一个令牌 |
| `503 SESSION_BUSY` | 单实例并发上限 `PARALLEL_LIMIT=5`，闲置 10 分钟才回收 | 等一会儿或重启服务；这不是对话链路故障 |
| `/console` 登录报"邮箱或口令不正确" | 账号/口令不对，或 5 次/分钟限速 | 用 `zhang.wei@wotai.demo` / `li.na@wotai.demo` / `admin@wotai.demo`（口令都是 `wt-demo-2026`）；等一分钟再试（限速键 `login:<ip>`） |
| `/api/admin/*` 返回 403 `FORBIDDEN` | 登录了但角色不够（查看/编辑要 `lead`，发布/归档/字典/人员要 `admin`） | 换 `admin@wotai.demo` 或用 `lead` 只做 draft 相关动作；403 **不会**清登录态（D31） |
| `/console` 打开就 401 | 会话票据过期（`SESSION_TTL_HOURS`，默认 12h）或已登出 | 重新登录；旧 `X-Admin-Token` 已无效 |
| `/internal/*` 返回 404 | 缺内部令牌，或来源不是回环 | 这是设计：内部路由对非回环一律 404 |
| 检索命中很差、引用为空 | `DASHSCOPE_API_KEY` 缺失 → 退回 hash 兜底向量 | 配好 Key，确认 `EMBED_BACKEND=dashscope`，然后 `ingest` 重灌 |
| `npm test` 用例互相污染 | 并发跑共享一套数据层 | 必须 `--test-concurrency=1`（`npm test` 已内置） |
| `db.sh psql -f xxx.sql` 说找不到文件 | psql 在容器内执行，宿主路径不存在 | SQL 走标准输入：`cat xxx.sql \| ./data/scripts/db.sh psql` |
| `npm audit` 报 high | 依赖漏洞 | `verify.sh` 的 G4 只读不自动 fix；处置记录见 `docs/output/gate.md` |

### 6.8 收工

```bash
Ctrl+C                              # 停应用（后台起的用 kill "$(cat server.pid)"）
./data/scripts/db.sh down           # 停数据层，数据卷保留；下次 db.sh up 接着用
```

需要**回到出厂状态**（清空全部数据、重建表、重灌语料、再造演示数据）：

```bash
./data/scripts/db.sh destroy        # 交互确认，输 yes；容器与三个卷一起删除
./data/scripts/db.sh up
cat sql/001_init.sql sql/002_seed.sql sql/003_faults_seed.sql | ./data/scripts/db.sh psql -v ON_ERROR_STOP=1
node --env-file-if-exists=.env scripts/ingest.ts corpus
node --env-file-if-exists=.env scripts/demo.ts
```

> `sql/001_init.sql` 开头是 `drop … cascade`，所以 `make init` / `make reset` 都会清掉同库所有数据。
> 演示前跑 `make reset && make ingest && make demo`，坐席队列里就有 8 张示例工单。

### 6.9 提交前：门禁怎么选

| 场景 | 命令 | 跑什么 |
|---|---|---|
| 提交前 | `bash scripts/verify.sh` | 九项全量（G1–G4 + L1–L5，含 387 个测试与真调模型） |
| 改后端 / 多 agent 并行占库 | `bash scripts/verify.sh --no-tests` | 跳过 G2 全量测试，其余八项 |
| 只改前端 / 文档 | `bash scripts/verify.sh --fast` | 再跳过 L4/L5 对话流 |

`[skip]` 表示**未验证，不等于通过**；服务没起时 L1/L3/L4/L5 会明确跳过。门禁要跑通必须先起服务和数据层。

---

## 7. 已知限制

**单一来源：`docs/prdv1.2/16-risks-errata.md` §3「已知限制」**（12 条：L1–L12，逐条带当前状态）；
设计意图与原始表述在同文件 §4 指向的 `docs/prdv1.1/16-risks-errata.md` §6。
README、演示脚本、答辩材料一律**只引用不重抄** —— 历史上三处分别写 ≥6 / ≥7 / 10 条，
互相矛盾，那是典型的多真源症状。想知道"哪些东西是故意不做"的（无登录、无持久会话、
扫描版 PDF 不支持、坐席端只有中文……），看那一节。

---

## 8. 文档地图

| 位置 | 内容 |
|---|---|
| `docs/prdv1.2/` | **as-built 规格（当前真源描述）**。19 个文件；接手顺序：`README.md` → `01-scope.md` → `02-architecture.md` → `17-ai-brief.md` → `15-tasks.md` |
| `docs/prdv1.1/` | **forward spec（已冻结）**，只读不改。设计意图与历史勘误；与实现的差异见 v1.2 `16` §2（E1–E53） |
| `docs/output/eval-*.md` | 评测报告（三行指标 + 题号级明细） |
| `docs/output/gate.md` | 提交前门禁的实测记录与本机现状（含未通过项的处置） |
| `docs/output/demo-script.md` | 3 分钟演示脚本（时间点 + 动作 + 预期现象，可直接照录屏） |
| `GLOSSARY.md` | 领域词汇表：**坐席**=人，**Agent**=AI |
| `docs/adr/` | 5 条架构决策（Pi 底座、内存会话、跨语种检索、拒答不经模型、克制技术栈） |
| `docs/prd/`、`docs/output/PRD.md` | 历史版本，**已作废**，仅存档 |

代码在 `src/`（`api/` 路由、`core/` 检索与 Agent、`ext/` 工具、`static/` 无构建前端）、
`scripts/`（ingest / check-corpus / check-terms / check-i18n / eval / demo / verify.sh）、
`sql/`（25 表 + 2 视图）、`corpus/`（五语语料与 `fault_codes.json`）、`data/`（数据层 compose 与 `db.sh`）。
>>>>>>> 2f33771 (first commit)
