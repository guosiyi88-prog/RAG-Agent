# 16 · 风险与勘误

## 1. 风险登记册

| # | 风险 | 概率 | 影响 | 触发信号 | 应对 | 责任 |
|---|---|---|---|---|---|---|
| R1 | Pi SDK 版本升级破坏 API | 低 | 中 | 启动报 extension 加载失败 | `package.json` 精确锁 `1.4.0`，`npm ci` 部署 | 后端 |
| R0 | **数据层镜像缺 pgvector** | **高** | **阻断** | `create extension vector` 报错；`pg_available_extensions` 查无 `vector` | `data/.env.example` 已是 `pgvector/pgvector:pg16`；老 `.env` 要手改 + `db.sh destroy && db.sh up`；T00 第 6 项必须验证 | 运维 |
| R0b | 数据层连接串与 PRD 不一致（Redis 有密码、库名 `wt_dev`、bucket `wt-dev`） | **高** | 高 | 启动 `NOAUTH` / bucket not exist | 连接串一律由 `./data/scripts/db.sh env` 生成，禁止手写 | 运维 |
| R2 | 容器内 Pi 读不到模型配置 | 中 | **高** | `/healthz` pi=false，日志报 no model | T00 必须先验证；容器内写一份最小 `models-store.json` | 后端 |
| R3 | PDF 解析失败（扫描件） | 中 | 中 | `status=failed`，`err=no_text_layer` | 前端「粘贴文本入库」；语料改为 txt | 后端 |
| R4 | 五语语料翻译质量差 | **高** | 高 | 荷兰语/西语回答生硬、术语错 | 中文源打满；术语表锁死；de 全审、nl/es 抽 20%；不够就降三语并写进 README | 内容 |
| R5 | 跨语种检索 hit@5 不达标 | 中 | 高 | `make eval` hit<70% | 先查 `lang = any()` 是否漏写；再查 RRF 归一化；最后调 `VEC_CANDIDATES` 20→40 | 后端 |
| R6 | 100% 拒答 | 中 | **高** | 所有问题都回固定话术 | 几乎必然是"用 RRF 原始分和 0.30 比"。查 `07-retrieval.md` §5.1 | 后端 |
| R7 | 模型越界承诺折扣/交期 | 中 | 高 | 回答出现"可以打折""保证两周" | 输出过滤词表 + 拒答三段式，不靠模型自觉 | 后端 |
| R8 | 引用造假（编造 `[3]`） | 中 | 高 | 角标点开无内容 | 后端强校验 `n ∈ 候选集`，不合格整条降级拒答 | 后端 |
| R9 | 用户端被刷建单 | 中 | 中 | tickets 表暴涨 | 匿名 token + 3 张/小时 + 同 conv 幂等 | 后端 |
| R10 | 微信内置浏览器不流式 | 中 | 中 | iOS 微信里回答一次性出现 | 用 `fetch` + `ReadableStream`，不用 `EventSource` | 前端 |
| R11 | 德语长词撑破 UI | 中 | 低 | 按钮文字溢出 | `overflow-wrap:anywhere` + 最小宽 + 德语全量过一遍 | 前端 |
| R12 | 内存随会话上涨 | 低 | 中 | RSS > 1.2GB | 并发上限 5 + 10 分钟回收 + 每分钟巡检 | 后端 |
| R13 | 10 小时装不下 | **高** | 高 | 某卡超时 30 分钟 | 熔断降级；连续两卡超时切 `01-scope.md` Plan C 收敛 | 全员 |
| R14 | 演示现场网络抖动 | 中 | 高 | 模型超时 | 录屏兜底 + `LLM_PROVIDER=mock` | 全员 |
| R15 | Pi 遥测误开 | 低 | 中 | 请求头出现 `pi/1.4.0` 归因 | `.env` 固定 `PI_TELEMETRY=0`，compose 里也写 | 后端 |

---

## 2. 已关闭风险

| 风险 | 结论 | 依据 |
|---|---|---|
| Pi 向 pi.dev 上传会话 | **不存在**。`enableInstallTelemetry` 只影响发往模型厂商的归因头（OpenRouter 的 `HTTP-Referer`、NVIDIA 的 `X-BILLING-INVOKE-ORIGIN`），不发往 pi.dev | `dist/core/telemetry.js`、`dist/core/client-identity.js`、`dist/bundle/chunks/chunk-H76KZMOI.js` |
| Pi 默认关闭遥测 | **不成立**。`settings-defaults.js` 里 `enableInstallTelemetry: true` | 同上 → 处置为 `PI_TELEMETRY=0` |

---

## 3. 勘误表（历史文档的错误，逐条留存）

### 3.1 `docs/output/task.md` v3

