# 10 · 用户端（9:16 手机框，as-built）

> 覆盖 `src/static/index.html`(374) + `user.js`(417) + `views.js`(400) + `lib/{stream,cite,sheet,cite-sheet,lang,fault-recent,i18n-chrome,i18n-de}.js`。
> 全部原生 ES module，无框架、无构建、无 npm 依赖。

---

## 1. 页面结构

单页、四个视图，靠 `body[data-view]` 切换（不路由、不刷新）：

| 视图 | `data-view` | 内容 | 入口 |
|---|---|---|---|
| 对话 | `chat` | 消息流 + 状态条 + 输入区 | 底部 Tab |
| 故障码 | `fault` | 输入码 → 结果卡（含义/严重度/步骤/来源）+ 最近查询 | Tab / 对话页"查故障码" |
| 转人工 + 查单 | `ticket` | 建单表单（邮箱+问题）与"查进度"（单号+邮箱） | Tab / 拒答气泡的"转人工" |
| 我的 | `me` | 语言单选、清除本地数据、版本号 | Tab |

底部 Tab 五项，每格 ≥44px；非 `chat` 视图时隐藏 `.stream` / `.status` / `.composer`（只认 `body[data-view]`）。

---

## 2. 状态机（`body[data-state]`）

| 状态 | 含义 | 页面表现 |
|---|---|---|
| `idle` | 空闲 | 状态条隐藏；发送按钮可用 |
| `streaming` | 正在出字 | 光标闪烁；状态条显示 `chat.status.searching`；按钮**仍可用**（连发走插入分支） |
| `refused` | 本轮已转人工 | 光标隐藏；气泡末尾挂工单小卡 |
| `error` | 本轮失败 | 光标隐藏；状态条转红色；气泡内出现"重试 / 转人工"两个动作 |

`aria-busy` = `streaming`（读屏据此播报"正在写"）。

---

## 3. 一轮对话的生命周期

```
send(text)
  → throttle / offline 前置检查（失败只提示，不清输入框）
  → turn(text, streaming ? "insert" : "primary")
      primary：接管四态与 AbortController
      insert ：连发分支，不 abort 主轮、不碰四态，独立气泡 + 前置灰字
  → postChat：ensureToken → POST /api/chat（带 x-trace-id）
      · 401 且未重试过 → 清令牌、重签一次、整轮重发（**只重试一次**）
      · 429 → 读 Retry-After（缺失兜底 60s），按钮倒计时禁用，toast
  → consume：fetch + ReadableStream → lib/stream.js 分帧
  → applyFrame：
      meta      存 conv_id（sessionStorage），后续轮次带上
      delta     追加到独立 Text 节点（逐字，不整块重排）
      citations 用 renderCitations 拆段 → 替换成角标按钮（纯函数 + DOM 分离）
      refusal   用**最后一帧 delta**（固定话术）覆盖整条气泡，挂工单卡，转 refused
      done      收尾，转 idle
      error     覆盖气泡为错误文案 + 动作，转 error（`error` 之后没有 done）
  → finally：abort 清理、状态归位
```

**三条必须知道的契约**：

1. **拒答是"用话术覆盖草稿"**：模型已经流出的正文收不回来，所以前端在收到 `refusal` 帧时用
   **最后一个 delta**（= 后端下发的固定话术）替换整条气泡，草稿连同角标一起丢掉。
   后端**建单失败时不发 `refusal` 帧**，那一轮保留草稿（用户至少看到模型说了什么，且没有"已建单"的承诺）。
2. **角标编号必须来自 `citations` 列表**：不在列表里的 `[n]` 保持纯文本（后端本应拦掉，这是兜底）。
3. **`SESSION_BUSY` 不是故障**：同会话连发时后端不发 `error` 帧；即使收到也只在状态条提示
   `chat.err.busy` 并回到 idle，不把气泡画成错误。

---

## 4. 断网、限流、重试

| 场景 | 行为 |
|---|---|
| 断网（`navigator.onLine === false`） | 顶部横幅 + 状态条 `chat.err.offline`；发送按钮禁用；**草稿留在输入框**；恢复后自动消失并 toast |
| 429 限流 | 按钮显示剩余秒数（`is-counting` 藏图标），到点自动恢复；不出"重试"按钮（只会再吃一个 429） |
| 401 令牌过期 | 静默重签一次并重发整轮；再失败才显示 `chat.err.auth` |
| 流中断 / 500 | 气泡替换为 `chat.err.internal`，附 `trace_id` 后 6 位（给坐席查日志） |

---

## 5. 输入区与键盘

| 行为 | 规则 |
|---|---|
| Enter | 发送 |
| Shift+Enter | 换行（交给浏览器） |
| IME 组合中（`event.isComposing`） | **不发送**（中日韩输入法选词确认会误发） |
| 输入框增高 | 按 `scrollHeight`，上限 120px（`MAX_INPUT_H`），超过出滚动条 |
| 键盘跟手 | `visualViewport` → 写 `--kb` / `--kb-h` / `--vvh`，CSS 用它给内容让位；**不用 `position:fixed` 硬顶**；rAF 去抖（iOS 键盘动画会连发几十次 resize） |

