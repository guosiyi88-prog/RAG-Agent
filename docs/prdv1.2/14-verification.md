# 14 · 验证（as-built）

> 三层：**门禁脚本**（提交前必跑）、**断言测试**（409 个）、**评测跑分**（30 题 + 多轮 5）。
> 三层用途不同：门禁回答"能不能提交"，测试回答"某个行为还对不对"，评测回答"答得好不好"。

---

## 1. 一层：提交前门禁 `scripts/verify.sh`

九项，任一 `fail` → 退出码 1。`[skip]` = **未验证，不等于通过**。

| 项 | 判据 | 依赖 |
|---|---|---|
| **G1** 类型检查 | `npx tsc --noEmit` 零错误 | Node |
| **G2** 断言脚本 | `node --test --test-concurrency=1` 全过（**必须串行**：37 个文件共享一套数据层） | 数据层 |
| **G3** 文案校验 | `check-i18n.ts` 五条断言全绿（127/127） | — |
| **G4** 依赖审计 | `npm audit --omit=dev --audit-level=high` 无 high/critical（**只读，不自动 fix**） | 网络 |
| **L1** 探活 | `/healthz` 四项全真；`pi=false` 记"待复检"，L4 跑完一轮再复检 | 服务 |
| **L2** 数据 | 五语片段齐（`count(distinct lang)=5`）、空向量 0、超长块 0 | 数据层 |
| **L3** 检索 | 正例 `chunks ≥ 1`；反例 `chunks=0` 或 `topScore < 0.30` | 服务 + 内部令牌 |
| **L4** 对话 | SSE 有 `meta` / `delta` / `done` 三帧（整条流落文件再判，不用 `head -c` 截断） | 服务 + 模型 |
| **L5** 拒答 | 超纲题出 `refusal` 帧且工单数 +1 | 服务 + 数据层 |

三档模式：

| 场景 | 命令 | 实际跑 |
|---|---|---|
| 提交前 | `bash scripts/verify.sh` | 九项全量（含真调模型、409 用例） |
| 改后端 / 多 agent 并行占库 | `--no-tests` | 跳过 G2，其余八项 |
| 只改前端/文档 | `--fast` | 再跳过 L4/L5 对话流 |

**脚本自身的三条设计**：① 只依赖 `bash + curl + node`（不装 `jq`，JSON 由 node 解析）；
② 服务没起时 L1/L3/L4/L5 明确标"未验证"，不静默通过；③ 会话池满（`SESSION_BUSY`）时重试 3 次，
仍失败就报"池满"而不是"对话链路故障"。

**本机实测（2026-10-27）**：`ok=9 fail=0 skip=0`，全绿。G2 报 `# pass 409`。

---

## 2. 二层：断言测试（37 文件 / 409 用例 / ~2008 条断言）

三个接缝，刻意保持少：

| 接缝 | 做法 | 覆盖 |
|---|---|---|
| ① 进程内 HTTP | `app.inject` + 原始 SSE 流按 `\n\n` 切帧，断言**事件种类/顺序/载荷字段**（不断言答案正文） | 鉴权、路由、错误码、帧契约、工单、坐席端 |
| ② CLI 子进程 + SQL 断言 | 真起 `scripts/ingest.ts` / `eval.ts`，再查库 | 入库幂等、语料质量、评测落表 |
| ③ 前端纯函数 | 无 DOM 模块直接测 | SSE 分帧、角标替换、语言回落、抽屉数学、SLA、键盘映射、关单计数 |

| 域 | 文件 |
|---|---|
| 数据层与骨架 | `data-modules` `schema` `healthz` |
| 入库与语料 | `ingest-pure` `corpus-quality` `corpus-terms` `i18n-check` `eval-script` |
| 检索 | `retrieval-recall` `retrieval-search` `retrieval-postprocess` `fuse` `query-build` `agent-retrieval-signal` |
| 对话 / Agent / 引用 | `chat-stream` `chat-refusal` `chat-fastpath` `chat-citations` `session-token` `session-pool` `run-log` `tool-registry` `refusal` `citations` `citation-store` |
| 故障码与工单 | `fault-lookup` `fault-public` `ticket-public` `ticket-internal` |
| 鉴权与坐席端 API | `auth-boundaries` `console-api` |
| 前端纯逻辑 / 静态资源 | `web-lib` `web-sheet` `web-fault` `console-web` `assets` |
| 五语 API | `i18n-api` |

单文件跑法（已验证）：`node --test --test-concurrency=1 tests/fuse.test.ts` → `# tests 11 / # pass 11`。

**为什么不铺单元测试**：v1.1 §1.3 第 11 条明确不做；接缝越少，重构时被测试绑住的实现细节越少。

---

## 3. 三层：评测跑分 `scripts/eval.ts`

### 3.1 夹具

