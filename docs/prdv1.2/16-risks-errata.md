# 16 · 风险、偏差与已知限制（as-built）

> 三份清单，**互不合并**：
> - §2 **E 系列（实现偏差）**：文档与代码不一致、且已裁定以代码为准的地方。编号 E1–E53，全仓引用都指本节。
> - §3 **L 系列（已知限制）**：功能上故意不做的事。沿用 v1.1 的 L1–L12，状态已复核。
> - §4 **历史勘误**：v1.1 之前文档的错误。**原样留在 `docs/prdv1.1/16-risks-errata.md` §3**，本版不复制、不改号。

---

## 1. 风险登记册（本金未变，处置状态已更新）

| # | 风险 | 现状 | 处置 |
|---|---|---|---|
| R0 | 数据层镜像缺 pgvector | ✅ 已消除 | 镜像固定 `pgvector/pgvector:pg16`，`db.sh check` 会验读写 |
| R0b | 连接串与文档不一致 | ✅ 已消除 | 一律 `db.sh env` 派生，禁止手写 |
| R1 | Pi SDK 升级破坏 API | 监控中 | `package.json` 精确锁 `1.4.0`，`npm ci` |
| R2 | 容器内读不到模型配置 | ✅ 已处理 | `setRuntimeApiKey` 注入 + 回落到 Pi 凭据库；两条都留 |
| R3 | 扫描版 PDF | 仍是限制（L4） | `no_text_layer` 失败码 + 夹具 `.fixtures/scan-sample.en.pdf` 负例 |
| R5 | 跨语种检索不达标 | ✅ 已消除 | 真嵌入 hit@5 = 1.00 |
| R6 | 100% 拒答 | ✅ 已消除 | 分值是 `归一化 RRF × 余弦²`（E27） |
| R8 | 引用造假 | ✅ 已消除 | 引用校验 + 整条降级拒答 |
| R9 | 建单被刷 | ✅ 已缓解 | 令牌 + 3 张/小时 + 300s 幂等 |
| R10 | 微信内不流式 | ✅ 已处理 | `fetch` + `ReadableStream`，不用 `EventSource` |
| R12 | 内存随会话上涨 | ✅ 已处理 | 上限 5 + 10 分钟回收 + 60s 巡检 |
| R15 | Pi 遥测误开 | ✅ 已处理 | `config.ts` import 期钉 `PI_TELEMETRY=0` |

---

## 2. E 系列：实现偏差（53 条）

> 格式：**v1.1 的说法 → 实现的事实**。凡"以代码为准"的，都是实现期做过的裁定，注释里通常有理由。
> 改其中任何一条，必须同时改对应章节与 `14` 的断言。

### 2.1 鉴权与端点（E1–E5、E20–E22）

| # | 偏差 | 证据 | 影响 |
|---|---|---|---|
| E1 | 内部接口失败形状：v1.1 一处写 401、一处写 404 → **统一 404**（与"路径不存在"逐字同形） | `src/auth.ts:224` | 扫描器拿不到"端点存在"的信号；测试断言的也是 404 |
| E2 | `/api/fault/:code` 在 v1.1 端点表标 `User` → **实际无令牌门禁** | `src/routes.ts:102` | 故障码页要在拿令牌之前出卡；数据是五语公开表 |
| E3 | v1.1 要求实现 `POST /api/feedback`（UI 不做）→ **完全没实现** | `grep -r feedback src/` 为空 | 反馈闭环缺失；`feedback` 表建好但无写入路径 |
| E4 | DDL：`create if not exists` → **先 drop 后建**；`char(2)` 语言列**全部**带约束；`closed` 行**任何 UPDATE 都 raise**；加 `pg_trgm` | `sql/001_init.sql:5,10,183` | `make init/reset` 会清空业务数据，这是刻意的 |
| E5 | `/api/fault` 响应 v1.1 无 `product_line` → **有**（与 `/internal/fault` 同一份 data） | `src/api/fault.ts:14` | 卡片能说清"这是哪条产品线的码" |
| E20 | v1.1 未规定快路帧集合 → 快路只发 `meta`/`delta`/`done`，**不发** `tool`/`citations` | `src/api/chat.ts:468` | 前端不会画出点开是空的角标 |
| E21 | v1.1 未规定 trace 形态 → 沿用前端 `X-Trace-Id`；非 uuid 时 `messages.trace_id` **不落** | `src/api/chat.ts:340` | 一个日志字段不会让整条请求 500 |
| E22 | 分页超界 v1.1 未定义 → **夹取**而非 400（`page≤10000`、`size≤100`） | `src/api/console.ts:104` | 手抖的 `?page=99999` 不会把整页刷红 |

