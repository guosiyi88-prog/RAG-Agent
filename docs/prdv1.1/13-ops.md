# 13 · 运维契约

> **本文件已按 `data/` 现有基础设施重写（v1.1.1）。**
> 原则：数据层归 `data/`，应用层归根目录，两层不互相复制。

---

## 1. 分层原则

| 层 | 位置 | 管什么 | 谁维护 |
|---|---|---|---|
| **数据层** | `data/` | PostgreSQL / Redis / MinIO 的容器、卷、口令、镜像加速、日志轮转、连通性自检 | 已有，**不要重写** |
| **应用层** | 根目录 | Node 应用（api）、静态页、语料、DDL | 本项目 |

**为什么不合成一个 compose**：数据层一年重启三次，应用层一天重启三十次。生命周期不同，合成一套会让"改一行前端也要重建数据库容器"。

---

## 2. 数据层（`data/`，已可用）

### 2.1 已提供的东西

| 能力 | 实现 |
|---|---|
| 三服务编排 | `data/docker-compose.yml`，project `wt-infra` |
| 一键启停/重置 | `data/scripts/db.sh`（360 行，`up/down/destroy/restart/status/check/env/psql/redis/mc/logs`） |
| 连通性自检 | `./db.sh check`：容器状态 + 宿主端口 + 真实读写探测（含 MinIO 鉴权与 bucket） |
| 连接串输出 | `./db.sh env`：直接打印 `DATABASE_URL` / `REDIS_URL` / `S3_*` |
| 国内镜像加速 | `REGISTRY_MIRROR`，已在 `db.sh` 里自动改写四个 image |
| 日志轮转 | `json-file`，10MB × 3 |

### 2.2 PostgreSQL 镜像必须带 pgvector

```bash
POSTGRES_IMAGE=pgvector/pgvector:pg16
```

**这是阻断项。** `postgres:16-alpine` 不含 `vector` 扩展，`create extension vector` 会失败，整个检索链路不可用。

已验证两条拉取路径均可用：

```
pgvector/pgvector:pg16
<REGISTRY_MIRROR>/pgvector/pgvector:pg16        # db.sh 自动拼接，命中华为云镜像
```

**已有 volume 必须先销毁**：Alpine 与 Debian 的 PG16 数据目录 collation 默认值不同，直接换镜像有索引损坏风险。

```bash
./data/scripts/db.sh destroy
./data/scripts/db.sh up
```

### 2.3 实际连接参数（**以此为准，覆盖旧版 PRD**）

| 项 | 值 |
|---|---|
| `DATABASE_URL` | `postgresql://wt:wt_dev_pg_2024@127.0.0.1:5432/wt_dev` |
| `REDIS_URL` | `redis://:wt_dev_redis_2024@127.0.0.1:6379/0` |
| `S3_ENDPOINT` | `http://127.0.0.1:9000` |
| `S3_ACCESS_KEY` | `wtadmin` |
| `S3_SECRET_KEY` | `wt_dev_minio_2024` |
| `S3_BUCKET` | `wt-dev` |
| `S3_REGION` | `us-east-1` |
| MinIO 控制台 | `http://127.0.0.1:9001` |
| `TZ` | `Asia/Shanghai`（容器时区；**DB 内一律存 UTC**） |

> Redis **有密码**。写成 `redis://127.0.0.1:6379` 会 `NOAUTH` 启动失败。
> Bucket 名是 `wt-dev`，不是 `knowledge`。

### 2.4 建表

`data/` 的 postgres **没有**挂 `/docker-entrypoint-initdb.d`（这是有意的：DDL 属于应用层）。建表走 stdin 管道：

```bash
cat sql/001_init.sql sql/002_seed.sql | ./data/scripts/db.sh psql -v ON_ERROR_STOP=1
```

`destroy` 之后必须重跑这一步。

---

## 3. 应用层

### 3.1 开发期：应用跑在宿主（推荐）

