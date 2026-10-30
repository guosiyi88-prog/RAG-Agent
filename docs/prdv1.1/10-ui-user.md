# 10 · 用户端规格（9:16）

> 实现文件：`src/static/index.html` + `src/static/user.js`。

## 1. 页面结构（DOM 契约，按此写）

```html
<!doctype html>
<html lang="zh" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>沃泰支持</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <style>/* 内联 app.css */</style>
</head>
<body data-app="user">
<div class="phone">

  <!-- 顶栏 -->
  <header class="hdr">
    <button class="hdr-back" aria-label="返回" data-i18n-aria="a11y.back" hidden></button>
    <h1 class="hdr-title" data-i18n="chat.title">沃泰支持</h1>
    <button class="hdr-lang" id="btn-lang" aria-label="切换语言" data-i18n-aria="a11y.lang">DE</button>
  </header>

  <!-- 消息流 -->
  <main class="stream" id="stream" aria-live="polite">
    <!-- 消息由 JS 追加 -->
  </main>

  <!-- 状态条 -->
  <div class="status" id="status" hidden data-i18n="chat.status.searching"></div>

  <!-- 输入区 -->
  <div class="composer">
    <textarea id="input" class="composer-input" rows="1"
      placeholder="输入问题…" data-i18n-ph="chat.placeholder" maxlength="2000"></textarea>
    <button class="btn btn-primary composer-send" id="btn-send"
      aria-label="发送消息" data-i18n-aria="a11y.send" data-i18n="chat.send">发送</button>
  </div>

  <!-- 底部 tab -->
  <nav class="tabbar" data-i18n-aria="a11y.tab">
    <a class="tab is-active" href="#" data-tab="chat" data-i18n="nav.chat">对话</a>
    <a class="tab" href="#" data-tab="fault" data-i18n="nav.fault">故障码</a>
    <a class="tab" href="#" data-tab="ticket" data-i18n="nav.ticket">工单</a>
    <a class="tab" href="#" data-tab="me" data-i18n="nav.me">我的</a>
  </nav>

</div>

  <!-- 引用抽屉 -->
<div class="overlay" id="cite-overlay" hidden>
  <div class="sheet" id="cite-sheet" role="dialog" aria-modal="true" aria-labelledby="cite-title">
    <div class="sheet-handle"></div>
    <h2 id="cite-title" class="sheet-title" data-i18n="cite.title">引用 1 / 3</h2>
    <div class="sheet-body" id="cite-body"></div>
    <div class="sheet-foot">
      <button class="btn btn-ghost" id="cite-prev" data-i18n="cite.prev">上一条</button>
      <button class="btn btn-ghost" id="cite-next" data-i18n="cite.next">下一条</button>
      <button class="btn btn-primary" id="cite-close" data-i18n="common.close"
        aria-label="关闭" data-i18n-aria="a11y.close">关闭</button>
    </div>
  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast" hidden></div>

<script type="module" src="/assets/user.js"></script>
</body>
</html>
```

> 上面模板里的中文只是**占位**：所有可见文字都必须带 `data-i18n` / `data-i18n-ph` / `data-i18n-aria`，`applyLang()` 启动时整页替换。**新增节点忘了挂 key 就是 bug**（`12-i18n.md` §7 与 G4 闸门都会抓）。

**视图切换**：`body.dataset.view = "chat" | "fault" | "ticket" | "me"`，CSS 用 `[data-view]` 控制 `.stream` / 故障码区 / 工单区 的显隐。**不做路由**，不用 hash。

---

## 2. `user.js` 模块契约

```js
// 只允许这些顶层符号
const state = {
  token: null,          // X-User-Session
  convId: null,
  lang: 'en',
  i18n: {},
  citations: [],        // 当前消息的引用
  citingIdx: 0,         // 抽屉正在看第几条
  streaming: false,
  faultRecent: [],      // 最近查过的故障码（localStorage）
};
```

