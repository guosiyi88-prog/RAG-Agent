# 09 · 设计令牌（as-built）

> 权威文件：`src/static/app.css`（174 行，两端共用）+ `src/static/console.css`（192 行，坐席端专属）。
> **硬规则：CSS 里不许出现裸色值**（`app.css:1`），一律用变量。新增颜色 = 新增令牌。

---

## 1. 尺寸令牌

| 组 | 令牌 | 值 |
|---|---|---|
| 间距 | `--s1/2/3/4/6/8/12` | 4 / 8 / 12 / 16 / 24 / 32 / 48 px |
| 圆角 | `--r-sm/md/lg/xl/full` | 8 / 12 / 16 / 24 / 999 px |
| 字号 | `--t-cap/sm/body/title/h2/h1` | 12 / 14 / 16 / 20 / 24 / 32 px |
| 行高 | `--lh-tight` / `--lh-body` | 1.25 / 1.55 |
| 层级 | `--z-base/sticky/overlay/sheet/toast` | 0 / 10 / 20 / 40 / 100 |
| 动效 | `--dur-fast/base/slow` | 150 / 220 / 320 ms |
| 缓动 | `--ease-out` | `cubic-bezier(.16,1,.3,1)` |
| 布局 | `--header-h` / `--tabbar-h` / `--composer-h` / `--nav-w` | 56 / 56 / 64 / 240 px |
| 键盘 | `--kb-h` | 运行期由 `user.js` 写入（默认 0） |

---

## 2. 两套色系（同源令牌，色系分家）

### 2.1 用户端 `--u-*`（暖色，安装商/业主）

| 令牌 | 值 | 用法约束 |
|---|---|---|
| `--u-primary` | `#F97316` | **只做填充**（按钮底色、气泡底色） |
| `--u-primary-ink` | `#C2410C` | **白底上的文字/边框**（对比度 5.2:1） |
| `--u-on-primary` | `#0F172A` | 主色底上的前景 |
| `--u-accent` | `#22C55E` | 成功 |
| `--u-bg` / `--u-surface` | `#FFFFFF` / `#F8FAFC` | 页面 / 卡片 |
| `--u-text` / `--u-muted` / `--u-border` | `#0F172A` / `#64748B` / `#E2E8F0` | — |
| `--u-danger` / `--u-warn` | `#EF4444` / `#F59E0B` | — |
| `--u-focus` | `= --u-primary-ink` | 焦点环：`--u-primary` 在白底只有 **2.8:1**，不够 |
| `--u-mark` | `rgba(249,115,22,.22)` | `<mark>` 高亮 |
| `--u-scrim` / `--u-frame` | `rgba(0,0,0,.5)` / `#0F172A` | 抽屉遮罩 / 手机框外底色 |

### 2.2 坐席端 `--c-*`（冷色，内部工具）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--c-primary` | `#0F172A` | 顶栏/导航深色底 |
| `--c-on-primary` | `#FFFFFF` | 深底前景 |
| `--c-cta` | `#0369A1` | 主操作（CTA） |
| `--c-bg` / `--c-surface` / `--c-border` | `#F8FAFC` / `#FFFFFF` / `#E2E8F0` | — |
| `--c-text` / `--c-muted` | `#0F172A` / `#64748B` | — |
| `--c-st-open` | `#F59E0B` | 待处理 |
| `--c-st-claimed` | `#0369A1` | 处理中 |
| `--c-st-closed` | `#22C55E` | 已关闭 |
| `--c-st-sla` | `#EF4444` | SLA 紧急/超时 |
| `--c-st-other` | `#8B5CF6` | 已升级等其它状态 |

坐席端**不复制**基础组件样式：`.btn` / `.input` / `.badge` / `.cite` / `.toast` / `.sprite` 全部来自
`app.css`，`console.css` 只写坐席端独有的骨架与栏位。

### 2.3 暗色模式

`[data-theme="dark"]` 覆写 **10 个** `--u-*` 变量（bg / surface / text / muted / border / primary /
primary-ink / accent / danger / warn）+ `color-scheme: dark`。**收尾阶段只做了变量层面**，未逐屏精修
（v1.1 已把"深色精修"列为不做）。

---

## 3. 组件令牌与几何

| 组件 | 几何 | 备注 |
|---|---|---|
| 手机框 `.phone` | `aspect-ratio: 9/16`；宽 `min(100%, frame-h*9/16)`，高 `min(frame-h, 100vw*16/9)` | 用 `aspect-ratio` 约束，**不靠 `overflow-x`**；`frame-h` 走 `100dvh`（`@supports`） |
| 气泡 | 最大宽 80%，圆角 `--r-lg`，靠底角 `--r-sm` | 用户右、助手左 |
| 角标 `.cite` | 18×18，字号 11，边框 `--u-primary-ink`，`::before` 扩到 44px 命中区 | 视觉 18px、触达 44px |
| 按钮 `.btn` | 最小 **44×44**，圆角 `--r-md` | `:active` 缩放到 .97 |
| 输入 `.input` | 最小高 44 | 大号 `.input-lg` 48 |
| 徽章 `.badge` | 高 22，横向内边距 `--s2` | **不做 44 宽**（它是标签不是按钮） |
| 抽屉 `.sheet` | 最大高 70vh，最大宽 560，圆角只在上两角 | 位移由 `--sheet-dy` 驱动 |
| 快捷条 `.tabbar` | 高 56，每格 ≥44 | 5 个目标 |

**可访问性三条**：`:focus-visible` 统一 2px 焦点环；`[hidden]` 强制 `display:none!important`；
移动端触控目标 ≥44px，间距 ≥8px。

---

## 4. 动效与降级

| 场景 | 时长 | 说明 |
|---|---|---|
| 按压反馈 | ≤150ms | `.cite::after` 透明度、`.btn:active` 缩放 |
| 抽屉滑出 | 220ms（开）/ 160ms（关） | 拖拽时 `is-dragging` 关掉 transition |
| 光标闪烁 | 1s steps | 只在 `streaming` 显示 |

`@media (prefers-reduced-motion: reduce)`：所有动画/过渡降到 `0.01ms`，光标常亮，**抽屉不做位移**。

---

## 5. 字号与断词（五语的现实问题）

- `.btn` / `.tab` / `.badge` / `legend` 全部 `hyphens:auto`，依赖 `<html lang>`（`applyLang` 写入）——
  德语长词（`Wechselrichterwirkungsgrad`）在 390 宽下靠断词而不是撑破。
- `.badge` 允许在 flex 行里收缩（`max-width:100%`），否则会顶出容器。

---

## 6. 与 v1.1 的差异（本章）

| # | v1.1 | 实际 | 编号 |
|---|---|---|---|
| 1 | 令牌表未含坐席端状态色 | 新增 `--c-st-*` 五色（open/claimed/closed/sla/other） | E36 |
| 2 | 未写暗色模式的落地范围 | 只覆写变量，未逐屏精修 | E37 |
| 3 | 类名只有一套 | 出现**双写**：`.msg`/`.bubble`、`.msg-u`/`.bubble--user`、`.status*` 等（历史兼容） | E38 |
