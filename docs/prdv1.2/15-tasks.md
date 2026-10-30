# 15 · 任务账与闸门（as-built）

> v1.1 的计划是 **12 张任务卡（T00–T11）**；真实落账是 **8 个 spec / 19 张工单**（`.scratch/`）。
> 本章记真实的账：谁覆盖了谁、卡在哪、现在什么状态。**计划账与真实账不是一一对应**，映射在 §1。

---

## 1. 计划 → 真实：映射

| v1.1 卡 | spec | 工单 | 主要产出 |
|---|---|---|---|
| T00 环境验证 | `01-foundation` | #01 | `docs/output/env-check.md`（9 项阻断验证） |
| T01 骨架与依赖 | `01-foundation` | #01 | `server.ts` / `routes.ts` / `config.ts` / `errors.ts` / `logger.ts` / `/healthz` |
| T02 数据层 | `01-foundation` | #02 | `sql/001_init.sql`、`sql/002_seed.sql`、`db.ts` / `redis.ts` / `storage.ts` |
| T03 入库与语料 | `02-corpus-ingestion` | #01 #02 | `core/ingest|chunk|clean|embed|hash-embed`、五语 13 篇、`check-corpus` / `check-terms` |
| T04 检索 | `03-hybrid-retrieval` | #01 #02 | `core/retrieval|fuse|query`、`/internal/search`、`/internal/retrieval/recall`、**G1** |
| T05 Agent | `04-agent-chat` | #01 #02 #03 | `core/agent`、`ext/support`（四工具）、快路、会话池、SSE、**G2** |
| T06 拒答 + 工单 | `05-refusal-and-tickets` | #01 #02 | `core/citations|citation-store|refusal`、工单生命周期、**G3** |
| T07 用户端 | `06-user-web-ui` | #01 #02 #03 | `index.html` / `user.js` / `views.js` / `lib/*`、**G4** |
| T08 坐席端 | `07-console-and-security` | #01 #02 | `auth.ts` 三档收敛、`console.*`、队列/详情/补丁/统计、**G5** |
| T09 文案 | `08-i18n-eval-handoff` | #01 | `i18n.json`（127×5）、`i18n-table.ts`、`check-i18n.ts` |
| T10 评测 | `08-i18n-eval-handoff` | #02 | `scripts/eval.ts`、`qa_gold` 30 题、`eval_runs`、`docs/output/eval-*.md` |
| T11 收尾 | `08-i18n-eval-handoff` | #03 | `scripts/verify.sh` 九项、`demo.ts`、双尺寸截图、`demo-script.md`、交付说明 |

**为什么拆成 19 而不是 12**：每个 spec 终止在**一个闸门或一个可交付物**上，且自身可独立验收。
`04-agent-chat` 拆三张是刻意的——装配、工具、快路/上限三件事的验收口径完全不同。

---

## 2. 19 张工单的真实账

| # | spec | 工单 | 阻塞于 | 闸门 | 状态 |
|---|---|---|---|---|---|
| 1 | 01-foundation | 环境验证与应用骨架 | — | — | ✅ 收口 |
| 2 | 01-foundation | 数据模型与数据访问模块 | 01#01 | — | ✅ |
| 3 | 02-corpus-ingestion | 入库流水线（单文档端到端） | 01#02 | — | ✅ |
| 4 | 02-corpus-ingestion | 五语语料与质量门槛 | 02#01 | — | ✅ |
| 5 | 03-hybrid-retrieval | 双路召回与语言过滤 | 02#02 | — | ✅ |
| 6 | 03-hybrid-retrieval | RRF 融合、归一化与后处理 | 03#01 | **G1** | ✅（含 E27 的分值勘误） |
| 7 | 04-agent-chat | Agent 装配与流式对话 | 03#02 | — | ✅ |
| 8 | 04-agent-chat | 四个业务工具齐活 | 04#01 | — | ✅ |
| 9 | 04-agent-chat | 故障码快路、连发与会话上限 | 04#02 | **G2** | ✅ |
| 10 | 05-refusal-and-tickets | 引用校验与快照落库 | 04#03 | — | ✅ |
| 11 | 05-refusal-and-tickets | 拒答判定、固定话术与工单生命周期 | 05#01 | **G3** | ✅ |
| 12 | 06-user-web-ui | 手机框与对话流 | 05#02 | — | ✅ |
| 13 | 06-user-web-ui | 引用抽屉与角标 | 06#01 | — | ✅ |
| 14 | 06-user-web-ui | 故障码页、转人工与语言切换 | 06#02 | **G4** | ✅ |
| 15 | 07-console-and-security | 三档鉴权与安全边界 | 05#02 | — | ✅ |
| 16 | 07-console-and-security | 坐席队列与详情处置 | 07#01 | **G5** | ⚠️ 代码收口，**读代码签字待补**（见 §3） |
| 17 | 08-i18n-eval-handoff | 五语文案与校验脚本 | 06#03 | — | ✅ |
| 18 | 08-i18n-eval-handoff | 评测跑分 | 05#02 | — | ✅ |
| 19 | 08-i18n-eval-handoff | 交付包与提交前门禁 | 07#02、08#01、08#02 | — | ✅ |

