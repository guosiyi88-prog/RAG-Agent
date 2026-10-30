# 15 · 任务图与任务卡

> **这是本套 PRD 的执行入口。** 每张卡自带目标、依赖、产出、验收，读一张卡即可开工。

## 1. 依赖图

```
T00 环境验证（阻断）
  │
  ▼
T01 骨架 + 依赖 + compose + DDL + /healthz
  │
  ├──▶ T02 数据层（db/redis/storage/config）
  │      │
  │      ├──▶ T03 入库流水线 ──▶ 语料灌库
  │      │        │
  │      │        ▼
  │      │    T04 检索（RRF + 语言过滤）
  │      │        │
  │      │        ▼
  │      └──▶ T05 Agent 桥 + /api/chat（SSE）
  │               │
  │               ▼
  │           T06 拒答三段式 + 工单
  │               │
  │      ┌────────┴────────┐
  │      ▼                 ▼
  └──▶ T07 用户端 UI   T08 坐席端 UI
         │                 │
         └────────┬────────┘
                  ▼
              T09 五语文案
                  │
                  ▼
              T10 评测跑分 ──▶ T11 收尾交付
```

**可并行的只有 T07 与 T08**（两人时）。

---

## 2. 任务卡

### T00 · 环境验证（0.5h，**阻断项**）

| 项 | 内容 |
|---|---|
| 目标 | 确认 Pi SDK 与三个外部服务在本机可用，避免中途发现致命不兼容 |
| 依赖 | 无 |
| 产出 | 一份 `docs/output/env-check.md`（含实际输出） |

**必做 9 项**

1. `node -v` → 必须 ≥ 22.19.0
2. `npm i -E @earendil-works/pi-coding-agent@1.4.0` 后跑官方最小示例，能拿到模型回复
3. 用 `PI_TELEMETRY=0` 启动，确认无对外归因头（可选：抓包一次）
4. `pdftotext -v` 可用（宿主或容器内均可）
5. 两个 API Key 各调通一次（DeepSeek chat、DashScope embedding 返回 1024 维）
6. **pgvector 可用**（阻断项，见下）
7. **三个数据服务连通**：`./data/scripts/db.sh check` 全绿
8. **模型对象可取**：`ModelRuntime.create()` → `getModel("deepseek","deepseek-flash")` 必须非 `undefined`（返回 undefined 说明容器里没有模型目录，按 `03-tech-stack.md` §5 的第 2 条注 `setRuntimeApiKey` 或挂最小 `models-store.json`）
9. **关思考后首字可达**：`thinkingLevel: "off"` 下真实 prompt 一次，首字 < 3s（不关思考必然超）

**第 6 项 · pgvector 判定（必须先做）**

```bash
# ① 镜像对不对
./data/scripts/db.sh psql -tAc "show server_version"     # 16.x
# ② 扩展装没装
./data/scripts/db.sh psql -tAc \
  "select name, default_version, installed_version
     from pg_available_extensions where name='vector'"
```

| 结果 | 判定 |
|---|---|
| 返回一行，`default_version` 有值 | ✅ 通过 |
| 返回 0 行 | ❌ 用的是 `postgres:16-alpine`，换 `pgvector/pgvector:pg16` 并 `db.sh destroy && db.sh up` |
| 命令报 `NOAUTH` / 连不上 | `.env` 里的连接串不对，先跑 `./data/scripts/db.sh env` 重生成 |

**第 7 项 · 连接串三项实测**

```bash
./data/scripts/db.sh check
# 期望：Postgres / Redis / MinIO 全部 ✓，含 MinIO 鉴权与 bucket 检查

# 手工确认真实值（会覆盖旧 PRD 里的 wt/wt、无密码 Redis、knowledge bucket）
./data/scripts/db.sh env | grep -E '^(DATABASE_URL|REDIS_URL|S3_)'
```

必须确认：Redis URL **带密码**、bucket 是 **`wt-dev`**、库名是 **`wt_dev`**。

**阻断判据**：任一项失败 → 停止，先解决。第 4 项失败则改为"只支持 txt/md + 粘贴文本入库"；第 6 项失败则整条检索链路不可用，**必须修完再开工**。

---

### T01 · 骨架与依赖（1h）

| 项 | 内容 |
|---|---|
| 目标 | `docker compose up -d` 后 `/healthz` 四项全 ok |
| 依赖 | T00 |
| 产出 | `docker-compose.app.yml`、`Dockerfile`、`.dockerignore`、`.gitignore`、`.env.example`、`Makefile`、`package.json`、`tsconfig.json`、`sql/001_init.sql`、`sql/002_seed.sql`、`src/server.ts`、`src/config.ts`、`src/logger.ts`、`src/errors.ts` |

**实现要点**