```
宿主  Node :8000  ──127.0.0.1──▶  Docker 三容器
```

最简单，热重载最快。`npm run dev` 直接连 `127.0.0.1`。

**Windows 注意**：`08-ingestion.md` 需要 `pdftotext`。Git Bash 通常自带（`/mingw64/bin/pdftotext`）。先验证：

```bash
which pdftotext || echo "缺失：装 poppler 或用粘贴文本入库"
```

### 3.2 集成期：应用进容器

`docker-compose.app.yml`（根目录）：

```yaml
name: wt-app

services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: wt-api
    restart: unless-stopped
    env_file:
      - .env
    environment:
      # 容器内用 container_name 直连，已在同一网络。
      # ${POSTGRES_USER} / ${POSTGRES_PASSWORD} / ${POSTGRES_DB} / ${REDIS_PASSWORD} 由 §4.1 第 3 步从 data/.env 追加，
      # 缺失时 docker compose 会静默替换成空串，表现为启动即 NOAUTH / password authentication failed。
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@wt-postgres:5432/${POSTGRES_DB}
      REDIS_URL: redis://:${REDIS_PASSWORD}@wt-redis:6379/0
      S3_ENDPOINT: http://wt-minio:9000
      S3_BUCKET: ${S3_BUCKET}
      PI_TELEMETRY: "0"
    ports:
      - "8000:8000"
    networks:
      - wt-infra
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8000/healthz"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s

networks:
  wt-infra:
    external: true
    name: wt-infra_default
```

要点：

- `external: true` 接入 `data/` 建的网络，**不复制三个数据服务**
- 容器内主机名用 `wt-postgres` / `wt-redis` / `wt-minio`（`data/` 已固定 `container_name`）
- 口令从 `data/.env` 复制到根 `.env`，见 §4

### 3.3 Dockerfile

```dockerfile
FROM node:22-alpine

# pdftotext：唯一系统依赖（PDF 解析）
RUN apk add --no-cache poppler-utils wget

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY sql ./sql

EXPOSE 8000
CMD ["node", "--experimental-strip-types", "src/server.ts"]
```

---

## 4. 配置文件（只有一份 `.env`）

### 4.1 生成，不要手写

`data/scripts/db.sh` 能打印应用需要的全部连接串。根 `.env` 由它生成：

```bash
# 1. 应用专属变量（模板）
cp .env.example .env

# 2. 追加数据层连接串
#    注意：db.sh env 的输出是「分节标题 + 4 空格缩进」的表格，不是裸 KEY=value，
#    所以只能用 -oE 抽片段；写成 grep -E '^DATABASE_URL' 会一行都匹配不到
./data/scripts/db.sh env | grep -oE '(DATABASE_URL|REDIS_URL|S3_[A-Z_]+)=[^[:space:]]+' >> .env

# 3. 追加容器内插值需要的口令变量（应用 compose 用 ${POSTGRES_PASSWORD} 等，见 §3.2）
grep -E '^(POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB|REDIS_PASSWORD)=' data/.env >> .env
```

`db.sh env` 的实际输出形如：

```
应用连接信息
  PostgreSQL
    DATABASE_URL=postgresql://wt:...@127.0.0.1:5432/wt_dev
```

> **不允许**手写连接串进 `.env`。第 2、3 步都从 `data/` 的既有配置派生，两份配置不会漂移。
> 根 `.env`、`data/.env` 都必须被 `.gitignore` 忽略，**不要提交**。

### 4.2 根 `.env.example`（应用专属部分）

