# 18 · 代码审查闸门

> **人看的是代码，不是跑起来的程序。**
> 自动断言证明"行为对"，代码审查证明"实现对"。这两件事不等价。

---

## 1. 为什么必须人看代码

本项目的错误有四种，自动化全抓不到：

| 类型 | 例子 | 跑一遍能发现吗 |
|---|---|---|
| **语义比错对象** | RRF 原始分和 `0.30` 比，阈值写反 | 能（全拒答），但会误判成"语料不够" |
| **开关写反但默认值正确** | `tools:["kb_search","read"]`，read 没被调用过 | **不能**，直到模型想读文件 |
| **绕过设计的实现** | 拒答话术让模型生成，只是恰好这次答对了 | **不能**，直到某次模型不听话 |
| **静默降级** | `catch {}` 吞掉 embedding 错误，走空结果 | **不能**，只是命中率莫名偏低 |

这四类只能靠人读代码。所以闸门设在**代码层面**。

---

## 2. 闸门总览

| 闸门 | 时机 | 审什么 | 耗时 |
|---|---|---|---|
| **G1** 检索核心 | T04 后 | `core/retrieval.ts` | 12 min |
| **G2** Agent 装配 | T05 后 | `core/agent.ts` + `ext/support.ts` | 15 min |
| **G3** 引用与拒答 | T06 后 | `core/refusal.ts` + `core/citations.ts` + `api/chat.ts` | 12 min |
| **G4** 前端关键路径 | T07 后 | `static/user.js` | 10 min |
| **G5** 安全边界 | T08 后 | `auth.ts` + `api/internal.ts` + `redis.ts` | 10 min |

**合计 59 分钟。**

---

## 3. 先跑这 8 条 grep（80% 的坑在这里）

审查开始前，让 AI 在仓库根跑一遍，把输出贴给人：

```bash
# ① 检索必须带语言过滤（缺了就漏召回）
grep -n "lang = any" src/core/retrieval.ts

# ② RRF 必须归一化（缺了就 100% 拒答）
grep -n "normalized\|maxPossible" src/core/retrieval.ts

# ③ tools 列表里绝不能有内置工具
grep -n "tools:" src/core/agent.ts

# ④ 只有 config.ts 能读 process.env
grep -rn "process\.env" src --include=*.ts | grep -v "src/config.ts"

# ⑤ 必须覆盖 system prompt
grep -n "systemPromptOverride\|appendSystemPromptOverride" src/core/agent.ts

# ⑥ 前端不能用 EventSource
grep -rn "EventSource" src/static/

# ⑦ 禁止 console.log
grep -rn "console\.log" src/

# ⑧ 拒答话术不得来自模型
grep -n "NO_ANSWER\|REFUSAL" src/core/refusal.ts src/api/chat.ts
```

### 期望结果

| # | 期望 | 若不对 |
|---|---|---|
| ① | 至少 1 行 | 回 T04，检索必然漏召回 |
| ② | 至少 1 行 | 回 T04，必然全拒答 |
| ③ | 只有 4 个业务工具名，**无** `read`/`bash`/`edit`/`write` | **立即停**，这是安全事故级 |
| ④ | 输出为空 | 回 T02，配置散落无法审计 |
| ⑤ | 两行都在 | 回 T05，模型会当自己是编码助手 |
| ⑥ | 输出为空 | 回 T07，微信里不流式 |
| ⑦ | 输出为空（`scripts/` 除外） | 回对应卡清理 |
| ⑧ | 有 `REFUSAL` 常量引用，且**不在** prompt 字符串里 | 回 T06，话术不可控 |

---

## 4. G1 · 检索核心（T04 后，12 min）

### 审什么

| 文件 | 函数 |
|---|---|
| `src/core/retrieval.ts` | `retrieve()`、`rrf()`、`buildQuery()`、`LANG_SCOPE` |

### 红线（必须有）

**① 语言过滤**

```ts
// 必须有
where c.lang = any($2::char(2)[])
```

