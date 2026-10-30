# 01 · 范围与总验收（as-built）

> 本章回答三个问题：**实际交付了什么**、**哪些只是占位**、**验收指标的实测值是多少**。
> 所有"有/没有"都指到证据；指标一律给实测口径，不给目标值。

---

## 1. 实际交付面

### 1.1 用户端（9:16 手机框，五语）

| 能力 | 行为 | 证据 |
|---|---|---|
| 流式对话 | SSE 逐字出字；帧序 `meta → tool? → delta* → citations? → refusal? → done`；`error` 之后只关流 | `src/api/chat.ts:563`、`src/static/user.js` |
| 引用角标 + 抽屉 | 每个结论后 `[n]`；点开见文档名、页码、语种徽章、原文片段；快照来自 `citations` 表 | `src/core/citations.ts`、`src/static/lib/cite-sheet.js` |
| 故障码页 | 输入 `E03` 走主键直查（不建会话、不调模型、不嵌入）；未命中是 `found:false` 不是错误 | `src/api/fault.ts:106`、`src/static/views.js` |
| 转人工 | 表单（邮箱 + 问题）→ `WT-YYYY-NNNN`；同一邮箱同一问题幂等；每令牌每小时 3 张 | `src/api/ticket.ts:75`、`src/core/ticket-public.ts` |
| 工单进度查询 | **v1.1 列为"UI 不做"，实际做了**：单号 + 邮箱查状态 | `src/static/views.js`（`VIEWS = ["chat","fault","ticket","me"]`） |
| 全局语言切换 | 五语；`POST /api/i18n/:lang` 拉文案表 → 覆盖 `document.documentElement.lang` + `localStorage` | `src/api/i18n.ts`、`src/static/lib/lang.js` |
| 我的 / 清除本地数据 | 清掉 `localStorage` 里的语言、令牌、最近查询 | `src/static/index.html`（`data-view="me"`） |

### 1.2 坐席端（1440×810，只中文）

| 能力 | 行为 | 证据 |
|---|---|---|
| 队列 | 5 秒轮询；按 SLA 排序；状态/原因筛选；分页；新单高亮 | `src/api/console.ts:227`、`src/static/console.js` |
| 详情三栏 | 左列表 / 中对话 / 右处置；会话消息含 AI 的引用与 `no_evidence` 标记 | `src/core/ticket-queue.ts`（`getTicketDetail`） |
| 认领 / 关单 | 认领写 `assignee`；关单必须过结论阈值，`closed` 后不可再改（触发器硬拦） | `src/core/ticket-queue.ts:406`、`sql/001_init.sql:187` |
| 连续处理 | 键盘：`j/k` 上下、`Enter` 进入、`Esc` 返回；发送 = `Ctrl+Enter` | `src/static/console.js`（`onKeydown`） |
| 草稿隔离 | 每张单一份草稿，防抖写 `localStorage`，切单不串 | `src/static/lib/console-draft.js` |
| 复制 | 复制单号 / 复制本单链接 | `data-act="copy-no"`、`data-act="copy-link"` |
| 统计 | 真实聚合（工单总数/待办/按状态/运行数/拒答率/平均剩余 SLA），不做图表 | `src/api/console.ts:253` |
| 占位导航 | 知识库 / 未命中池 / 看板三个导航项 `aria-disabled="true"`，点了不动 | `src/static/console.html:50` |

### 1.3 后端能力