- `config.ts` 启动校验关键 env，缺项 `process.exit(1)`
- `server.ts` 按 `02-architecture.md` §7 的 7 步启动
- `/healthz` 四项探活，任一 false 返回 503
- `pi` 项用进程内标志：成功创建过一次 AgentSession 才置 true；T01 阶段先恒为 false 也可接受，T05 接入后变 true

**验收断言**

```bash
# 数据层（data/ 已建好，这里只确认连得上）
./data/scripts/db.sh check
cat sql/001_init.sql sql/002_seed.sql | ./data/scripts/db.sh psql -v ON_ERROR_STOP=1

# 应用
npm run dev &
curl -s localhost:8000/healthz | jq -e '.checks.pg and .checks.redis and .checks.minio'
./data/scripts/db.sh psql -tAc "\dt" | grep -c tickets   # ≥1
./data/scripts/db.sh psql -tAc \
  "select extversion from pg_extension where extname='vector'"   # 0.7.x
```

**禁止**：
- 带默认值兜底 `ADMIN_TOKEN`/`INTERNAL_TOKEN`
- 在本项目内再造一套 postgres/redis/minio compose（数据层归 `data/`）

---

### T02 · 数据层（0.5h）

| 项 | 内容 |
|---|---|
| 目标 | `db.ts`/`redis.ts`/`storage.ts` 三个模块可用 |
| 依赖 | T01 |
| 产出 | `src/db.ts`、`src/redis.ts`、`src/storage.ts` |

**接口契约**

```ts
// db.ts
export const pool: Pool;
export function query<T>(sql: string, params?: unknown[]): Promise<T[]>;
export function one<T>(sql: string, params?: unknown[]): Promise<T | null>;
export function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>;

// redis.ts
export const redis: Redis;
export function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean>;
export function setLease(id: string, ttlSec: number): Promise<void>;
export function hasLease(id: string): Promise<boolean>;

// storage.ts
export function putObject(key: string, buf: Buffer, mime: string): Promise<void>;
export function getObject(key: string): Promise<Buffer>;
export function presignedUrl(key: string, seconds?: number): Promise<string>;
export function ensureBucket(): Promise<void>;
```

**验收断言**

```bash
# 在 API 里临时加 /debug/ping 或直接跑脚本
node -e "..."   # query('select 1') 返回 [{?column?:1}]
```

---

### T03 · 入库流水线与语料（1h）

| 项 | 内容 |
|---|---|
| 目标 | `make ingest` 后五语 chunks 均有数据（每语 ≥8、合计 ≥40），`documents` 已索引 ≥11；`make corpus-check` 与 `make corpus-terms` 全绿 |
| 依赖 | T02 |
| 产出 | `src/core/ingest.ts`、`src/core/embed.ts`、`src/core/hash-embed.ts`、`src/core/terms.ts`、`scripts/ingest.ts`、`scripts/check-corpus.ts`、`scripts/check-terms.ts`、`corpus/*` |

**实现要点**：严格按 `08-ingestion.md` 的分块参数与清洗顺序；语料清单与故障码改道见 `08` §9，质量门槛见 `08` §10。

**验收断言**

```bash
# 一条命令给结论：片段数 / 空向量 / 超长块 / 空块 / 文档状态 / 语种纯度 / 故障码
make corpus-check
# 期望：全部 [ok  ]，退出码 0；任一 [fail] 即退出码 1

# 术语表逐条对齐 + de/nl/es 无残中文（12-i18n.md §5）
make corpus-terms
# 期望：全部 [ok  ]，退出码 0

# 幂等：同一份语料连跑两次，documents / chunks 行数不变（片段不翻倍、文档不新增）
node --env-file-if-exists=.env scripts/ingest.ts corpus   # 跑前记录 select count(*) from chunks / from documents，跑完再对一次
```

`make corpus-check` 覆盖的阈值（与 `08` §10.1 同一张表，不另立口径）：每语 ≥8 片段、合计 ≥40 片段、空向量 0、超长块（>2000 字符）0、空块（<60 字符）0、`indexed ≥11` 且 `pending`/`failed` 均为 0、同一 `object_key` 多版本 0、故障码五语齐全 ≥3 且无缺语、de/nl/es 片段含 CJK 为 0。跑不了脚本时的手查 SQL 见 `08` §10.3。

**禁止**：跳过 `delete from chunks where doc_id=$1`（重索引必须幂等）。

---

### T04 · 检索（1h）

| 项 | 内容 |
|---|---|
| 目标 | `retrieve()` 在 3 个正例上 top1 命中，在 2 个反例上返回空或低分 |
| 依赖 | T03 |
| 产出 | `src/core/retrieval.ts`、`src/api/internal.ts`（`/internal/search`） |

**实现要点**：严格按 `07-retrieval.md`。三个必须做对的点：