**② RRF 归一化**

```ts
// 必须有，且在比较 MIN_SCORE 之前
const maxPossible = vecWeight / (RRF_K + 1) + ftsWeight / (RRF_K + 1);
const normalized = Math.min(1, rawScore / maxPossible);
```

**③ per-doc 上限**

```ts
// 同一文档最多 3 条
const perDoc = new Map<string, number>();
```

### 黑线（必须没有）

```ts
// ✗ 直接拿原始 RRF 分和阈值比
if (score < RETRIEVAL_MIN_SCORE)   // score 是 0.013 量级

// ✗ 拼 SQL
`select * from chunks where content like '%${query}%'`

// ✗ 吞掉 embedding 异常后返回空而不标记 fallback
try { await embed(q) } catch {}
```

### 常见错误对照

| 写对 | 写错 |
|---|---|
| `1 - (c.embedding <=> $1::vector) as score` | `c.embedding <-> $1`（用 L2 距离却按 cosine 理解） |
| `order by c.embedding <=> $1` | `order by score desc`（score 是算出来的别名，排序方向反） |
| 向量 20 + 全文 20 → RRF → 5 | 向量 5 + 全文 5 → RRF（候选太少，融合没意义） |
| `buildQuery` 只在短问句时拼接 | 每轮都拼，导致越长越偏离 |

### 通过标准

- [ ] 8 条 grep 的 ①② 都通过
- [ ] `retrieve()` 里没有任何字符串拼接 SQL
- [ ] 归一化发生在与阈值比较之前
- [ ] 有 `per doc ≤3` 的去重
- [ ] embedding 失败时 `fallback="fts_only"` 而不是静默返回空

---

## 5. G2 · Agent 装配（T05 后，15 min）

### 审什么

| 文件 | 函数 |
|---|---|
| `src/core/agent.ts` | `createSupportSession()`、会话池 |
| `src/ext/support.ts` | 4 个 `registerTool`、2 个 `on` |

### 红线

**① 三条硬约束**

```ts
new DefaultResourceLoader({
  systemPromptOverride: () => SYSTEM_PROMPT,      // ← 必须有
  appendSystemPromptOverride: () => [],           // ← 必须有
  extensionFactories: [supportExtension],         // ← 必须有
});

await createAgentSession({
  sessionManager: SessionManager.inMemory(),      // ← 必须有
  tools: ["kb_search", "fault_code_lookup", "ticket_create", "ticket_lookup"],
});
```

**② tool_call 白名单 fail-closed**

```ts
pi.on("tool_call", async (event) => {
  if (!ALLOW.has(event.toolName)) return { block: true, reason: "tool_not_allowed" };
  return;
});
```

**③ 连发走 steer**

```ts
if (session.isStreaming) await session.steer(text);
else await session.prompt(text);
```

### 黑线

```ts
// ✗ 三选一的死法
session.agent.state.messages = history;        // 无效，多轮必丢
tools: ["read", "bash", ...]                    // 安全事故
new DefaultResourceLoader({})                   // 没覆盖 prompt

// ✗ 吞掉 steer 分支
await session.prompt(text);                     // streaming 时直接 reject
```

### 特别检查：hook 里没有 HTTP

```ts
// ✗ 工具 hook 里发请求，增加工具延迟
pi.on("tool_result", async (e) => { await fetch("/internal/citations", ...) });

// ✓ 只往内存缓冲里塞
pi.on("tool_result", async (e) => { buffer.push(...e.details.citations); });
```

### 通过标准

- [ ] 8 条 grep 的 ③⑤ 通过
- [ ] `tools` 数组恰好 4 项，全是业务工具名
- [ ] `systemPromptOverride` 与 `appendSystemPromptOverride` 都在
- [ ] `SessionManager.inMemory()` 在
- [ ] `tool_call` 返回 `{block:true}` 而非静默 return
- [ ] 有 `isStreaming` 分支
- [ ] 代码里搜不到 `agent.state.messages =`