### 2.2 记账、配置与工程（E6–E8、E13–E19、E48–E51）

| # | 偏差 | 证据 | 影响 |
|---|---|---|---|
| E6 | 输入/输出 token 分侧落库 → `splitTokens` 把**输入记 0、全算输出** | `src/api/chat.ts:159`（带 TODO） | 成本偏高（保守），报表不会"少记" |
| E7 | `EMBED_DIM` 可配 → DDL 固定 `vector(1024)` | `sql/001_init.sql:66` | 改维度必须重建表 + 重灌语料 |
| E8 | 会话池 v1.1 只写"上限 5/闲置 10 分钟/每分钟巡检" → 还要**装配去重、复用先于判满、先回收再判满、busy 不回收** | `src/core/agent.ts:314-376` | 满池时老用户追问不会被误拒 |
| E13 | `name: wotai-support-agent`、六脚本带 `--experimental-strip-types` → `wt-agent`、七脚本且**无该 flag** | `package.json` | Node 22.19+ 已不需要该 flag |
| E14 | 依赖含 `pi-ai`/`pino`/`pino-pretty` → **都没声明**；`logger.ts` 直接 `import pino`（靠 fastify 传递依赖 hoist） | `src/logger.ts:1` | 哪天 fastify 换日志依赖，运行期 `ERR_MODULE_NOT_FOUND`。**建议显式声明 pino** |
| E15 | `tsconfig` 开 `noUncheckedIndexedAccess`、`ES2022`、`include` 只 src+scripts → **未开该选项**、`ES2023`、`include` 含 `tests` | `tsconfig.json` | 测试也过类型检查 |
| E16 | 有 `scripts/perf-fault.ts` → **不存在** | — | 故障码耗时只打日志（`chat.ts:358`） |
| E17 | 未提 `undici` → `overrides: 8.12.3` | `package.json:18` | 门禁 G4 唯一的修复手段（不允许 `audit fix`） |
| E18 | `settings` 是"运行时覆盖层" → **只有 `sla.hours` 被读**；`v_health` 建了但 `/healthz` 未用 | `src/core/ticket-store.ts:80` | "改 settings 调参"目前只对 SLA 成立 |
| E19 | seed 的 jsonb 应为数字/布尔 → **全是字符串**（`'5'`/`'0.30'`/`'true'`） | `sql/002_seed.sql:23` | 读取方必须 `Number()` 转换 |
| E48 | `.env.example` 列了主要变量 → **`MODEL_PROVIDER`/`THINKING_LEVEL` 未列**（有默认值） | `src/config.ts:132` | 想换模型提供商时容易只改 `MODEL_ID`，症状是 401 |
| E49 | `S3_REGION` 未定是否必填 → **可选**，默认 `us-east-1` | `src/config.ts:65` | 不在必填表里 |
| E50 | 未规定两个常量 → `healthCheckTimeoutMs=1000`、`gracefulShutdownMs=10000` | `src/config.ts:135` | 探活不会自己挂住；SSE 不会被无限拖住 |
| E51 | 备份未规定工具 → 容器内 `pg_dump`/`pg_restore`（16.3） | `Dockerfile`、镜像 | 宿主不用装客户端 |

### 2.3 Agent 与工具（E9、E24–E26）

| # | 偏差 | 证据 | 影响 |
|---|---|---|---|
| E9 | A2「采纳 AI 答复」是一键动作 → **没有一键采纳**：AI 消息 + 引用可点 + `no_evidence` 标记 + 手写回复框（草稿自动存） | `src/static/console.js`、`core/ticket-queue.ts` | 坐席需要手动复制；换来的是"AI 说的"与"坐席发的"永不混淆 |
| E24 | `fault_code_lookup` 由模型给产品线 → **写死 `balcony`**，schema 里没有这个参数 | `src/ext/support.ts:249` | 模型没有判断依据，猜错就是查错含义 |
| E25 | usage 形状写 `inputTokens/outputTokens` → SDK 实际是 `{ input, output, cost: { total } }` | `src/core/agent.ts:661` | 按真实形状取，取不到记 0 |
| E26 | 未写模板展开开关 → `expandPromptTemplates: false` | `src/core/agent.ts:584` | 客户输入里的 `/xxx` 不会被当斜杠命令 |

