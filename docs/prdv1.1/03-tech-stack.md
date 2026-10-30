# 03 · 技术栈与依赖

## 1. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | **≥ 22.19.0** | Pi SDK 硬性要求 |
| TypeScript | ^5.6 | `strict: true` |
| Fastify | ^5 | HTTP + SSE |
| PostgreSQL | **16**（镜像 `pgvector/pgvector:pg16`） | 含 pgvector 0.7+ |
| Redis | **7-alpine** | 缓存/租约/限流 |
| MinIO | latest | 对象存储 |
| `@earendil-works/pi-coding-agent` | **1.4.0（精确锁，不带 ^）** | 升级会破坏 API |

---

## 2. package.json（权威内容，直接复制）

```json
{
  "name": "wotai-support-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.19.0"
  },
  "scripts": {
    "dev": "node --env-file-if-exists=.env --experimental-strip-types --watch src/server.ts",
    "start": "node --env-file-if-exists=.env --experimental-strip-types src/server.ts",
    "ingest": "node --env-file-if-exists=.env --experimental-strip-types scripts/ingest.ts",
    "eval": "node --env-file-if-exists=.env --experimental-strip-types scripts/eval.ts",
    "demo": "node --env-file-if-exists=.env --experimental-strip-types scripts/demo.ts",
    "i18n:check": "node --env-file-if-exists=.env --experimental-strip-types scripts/check-i18n.ts",
    "perf:fault": "node --env-file-if-exists=.env --experimental-strip-types scripts/perf-fault.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "1.4.0",
    "@earendil-works/pi-ai": "1.4.0",
    "fastify": "^5.2.0",
    "ioredis": "^5.4.0",
    "minio": "^8.0.0",
    "pg": "^8.13.0",
    "pino": "^9.5.0",
    "pino-pretty": "^13.0.0",
    "typebox": "^1.3.27"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.0",
    "typescript": "^5.6.0"
  }
}
```

### 2.1 依赖取舍说明

| 决定 | 原因 |
|---|---|
| 不用 dotenv | Node 22 自带 `--env-file`，`node --env-file=.env` 即可 |
| 不用 ORM | 手写 SQL，18 张表不值得引入 Prisma |
| 不用 zod | Pi 1.4.0 的 `ToolDefinition.parameters` 是 **`typebox` v1** 的 `TSchema`（`typebox` 是 `@sinclair/typebox` 的新包名，SDK 内部依赖 `typebox@1.3.27`）。用旧包 `@sinclair/typebox@0.34` 会类型不兼容，一个 schema 库够了 |
| 不用 express | Fastify 原生支持流式响应与 schema 校验 |
| 不用 pdf-parse | 见 §4 |
| 精确锁 Pi | 1.x 内部 API 会变，`^` 会在某天静默破坏 |