**可并行的两条边**（当时的事实）：`07#01` 与 `06#01` 都只依赖 `05#02`；`08#02` 只等 `05#02`。

---

## 3. 五个闸门：位置与现状

| 闸门 | 停在 | 审什么 | 现状 |
|---|---|---|---|
| **G1 检索核心** | 03#02 之后 | 双路 SQL、语言过滤、RRF/归一化、阈值口径 | ✅ 已过；本轮 `verify.sh` 的 L3 复验通过 |
| **G2 Agent 装配** | 04#03 之后 | 五条硬约束、四工具、fail-closed、hook 不发 HTTP | ✅ 已过；静态断言在 `tests/tool-registry.test.ts` |
| **G3 引用与拒答** | 05#02 之后 | 引用校验顺序、拒答四步、建单失败不发 `refusal` | ✅ 已过 |
| **G4 前端关键路径** | 06#03 之后 | 角标编号来自服务端、拒答覆盖气泡、语言不刷新 | ✅ 已过 |
| **G5 安全边界** | 07#02 之后 | 三档鉴权、令牌常数时间、内部 404、脱敏、工单不可变 | ⚠️ **代码已完成、门禁脚本全绿，但"人读代码签字"仍待补** |

G5 的待读清单在 `docs/output/review-07-08.md` 第四节：`src/auth.ts`、`src/api/console.ts`、
`src/core/ticket-queue.ts` 的 `updateTicket`、`src/server.ts` 的错误处理。
**`verify.sh` 的九项不能替代 G5**——它证明行为对，不证明"没有绕过路径"。

---

## 4. 未开卡与未完成（诚实清单）

| # | 项 | 现状 | 归属 |
|---|---|---|---|
| 1 | `POST /api/feedback` | v1.1 要求"接口实现" → **完全没做**（E3） | 缺口 |
| 2 | `scripts/perf-fault.ts` | v1.1 的 `npm run perf:fault` → 不存在（E16） | 缺口 |
| 3 | 数据保留/清理（90 天） | 未实现（L6） | 上线前必须补 |
| 4 | 坐席端知识库/未命中池/看板 | 三个 `disabled` 导航（L7） | P1 |
| 5 | 3 分钟演示录屏 | 双尺寸截图有 10 张，**视频没有** | 交付物缺口 |
| 6 | 答辩材料 ≤10 页 | 不在本仓 | 交付物缺口 |
| 7 | 延迟/成本自动化 | 只在日志有可测点（E52） | 缺口 |
| 8 | G5 人读签字 | 见 §3 | 流程缺口 |

---

## 5. 下一步（按"完成判据"写，不按"建议"写）

| 优先级 | 动作 | 完成判据 |
|---|---|---|
| P0 | 显式声明 `pino` 依赖 | `package.json` 有 `pino`；`npm ci --omit=dev` 后 `node -e "import('pino')"` 成功（E14） |
| P0 | G5 人读签字 | `review-07-08.md` 四节的四项各有"已读/通过"记录 |
| P1 | 真模型跑一遍 30 题 | `docs/output/eval-*.md` 的 LLM 维度写 `deepseek`，四项指标达门槛（当前证据是 mock LLM） |
| P1 | `feedback` 要么实现要么删表 | 二者之一落地，并在 `01` §4 改状态（E3） |
| P2 | 修 seed 的两个问题 | `settings` 只保留被读取的键或补读取方；jsonb 值改成数字/布尔（E18/E19） |
| P2 | 延迟与成本进自动化 | `verify.sh` 增加 L6：`done.latency_ms` 与 `ai_runs.cost_usd` 的阈值断言（E52） |
| P3 | 补录屏与答辩材料 | `docs/output/demo.mp4`、`docs/output/答辩.md` |

---

## 6. 与 v1.1 的差异（本章）

