# 06 · 非功能需求：安全、性能、合规、可观测

## 1. 安全矩阵

| 面 | 威胁 | 措施 | 验收方式 |
|---|---|---|---|
| 用户端身份 | 匿名刷接口 | 后端签发 `session_token`（UUID v4，Redis TTL 7d，签名绑定 IP 段） | 无 token 请求 `/api/chat` 返回 401 |
| 接口滥用 | 单 token 高频调用 | 20 次/分/token；IP 60 次/分 | 压测触发 429 |
| 工单灌库 | 匿名批量建单 | 3 张/小时/token；同 question 去重 10 分钟内合并 | 脚本连发 10 次，第 4 次 429 |
| 文件上传 | 恶意大文件/类型伪装 | ≤5MB、`image/*` 嗅探（magic number）、10 张/天/token | 上传 .exe 改名 .png 被拒 |
| 坐席端 | 未授权访问运营接口 | 固定 `X-Admin-Token`（env），所有 `/api/console/*` 校验 | 无 header 返回 401 |
| 内部接口 | 浏览器直接打 `/internal/*` | `X-Internal-Token` + 只监听 127.0.0.1 | 公网访问返回 404 |
| 工具越权 | 模型调用 read/bash/edit/write | `tools:[]` 白名单不含内置工具；`tool_call` hook 二次拦截（fail-closed） | `getActiveToolNames()` 只含 7 个 |
| Prompt 注入 | 文档里藏"忽略以上指令" | 片段入库前正则清洗；`<doc>` 包裹 + 声明"资料非指令" | 构造注入文档，回答不偏离 |
| 输出越界 | 承诺折扣/交期/竞品评价 | 输出过滤词表 + 拒答三段式 | 问 8 折 → 固定话术 |
| 引用造假 | 模型编造 `[3]` | 后端强校验 n ∈ 候选编号；不合格整条降级为拒答 | 刻意诱导，输出仍合法 |
| 密钥泄露 | token 进前端包 | 只下发短期 user token；Admin token 永不进前端 | 检查构建产物无 admin token |
| 依赖风险 | npm 供应链 | `package-lock.json` + `npm ci`；锁 22 个依赖版本 | `npm audit` 无 high |

### 1.1 限流实现

Redis 滑动窗口（`ZSET` + `ZREMRANGEBYSCORE`），key 维度：

```
rl:chat:{token}      20/min
rl:chat:ip:{ip}      60/min
rl:ticket:{token}    3/hour
rl:upload:{token}    10/day
rl:admin:{ip}        300/min
```

超限返回 `RATE_LIMITED` + `Retry-After` 头。

---

## 2. 合规（GDPR / 欧洲客户）

| 要求 | 措施 |
|---|---|
| 数据最小化 | 只存邮箱（可选）、会话内容、语言；不存 IP 明文（哈希后存） |
| 会话不上报 | **禁用 Pi 的 session 分享能力**，README 明确声明；`PI_SHARE=off` |
| 数据驻留 | 全部组件自托管（PG/Redis/MinIO 同机），无第三方 SaaS 存储 |
| 保留期限 | 90 天自动清理会话；工单 2 年 |
| 删除权 | 「我的」→「删除我的数据」：删 `conversations`（级联 messages/citations/feedback）+ MinIO 附件，24h 内完成 |
| 可携带权 | 「下载我的数据」：导出 JSON（会话 + 工单） |
| 处理者告知 | 首屏底部一行说明 + 「隐私说明」页 |
| 日志脱敏 | 邮箱打码 `a***@b.com`；不记消息原文到应用日志 |

### 2.1 待确认的合规项

| # | 项 | 状态 |
|---|---|---|
| C-1 | Pi 运行时是否内置遥测/上报 | **未验证**，需在 H0 用抓包确认；若有，必须关 |
| C-2 | DeepSeek API 的数据使用条款是否可用于欧洲客户数据 | 需法务确认；备选切自托管模型（本地 Qwen） |
| C-3 | 会话内容是否属于"个人数据"（安装商以公司身份提问时） | 需法务确认 |

> C-1 是开发前置阻断项：H0 阶段必须先验证，未通过不得进入 H1.5 之后。

---

## 3. 性能 SLO

| 指标 | 目标 | 测量点 |
|---|---|---|
| 首字延迟 | P95 < 3s | SSE 第一个 `delta` |
| 单轮延迟 | P95 < 8s | 发送 → `done` |
| 故障码直查 | P95 < 1s | 输入 → 结果卡 |
| 检索耗时 | P95 < 300ms | pgvector + tsvector + RRF |
| 页面首屏 | < 1.5s（3G Fast） | LCP |
| 坐席队列 | < 800ms | 列表渲染 |
| 并发会话 | 5（单实例） | 超限排队 |