1. `lang = any($2::char(2)[])` 不可省
2. RRF 分数必须**归一化**后再和 `RETRIEVAL_MIN_SCORE` 比
3. `per doc` 上限 3

**验收断言**

```bash
curl -s -X POST localhost:8000/internal/search \
  -H "X-Internal-Token: $INTERNAL_TOKEN" -H 'content-type: application/json' \
  -d '{"query":"E03 Netzspannung","lang":"de","top_k":5}' | jq '.data.chunks[0].doc_title'
# 期望：非空且含故障码/安装相关文档

curl -s -X POST localhost:8000/internal/search \
  -H "X-Internal-Token: $INTERNAL_TOKEN" -H 'content-type: application/json' \
  -d '{"query":"今天天气怎么样","lang":"zh","top_k":5}' | jq '.data.chunks | length'
# 期望：0，或 topScore < 0.30
```

**禁止**：检索不达标就改 prompt。

---

### T05 · Agent 桥 + 对话 API（1.5h）

| 项 | 内容 |
|---|---|
| 目标 | `curl -N POST /api/chat` 能看到 `meta → delta → citations → done` |
| 依赖 | T04 |
| 产出 | `src/core/agent.ts`、`src/ext/support.ts`、`src/api/chat.ts`、`src/api/session.ts`、`src/api/fault.ts`、`src/auth.ts` |

**实现要点**

- session 装配严格按 `06-agent.md` §1（三条硬约束）
- `tools:[]` 只含 4 个业务工具，**绝不含 read/bash/edit/write**
- `tool_call` hook 白名单 fail-closed
- 连发走 `session.steer()`
- 故障码快路：正则命中直接查表，不建 session
- SSE 响应头：`Cache-Control: no-cache`、`X-Accel-Buffering: no`

**验收断言**

```bash
TOKEN=$(curl -s -X POST localhost:8000/api/session | jq -r .data.token)
curl -N -X POST localhost:8000/api/chat \
  -H 'content-type: application/json' -H "X-User-Session: $TOKEN" \
  -d '{"text":"Wechselrichter zeigt E03","lang":"de"}' | head -20
# 期望：出现 event: meta / delta / citations / done

curl -s "localhost:8000/api/fault/E03?lang=de" -H "X-User-Session: $TOKEN" \
  | jq -e '.data.found and (.data.actions|length)>0'
```

**禁止**：
- 用 pro 级模型，或把 `thinkingLevel` 从 `"off"` 调走
- 改 `session.agent.state.messages`
- 在 `agent_before_settle` 里发消息

---

### T06 · 拒答三段式 + 工单（0.5h）

| 项 | 内容 |
|---|---|
| 目标 | 问「能打 8 折吗」→ 固定话术 + 自动建单 |
| 依赖 | T05 |
| 产出 | `src/core/refusal.ts`、`src/core/citations.ts`、`src/core/ticket.ts`、`src/api/ticket.ts`、`/internal/ticket`、`/internal/citations` |

**实现要点**

- 无引用 或 文本含 `NO_ANSWER` → 丢弃模型输出，下发 `REFUSAL[lang]`
- 角标合法性校验：`[n]` 必须在候选集内，否则整条降级为拒答
- 工单号用 DB 默认值 `gen_ticket_no()`
- 建单限流 3/小时/token；同 conv 5 分钟幂等

**验收断言**

```bash
curl -N -X POST localhost:8000/api/chat -H 'content-type: application/json' \
  -H "X-User-Session: $TOKEN" -d '{"text":"Kunnen jullie 20% korting geven?","lang":"nl"}'
# 期望：event: refusal，data.ticket_no 形如 WT-2026-0001

./data/scripts/db.sh psql -c "select no,reason,status from tickets order by id desc limit 1;"
# 期望：reason=no_citation 或 out_of_scope，status=open
```

---

### T07 · 用户端 UI（1.5h）

| 项 | 内容 |
|---|---|
| 目标 | 浏览器完成：提问 → 流式 → 点角标看原文 → 转人工拿单号 |
| 依赖 | T05、T06、T09（可先用 zh 占位） |
| 产出 | `src/static/index.html`、`src/static/user.js`、`src/static/app.css` |

**实现要点**：严格按 `10-ui-user.md` 的 DOM 契约与函数表。

**验收断言（手工）**

- [ ] 桌面打开 `/` 是 9:16 手机框，两侧深色
- [ ] 390×844 无横向滚动
- [ ] 德语提问 → 德语回答，逐字出现
- [ ] 角标可点开抽屉，见文档名 + 页码 + 原文
- [ ] 「转人工」填邮箱后显示 `WT-YYYY-NNNN`
- [ ] 键盘弹出时输入框贴键盘

---

### T08 · 坐席端 UI（1h）