### 2.4 检索（E27–E30）

| # | 偏差 | 证据 | 影响 |
|---|---|---|---|
| E27 | §5.1 把**归一化 RRF** 当最终分 → 最终分 = 归一化 RRF **× 余弦²** | `src/core/retrieval.ts:441` | 不这样改，0.30 阈值等于没有阈值（所有问题都是 0.8） |
| E28 | 伪代码先截 `max(topK*3,15)` 再去重 → **不预截断**，直接在全部候选上去重 | `src/core/retrieval.ts:484` | 两路合计最多 40 条，去重 O(n) |
| E29 | 未定义 `fallback` → `none`/`fts_only`/`empty` 三值 + 明确的降级边界（维度错与其它异常**上抛**） | `src/core/retrieval.ts:368` | `fts_only` 时向量路仍跑（hash 兜底） |
| E30 | 未规定语言视野 → `LANG_SCOPE` 五语各带 `en`，是 SQL 语言数组的唯一生成源 | `src/core/retrieval.ts:40` | 加语言只改这一处 |

### 2.5 入库（E31–E35、E53）

| # | 偏差 | 证据 | 影响 |
|---|---|---|---|
| E31 | 表格处理未写成硬规则 → 连续 ≥2 行含 `|` 整表成块、块首重复表头、**不做重叠** | `src/core/chunk.ts:239` | 参数表不再被切碎 |
| E32 | 超长块未规定 → 超过 2000 **抛错**让整篇失败 | `src/core/chunk.ts:186` | 宁可失败也不写超长块 |
| E33 | 未规定批大小 → 插入 **100**/批、嵌入 **10**/批 | `src/core/ingest.ts:33`、`embed.ts:28` | DashScope 单批 >10 会 400（v1.1 §5 A7 已证伪过） |
| E34 | 未规定旧版本退场时机 → **新版本写成功之后**才删旧行 | `src/core/ingest.ts:495` | 失败时旧版本仍是最好的数据 |
| E35 | 无 `.fixtures/` 规则 → 以 `.` 开头的文件/目录一律跳过 | `src/core/ingest.ts:594` | 评测集与负例夹具不会被当语料 |
| E53 | 夹具路径写 `corpus/qa_gold.json` → 实际 `corpus/.fixtures/qa_gold.json` | `corpus/.fixtures/` | 就是为了让 ingest 跳过它 |

### 2.6 界面（E10、E36–E45）

| # | 偏差 | 证据 | 影响 |
|---|---|---|---|
| E10 | U8 工单进度"UI 不做" → **做了**（单号 + 邮箱） | `src/static/views.js` | 用户能自助查单 |
| E36 | 令牌表未含坐席端状态色 | `--c-st-*` 五色 | 队列状态一眼可辨 |
| E37 | 暗色模式未写落地范围 | 只覆写变量，未逐屏精修 | 与 L 系列"深色不精修"一致 |
| E38 | 类名只有一套 → 出现**双写**（`.msg`/`.bubble`、`.msg-u`/`.bubble--user`） | `app.css:61-68` | 历史兼容，改样式要两处一起改 |
| E39 | 未规定 DOM 上限 → 60 条气泡（只删 DOM） | `src/static/user.js:14` | 长会话不卡 |
| E40 | 未规定 401 处理 → 静默重签**一次**并重发整轮 | `src/static/user.js:201` | 令牌过期不打断用户 |
| E41 | 离线只有横幅 → 横幅 + 状态条 + 离线兜底词典（`i18n-chrome`/`i18n-de`） | `src/static/lib/` | 接口不可用时页面仍可用 |
| E42 | 未规定拒答客户端契约 → 用**最后一帧 delta** 覆盖整条气泡；无 `refusal` 帧则保留草稿 | `src/static/user.js:311` | 草稿不会以"已建单"的姿态留在屏幕上 |
| E43 | 坐席端只要求"队列和详情顺" → 完整键盘（`j/k/Enter/Esc/?`）+ 草稿按单隔离 | `lib/console-keys.js`、`console-draft.js` | 连续处理 |
| E44 | 未规定断点 → 1440 全展开 / 1280 最小 / <1280 右栏让位 + 提示 | `console.css:8` | 1280 以下不硬塞三栏 |
| E45 | 未规定 SLA 前端重算 → **30s** 本地重算，优先 `due_at` | `lib/console-sla.js:82` | 自愈休眠/改时钟 |

