# 18 · 人工代码闸门（as-built）

> 有六类问题**机器判不出来**：绕过的鉴权路径、fail-open 的钩子、静默降级、引用造假、
> 权限边界泄漏、把事故藏进拒答。所以这五道闸门必须**人读代码**，`verify.sh` 全绿不能替代它们。
> 每道闸门 10–15 分钟，先跑 §1 的 8 条 grep（80% 的坑在那里）。

---

## 1. 先跑这 8 条 grep（在本仓根目录）

```bash
# ① 环境变量只许在 config.ts 读
grep -rn "process\.env" src --include=*.ts | grep -v "src/config.ts"          # 期望：空

# ② 连接池只有一个
grep -rn "new Pool" src                                                       # 期望：只有 src/db.ts

# ③ 工具里不许出现危险工具名
grep -rnoE '"(read|write|edit|bash|shell)[a-z_]*"' src/ext src/core/agent.ts   # 期望：空

# ④ 令牌不许直接比较（必须常数时间）
grep -rn 'adminToken ===\|x-admin-token".*===' src --include=*.ts              # 期望：空

# ⑤ ext 只许 import core/retrieval（kb_search 进程内），不许 import 其它 core
grep -rn 'from "\.\./core' src/ext/support.ts                                  # 期望：只有 retrieval.ts 一行

# ⑥ fail-closed 必须在场
grep -c "block: true" src/ext/support.ts                                       # 期望：≥3

# ⑦ 向量维度与 DDL 一致
grep -n "vector(1024)" sql/001_init.sql                                        # 期望：chunks.embedding 一行

# ⑧ 后端不许有调试输出
grep -rn "console\.log" src --include=*.ts --include=*.js | grep -v src/static # 期望：空
```

**本机实测（2026-10-27）**：① 空 · ② 只 `src/db.ts` · ③ 空 · ④ 空 · ⑤ 只 `core/retrieval.ts` ·
⑥ 4 处 · ⑦ `sql/001_init.sql:66` · ⑧ 空。

> 第 ⑤ 条是本次逆向发现的**文档错误**：`02-architecture.md` 曾写"ext 不 import core"，
> 实际 `kb_search` 必须进程内调 `retrieve()`。正确表述是"只许 import `core/retrieval.ts`"。

---

## 2. G1 · 检索核心（03#02 之后，12 分钟）

**读**：`src/core/retrieval.ts`（召回 + 融合）、`src/core/fuse.ts`、`src/core/query.ts`

**红线（必须有）**

1. 两路 SQL 都带 `lang = any($2::char(2)[])`（**cast 不能省**，省了索引失效）。
2. 向量路用 `<=>` + `vector_cosine_ops` + `score = 1 - distance`（换算子会让分数与索引脱钩）。
3. 最终分 = **归一化 RRF × 余弦²**，且无余弦时按 1（`retrieval.ts:455`）。
4. 归一化分母由 `maxPossibleScore()` **算**出来，不是魔数。
5. 后处理顺序：去重（每文档 ≤3）→ 截断 600 → topK → `idx` 连续。
6. `fallback` 三值语义与降级边界（维度错上抛、DB 不可用降 empty）。

**黑线（必须没有）**

- 用 RRF 原始分与 `0.30` 比较。
- 在 SQL 里写死 `array['de','en']`。
- `slice(0, NaN)` 导致 topK 静默变 0。
- 用 `String.length` 判断块长（应明确是 UTF-16 语义，改就一起改）。

**通过标准**：8 条全满足；`tests/fuse.test.ts`、`tests/retrieval-postprocess.test.ts`、
`tests/retrieval-search.test.ts` 通过。

---

## 3. G2 · Agent 装配（04#03 之后，15 分钟）

**读**：`src/core/agent.ts`（`createSupportSession` / `acquire` / `runTurnLocked`）、`src/ext/support.ts`

**红线**

1. 五条硬约束全在（C1 注册制 / C2 两个 prompt 覆盖 / C3 `SessionManager.inMemory()` / C4 模型对象 / C5 thinking off）。
2. `noExtensions`、`noContextFiles`、`agentsFilesOverride` 三个开关**同时**在（否则磁盘扩展能决定工具面）。
3. 工具恰好四个，且全部来自 `SUPPORT_TOOL_NAMES`（唯一真源）。
4. `tool_call` 钩子 fail-closed：白名单外返回 `block`，**且不吞异常**。
5. `tool_result` 钩子**不发 HTTP**（只往 `slot.buffer` 推）。
6. 会话池：装配去重、复用先于判满、先回收再判满、busy 不回收。
7. 连发用 `steer`，非流式用 `prompt`，且 `expandPromptTemplates: false`。

**黑线**

- `tools: []` 里出现白名单之外的任何名字。
- 给 `session.agent.state.messages` 赋值。
- 在 hook 里 `try/catch` 后返回 `undefined`（= fail-open）。
- `thinkingLevel` 非 `off`。