| # | v1.1 | 实际 |
|---|---|---|
| 1 | 12 张任务卡、11.1 小时预算 | 8 spec / 19 工单，无小时预算（真实耗时未记） |
| 2 | 无 spec 层 | 多一层 spec，每 spec 终止于一个闸门或可交付物 |
| 3 | 闸门按 T 卡编号 | 闸门按 spec 编号（G1→03#02、G2→04#03、G3→05#02、G4→06#03、G5→07#02） |
| 4 | T11 一次收尾 | 拆成 08#01/02/03 三张（文案、评测、交付包） |

---

## 7. 管理端第一批（2026-10-27，`09#01` / `09#02`）

> 这一批**不在**上面 19 张卡内：它来自录音需求（`docs/output/reviews.md` D1–D32），
> 计划在 `docs/prdv1.3/`，工单在 `.scratch/09-admin-console/`。记在这里是因为它改了数据层与接口契约。

| 卡 | 改了什么 | 证据 |
|---|---|---|
| `09#01` 看板口径 | `GET /api/console/stats` 加 `exclude_demo`（默认 true）与 `window=today\|week\|all`；非法取值 400 | `src/api/console.ts`、`src/core/ticket-queue.ts:readStats`、`tests/console-api.test.ts` |
| `09#02` 真源与发布态 | `fault_codes.status`（draft/published/archived）+ `product_lines` 字典表（18→19 表）；`writeFaultCodes` 改 `do nothing`；种子迁到 `sql/003_faults_seed.sql`；`corpus/fault_codes.json` → `corpus/.fixtures/`；`scripts/export-faults.ts` 单向导出；门禁只统计 published（D24）+ 归档不被重放复活（D25） | `sql/001_init.sql`、`sql/003_faults_seed.sql`、`src/core/fault-codes.ts:LOOKUP_SQL`、`src/core/ingest.ts`、`scripts/check-corpus.ts`、`tests/schema.test.ts`、`tests/corpus-quality.test.ts` |

未开：`09#03`（真登录 + 角色门，**等人签 `docs/output/boundary-change-R2.md`**）、`09#04`（管理面板）、`09#05`（知识库 CRUD）。

---

## 8. 管理端收口（2026-10-28，`09#03` 剩余 + `09#04` + `09#05`）

> 九张卡全部落地。`09#03` 的前两段在 §7 之前就已记入，这里只记这三张卡**后来的**改动。

| 卡 | 改了什么 | 证据 |
|---|---|---|
| `09#03` 缺口 | `updateTicket` 补**资源级可见性**：`agent` 改他人工单 → 403 `FORBIDDEN`（未分配 / 自己的单放行），顺序固定 **404 → 409 → 403(可见) → 403(派发) → 400** | `src/core/ticket-queue.ts:updateTicket`、`tests/queue-visibility.test.ts` |
| `09#04` 残留 | `severity` 三态（键缺失=不改 / 显式 `null`=清空 / 有值=校验）；派发选人下拉（`lead`/`admin`）；`GET /api/admin/staff` 降至 `lead` | `src/api/admin.ts`、`src/core/admin-store.ts:updateFault`、`src/static/lib/console-view.js`、`tests/admin-api.test.ts` |
| `09#05` 知识库 | `documents.body/version/updated_at` + status 扩 `archived`；`document_versions`/`document_version_chunks`/`document_rebuild_jobs`（22→**25 表**）；`ingest.ts` 抽出 `indexPages`（切块+嵌入唯一实现）；8 条 `/api/admin/documents*`（`ROUTE_MIN_ROLE` 40→**48 条**）；异步重建 + 一个事务换索引 + 版本化回滚 + 停用；召回 SQL 排除 `archived`；`console-admin-kb.js` 面板 + `kb` 导航位启用 | `sql/001_init.sql`、`src/core/kb-store.ts`、`src/api/admin-kb.ts`、`src/api/admin-guard.ts`、`src/core/retrieval.ts`、`src/static/lib/console-admin-kb.js`、`tests/admin-kb.test.ts`、`tests/web-admin-kb.test.ts` |

**守卫去重**：`src/api/admin-guard.ts` 是管理端鉴权口径的唯一副本（`guard`/`minRoleOf`/`actorOf`/`requireBodyRecord`），
`api/admin.ts` 与 `api/admin-kb.ts` 都从这里 import —— 两份副本时代"改一处漏一处"是安静的提权面。

**仍未做**：`GET /api/console/stats` 的团队看板分档（`agent` 仍能看到全量工单数与平均 SLA 剩余；
要新定 `scope=self|team` 口径，会牵动 `09#01` 的基线用例）。