### 2.2 TypeScript 配置（`tsconfig.json`）

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts"]
}
```

> `allowImportingTsExtensions: true` + `noEmit`：运行时用 `--experimental-strip-types` 直接跑 `.ts`，不产出 JS，也不引入构建链。

---

## 3. PDF 解析方案（必须先用 T01 验证）

| 方案 | 优点 | 缺点 | 备注 |
|---|---|---|---|
| **`pdftotext`（poppler-utils）** | 稳定、快、无 JS 依赖 | 需系统装 poppler；Dockerfile 里 `apk add poppler-utils` | **首选** |
| `pdfjs-dist` | 纯 JS | 复杂版式易乱 | 备选 |
| 调外部 HTTP 服务 | 无 | 引入新依赖 | 不采用 |

**决策**：Dockerfile `apk add --no-cache poppler-utils`，`ingest.ts` 用 `child_process.execFile('pdftotext', ['-layout', in, out])`。

若 T01 发现环境装不上 → 降级为"只支持 `.txt` 与 `.md` 语料 + 前端粘贴文本入库"。**此项必须在 T01 结束前确认。**

---

## 4. Embedding 方案

| 模式 | 实现 | 何时用 |
|---|---|---|
| `dashscope`（默认） | `POST https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding`，model `text-embedding-v3`，1024 维 | 正常 |
| `hash`（兜底） | `src/core/hash-embed.ts`：FNV-1a 对 token 哈希后填 1024 维并 L2 归一化（`scripts/mock-embed.ts` 只是 CLI 包装，见 08 §5.3） | API 故障/离线演示 |

**维度锁死 1024**，换模型必须重建 `chunks` 表。

---

## 5. LLM 方案

| 项 | 值 |
|---|---|
| Provider id | `deepseek`（即 `modelRuntime.getModel("deepseek", …)` 的第一个参数） |
| Base URL | `https://api.deepseek.com`（OpenAI 兼容） |
| 默认模型 | `deepseek-flash` |
| 思考模式 | **必须 `thinkingLevel: "off"`**。该模型默认开思考，不关则首字破 3s |
| 参数 | `temperature=0.2`，`max_tokens=800` |
| 禁用 | 任何 pro 级模型（延迟与单价都翻倍，破坏首字与成本预算） |
| 降级 | `LLM_PROVIDER=mock` → 从命中片段摘句 |

模型对象的来源（按序尝试，见 `02-architecture.md` §4.1）：

1. **宿主**：`ModelRuntime.create()` 自动读 `~/.pi/agent/models-store.json` + `auth.json`（`deepseek` 目录里已有 `deepseek-flash`）
2. **容器**：镜像里没有 `~/.pi/agent`，靠 `modelRuntime.setRuntimeApiKey(config.MODEL_PROVIDER, config.DEEPSEEK_API_KEY)` 注入凭据；模型目录用内置目录，只有当 `getModel()` 返回 `undefined` 时才需要挂一份最小 `models-store.json`（对应 `16-risks-errata.md` R2）
3. **降级判定**：`getModel()` 为 `undefined` → 抛 `LLM_UNAVAILABLE`，`/healthz` 的 `pi` 项为 false

**T00 必须验证**：容器内 `getModel("deepseek","deepseek-flash")` 非 `undefined`，且发一次真实 prompt 能拿到回复。

---

## 6. 前端技术（有意保持原始）

| 项 | 选择 | 理由 |
|---|---|---|
| 框架 | 无 | 两个页面，不需要 |
| 样式 | 手写 CSS + CSS 变量 | Tailwind CDN 会增加一次外部依赖与闪烁；手写 `app.css` 约 400 行可控 |
| 图标 | 内联 Lucide SVG path | 不引 CDN，不阻塞首屏 |
| 构建 | 无 | 浏览器直接跑 ES module |
| 状态 | 原生 DOM + 局部重渲染 | 页面简单，不上框架 |

**硬规则**：`static/` 下不得出现任何 `import` 自 npm 的语句，不得有构建步骤。

---

## 7. 依赖安全

| 项 | 要求 |
|---|---|
| 锁文件 | `package-lock.json` 必须提交 |
| 安装 | 部署用 `npm ci`，不用 `npm install` |
| 审计 | T01 结束跑 `npm audit --audit-level=high`，有 high 必须处理 |
| Pi 的 22 个传递依赖 | 已知，接受；锁死版本 |

---

## 8. 明确不引入的东西

| 不引入 | 原因 |
|---|---|
| LangChain / LlamaIndex | Pi 已是运行时，再套一层只会增加不确定 |
| Prisma / Drizzle | 18 张表手写 SQL 更快 |
| BullMQ / 队列 | 单进程，会话池在内存，不需要 |
| OpenTelemetry | 过度，pino + `ai_runs` 表够用 |
| Jest / Vitest | 只保留 `scripts/eval.ts` 一个集成验证 |
| ESLint / Prettier | `tsc --noEmit` + 团队约定够用，省时间 |