| 项 | 内容 |
|---|---|
| 目标 | 浏览器完成：看队列 → 开详情 → 认领 → 关单 |
| 依赖 | T06、T09 |
| 产出 | `src/static/console.html`、`src/static/console.js`、`src/api/console.ts` |

**实现要点**：严格按 `11-ui-console.md`。

**验收断言（手工）**

- [ ] 新单 5s 内出现，SLA 倒计时跳动
- [ ] 点行进入详情，URL 变 `#/ticket/{id}`，刷新能回
- [ ] 认领后指派列更新
- [ ] 关单必须填 ≥10 字
- [ ] 1440×810 下「发送」「关单」无需滚动可见

---

### T09 · 五语文案（0.5h）

| 项 | 内容 |
|---|---|
| 目标 | `npm run i18n:check` 全绿，切语言整页生效 |
| 依赖 | T07、T08（DOM 里已有 key 占位） |
| 产出 | `src/static/i18n.json`、`scripts/check-i18n.ts`、`src/api/i18n.ts` |

**实现要点**：按 `12-i18n.md` 的 **127** 个 key，中文定稿 → 生成四语 → 校验脚本。拒答话术不进 i18n，写在 `src/core/refusal.ts`。

**验收断言**

```bash
npm run i18n:check
# 期望：keys: 127/127，无 [fail]
```

---

### T10 · 评测跑分（0.5h）

| 项 | 内容 |
|---|---|
| 目标 | `make eval` 输出三指标并写 `eval_runs` |
| 依赖 | T03–T09 全部 |
| 产出 | `scripts/eval.ts`、`corpus/qa_gold.json`（含 30 题） |

**实现要点**

- 逐题 POST `/api/chat`，消费 SSE 到 `done`
- 采集 `citations` 事件判断 hit@5（用 `expect_doc_id`）
- 拒答题判断 `refusal` 事件 + 新增工单
- 输出 markdown 到 `docs/output/eval-{YYYYMMDD}.md`

**验收断言**

```bash
make eval
# 期望输出三行：
# hit@5    0.xx  (>=0.70)
# cite     0.xx  (>=0.85)
# refuse   0.xx  (>=0.90)
```

**不达标处置**：按 `07-retrieval.md` §10 调参，**不得改 prompt 掩盖**。

---

### T11 · 收尾交付（0.5h）

| 项 | 内容 |
|---|---|
| 目标 | 换机器能起，有录屏有截图 |
| 依赖 | T10 |
| 产出 | `README.md`、`docs/output/demo-script.md`、录屏、10 张截图 |

**必做**

1. `README.md`：5 分钟复现 + **已知限制 ≥10 条**（照抄 `16-risks-errata.md` §6，唯一来源）
2. `make reset && make demo` 跑一遍确认真能起
3. 按 `14-verification.md` §5 的演示脚本录 3 分钟视频
4. 截图：用户端 5 张（390×844）+ 坐席端 5 张（1440×810）
5. `npm audit --audit-level=high` 无 high

---

## 3. 时间预算

| 卡 | 编码 | 代码闸门 | 累计 |
|---|---|---|---|
| T00 | 0.5h | — | 0.5 |
| T01 | 1.0h | — | 1.5 |
| T02 | 0.5h | — | 2.0 |
| T03 | 1.0h | — | 3.0 |
| T04 | 1.0h | **G1 12min** | 4.2 |
| T05 | 1.5h | **G2 15min** | 5.95 |
| T06 | 0.5h | **G3 12min** | 6.65 |
| T07 | 1.5h | **G4 10min** | 8.4 |
| T08 | 1.0h | **G5 10min** | 9.6 |
| T09 | 0.5h | — | 10.1 |
| T10 | 0.5h | — | 10.6 |
| T11 | 0.5h | — | 11.1 |

**11.1 小时 = 编码 10 小时 + 代码审查 59 分钟**（零返工）。

含返工的现实区间：**11.5–14.5 小时**。排期按 **13 小时**承诺，别按 10 小时。

闸门规则见 `18-human-gates.md`。**闸门不过，不许进下一张卡。**

### 3.1 熔断规则

任一张卡超时 30 分钟 → 立即降级为最小可用并记录，**不向后挤占**。连续两张卡超时 → 执行 `01-scope.md` 的 Plan C 收敛：砍 T08 到"只读详情"、砍 T09 到"只做 zh/en/de"。

### 3.2 闸门与熔断的关系

闸门**不参与熔断**。编码可以降级，审查不能省——省下来的时间会在演示现场十倍偿还。

---

## 4. 开工前必读清单

- [ ] `README.md`（维度与用法）
- [ ] `01-scope.md`（范围）
- [ ] `17-ai-brief.md`（纪律与禁止）
- [ ] `02-architecture.md`（文件树）
- [ ] 本文件的 T00 卡