```bash
# ── 应用 ─────────────────────────────
PORT=8000
NODE_ENV=development
ADMIN_TOKEN=change-me-admin-token
INTERNAL_TOKEN=change-me-internal-token

# ── 数据层（由 ./data/scripts/db.sh env 追加，勿手写）──
# DATABASE_URL=
# REDIS_URL=
# S3_ENDPOINT=
# S3_ACCESS_KEY=
# S3_SECRET_KEY=
# S3_BUCKET=
# S3_REGION=

# ── 容器插值用（§4.1 第 3 步从 data/.env 追加，勿手写）──
# POSTGRES_USER=
# POSTGRES_PASSWORD=
# POSTGRES_DB=
# REDIS_PASSWORD=

# ── 模型 ────────────────────────────
LLM_PROVIDER=deepseek          # deepseek | mock
DEEPSEEK_API_KEY=sk-xxxxxxxx
MODEL_ID=deepseek-flash

# ── Embedding ───────────────────────
EMBED_BACKEND=dashscope        # dashscope | hash
DASHSCOPE_API_KEY=sk-xxxxxxxx
EMBED_DIM=1024

# ── 检索 ────────────────────────────
RETRIEVAL_TOP_K=5
RETRIEVAL_MIN_SCORE=0.30
RETRIEVAL_VEC_WEIGHT=0.8
RETRIEVAL_FTS_WEIGHT=0.2
RRF_K=60

# ── 运行 ────────────────────────────
PARALLEL_LIMIT=5
SESSION_IDLE_MS=600000
CHAT_TIMEOUT_MS=30000
SAFE_MODE=false

# ── Pi ──────────────────────────────
PI_TELEMETRY=0
```

### 4.3 启动校验（`src/config.ts`）

| 变量 | 缺失行为 |
|---|---|
| `ADMIN_TOKEN` / `INTERNAL_TOKEN` | 退出码 1 |
| `DATABASE_URL` / `REDIS_URL` | 退出码 1 |
| `S3_*` | 退出码 1 |
| `DEEPSEEK_API_KEY` | `LLM_PROVIDER=deepseek` 时退出，`mock` 可缺 |
| `DASHSCOPE_API_KEY` | `EMBED_BACKEND=dashscope` 时退出，`hash` 可缺 |

**禁止给关键密钥设默认值**——会在演示现场静默失败。

---

## 5. Makefile（薄包装，不重复实现）

```makefile
DATA := ./data/scripts/db.sh

.PHONY: up down reset status check env init dev build logs health ingest demo eval typecheck check-i18n verify

up:            ## 起数据层并等健康
	$(DATA) up

down:          ## 停数据层（卷保留）
	$(DATA) down

reset:         ## 清空数据层 + 重建 + 重新建表
	$(DATA) destroy
	$(DATA) up
	cat sql/001_init.sql sql/002_seed.sql | $(DATA) psql -v ON_ERROR_STOP=1

status:
	$(DATA) status

check:         ## 数据层连通性自检
	$(DATA) check

env:           ## 打印应用连接串
	$(DATA) env

init:          ## 只重建表（不清卷）
	cat sql/001_init.sql sql/002_seed.sql | $(DATA) psql -v ON_ERROR_STOP=1

dev:
	npm run dev

build:
	docker compose -f docker-compose.app.yml up -d --build

logs:
	$(DATA) logs

health:
	@curl -s http://127.0.0.1:8000/healthz

ingest:
	npm run ingest -- corpus

demo:
	npm run demo

eval:
	npm run eval

typecheck:
	npx tsc --noEmit

check-i18n:
	npm run i18n:check

verify:         ## 提交前 L1–L5 断言（14 §2）
	bash scripts/verify.sh
```

---

## 6. 首次运行手册

