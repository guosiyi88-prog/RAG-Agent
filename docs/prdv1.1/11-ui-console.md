# 11 · 坐席端规格（16:9）

> 实现文件：`src/static/console.html` + `src/static/console.js`。Plan C 只做**队列 + 详情**。
> **i18n 例外（有意）**：坐席端只做中文，不做五语，**允许硬编码中文**。理由：内部工具 + 时间预算，且 `12-i18n.md` 的 key 表只覆盖用户端。用户端仍强制 `data-i18n`，不适用本例外。

## 1. 页面结构（DOM 契约）

```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>沃泰客服台</title>
  <style>/* 内联 app.css */</style>
</head>
<body data-app="console">
<div class="shell">

  <header class="topbar">
    <span class="topbar-brand">沃泰 客服台</span>
    <span class="topbar-spacer"></span>
    <span class="topbar-agent" id="agent-name">张伟</span>
  </header>

  <aside class="nav">
    <a class="nav-item is-active" data-nav="tickets">工单</a>
    <a class="nav-item" data-nav="kb" aria-disabled="true">知识库</a>
    <a class="nav-item" data-nav="nohit" aria-disabled="true">未命中池</a>
    <a class="nav-item" data-nav="board" aria-disabled="true">看板</a>
  </aside>

  <main class="work" id="work"><!-- 由 JS 渲染两个视图之一 --></main>

</div>
<script type="module" src="/assets/console.js"></script>
</body>
</html>
```

`aria-disabled="true"` 的导航项本期不实现，点击 toast「本期未开放」。

---

## 2. 视图一：队列（`#work` 内容）

```html
<section class="queue">
  <div class="queue-toolbar">
    <div class="tabs" role="tablist">
      <button role="tab" data-status="open,claimed,escalated" class="is-active">待处理</button>
      <button role="tab" data-status="closed">已关闭</button>
    </div>
    <select id="filter-reason">
      <option value="">全部原因</option>
      <option value="no_citation">无引用</option>
      <option value="out_of_scope">越界</option>
      <option value="low_conf">低置信</option>
      <option value="user_request">用户要求</option>
    </select>
    <input id="filter-q" class="input" placeholder="搜单号或问题">
  </div>

  <table class="grid">
    <thead>
      <tr>
        <th data-sort="no">单号</th>
        <th>摘要</th>
        <th>语言</th>
        <th>原因</th>
        <th>指派</th>
        <th data-sort="due_at" aria-sort="ascending">SLA</th>
        <th>创建</th>
      </tr>
    </thead>
    <tbody id="queue-body"><!-- 行由 JS 渲染 --></tbody>
  </table>
  <div class="empty" id="queue-empty" hidden>暂无工单</div>
</section>
```

### 2.1 行规格

| 列 | 宽 | 格式 |
|---|---|---|
| 单号 | 140 | `var(--font-mono)`，可点击复制 |
| 摘要 | flex | `ticket.question` 截 40 字，`title` 属性放全文 |
| 语言 | 64 | 大写两字母 + 徽章 |
| 原因 | 120 | 徽章，颜色见 §2.3 |
| 指派 | 84 | 无则 `—` |
| SLA | 100 | 倒计时 `Hh MMm`；<1h 用 `var(--c-st-sla)` 加粗 |
| 创建 | 96 | `MM-DD HH:mm` |

行高 `56px`。整行可点，`cursor:pointer`。

### 2.2 SLA 计算

```js
const left = Math.max(0, Math.floor((new Date(t.due_at) - Date.now()) / 1000));
const txt = left >= 3600 ? `${Math.floor(left/3600)}h ${Math.floor(left%3600/60)}m`
                         : `${Math.floor(left/60)}m`;
```

超时显示 `超时`（红色）。每 30s 重算一次（`setInterval`），不重新请求。

### 2.3 原因徽章

| reason | 文案 | 底色 |
|---|---|---|
| `no_citation` | 无引用 | `color-mix(in srgb, var(--c-st-open) 15%, transparent)` |
| `out_of_scope` | 越界 | `color-mix(in srgb, var(--c-st-other) 15%, transparent)` |
| `low_conf` | 低置信 | `color-mix(in srgb, var(--c-st-open) 15%, transparent)` |
| `user_request` | 用户要求 | `color-mix(in srgb, var(--c-st-claimed) 15%, transparent)` |

> 底色只能由令牌混出，**不得出现裸色值**（`09-ui-tokens.md` §1 硬规则）。

### 2.4 轮询

| 项 | 值 |
|---|---|
| 首屏 | 立即拉 |
| 间隔 | 5s |
| 暂停条件 | 标签页 `document.hidden` |
| 新单提示 | 顶部 toast「1 个新工单」+ 表格首行 300ms 高亮 |

---

## 3. 视图二：详情（三栏）

```html
<section class="detail">
  <div class="detail-col detail-left">
    <button class="btn btn-ghost" id="btn-back">← 返回队列</button>
    <div class="detail-meta" id="detail-meta"></div>
  </div>

  <div class="detail-col detail-main">
    <div class="thread" id="thread"></div>
    <div class="replier">
      <textarea id="reply" class="input" rows="5" placeholder="输入回复…"></textarea>
      <div class="replier-bar">
        <span class="replier-hint">Ctrl/Cmd + Enter 发送</span>
        <button class="btn btn-ghost" id="btn-translate">翻译</button>
        <button class="btn btn-primary" id="btn-send-reply">发送</button>
        <button class="btn btn-ghost" id="btn-close-ticket">关单</button>
      </div>
    </div>
  </div>

  <aside class="detail-col detail-side">
    <div class="side-block">
      <h3>AI 候选</h3>
      <div id="ai-draft" class="empty-sm">本期不提供（A3 预留）</div>
    </div>
    <div class="side-block">
      <h3>引用</h3>
      <ul id="side-cites"></ul>
    </div>
  </aside>
</section>
```