| 函数 | 职责 | 触发 |
|---|---|---|
| `boot()` | 取/建 token、拉 i18n、绑事件、渲染 tab | DOMContentLoaded |
| `t(key)` | 取文案，回落 `en` | 各处 |
| `applyLang(lang)` | 写 `state.lang`、`<html lang>`、重渲染所有 `[data-i18n]` | 语言切换 |
| `send(text)` | 建/复用 conv，POST `/api/chat`，消费 SSE | 发送 / 快捷 |
| `appendUser(text)` | 追加用户气泡 | send 内 |
| `appendAssistant()` | 创建空助手气泡，返回元素 | send 内 |
| `appendDelta(el, t)` | 追加文本到气泡 | SSE `delta` |
| `renderCitations(list)` | 渲染角标（替换最后一条助手消息的裸 `[n]`） | SSE `citations` |
| `openCitation(idx)` | 打开抽屉、定位、高亮 | 点角标 |
| `closeCitation()` | 关抽屉，焦点回角标 | 关闭 / 滑下 / Esc |
| `showRefusal(ticketNo)` | 渲染拒答气泡 + 工单小卡 | SSE `refusal` |
| `lookupFault(code)` | GET `/api/fault/:code`，渲染结果卡 | 故障码页输入 |
| `createTicket(email, question)` | POST `/api/ticket` | 转人工 |
| `toast(msg)` | 3.5s 提示 | 各处 |
| `setStatus(textOrNull)` | 状态条显隐 | 流式开始/结束 |
| `abortIfStreaming()` | 有道未完成请求时先 abort | 再次发送 |

---

## 3. 对话页（`data-view="chat"`）

### 3.1 气泡规格

| 项 | 助手 | 用户 |
|---|---|---|
| class | `.msg.msg-a` | `.msg.msg-u` |
| 对齐 | `align-self:flex-start` | `flex-end` |
| 底色 | `var(--u-surface)` | `var(--u-primary)` |
| 文字 | `var(--u-text)` | `var(--u-on-primary)` |
| 圆角 | `var(--r-lg)` | `var(--r-lg)` |
| 最大宽 | `80%` | `80%` |
| 内边距 | `12px 14px` | `12px 14px` |
| 行内换行 | `overflow-wrap:anywhere` | 同 |

### 3.2 流式渲染

```
发送 → 立即追加用户气泡 + 空助手气泡 → setStatus("正在查资料…")
      → SSE delta 追加文本（保留末尾光标块 ▍）
      → SSE citations：把文本里的 [1] [2] 替换为 .cite 元素
      → SSE done / refusal：移除光标块，setStatus(null)
```

**角标渲染规则**：不能凭空造。只在收到 `citations` 事件后，把助手文本中形如 `[n]` 且 `n` 在 `citations` 里的片段替换为 `.cite` 元素；不在列表里的 `[n]` 原样保留为纯文本（这种异常由后端拦截，前端只兜底）。

### 3.3 连发

`state.streaming === true` 时再点发送：直接把新文本发出去（后端走 `steer`），并在流末尾插一行灰色小字"（已插入当前处理）"。

### 3.4 错误表现

| 错误码 | 表现 |
|---|---|
| `RATE_LIMITED` | toast「操作太频繁」+ 按钮禁用剩余秒数 |
| `LLM_TIMEOUT` | 助手气泡改为「响应超时」+「转人工」按钮 |
| `SESSION_BUSY` | 状态条「前方还有 N 位，已排队」，不报错 |
| `AUTH_INVALID` | 清 token，重新 `boot()` |
| 其他 | toast「系统繁忙」+ trace_id 后 6 位 |

### 3.5 键盘与安全区

```js
// 键盘跟手（不能用 position:fixed 硬顶）
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    document.documentElement.style.setProperty(
      '--kb-h', `${window.innerHeight - window.visualViewport.height}px`);
  });
}
```

`textarea` 自动增高：`scrollHeight` 上限 120px。

---

## 4. 引用抽屉

| 项 | 规格 |
|---|---|
| 打开 | 点 `.cite` → 存 `citingIdx` → 显示 overlay（去掉 `hidden`） |
| 动画 | `transform: translateY(100%)` → `0`，`var(--dur-base)` `var(--ease-out)` |
| 关闭动画 | `160ms`（比打开短 30%） |
| 关闭方式 | 点 `#cite-close` / 点 overlay 空白 / Esc / 下滑 >96px |
| 焦点 | 打开聚焦 `#cite-close`；关闭回原 `.cite` |
| 蒙层 | `rgba(15,23,42,.5)` |

### 内容渲染