```bash
# 1. 数据层
./data/scripts/db.sh destroy          # 若之前用过 postgres:16-alpine 则必须
./data/scripts/db.sh up
./data/scripts/db.sh check            # 期望：三服务 healthy + 读写探测全绿

# 2. 验证 pgvector（阻断项）
./data/scripts/db.sh psql -tAc \
  "select extversion from pg_extension where extname='vector'"
# 空 → 还没建，继续第 3 步；建完应输出 0.7.x 或更高

# 3. 建表
cat sql/001_init.sql sql/002_seed.sql | ./data/scripts/db.sh psql -v ON_ERROR_STOP=1
./data/scripts/db.sh psql -tAc "select count(*) from chunks"   # 0

# 4. 应用配置（三步都从 data/ 派生，别手写连接串；详见 §4.1）
cp .env.example .env
# 填 DEEPSEEK_API_KEY / DASHSCOPE_API_KEY
./data/scripts/db.sh env | grep -oE '(DATABASE_URL|REDIS_URL|S3_[A-Z_]+)=[^[:space:]]+' >> .env
grep -E '^(POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB|REDIS_PASSWORD)=' data/.env >> .env

# 5. 起应用
npm ci
npm run dev
curl -s localhost:8000/healthz

# 6. 灌语料 + 自检
npm run ingest -- corpus
npm run eval
```

---

## 7. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `create extension vector` 失败 | 用了 `postgres:16-alpine` | 换 `pgvector/pgvector:pg16` 并 `destroy` 重建 |
| `/healthz` pg=false，日志 `relation "chunks" does not exist` | 没建表 | 跑 §2.4 或 `make init` |
| 启动即 `NOAUTH Authentication required` | Redis 有密码，URL 少了 `:pwd@` | 用 `./db.sh env` 重新生成 `.env` |
| 上传报 `The specified bucket does not exist` | bucket 名写错 | 是 `wt-dev`，不是 `knowledge` |
| 应用容器连不上 `wt-postgres` | 没接入 `wt-infra_default` 网络 | 检查 `docker-compose.app.yml` 的 `external: true` |
| `pdftotext: command not found` | 宿主没装 poppler | 用容器跑，或改用「粘贴文本入库」 |
| 检索全空 | `chunks` 空 / 语言过滤写错 | `select lang,count(*) from chunks group by 1` |
| 100% 拒答 | `RETRIEVAL_MIN_SCORE` 与 RRF 原始分比较 | 见 `07-retrieval.md` §5.1 |
| 首字 >10s | 模型默认开了思考模式 | 确认 `thinkingLevel: "off"`，且 `MODEL_ID=deepseek-flash` |
| 前端不流式 | 反向代理缓冲 / 用了 `EventSource` | 加 `X-Accel-Buffering: no`；改 `fetch` + `ReadableStream` |
| 内存持续上涨 | session 未回收 | 查 `dispose` 日志与 `SESSION_IDLE_MS` |

---

## 8. 前端 SSE 消费（必须用 fetch）

```js
const res = await fetch('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-User-Session': state.token },
  body: JSON.stringify({ conv_id: state.convId, text, lang: state.lang }),
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const parts = buf.split('\n\n');
  buf = parts.pop() ?? '';
  for (const part of parts) handleEvent(part);
}
```

`EventSource` 只支持 GET、不能带自定义 header、在 iOS 微信里会被缓冲到连接结束才显示。

---

## 9. 演示与重置

```bash
make demo     # 灌语料 + 造 3 张示例工单
make reset    # destroy → up → 重建表（演示前必做）
make demo     # reset 之后必须再跑一次，否则队列是空的
```

---

## 10. 备份

```bash
./data/scripts/db.sh psql -tAc "\l" > /dev/null    # 确认可连
docker exec wt-postgres pg_dump -U wt wt_dev | gzip > backup-$(date +%Y%m%d).sql.gz
```

恢复：

```bash
gunzip -c backup-YYYYMMDD.sql.gz | docker exec -i wt-postgres psql -U wt -d wt_dev
```

演示前跑一次备份。

---

## 11. 已知限制

> **单一来源**：完整列表见 `16-risks-errata.md` §7。此处只列与运维直接相关的。

1. 会话不持久化：`SessionManager.inMemory()`，进程重启丢进行中会话
2. 单实例并发 5，超限排队
3. 数据层与应用层分两个 compose，演示机需两步启动
4. 未实现数据保留清理任务（90 天策略未生效）