| # | 错误 | 实际 | 证据 |
|---|---|---|---|
| E1 | 用 `pi --mode rpc` 子进程池 | SDK 是进程内 TS，无 `--mode`/`--no-builtin-tools`/`--session-dir` | 官方 SDK 文档 |
| E2 | 自定义工具 `customTools` 直传 | 必须经 extension 的 `pi.registerTool()`，`tools:[]` 只做选择 | `examples/sdk/05-tools.ts` |
| E3 | 默认 system prompt 可用 | 默认面向编码助手 | `examples/sdk/03-custom-prompt.ts` |
| E4 | 历史从 PG 塞 prompt | `SessionManager` 是上下文权威 | SDK 文档原话 |
| E5 | `agent_before_settle` 里发消息出拒答话术 | 文档未保证该阶段再触发模型 | extensions 文档 |
| E6 | 单会话成本 < $0.01 | 六轮口径约 $0.0126，上限应 $0.03 | 算术重算 |
| E7 | hit@5 未定义 | 未定义 = 不可测 | `14-verification.md` §7 |
| E8 | 用户端无鉴权 | 会被灌单 | `05-api.md` §1 |
| E9 | 12 小时装 16 项 | 实际约 20 小时 | `15-tasks.md` §3 |
| E10 | 跨语种检索未设计 | 五语副本互相稀释 | `07-retrieval.md` §2 |

### 3.2 `docs/prd/` v2.0

| # | 不足 | v1.1 处理 |
|---|---|---|
| E11 | 只有功能列表，无页面级规格 | `10`/`11` 补到 DOM 契约与函数表 |
| E12 | 无目标文件树 | `02-architecture.md` §2 |
| E13 | 算法只有描述，无可直译伪代码 | `07-retrieval.md` §7 |
| E14 | 无任务顺序 | `15-tasks.md` 全篇 |
| E15 | 验收不可执行 | `14-verification.md` §2 脚本 |
| E16 | 无 i18n key 表 | `12-i18n.md` §4（127 条） |
| E17 | 三个落地文件无处安放 | `03`/`04`/`13` 各按契约落位 |
| E18 | 没有给 AI 的操作纪律 | `17-ai-brief.md` |

---

## 4. 本次拷打中被推翻的假设

| # | 原假设 | 为什么错 | 何时会炸 |
|---|---|---|---|
| 1 | 三份文件（compose/DDL/package.json）单独放 `middleware/` 更方便 | `middleware/` 语义是 HTTP 中间件，会造成误 import；且规格与实现分家必漂移 | 第一个人接手时 |
| 2 | "写细一点" 就等于 "AI 能执行" | AI 缺的不是细节数量，是**边界、接口、顺序、断言**四类硬信息 | 开工第 2 小时就开始猜 |
| 3 | 五语只是多翻几份文档 | 检索层五语副本会互相稀释 | 评测时 hit@5 腰斩 |
| 4 | 拒答靠 prompt 就行 | 模型说"不知道"有 100 种说法 | 演示时答了不该答的 |
| 5 | 12 小时能做完 16 项 | 每轮加功能都没重算 | 最后一晚 |
| 6 | 引用角标前端渲染即可 | 后端不校验就是给模型造假机会 | 客户第一次点角标 |
| 7 | 匿名用户没风险 | 建单接口敞开 = 数据污染 | 上线第一天 |

---

## 5. 假设清单（本文档依赖但未验证的前提）

| # | 假设 | 验证方式 | 未验证的后果 |
|---|---|---|---|
| A1 | Node 22.19 的 `--experimental-strip-types` 能直接跑本项目所有 `.ts` | T00 跑一个 import 链验证 | 要退回 tsx 或加编译步骤 |
| A2 | 容器内 Pi 能读到模型凭据 | T00 跑一次真实 prompt | T05 才炸，返工 2 小时 |
| A3 | DashScope `text-embedding-v3` 支持 `dimension: 1024` 且跨语种对齐可用 | T03 灌五语（zh/en/de/nl/es）后看跨语检索 | 检索质量不达标 |
| A4 | `pdftotext -layout` 对现有手册版式提取质量足够 | T03 跑一份真实 PDF | 改粘贴文本入库 |
| A5 | 修复后 `chunks` 的 `tsvector('simple')` 对短术语（E03）够用 | T04 自测用例 1 | 全文路失效，仅靠向量 |
| A6 | 德语提问时 DeepSeek Flash 的德语质量足够 | T05 第一条德语请求 | 换 pro 或换模型 |
| A7 | ~~DashScope `text-embedding-v3` 单批可送 16 条~~ **已证伪**：实测上限 10 条，11 条即 400 `InvalidParameter` | T03 真实调用 | 整批失败、入库全红；已把批大小改为 10 |

---