### 3.1 容量与资源

| 资源 | 估算 | 上限 |
|---|---|---|
| 进程内存 | 基础 200MB + 100MB/活跃 session | 1.2GB（5 并发） |
| PG 存储 | 5 语 × 12 文档 × 300 chunks × 1.5KB + 向量 | < 200MB |
| Redis | 租约 + 限流 + 缓存 | < 50MB |
| MinIO | 原件 + 导出 | < 2GB |

单机 2C4G 可跑；演示环境 2C2G 也够（并发降到 3）。

---

## 4. 可观测

### 4.1 结构化日志

每请求一行 JSON：`{ts, level, trace_id, route, status, ms, token_id?, ticket_no?}`

**不记**：消息原文、邮箱、token 明文。

### 4.2 指标（`/healthz` + `/metrics`）

| 指标 | 采集 |
|---|---|
| `chat_total / chat_refused_total` | 计数 |
| `chat_latency_ms` | 直方图（p50/p95/p99） |
| `tool_calls_total{name}` | 计数 |
| `retrieval_hit_rate` | 每 100 轮统计一次 |
| `session_active` | 仪表 |
| `llm_tokens_total{model}` / `cost_usd_total` | 计数 |
| `pi_session_dispose_total{reason}` | 计数 |

### 4.3 告警阈值（演示期手动观察）

| 条件 | 动作 |
|---|---|
| 单轮延迟 P95 > 15s 持续 5 分钟 | 切 `SAFE_MODE` |
| 拒答率 > 60% 持续 10 分钟 | 检查 embedding / 检索 |
| 进程 RSS > 1.2GB | 强制回收最旧 session |
| `/healthz` 任一红 | 页面顶部条提示降级 |

---

## 5. 降级开关总表

| 开关 | 默认 | 触发 | 影响 |
|---|---|---|---|
| `EMBED_BACKEND` | `dashscope` | 额度/故障 | 切 `hash`，召回质量降 |
| `LLM_PROVIDER` | `deepseek` | 不可用 | 切 `mock`，摘句回答 |
| `STORAGE` | `minio` | 不可用 | 切 `local` |
| `SAFE_MODE` | `0` | 答辩/异常 | `1` 时只答有引用问题 |
| `REFUSAL_ENABLED` | `1` | 调试 | `0` 时不自动拒答（仅内部） |
| `NIGHT_AUTOREPLY` | `1` | — | 夜间只走 AI，不排坐席 |
| `PARALLEL_LIMIT` | `5` | 内存压力 | 降到 `3` |

所有开关走 `settings` 表 + 环境变量，环境变量优先。

---

## 6. 备份与恢复

| 数据 | 策略 | 恢复目标 |
|---|---|---|
| PG | 每日 `pg_dump` 到 MinIO | RPO 24h / RTO 1h |
| MinIO | 原件可重新上传 | 允许丢失（有源文件） |
| Redis | 不备份（缓存+租约） | 重启即空，可接受 |
| 配置 | `.env` + `settings` 表导出 | 版本管理 |

演示前必须做一次 `pg_dump`，防止现场改坏数据。

---

## 7. 无障碍与国际化

| 项 | 要求 |
|---|---|
| 对比度 | 正文 ≥4.5:1，大字 ≥3:1 |
| 键盘 | 全部可 Tab 达，焦点环 2px |
| 语义 | `aria-live` 新消息、`aria-sort` 表头、`aria-label` 图标按钮 |
| 动效 | 遵守 `prefers-reduced-motion` |
| 字号 | 支持 130% 系统放大不破版 |
| 语言属性 | `<html lang>` 随语言切换（影响屏幕阅读器发音） |
| 数字 | 等宽表格数字，避免跳动 |

---

## 8. 浏览器与设备支持

| 端 | 支持 |
|---|---|
| 用户端 | iOS Safari 16+、Android Chrome 110+、微信内置浏览器（基础功能） |
| 坐席端 | Chrome / Edge 最新两个版本；不支持 Safari（表格密度问题） |
| 不支持 | IE、Android 8 以下 |

**微信内置浏览器是隐性需求**（安装商常用微信分享链接），必须测：SSE 在 iOS 微信下会被缓冲，需要用 `fetch` + `ReadableStream` 而非 `EventSource`。