### 3.1 左栏 meta

渲染内容：

```
WT-2026-0031        [复制]
无引用 · 德语 · 阳台储能
SLA 2h14m           [认领]
创建 10-27 14:20
```

按钮：`认领`（`assignee` 为空时显示）、`转 L2`、`转 FAQ 草稿`（本期 toast 未开放）。

### 3.2 中栏 thread

| 元素 | 规格 |
|---|---|
| 用户消息 | `.t-msg.t-u`，左对齐，surface 底 |
| AI 消息 | `.t-msg.t-a`，左对齐，白底 + 左侧 3px `var(--c-cta)` 竖线 |
| 拒答标记 | AI 消息下方 `.t-warn`：「⚠ 本轮无检索证据」 |
| 角标 | 可点，弹 modal 显示 `snippet`（不是抽屉，桌面用 modal） |
| 工具轨迹 | `.t-tools` 折叠，默认收起，内容：`kb_search · 420ms` |
| 时间 | 每条右下角 `HH:mm` |

### 3.3 回复框

| 行为 | 规格 |
|---|---|
| 草稿保存 | `localStorage['draft:' + ticketId]`，输入即存（防抖 500ms） |
| 发送快捷键 | `Ctrl/Cmd + Enter` |
| 发送后 | `PATCH /api/console/tickets/:id`（status→claimed）+ 追加消息（本期只做本地追加 + 刷新详情） |
| 关单 | 弹输入框要求填 `resolution`（≥10 字），否则按钮禁用 |
| 翻译 | 调 `POST /api/console/translate`（本期返回 501 → toast「本期未开放」） |

### 3.4 右栏

| 区块 | Plan C 状态 |
|---|---|
| AI 候选 | 显示占位「本期不提供」 |
| 引用 | **实现**：列出当前工单对话里所有 AI 消息的 citations，点击展开原文 |

---

## 4. `console.js` 模块契约

```js
const state = {
  token: null,          // X-Admin-Token（从 localStorage 读，或 URL ?t=）
  staffId: null,        // X-Admin-Staff（seed 第一个坐席 id；认领时随 PATCH 一起发）
  view: 'queue',        // 'queue' | 'detail'
  ticketId: null,
  items: [],
  filter: { status: 'open,claimed,escalated', reason: '', q: '' },
  timer: null,
};
```

> 每个请求头都要带 `X-Admin-Token`；`claimTicket()` 额外带 `X-Admin-Staff: state.staffId`，否则后端会退回 seed 第一条坐席（`05-api.md` §4.3）。

| 函数 | 职责 |
|---|---|
| `boot()` | 校验 token，绑事件，`loadQueue()` |
| `loadQueue()` | GET 列表，渲染表格 |
| `renderRow(t)` | 单行 HTML |
| `openTicket(id)` | 切详情视图，GET 详情，渲染三栏，写 `location.hash` |
| `renderThread(messages)` | 渲染对话 + 引用 |
| `claimTicket(id)` | PATCH status=claimed |
| `closeTicket(id, resolution)` | PATCH status=closed |
| `copyNo(no)` | 复制单号 + toast |
| `startPolling()` / `stopPolling()` | 5s 轮询，`visibilitychange` 控制 |
| `toast(msg)` | 提示 |

**路由**：`location.hash` = `#/ticket/{id}` 或空。`hashchange` 时切换视图。刷新页面能回到同一工单。

---

## 5. 快捷键

| 键 | 功能 |
|---|---|
| `J` / `K` | 队列上下移动 |
| `Enter` | 打开选中行 |
| `Esc` | 返回队列 / 关 modal |
| `Ctrl/Cmd + Enter` | 发送回复 |
| `?` | 显示「本期仅支持上述 4 个快捷键」toast |

有输入框聚焦时，`J/K/Enter` 不生效（避免抢输入）。

---

## 6. 布局尺寸

```css
body[data-app="console"] { height: 100dvh; overflow: hidden; }
.shell {
  display: grid;
  grid-template-columns: var(--nav-w) 1fr;
  grid-template-rows: 56px 1fr;
  grid-template-areas: "top top" "nav work";
  height: 100dvh;
}
.topbar { grid-area: top; }
.nav    { grid-area: nav; background: var(--c-primary); color: var(--c-on-primary); }
.work   { grid-area: work; overflow: auto; background: var(--c-bg); }

.detail {
  display: grid;
  grid-template-columns: 280px minmax(420px, 1fr) 360px;
  gap: var(--s4);
  height: 100%;
}
```

| 断点 | 行为 |
|---|---|
| ≥1440 | 三栏如上 |
| 1280–1439 | 右栏 320px |
| <1280 | 右栏折叠为图标，点击浮层展开 |

**最小支持 1280×720**，低于此显示「请放大窗口至 1280 宽以上」。

---

## 7. 验收清单

- [ ] 新工单 5s 内出现在队列
- [ ] SLA 倒计时等宽不抖动，超时变红
- [ ] 点行进入详情，URL 变 `#/ticket/31`，刷新能回到该工单
- [ ] 认领后指派列显示当前坐席
- [ ] 关单必须填 ≥10 字 resolution
- [ ] 引用可点开看原文
- [ ] 1440×810 下「发送」「关单」无需滚动可见
- [ ] 1280×720 无横向滚动
- [ ] 刷新页面后草稿仍在
- [ ] Tab 顺序 = 视觉顺序，焦点环可见
