# 09 · 设计令牌与组件

> 实现文件：`src/static/app.css`。两端共用一套令牌，色系分家。

## 1. 令牌（`app.css` 顶部，直接复制）

```css
:root {
  /* ── 间距：4/8 栅格 ── */
  --s1:4px;  --s2:8px;  --s3:12px; --s4:16px;
  --s6:24px; --s8:32px; --s12:48px;

  /* ── 圆角 ── */
  --r-sm:8px; --r-md:12px; --r-lg:16px; --r-xl:24px; --r-full:999px;

  /* ── 字号 ── */
  --t-cap:12px; --t-sm:14px; --t-body:16px; --t-title:20px; --t-h2:24px; --t-h1:32px;

  /* ── 行高 ── */
  --lh-tight:1.25; --lh-body:1.55;

  /* ── 层级 ── */
  --z-base:0; --z-sticky:10; --z-overlay:20; --z-sheet:40; --z-toast:100;

  /* ── 动效 ── */
  --ease-out:cubic-bezier(.16,1,.3,1);
  --dur-fast:150ms; --dur-base:220ms; --dur-slow:320ms;

  /* ── 尺寸 ── */
  --header-h:56px; --tabbar-h:56px; --composer-h:64px;
  --nav-w:240px;
  --kb-h:0px;                   /* 键盘高度，由 user.js 运行时写入（10 §3.5） */

  /* ── 用户端色 ── */
  --u-primary:#F97316;          /* 只做填充色，不做白底文字 */
  --u-primary-ink:#C2410C;      /* 白底文字/角标用，对比度 5.2:1 */
  --u-on-primary:#0F172A;
  --u-accent:#22C55E;
  --u-bg:#FFFFFF;
  --u-surface:#F8FAFC;
  --u-text:#0F172A;
  --u-muted:#64748B;
  --u-border:#E2E8F0;
  --u-danger:#EF4444;
  --u-warn:#F59E0B;

  /* ── 坐席端色 ── */
  --c-primary:#0F172A;
  --c-on-primary:#FFFFFF;       /* 深色底上的文字 */
  --c-cta:#0369A1;
  --c-bg:#F8FAFC;
  --c-surface:#FFFFFF;
  --c-border:#E2E8F0;
  --c-text:#0F172A;
  --c-muted:#64748B;
  --c-st-open:#F59E0B;
  --c-st-claimed:#0369A1;
  --c-st-closed:#22C55E;
  --c-st-sla:#EF4444;
  --c-st-other:#8B5CF6;         /* out_of_scope 等「其他原因」徽章 */

  /* ── 字体 ── */
  --font-ui: "Noto Sans SC", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-display: "Space Grotesk", var(--font-ui);
  --font-mono: "Fira Code", ui-monospace, "SF Mono", Consolas, monospace;
}

/* 用户端深色 */
[data-theme="dark"] {
  --u-bg:#0F172A;
  --u-surface:#1F2937;
  --u-text:#F8FAFC;
  --u-muted:#94A3B8;
  --u-border:#374151;
  --u-primary:#FB923C;
  --u-primary-ink:#FDBA74;      /* 深底上的角标文字，对比度 7.4:1 */
  --u-accent:#4ADE80;
  --u-danger:#F87171;
  --u-warn:#FBBF24;
}
```

**硬规则**：组件样式里**禁止**出现裸色值（`#fff`、`red`），一律用 `var(--*)`。

---

## 2. 基础元素样式

```css
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--t-body);
  line-height: var(--lh-body);
  color: var(--u-text);
  background: var(--u-bg);
  -webkit-font-smoothing: antialiased;
  overscroll-behavior-y: none;
}
button { font: inherit; cursor: pointer; touch-action: manipulation; }
:focus-visible { outline: 2px solid var(--u-primary); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    transition-duration: .01ms !important;
  }
}
```

---

## 3. 通用组件清单

| 组件 | class | 规格 |
|---|---|---|
| 主按钮 | `.btn .btn-primary` | 高 44，圆角 `--r-md`，字重 600 |
| 次按钮 | `.btn .btn-ghost` | 透明底，边框 `--u-border`（坐席端用 `--c-border`） |
| 危险按钮 | `.btn .btn-danger` | 底 `--u-danger`（坐席端同用），仅用于关单/删除 |
| 输入框 | `.input` | 高 44（移动端 48），内边距 12 |
| 徽章 | `.badge` | 高 22，字号 12，圆角 `--r-full` |
| 卡片 | `.card` | 白底，`--r-lg`，`1px` 边框，无重阴影 |
| 空态 | `.empty` | 居中，图标 48 + 主文案 + 次文案 + 主操作 |
| 骨架 | `.skeleton` | 灰底 + 120ms 脉冲，圆角跟随目标 |
| Toast | `.toast` | 底部浮层，3.5s 自动消失，`aria-live=polite` |
| 抽屉 | `.sheet` | 底部滑入，圆角上 16，蒙层 50% |
| 分割线 | `.divider` | 1px `--u-border`（坐席端 `--c-border`） |