**通过标准**：`tests/tool-registry.test.ts`、`tests/session-pool.test.ts`、`tests/chat-stream.test.ts` 通过。

---

## 4. G3 · 引用与拒答（05#02 之后，12 分钟）

**读**：`src/core/citations.ts`、`src/core/refusal.ts`、`src/api/chat.ts` 的 `streamTurn` / `refuseTurn`

**红线**

1. 引用校验先于发 `citations` 帧；**只发被引用到的**片段，不发候选全集。
2. 快照挂在**助手消息**上（不是 `meta.message_id` 那个用户消息）。
3. 拒答四步顺序固定：丢正文 → 话术（常量、不经模型）→ 建单 → `refusal` 帧带单号。
4. 建单失败**不发** `refusal` 帧（否则给用户一个查不到的单号）。
5. 记账在 `done` 之前，且 `refused` 如实标记。

**黑线**

- `citations` 帧里出现未被正文引用的片段。
- 拒答时把模型草稿落库（库里必须只有固定话术）。
- 把 `citationVerdict.ok === false` 却继续发 `citations` 的分支。

**通过标准**：`tests/chat-refusal.test.ts`、`tests/citations.test.ts`、`tests/citation-store.test.ts` 通过。

---

## 5. G4 · 前端关键路径（06#03 之后，10 分钟）

**读**：`src/static/user.js` 的 `applyFrame` / `onCitations` / `onRefusal`、`src/static/lib/cite.js`

**红线**

1. 角标编号**来自服务端 `citations`**，不在列表里的 `[n]` 保持纯文本。
2. 拒答时用最后一帧 `delta`（固定话术）**覆盖整条气泡**；无 `refusal` 帧则保留草稿。
3. 切语言不刷新页面，靠 `[data-i18n*]` 三类挂点。
4. `streaming` 时发送按钮**不禁用**（连发走插入分支）。
5. 用户可见文案全部走 `t()`，没有中文硬编码。

**黑线**

- 前端自己编号角标。
- 用 `textContent` 整块覆盖含 SVG 的按钮（会抹掉图标）。
- 切语言后仍有上一语言的残留（`state.i18n` 未清空）。

**通过标准**：`tests/web-lib.test.ts`、`tests/web-sheet.test.ts`、`tests/assets.test.ts` 通过；手点一遍 §10 的清单。

---

## 6. G5 · 安全边界（07#02 之后，10 分钟）—— **本轮唯一未签字的一道**

**读**：`src/auth.ts`、`src/api/console.ts`、`src/core/ticket-queue.ts` 的 `updateTicket`、`src/server.ts` 的错误处理

**红线**

1. 三档鉴权只有一份实现，**鉴权在解析 body 之前**。
2. 坐席令牌与内部令牌都用 `sha256 + timingSafeEqual`（不短路、不漏长度）。
3. 内部接口：回环判定认 `127/8`、`::1`、`::ffff:127.x.x.x`，**不认 `X-Forwarded-For`**；失败一律 404。
4. 日志脱敏覆盖 `token/email/requester/authorization/x-admin-token/x-internal-token`。
5. `closed` 工单不可变由**触发器**保证，路由层的 409 只是翻译。
6. 错误处理器：4xx 折 `VALIDATION`、未捕获一律 `INTERNAL`、堆栈只进日志。

**黑线**

- 任何一处 `token === config.adminToken`。
- `X-Admin-Staff` 的失败给出与"令牌错"不同的响应（会变成坐席 id 预言机）。
- 内部接口对非回环返回 401/403。
- 把堆栈或 SQL 片段放进错误响应体。

**通过标准**：`tests/auth-boundaries.test.ts`、`tests/console-api.test.ts` 通过；**且**本节的六条各有
"已读 + 通过"的手写记录（写进 `docs/output/review-07-08.md` 第四节即可）。

---

## 7. 闸门与门禁脚本的分工

| | `scripts/verify.sh` | 本文件 |
|---|---|---|
| 回答 | 行为还对吗 | 有没有绕过路径 |
| 代价 | 全量约数分钟 | 每道 10–15 分钟人力 |
| 能拦住 | 回归、契约破坏、指标退化 | fail-open、静默降级、权限越界 |
| 拦不住 | 能被正确调用绕过的旁路 | 逻辑错误（只要行为断言没覆盖） |

**两个都要过才算收口。** 本轮的现状是：门禁 9/9、测试 387 全过；G1–G4 已签字，**G5 待签字**。

---

## 8. 签字表（每完成一道填一行，不许代签）

| 闸门 | 读者 | 日期 | 结论 | 备注 |
|---|---|---|---|---|
| G1 检索核心 | | | | |
| G2 Agent 装配 | | | | |
| G3 引用与拒答 | | | | |
| G4 前端关键路径 | | | | |
| G5 安全边界 | | | ⬜ 待签 | 清单在 `docs/output/review-07-08.md` §4 |