| 能力 | 口径 | 证据 |
|---|---|---|
| 三档鉴权 | 用户令牌（Redis `sess:{uuid}`）/ 坐席固定令牌 / 内部回环 + 令牌 | `src/auth.ts` |
| 混合检索 | 向量 + 全文双路 → RRF → 归一化 → 后处理；语言过滤 `lang = any(...)` | `src/core/retrieval.ts` |
| Agent 四工具 | `kb_search` / `fault_code_lookup` / `ticket_create` / `ticket_lookup`；白名单外 fail-closed | `src/ext/support.ts` |
| 故障码快路 | 纯故障码整条匹配 → 主键直查；命中不发 `tool`/`citations` 帧 | `src/core/fastpath.ts`、`src/api/chat.ts:468` |
| 拒答三段式 | 判定纯函数 → 固定话术（不经模型）→ 建单 → `refusal` 帧带单号 | `src/core/refusal.ts`、`src/api/chat.ts:510` |
| 引用校验与快照 | 角标必须落在本轮候选集内；快照冻结标题/页码/片段，chunk 删除不影响历史 | `src/core/citations.ts`、`src/core/citation-store.ts` |
| 记账 | 每次 `done` 前写 `ai_runs`，累加 `conversations.total_cost_usd` | `src/core/run-log.ts` |
| 会话池 | 进程内上限 5、闲置 10 分钟回收、Redis 租约 600s | `src/core/agent.ts` |

### 1.4 工程与交付物

| 交付物 | 状态 | 证据 |
|---|---|---|
| 可运行仓库（`node src/server.ts` 一条命令） | ✅ | 根 `README.md` §2 |
| 数据层一键起停 | ✅ `data/scripts/db.sh`（独立 compose project `wt-infra`） | `data/docker-compose.yml` |
| `make demo` / `make reset` / `make ingest` / `make eval` | ✅ | `Makefile` |
| 五语文案表 + 校验 | ✅ 127 key × 5，脚本五条断言 | `src/static/i18n.json`、`scripts/check-i18n.ts` |
| 30 题评测 + 多轮 5 题 | ✅ 报告落 `docs/output/eval-*.md` | `scripts/eval.ts`、`corpus/.fixtures/qa_gold.json` |
| 双尺寸截图各 5 张 | ✅ `user-390x844-0{1..5}`、`console-1440x810-0{1..5}`（另加 1280×720 窄窗两张） | `docs/output/*.png` |
| 3 分钟演示脚本 | ✅ | `docs/output/demo-script.md` |
| 提交前九项门禁 | ✅ `scripts/verify.sh` | `docs/output/gate.md` |
| 3 分钟演示**录屏** | ❌ 无（截图有，视频没有） | — |
| 答辩材料 ≤10 页 | ❌ 不在本仓 | — |

---

## 2. v1.1 的 9 项 MUST：状态

| ID | v1.1 的验收 | 实际 | 证据 |
|---|---|---|---|
| U1 多语种流式对话 | 德语问 → 德语答，逐字出现 | ✅ | L4 门禁、`tests/chat-stream.test.ts` |
| U2 引用角标与抽屉 | 每条答案 ≥1 角标，点开有文档名+页码+原文 | ✅（拒答轮除外，拒答不发 `citations`） | `tests/chat-citations.test.ts` |
| U3 故障码直查 | `E03` 1s 内出卡、不调模型 | ✅（P95 < 20ms 是设计预算，实测见 §3） | `tests/chat-fastpath.test.ts` |
| U7 转人工建单 | 填邮箱 → 返回 `WT-YYYY-NNNN` | ✅ 幂等 + 配额 3/小时 | `tests/ticket-public.test.ts` |
| A1 工单队列 | 新单 5s 内出现，按 SLA 排序 | ✅ | `tests/console-api.test.ts` |
| A2 工单详情 + 采纳 AI 答复 | 采纳后回复框有内容 | ⚠️ **改了形态**：没有"一键采纳"，改为"AI 消息可读 + 引用可点 + `no_evidence` 标记 + 手写回复框（草稿自动存）" | `src/static/console.js`、`console-view.js` |
| R1 混合检索 | hit@5 ≥ 70% | ✅ 实测 **1.00**（16/16） | `docs/output/eval-20261027-165954.md` |
| R2 拒答三段式 | 问折扣 → 固定话术 + 自动建单 | ✅ | `tests/chat-refusal.test.ts` |
| U9 五语 UI 切换 | 127 key × 5 语 | ✅ | `tests/i18n-check.test.ts` |