```html
<div class="cite-card">
  <div class="cite-doc">Installationshandbuch 600W <span class="badge">DE</span></div>
  <div class="cite-meta">S. 12 · 4.2 Netzanschluss</div>
  <p class="cite-text">Die Netzspannung muss zwischen <mark>195 und 253 V</mark> liegen …</p>
</div>
```

- `snippet` ≤300 字，超长截断 + 「展开」
- 关键词高亮：把 query 的主要词（≥3 字符）包 `<mark>`
- 多引用时显示「上一条 / 下一条」，单条时隐藏

---

## 5. 故障码页（`data-view="fault"`）

```html
<section class="fault">
  <input id="fault-input" class="input input-lg" placeholder="输入故障码，如 E03"
         data-i18n-ph="fault.placeholder"
         autocapitalize="characters" autocomplete="off" inputmode="text">
  <div class="fault-recent" id="fault-recent"></div>
  <div class="fault-result" id="fault-result"></div>
</section>
```

| 行为 | 规格 |
|---|---|
| 输入防抖 | 400ms |
| 触发条件 | `/^[A-Za-z]\d{2,3}$/` 完全匹配 |
| 请求 | `GET /api/fault/{CODE}?lang={lang}&product_line=balcony` |
| 命中 | 渲染结果卡：代码 + 严重度徽章 + 含义 + 有序步骤 + 来源行（固定文案 `fault.source` = "来源：故障码表"） |
| 未命中 | 「没找到 E99」+「问 AI」按钮（把 `E99` 作为上下文进对话） |
| 最近 | `localStorage.faultRecent`，最多 3 个，点击直接查 |

**关键**：此页**不建立会话、不调模型**，延迟预算 1s。

---

## 6. 工单页（`data-view="ticket"`）

Plan C 只做**转人工入口**和**单号展示**，不做列表。

| 元素 | 行为 |
|---|---|
| 邮箱输入 | `type=email`，失焦校验 `^[^@\s]+@[^@\s]+\.[a-z]{2,}$` |
| 提交 | `POST /api/ticket` → 成功后切换到"已建单"状态 |
| 已建单 | 大字显示 `WT-2026-0031` + 复制按钮 + 「查看状态」 |
| 查看状态 | `GET /api/ticket/:no?email=`，显示状态徽章与截止时间 |
| 限流 | 收到 `QUOTA_TICKET` → 「今日建单已达上限」 |

---

## 7. 我的页（`data-view="me"`）

| 区块 | 内容 |
|---|---|
| 语言 | 5 个单选（`zh/en/de/nl/es`） |
| 外观 | 跟随系统 / 浅色 / 深色 |
| 数据 | 清空本机会话（清 localStorage + 新建 conv） |
| 关于 | 版本号 + 隐私说明（静态文案） |

---

## 8. 文案加载

```js
async function boot() {
  state.lang = pickLang();                 // localStorage → navigator.language → 'en'
  state.i18n = await fetch(`/api/i18n/${state.lang}`).then(r => r.json()).then(r => r.data);
  applyLang(state.lang);
  ...
}
```

- 所有静态文案节点写 `data-i18n="key"`，`applyLang` 时遍历替换
- 占位符写 `data-i18n-ph="key"`
- `aria-label` 写 `data-i18n-aria="key"`

**禁止**在 HTML 里硬编码用户可见文字（除 `<title>` 与 `<noscript>`）。

---

## 9. 无障碍检查点

- [ ] `.cite` 有 `aria-label="引用 1，查看原文"`
- [ ] `#stream` 有 `aria-live="polite"`
- [ ] 抽屉 `role="dialog"` + `aria-modal="true"` + 打开时聚焦
- [ ] 所有图标按钮有 `aria-label`
- [ ] Tab 顺序：输入框 → 发送 → tab 栏
- [ ] 抽屉打开时背景不可 Tab 进入（焦点陷阱）

---

## 10. 验收清单

- [ ] 390×844 下无横向滚动
- [ ] 桌面打开是 9:16 手机框，两侧深色
- [ ] 德语提问 → 德语回答 + 角标可点开
- [ ] `E03` 走快路，1s 内出卡
- [ ] 问「能打 8 折吗」→ 固定拒答话术 + 工单号
- [ ] 键盘弹出时输入框贴键盘，消息不被遮挡
- [ ] 切语言后全站文案变化，无需刷新
- [ ] `prefers-reduced-motion` 下抽屉无位移动画
- [ ] 弱网 3G 首屏 ≤3s 可用