---

## 6. G3 · 引用与拒答（T06 后，12 min）

### 审什么

| 文件 | 函数 |
|---|---|
| `src/core/refusal.ts` | `shouldRefuse()`、`REFUSAL` 常量 |
| `src/core/citations.ts` | `persist()`、`validate()` |
| `src/api/chat.ts` | `finalize()` |

### 红线

**① 拒答是常量，不是模型输出**

```ts
const REFUSAL: Record<Lang, string> = { zh: "这个问题我需要工程师确认。…", de: "…" };
// 使用时直接下发
send("delta", { t: REFUSAL[lang] });
```

**② 角标合法性校验**

```ts
const used = [...text.matchAll(/\[(\d+)\]/g)].map(m => +m[1]);
const illegal = used.filter(n => !ctx.citationBuffer.some(c => c.idx === n));
if (used.length && illegal.length) { /* 整条降级为拒答 */ }
```

**③ 空引用即拒答**

```ts
if (!ctx.citationBuffer.length || text.includes("NO_ANSWER")) { /* 拒答 + 建单 */ }
```

### 黑线

```ts
// ✗ 让模型说"不知道"
if (/我不知道|不知道|sorry/.test(text)) { ... }

// ✗ 不校验角标，直接渲染
text.replace(/\[(\d+)\]/g, '<span class="cite">$1</span>')

// ✗ 拒答话术走第二次模型调用
const msg = await callModel("请礼貌地说明你不知道");
```

### 常见错误对照

| 写对 | 写错 |
|---|---|
| 拒答延迟 0（直接下发常量） | 拒答延迟 3s（再调一次模型） |
| 校验 `n ∈ 候选集` | 校验 `n >= 1 && n <= 5` |
| `NO_ANSWER` 字符串匹配 | 判断"回答长度 < 20" |
| 建单在拒答之后 | 建单在拒答之前（失败就两空） |

### 通过标准

- [ ] `REFUSAL` 是模块级常量
- [ ] 拒答路径里没有模型调用
- [ ] 角标校验用的是候选集 `idx`，不是范围判断
- [ ] 建单发生在拒答话术下发之后
- [ ] `grep -n "REFUSAL" src/ext/support.ts` 无结果（话术不该进 prompt）

---

## 7. G4 · 前端关键路径（T07 后，10 min）

### 审什么

| 文件 | 关注点 |
|---|---|
| `src/static/user.js` | SSE 消费、角标渲染、抽屉 |

### 红线

**① 用 fetch + ReadableStream**

```js
const reader = (await fetch('/api/chat', {...})).body.getReader();
```

**② 角标不虚构**

```js
// 只在 citations 事件后替换，且 n 必须在列表里
for (const c of citations) { /* 替换 [c.idx] */ }
```

**③ 44px 命中区**

```css
.cite::after { content:""; position:absolute; inset:-13px; }
```

### 黑线

```js
// ✗ EventSource
new EventSource('/api/chat')

// ✗ 前端造角标
text.replace(/\[(\d+)\]/g, `<span class="cite">$1</span>`)

// ✗ 硬编码文案
btn.textContent = '发送';
```

### 通过标准

- [ ] 8 条 grep 的 ⑥ 通过
- [ ] 角标渲染逻辑里引用了 `citations` 数组
- [ ] `app.css` 里 `.cite::after` 的 `inset` 为负值
- [ ] `user.js` 里搜不到中文字符串（除注释）
- [ ] 有 `isStreaming` 状态，重复发送不并发

---

## 8. G5 · 安全边界（T08 后，10 min）

### 审什么

| 文件 | 关注点 |
|---|---|
| `src/auth.ts` | token 签发与校验 |
| `src/api/internal.ts` | 127.0.0.1 限制 |
| `src/redis.ts` | 限流实现 |
| 全部 `src/api/*.ts` | SQL 参数化、错误不泄露 |

### 红线