**超出 v1.1 范围的交付**（这些都是 v1.1 说"不做/预留"的）：

1. **工单进度查询 UI**（U8 从"UI 不做"升为已做）。
2. **坐席端键盘连续处理**（v1.1 只要求"队列和详情顺"）。
3. **坐席端每单草稿隔离**（v1.1 没有）。
4. **`no_evidence` 证据标记**（v1.1 没有；坐席据此判断能不能直接采纳）。
5. **五语文案校验脚本 + 术语机检**（v1.1 只要求文案表）。
6. **30 题评测 + 多轮 5 题 + `eval_runs` 落表**（v1.1 有要求，但实现了完整报告链）。
7. **九项门禁脚本**（v1.1 是四条命令）。

---

## 3. 验收指标：门槛 vs 实测

| 指标 | v1.1 门槛 | 实测（真嵌入 + mock LLM，2026-10-27） | 口径 |
|---|---|---|---|
| hit@5 | ≥ 0.70 | **1.0000**（16/16） | 正例题里「引用事件的 `doc_id` ∈ 期望集合」的占比 |
| 引用合法率 | = 1.00 | **1.0000**（16/16） | 有引用事件的题里，所有 `[n]` 都合法 |
| 拒答准确率 | ≥ 0.90 | **1.0000**（10/10） | 反例题出现 `refusal` 且该会话工单 +1 |
| 误拒率（严格口径） | ≤ 0.10 | **0.0000**（0/16） | 有文档期望的正例题里出现拒答 |
| 误拒率（透明口径） | ≤ 0.10 | **0.2000**（4/20）❌ | 把 4 道**纯故障码正例**也算进分母：mock LLM 只调 `kb_search`、不调 `fault_code_lookup`，于是必然拒答 |
| 首字延迟 P95 | < 3s | 未纳入自动门禁（手工） | `verify.sh` 只验帧齐全，不算延迟 |
| 单轮延迟 P95 | < 8s | 未纳入自动门禁 | 同上 |
| 故障码直查 P95 | < 1s | 未纳入自动门禁（日志里打 `ms`） | `chat.ts:358` 的 `lookupMs` |
| 单会话成本 | < $0.03 | 未统计 | `conversations.total_cost_usd` 有数据，无断言 |
| `/healthz` 四项 | 100% 为真 | ✅ | L1 |

**两条必须说清的事**：

1. **hash 兜底向量不能用于验收**。同一天用 `EMBED_BACKEND=hash` 跑同一套题：hit@5 = 0.0000、误拒率 = 0.9375（`docs/output/eval-hash-mode.md`）。hash 模式只用于"没 Key 也能启动"，任何指标结论都必须标明后端。
2. **透明口径的 0.2 是已知缺口，不是 bug**：mock LLM 不会调 `fault_code_lookup`，所以纯故障码正例必然被拒。真模型下这些题走快路（`E03` 不进模型），不受影响。登记在 `16` §2。

---

## 4. 预留 ≠ 没做：边界表（最容易被误读的一张）

> **注意（2026-10-28，`09#06` 收口时补）**：本表**截止 `09#03`**，`09#04`–`09#06` 之后已经有多行过期：
> A4 知识库有了 CRUD + 重建 + 回滚面板（`09#05`）；A5 未命中池 → FAQ 草稿 → 审批入索引整条链路已落地
> （`09#06`，`src/core/faq-store.ts`）；A6 看板是真面板（`09#04`）；A3 里的 `POST /api/console/draft`
> **不再是 501**，它现在是转 FAQ 草稿的真接口（只有 `translate` / `export` 仍是 501）。
> 权威现状以 `AGENTS.md` 与 `.scratch/09-admin-console/issues/` 为准，本表留作 `09#03` 时的快照。