## 6. 已知限制（单一来源）

> 其他文档只引用本节，不重复列举。

| # | 限制 | 原因 | 可否接受 |
|---|---|---|---|
| L1 | 会话不持久化，进程重启丢进行中会话 | `SessionManager.inMemory()`，见 ADR-0002 | 可接受（会话平均 6 轮） |
| L2 | 单实例并发上限 5，超限排队 | 单进程 + 每会话约 100MB | 演示可接受 |
| L3 | 五语中 nl / es 语料只覆盖保修与安装两节 | 语料产出时间限制 | 可接受，README 说明 |
| L4 | 扫描版 PDF 不支持 | `pdftotext` 取不到文本层 | 可用「粘贴文本入库」绕 |
| L5 | 无登录体系，坐席端靠固定 token | 本期范围外 | 可接受（内网演示） |
| L6 | 数据保留清理任务未实现（90 天策略未生效） | 本期范围外 | 上线前必须补 |
| L7 | 坐席端知识库 / 未命中池 / 看板三页未实现 | Plan C 范围 | 已列入 P1 |
| L8 | 数据层与应用层分两个 compose，启动两步 | 生命周期不同，见 `13-ops.md` §1 | 可接受 |
| L9 | 不引入构建链，前端无类型检查 | 见 ADR-0005，靠 G4 闸门人读代码 | 可接受 |
| L10 | 换 embedding 模型需重建 `chunks` 表 | 维度锁死 1024 | 可接受（演示规模） |
| L11 | 坐席端仅中文，不做五语 i18n | 内部工具 + 时间预算；`12-i18n.md` key 表只覆盖用户端 | 可接受（见 `11-ui-console.md` 顶部例外） |
| L12 | 故障码快路不出引用角标 | 数据来自 `fault_codes` 表，没有 chunk 可追溯 | 可接受；原文追溯只在对话路径可用 |

---

## 7. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0（task.md） | 2026-10-27 | 初版工单，RPC 架构 |
| v2.0（prd/） | 2026-10-27 | 转 SDK，补指标与风险 |
| **v1.1（prdv1.1/）** | 2026-10-27 | 按"AI 可执行"标准重拆 18 个文件；补文件树、DOM 契约、算法伪代码、142 key、任务卡、断言脚本 |
| **v1.1.1** | 2026-10-27 | 对齐 `data/` 既有基础设施：pgvector 镜像、Redis 密码、`wt_dev` 库、`wt-dev` bucket、两层 compose 分层、`.env` 由 `db.sh env` 生成；新增 R0/R0b 风险与 §6 已知限制单一来源 |
| **v1.1.2** | 2026-10-27 | 一致性修复（见 §8）：`model` 改传 `Model` 对象 + `thinkingLevel:"off"`；`typebox` 换包；所有 node 命令加 `--env-file-if-exists`；`.env` 生成改用 `grep -oE` 并补 `POSTGRES_*`；语料移出 `data/` 到 `corpus/` 且补齐 en/es；i18n 由 142 改为实测 127 并把拒答话术收归 `refusal.ts`；`topScore`/`fallback` 补进 `/internal/search` 契约；保留端点补进端点总表；检索 SQL 只留 `07` 一处 |
| **v1.1.3** | 2026-10-27 | 语料工单（`02-corpus-ingestion` #02）收口，文档对齐已落地的语料与自检脚本：`08` §9 换成真实的 `.md` 清单（含「参数表只有 zh/en/de」与 `fault_codes.json` 改道小节）、§10 改为「`make corpus-check` / `make corpus-terms` 为主、手查 SQL 为附录」并逐个列出阈值、§8 输出示例与 §6 写入字段对齐实现；`04` §2/§3 补上库表写入方与 `documents.status` 三态、seed 与语料 upsert 的关系；`15` T03 验收改为一键断言；`02` §2 文件树补 es 语料与两个自检脚本。同日补：`08` §6/§10.1 增「改完文件重跑入库，旧版本在同一事务里退场」与「多版本 = 0」阈值；`14` §3 的语种断言由 `>= 3` 改为 `= 5`（五语语料已到位）；`15` T03 产出移除从未创建的 `scripts/mock-embed.ts`（§5.3 改写为「自检走测试断言」） |