```ts
// ① 内部接口双重限制
if (req.ip !== "127.0.0.1" && req.ip !== "::1") return reply.code(404).send();
if (req.headers["x-internal-token"] !== config.INTERNAL_TOKEN) return reply.code(401).send();

// ② 限流在业务逻辑之前
if (!(await rateLimit(`rl:chat:${token}`, 20, 60))) throw new AppError("RATE_LIMITED");

// ③ SQL 全参数化
query("select * from tickets where no = $1", [no]);
```

### 黑线

```ts
// ✗ 用 startsWith 判断内网
if (req.ip.startsWith("127."))

// ✗ 错误里带堆栈
reply.code(500).send({ error: err.stack })

// ✗ 日志里打印明文邮箱
logger.info(`ticket for ${email}`)
```

### 通过标准

- [ ] `grep -rn '\${' src --include=*.ts | grep -iE 'select|insert|update|delete'` 输出为空
- [ ] 内部接口同时校验 IP 与 token
- [ ] 所有 `catch` 都不把 `err.stack` 返给客户端
- [ ] 日志里邮箱经 `maskEmail()`
- [ ] `/healthz` 不返回连接串

---

## 9. 审查记录格式

写进 `docs/output/code-review-log.md`：

```markdown
## G1 · 检索核心 · 2026-10-27 14:20
审查人：张伟（后端）
结论：**不通过**
未过项：
- 归一化写在 `retrieve()` 返回之后，`chat.ts` 里比较时又用了原始分
处置：把 normalize 移到 `retrieve()` 内部，返回前完成
复测：14:50 → 通过
```

**必须**有：审查人 / 结论 / 未过项 / 处置 / 复测。缺项视为没审。

---

## 10. AI 在闸门前的行为

| 规则 | 说明 |
|---|---|
| 闸门前必须停 | 不许"我自查过没问题了"就继续 |
| 必须先跑 8 条 grep 并贴输出 | 不要让人自己去 grep |
| 必须列出"本次改动涉及的文件 + 行号" | 让人知道看哪里 |
| 收到 fail **不许辩解** | 按未过项改，改完请求复测 |
| 一轮最多改 3 次 | 第 3 次仍 fail → 停下来讨论设计 |

### 10.1 闸门提示词模板（AI 直接发）

```
【代码闸门 G1 · 检索核心】约 12 分钟

改动文件：
  src/core/retrieval.ts (新增 186 行)

请先看这 8 条 grep 的输出（已贴在下面），再读 3 个函数：
  - rrf()        第 42–70 行
  - retrieve()   第 88–160 行
  - buildQuery() 第 24–38 行

重点看三处：
  1. 归一化是否发生在与 MIN_SCORE 比较之前
  2. 两条 SQL 是否都带 lang = any(...)
  3. embedding 失败时是否标记 fallback

通过/不通过 + 未过项，各一行回我。
```

---

## 11. 时间预算（修正）

| 闸门 | 审查 | 可能返工 | 合计 |
|---|---|---|---|
| G1 | 12 min | 0–40 min | 52 min |
| G2 | 15 min | 0–60 min | 75 min |
| G3 | 12 min | 0–40 min | 52 min |
| G4 | 10 min | 0–30 min | 40 min |
| G5 | 10 min | 0–30 min | 40 min |

**代码审查合计 59 分钟，含返工 1.5–4.5 小时。**

`15-tasks.md` 的 10 小时是"零返工"值。加闸门后现实区间 **11.5–14.5 小时**，排期按 **13 小时**承诺。

---

## 12. 代码审查 ≠ 产品验收

| 层 | 谁做 | 判什么 |
|---|---|---|
| 自动断言（`14` §2） | AI | 行为对：字段、SSE、工单 |
| **代码审查（本文件）** | **人读代码** | **实现对**：不绕设计、不吞异常、不写反 |
| 产品验收（可选） | 人点界面 | 好用：手感、语气、真机 |

三者叠加，缺一层就有一类错误漏过去。本文件只管中间那层。