`corpus/.fixtures/qa_gold.json`（`version: 1.0`）：**30 题**（含 10 道 `should_refuse` 反例）
+ `multi_turn` **5 题**（单独跑，不计入 30）。放在以 `.` 开头的目录里，`ingest` 会跳过。

`make demo` 把 `expect_doc_hint` 解析成 `documents.id` 写进 `qa_gold` 表——**评测前必须先 `make demo`**。

### 3.2 四项指标的口径

| 指标 | 定义 | 门槛 | 实测（真嵌入 + mock LLM） |
|---|---|---|---|
| `hit@5` | 正例题里「`citations` 帧中的 `doc_id` ∈ 期望集合」的占比（引用是候选子集，**保守下界**） | ≥ 0.70 | **1.0000**（16/16） |
| 引用合法率 | 有引用的题里，所有 `[n]` 都能回查（标题可回查、`idx ∈ 1..5`、片段非空） | = 1.00 | **1.0000** |
| 拒答准确率 | 反例题里「出现 `refusal` 帧」且「该会话工单 +1」的占比 | ≥ 0.90 | **1.0000**（10/10） |
| 误拒率（严格） | 有文档期望的正例题里出现拒答的占比 | ≤ 0.10 | **0.0000**（0/16） |
| 误拒率（透明） | 把 4 道**纯故障码正例**也算进分母 | ≤ 0.10 | **0.2000**（4/20）❌ |

**透明口径未达标是已知缺口**：mock LLM 只调 `kb_search`、不调 `fault_code_lookup`，纯故障码题必然拒答。
真模型下这些题走快路（`E03` 根本不进模型），不受影响。登记在 `16` §2 E11。

### 3.3 两个必须标明的维度

| 维度 | 取值 | 影响 |
|---|---|---|
| LLM | `deepseek` / `mock` | 只影响"答得好不好"，不影响检索命中 |
| 嵌入 | `dashscope` / `hash` | **决定成败**：hash 模式 hit@5 = **0.0000**、误拒率 = **0.9375** |

任何指标结论都必须写清这两个维度。`docs/output/eval-hash-mode.md` 记录了同一天同一套题的 hash 对照结果
（三次跑分数值逐位一致 → 确定性成立，但质量不成立）。

### 3.4 落库与报告

写 `eval_runs`（`total/hit/cite_ok/refuse_ok` + 三个比率 + `detail jsonb`），
并落一份 markdown 到 `docs/output/eval-<时间戳>.md`（含题号级明细表）。

---

## 4. 手工验收清单（自动化没覆盖的部分）

自动化缺口在**延迟**与**主观质量**，这两项只能手验：

| # | 动作 | 期望 |
|---|---|---|
| 1 | `curl -s 127.0.0.1:8000/healthz` | 四项全真 |
| 2 | 浏览器开 `/`（390×844） | 9:16 框、五语切换不刷新、手机框不出现横向滚动 |
| 3 | 德语提问 | 德语答、逐字出现、有角标 |
| 4 | 点角标 | 抽屉滑出，见文档名 + 页码 + 语种 + 原文；上一条/下一条可用；Esc 关闭 |
| 5 | 输入 `E03` | 1 秒内出结果卡，且**没有**经过模型（服务端日志有"故障码快路命中"） |
| 6 | 问"能打几折" | 固定话术 + 工单小卡；坐席端 5 秒内出现新单 |
| 7 | 开 `/console`（1440×810） | 三栏；`j/k` 换单、`Enter` 进入、`Esc` 返回、`Ctrl+Enter` 发送 |
| 8 | 关单不写结论 | 按钮禁用并提示还差几个字 |
| 9 | 存图 | `docs/output/user-390x844-0{1..5}.png`、`console-1440x810-0{1..5}.png` 共 10 张 |

**首字延迟 / 单轮延迟 / 故障码 P95 / 单会话成本**：v1.1 有门槛（3s / 8s / 1s / $0.03），
**没有进入自动化门禁**，只在日志里有可测点（`done.latency_ms`、快路的 `ms`、`ai_runs.cost_usd`）。

---

## 5. 与 v1.1 的差异（本章）

| # | v1.1 | 实际 | 编号 |
|---|---|---|---|
| 1 | 四条命令（tsc / test / audit / eval） | 九项门禁脚本（G1–G4 + L1–L5），含三档模式 | E12 |
| 2 | 延迟/成本有门槛 | 未自动化，只留可观测点 | E52 |
| 3 | 夹具路径写 `corpus/qa_gold.json` | 实际在 `corpus/.fixtures/qa_gold.json`（避免被当语料入库） | E53 |
| 4 | 未定义"透明口径" | 增加"含纯故障码正例"的透明误拒率（0.2，未达标） | E11 |
| 5 | 未规定 hash 模式的验收含义 | hash 模式只用于链路验证，不得用于质量结论 | E11 |