滚动策略：距底 48px 内视为"跟着看"（`pinned`），自动滚到底；否则不抢用户翻历史的滚动。
DOM 上限 **60 条气泡**（超出的从头部删）——丢的只是 DOM，消息/引用/工单都在服务端。

---

## 6. 引用抽屉（`lib/cite-sheet.js` + `lib/sheet.js`）

| 项 | 行为 |
|---|---|
| 打开 | 点角标 → `user:cite` 事件（带**整轮** citations + index）→ 底部抽屉滑出 |
| 内容 | `cite.title`（带 `{i}/{n}`）、文档名、页码、语种徽章、原文片段（`<mark>` 高亮） |
| 上下条 | 抽屉底部"上一条/下一条"，切换 `state.citingIdx` |
| 手势 | 下滑关闭：位移写 `--sheet-dy`，超过阈值回弹或关闭（数学在 `sheet.js`，纯函数可测） |
| 键盘 | Esc 关闭；焦点陷阱在抽屉内；关闭后焦点回到原角标 |
| 滚动锁 | `body[data-sheet="open"]` 时 `overflow:hidden` |
| 切语言 | 抽屉开着时重派发 `user:cite` 重渲染标题与页码（`refreshCiteTitle`） |
| 减弱动效 | `prefers-reduced-motion` 时抽屉不做位移，只淡入 |

---

## 7. 语言切换（五语，不刷新）

```
resolveLang = normalizeLang(pickLang({stored: localStorage, browser: navigator.language})) || "de"
切语言 → loadI18n(lang)（GET /api/i18n/:lang，失败不弹错）
      → applyLang(lang)：<html lang> + 三类节点 + <title> + 各动态文本
      → views.onLang(lang)：三个次级视图重渲染自己的动态文本
```

三类 i18n 挂点：`[data-i18n]`（textContent）、`[data-i18n-ph]`（placeholder）、
`[data-i18n-aria]`（aria-label）。**漏挂一个 key 就漏一条翻译**——这是"切语言后全站变化"的实现方式。

`t(key, vars)` 的查找顺序：`/api/i18n` 的合并结果 → 离线兜底（`i18n-chrome` 五语骨架 → `i18n-de` 德语表）
→ key 原文。**不逐 key 用 `??` 往回兜**：服务端合并结果里一定有每个 key（最后一格就是 key 原文），
再往回兜会盖掉"服务器故意给的 key"，缺翻译反而看不见。

---

## 8. 三个次级视图（`views.js`）

| 视图 | 关键行为 |
|---|---|
| 故障码 | 判形后才请求（`X1`/`E1234` 不发）；同一码不重复请求（`lastLookupCode` + `lookupSeq` 防竞态）；未命中渲染"没找到 + 问 AI"；结果卡带严重度徽章与有序步骤；**最近查询**存 localStorage（去重 + 上限，`lib/fault-recent.js`） |
| 转人工 | 邮箱正则前置校验；提交后显示单号 + 复制按钮；`QUOTA_TICKET`/`RATE_LIMITED` 映射到 `ticket.quota` |
| 查进度 | **单号 + 邮箱**两个都必填（与后端口径一致：单号对不对与邮箱匹不匹配返回同一个 404） |
| 我的 | 语言单选（五语）、清除本地数据（token/conv/lang/最近查询）、版本号 |

跨视图通信走 `CustomEvent`：`user:handoff`（拒答气泡 → 转人工，带问题原文与会话 id）、
`views:lang`、`views:toast`。

---

## 9. 启动顺序（弱网可用）

```
bind()                    抓 DOM（缺元素一律按 null 跳过，不让一处缺失炸整页）
applyLang(本地字典)        先点亮页面，不等网络
loadI18n(远程表) → applyLang(再次) → views.onLang
ensureToken()             失败不阻塞（首次发送时会再签）
setPhase(idle) / syncOnline / syncViewport / grow
```

**先文案后令牌**：`/api/i18n/:lang` 与 `/api/session` 都不需要令牌，弱网下先把界面点亮再取令牌。

---

## 10. 与 v1.1 的差异（本章）

| # | v1.1 | 实际 | 编号 |
|---|---|---|---|
| 1 | 未规定 DOM 气泡上限 | 60 条，超出从头部删（只删 DOM，不动数据） | E39 |
| 2 | 未规定 401 的处理 | 静默重签**一次**并重发整轮 | E40 |
| 3 | 离线只有"横幅" | 横幅 + 状态条 + 离线兜底词典（`i18n-chrome` / `i18n-de`） | E41 |
| 4 | 工单进度 UI 不在范围 | **已实现**（单号 + 邮箱） | E10 |
| 5 | 未规定拒答的客户端契约 | 用最后一帧 delta 覆盖整条气泡；无 `refusal` 帧则保留草稿 | E42 |