### 3.1 状态样式（每个可交互元素必须有）

```css
.btn:active      { transform: scale(.97); }
.btn[disabled]   { opacity: .45; cursor: not-allowed; transform: none; }
.btn.is-loading  { color: transparent; position: relative; }
.btn.is-loading::after {
  content:""; position:absolute; inset:0; margin:auto;
  width:16px; height:16px; border-radius:50%;
  border:2px solid currentColor; border-top-color:transparent;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
```

按压反馈必须 **≤100ms** 出现（`scale(.97)` 已满足）。

---

## 4. 引用角标（用户端专用，规格严格）

```css
.cite {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px; height: 18px;
  padding: 0 4px;
  margin: 0 2px;
  border: 1px solid var(--u-primary-ink);
  border-radius: 4px;
  font-size: 11px;
  line-height: 1;
  color: var(--u-primary-ink);
  font-variant-numeric: tabular-nums;
  position: relative;
  cursor: pointer;
  background: transparent;
}
/* 命中区扩到 44×44 */
.cite::after {
  content: "";
  position: absolute;
  inset: -13px;
}
```

**必须**：视觉 18px，命中 44×44。手机上 18px 点不中。

---

## 5. 图标（内联 SVG，不引 CDN）

用 Lucide 的 path，统一 24×24 viewBox、`stroke-width:1.75`、`stroke:currentColor`、`fill:none`、`stroke-linecap:round`。

需要的最小集合（8 个）：

| 名称 | 用途 |
|---|---|
| `message-circle` | 对话 tab |
| `alert-triangle` | 故障码 tab |
| `ticket` | 工单 tab |
| `user` | 我的 tab |
| `globe` | 语言切换 |
| `send` | 发送 |
| `x` | 关闭 |
| `chevron-left` | 返回 |

**禁止**：用 emoji 当图标。

---

## 6. 两端的差异（同一份 CSS）

| 项 | 用户端 | 坐席端 |
|---|---|---|
| 作用域 | `body[data-app="user"]` | `body[data-app="console"]` |
| 主色变量 | `--u-*` | `--c-*` |
| body 背景 | `--u-bg` | `--c-bg` |
| 字号基准 | 16 | 14（表格密度） |
| 圆角 | `--r-lg` 为主 | `--r-md` 为主 |

实现方式：`app.css` 里写两套作用域，不写媒体查询。

```css
body[data-app="console"] { font-size: 14px; background: var(--c-bg); color: var(--c-text); }
body[data-app="console"] .card { background: var(--c-surface); border-color: var(--c-border); }
```

---

## 7. 用户端 9:16 容器（精确实现）

```css
body[data-app="user"] { display: grid; place-items: center; height: 100dvh; background: #0F172A; }

.phone {
  width:  min(100vw, calc(100dvh * 9 / 16));
  height: min(100dvh, calc(100vw * 16 / 9));
  aspect-ratio: 9 / 16;
  background: var(--u-bg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
}
```

桌面下两侧是 `#0F172A`，手机框居中，**不变形**。

---

## 8. 可访问性基线

| 项 | 要求 |
|---|---|
| 对比度 | 所有文字 ≥4.5:1；大字（≥20px 粗体）≥3:1 |
| 触摸目标 | ≥44×44（用 `::after` 扩展，不改视觉尺寸） |
| 焦点 | `:focus-visible` 必须有可见环 |
| 语义 | 按钮用 `<button>`，不用 `<div onclick>` |
| ARIA | 图标按钮必须有 `aria-label`；新消息区 `aria-live="polite"` |
| 语言 | `<html lang>` 随语言切换 |
| 缩放 | 允许用户缩放，禁止 `user-scalable=no` |

---

## 9. 性能约束

| 项 | 要求 |
|---|---|
| 首屏 CSS | 单文件内联进 HTML（`<style>`），≤15KB |
| 外部字体 | 最多 1 个（Space Grotesk 500/700），`font-display:swap` + `preconnect` |
| 图片 | 不使用位图；logo 用 SVG |
| JS | 两个 `.js` 文件，各 ≤400 行，原生 ES module |
| 无 CDN | 除字体外不请求外部资源 |