| **v1.1.4** | 2026-10-27 | 检索核心（`03-hybrid-retrieval` #02）收口：`07` §3 的查询构建算例自相矛盾——表里标「24 字符」的 `"Und wie viel Watt?"` 实际 18 字符，标「直接用，不拼」的中文例句实际 22 字符、按同节 `length <= 25` 的分支必须拼接。按「分支以字符数为唯一判据」修正表格：写真实字符数、换一条真正 >25 字符的长问句做反例，并写明中文 22 字仍会拼接、要改只改 `QUERY_STITCH_MAX_CHARS`（不新增「按字数折算」的分支）；同时 `07` §1/§5.1/§6/§7 的 `retrieve()` 契约在 `src/core/retrieval.ts` 落地（新增 `retrieve()` 与 `POST /internal/search`，`fallback ∈ {none,fts_only,empty}`） |
| **v1.1.5** | 2026-10-27 | **`07` §5.1 的归一化被证伪（活体实测）**：归一化是纯排名信号，任何有向量命中的查询都排第一 → 必得 0.8/1.0，无关问题（`今天天气怎么样` 余弦 0.419、`20% korting` 0.456）与相关问题的归一化分完全相同，`topScore < 0.30` 永不成立。新增 `07` §5.2「最终分」：`score = 归一化 RRF × 余弦²`（余弦缺失按 1，全文路独有片段不因缺向量被判无关），实测正例 0.421/0.434/0.470、反例 0.140/0.166，`0.30` 重新有区分力；`07` §8 与 `14` §3 的断言口径同步改为「融合分」 |

---

## 8. v1.1.2 一致性修复清单

> 每条都是「两个文档说法不一致，开发 AI 只能猜」的问题，现统一为「现口径」这一处真源。

| # | 原问题 | 现口径 | 落在哪 |
|---|---|---|---|
| 1 | `model` 传字符串 | 传 `Model` 对象：`modelRuntime.getModel(provider, id)` | `02` §4.1、`06` §1 |
| 2 | 模型默认开思考，首字必超 | 固定 `thinkingLevel: "off"` | `02` §4.1、`03` §5、`14` §7 |
| 3 | 工具参数用了旧包 | `typebox` v1（与 SDK 内置 1.3.27 一致） | `03` §2 |
| 4 | `.env` 从未被 node 加载 | 所有 script 带 `--env-file-if-exists=.env` | `03` §2 |
| 5 | `db.sh env \| grep -E '^…'` 一行都匹配不到 | 改 `grep -oE` 抽 `KEY=value` 片段 | `13` §4.1/§6、`15` T00 |
| 6 | 应用 compose 引用未定义变量 | `.env` 追加 `POSTGRES_*` / `REDIS_PASSWORD`，URL 用 `${POSTGRES_USER}`/`${POSTGRES_DB}` | `13` §3.2/§4.1/§4.2 |
| 7 | 语料放在 `data/`，与数据层冲突 | 移到根 `corpus/` | `02` §2、`08` §8/§9、`13` §5、`14` §4、`15` T03/T10 |
| 8 | compose 两个名字 | 只叫 `docker-compose.app.yml` | `02`、`13`、`15` T01、`README` |
| 9 | 语料清单缺 en，测评集却考 en/es | en/es 全部列必需，五语各 ≥8 块 | `08` §9、`15` T03、`14` §2 |
| 10 | 无 `[n]` 时不拒答 | `finalize()` 五条判定，②③④全覆盖 | `06` §5.1、`05` §3.2 |
| 11 | `/internal/search` 没有 `topScore` | 契约补 `topScore` + `fallback` | `05` §5.1、`14` §2、`15` T04 |
| 12 | 保留端点不在端点总表 | draft / translate / export / stats 四条入表 | `05` §2、`01` §1.2 |
| 13 | i18n key 数三处不同（140/142/实测） | 实测 **127**，算式写进文档 | `12` §4、`01` §3、`15` T09、`16` E16 |
| 14 | 拒答话术两个真源 | 只在 `core/refusal.ts` 的 `REFUSAL` | `06` §5.3、`12` §4.10 |
| 15 | 回落链 `zh→en` | 统一 `→ en` | `01` §3、`12` §2 |
| 16 | 令牌名不存在、出现裸色值 | 新增 `--u-primary-ink`、`--c-on-primary`、`--c-st-other` | `09`、`11` §2.3/§6 |
| 17 | 用户端 DOM 硬编码中文 | 全部挂 `data-i18n*`；坐席端明示例外 | `10` §1、`11` 顶部、`12` §7 |
| 18 | `process.env` 出现在 healthz | 改 `config.S3_BUCKET` | `05` §7 |
| 19 | 引用合法率当作渐近指标 | 定义为恒等于 1 的校验不变量 | `01` §2、`14` §7 |
| 20 | T00 项数 5/7 两说 | 9 项（补模型对象与首字延迟） | `15` T00、`17` §8 |
| 21 | 检索 SQL 两份（`04` §5 与 `07` §4） | 只留 `07`，`04` 只强调语言过滤 | `04` §5 |
| 22 | `settings` 表与 `config.ts` 谁优先未定 | DB 覆盖 env 默认值，无第三份 | `04` §3、`06` §7 |