| 预留项 | v1.1 的说法 | 实际 | 证据 |
|---|---|---|---|
| A3 AI 起草 / 翻译 | 返回 501 | ✅ **确实 501**：`POST /api/console/draft`、`/translate`、`/export` 三个路由**真实存在、也照样要令牌**，行为固定 `501 NOT_IMPLEMENTED` | `src/api/console.ts:224` |
| A4 知识库管理 UI | 数据表建好，上传走 CLI | ✅ 无 UI；三个导航项 `disabled` | `src/static/console.html:50` |
| A5 未命中池转 FAQ | `v_no_hit` 视图建好，UI 不做 | ✅ 视图在（`sql/001_init.sql:319`），UI 无；坐席端有 `data-act="faq"` 按钮但走的是未开放路径 | `console-view.js` |
| A6 数据看板 | `/api/console/stats` 真实聚合，不做图表 | ✅ 聚合真实，导航项 `disabled` | `src/api/console.ts:253` |
| A7 会话导出 | 返回 501 | ✅ 501 | 同上 |
| U5 会话历史侧栏 | 数据存好，UI 不做 | ✅ 无 UI（`conversations`/`messages` 有数据） | — |
| U6 反馈按钮 | **接口实现**，UI 不做 | ❌ **接口也没实现**：全仓没有 `/api/feedback` | `grep -r feedback src/` 为空 → E3 |
| U8 工单进度查询 | 接口实现，UI 不做 | ✅ **接口 + UI 都做了** | `src/static/views.js` |

---

## 5. 明确不做（沿用 v1.1 §1.3，实现期新增两条）

1. 登录/注册 · 2. 多租户 · 3. sub-agent / plan mode · 4. codemode / tool_search / MCP · 5. 图片多模态 · 6. CRM/邮件/WhatsApp · 7. Zendesk/Copilot API · 8. query 改写 · 9. 独立 reranker · 10. 前端构建链 · 11. 单元测试铺开（只测接缝） · 12. 语音 · 13. 移动端横屏 · 14. 深色模式精修 · 15. Excel 导出 · 16. Pi 源码 fork

> **第 1 条已被 `09#03` 推翻**（`docs/output/boundary-change-R2.md`，2026-10-27 签字）：坐席端现在是
> **邮箱 + 口令登录 + 服务端会话票据 + 三级角色**。**用户端仍是匿名令牌**，不注册、不登录 ——
> 推翻的只是"坐席也共用一枚固定令牌"这件事，不是"用户要注册"。

**实现期新增的两条边界**（v1.1 没写，代码里已固化）：

17. **不做持久化会话**：上下文只活进程内存（ADR-0002）；`messages` 表只用于记录/回放，不做上下文回灌（`sql/001_init.sql:105`）。
18. **不做跨进程会话迁移**：会话池是进程内的，多实例部署时会话不共享（`src/core/agent.ts` 的 Map + Redis 租约只解决"存活判断"，不解决"迁移"）。

---

## 6. 角色与取舍（未变）

| 角色 | 优先级 | 取舍 |
|---|---|---|
| P1 欧洲安装商（手机、现场） | 最高 | 宁可少功能，不能慢、不能错 |
| P2 终端业主（手机、夜间） | 中 | 能用就行 |
| P3 售后坐席（桌面） | 高 | 队列和详情必须顺 |

**裁决顺序**：正确性 > 速度 > 功能数 > 美观。

---

## 7. 与 v1.1 的差异（本章）

| # | 差异 | 详见 |
|---|---|---|
| 1 | `/api/feedback` 未实现（v1.1 要求接口实现） | 16 §2 E3 |
| 2 | A2「采纳 AI 答复」改为「证据标记 + 手写回复」 | 16 §2 E9 |
| 3 | U8 工单进度**做了 UI**（v1.1 说 UI 不做） | 16 §2 E10 |
| 4 | 透明口径误拒率 0.2 未达标（已知缺口） | 16 §2 E11 |
| 5 | 门禁从"四命令"扩为"九项" | 16 §2 E12 |