### 2.7 文案（E23、E46–E47）

| # | 偏差 | 证据 | 影响 |
|---|---|---|---|
| E23 | 只提"长度告警" → **显示宽度**口径（CJK 记 2 列），当前 **40 条**，不拦提交 | `scripts/check-i18n.ts:45` | `es` 长词为主；德语靠 `hyphens:auto` |
| E46 | 127 是一个数字 → 按**算式**断言（11 组各带条数） | `scripts/check-i18n.ts:33` | 改表忘改文档会被拦 |
| E47 | 服务端拼文本缺 key 未定义 → `t()` 返回 **`null`**（不回落 key 原文） | `src/core/i18n-table.ts:118` | 德语答复里不会露出 `fault.source` |

### 2.8 验收（E11–E12、E52）

| # | 偏差 | 证据 | 影响 |
|---|---|---|---|
| E11 | 只有一套误拒率 → 增加**透明口径**（含 4 道纯故障码正例）= **0.2，未达标** | `docs/output/eval-20261027-165954.md` | mock LLM 不调 `fault_code_lookup`；真模型走快路不受影响 |
| E12 | 四条命令 → **九项门禁**（G1–G4 + L1–L5）+ 三档模式 | `scripts/verify.sh` | `[skip]` 不等于通过 |
| E52 | 延迟/成本有门槛 → **未自动化**，只留可观测点 | `done.latency_ms`、快路 `ms`、`ai_runs.cost_usd` | 无法在 CI 里守住首字 3s |

---

## 3. L 系列：已知限制（L1–L12，状态已复核）

| # | 限制 | 状态 |
|---|---|---|
| L1 | 会话不持久化，进程重启丢进行中会话 | 仍成立（ADR-0002） |
| L2 | 单实例并发上限 5，超限排队 | 仍成立 |
| L3 | 五语中 nl/es 语料只覆盖保修与安装 | **已变化**：实际 nl 2 篇 / es 2 篇（install+warranty），zh/en/de 各 3 篇（多 spec）。片段数 nl 10 / es 10，仍过"每语 ≥8"门槛 |
| L4 | 扫描版 PDF 不支持 | 仍成立（`no_text_layer`） |
| L5 | 无登录体系，坐席端靠固定 token | 仍成立 |
| L6 | 数据保留/清理任务未实现 | 仍成立（上线前必须补） |
| L7 | 坐席端知识库 / 未命中池 / 看板未实现 | 仍成立（三个 `disabled` 导航） |
| L8 | 数据层与应用层两个 compose，启动两步 | 仍成立 |
| L9 | 前端无构建链、无类型检查 | 仍成立 |
| L10 | 换嵌入模型需重建 `chunks` 表 | 仍成立（= E7） |
| L11 | 坐席端仅中文 | 仍成立（`console.*` 不许进文案表） |
| L12 | 故障码快路不出引用角标 | 仍成立（快路不发 `citations`） |

---

## 4. 历史勘误（不复制，只指路）

v1.1 之前文档（`docs/output/task.md` v3、`docs/prd/` v2.0）的错误与修正，**原样保留**在
`docs/prdv1.1/16-risks-errata.md` §3（E1–E18）与 §4（被推翻的假设）、§5（未验证假设）。
本版**不重编号、不复制**——那份表的价值是"当时为什么改了"，它属于历史，不属于 as-built。

---

## 5. 本版新增的假设（仍未验证的前提）

| # | 假设 | 怎么验 | 不验的后果 |
|---|---|---|---|
| A1 | 真实 DeepSeek 下德语/荷兰语回答质量足够 | 手问 5 个典型问题 | 换模型（成本与延迟翻倍） |
| A2 | 真模型会主动调 `fault_code_lookup`（而不是走 `kb_search`） | 手问 4 道纯故障码题 | 透明口径的 0.2 会变成真实用户体验 |
| A3 | 浏览器里 60 条气泡上限够用（超长会话会被截断 DOM） | 连问 70 轮 | 用户看到滚动上限 |
| A4 | `pg_dump` 备份在"表很多但数据少"的演示规模下够快 | 实测一次 | 上线前要换逻辑备份/物理备份 |
