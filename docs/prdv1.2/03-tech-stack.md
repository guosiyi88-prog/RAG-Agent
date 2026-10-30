# 03 · 技术栈与依赖（as-built）

> 本章的每个版本号都取自 `package-lock.json` 的**实际解析结果**，不是 `package.json` 里的范围声明。
> 运行方式与 `docs/prdv1.1/03-tech-stack.md` 差得比较多，差异集中在 §7。

---

## 1. 版本矩阵（实测）

| 组件 | 实际版本 | 声明方式 | 说明 |
|---|---|---|---|
| Node.js | **v22.23.1**（本机） / `engines: >=22.19.0` | `package.json` | 直接跑 `.ts`，无构建 |
| TypeScript | **5.9.3** | `^5.7.2` | 仅用于 `tsc --noEmit` |
| Fastify | **5.12.7** | `^5.2.0` | HTTP + SSE |
| `@earendil-works/pi-coding-agent` | **1.4.0** | `1.4.0`（精确锁，无 `^`） | 升级会破坏内部 API |
| pg | **8.23.1** | `^8.13.1` | 唯一 Pool |
| ioredis | **5.11.1** | `^5.4.2` | 令牌/租约/限流 |
| minio | **8.0.7** | `^8.0.2` | S3 兼容 |
| typebox | **1.3.27** | `1.3.27`（精确锁） | Pi 工具参数 schema |
| pino | **10.4.0** | ⚠️ **未在 `package.json` 声明**（见 §7 E14） | `logger.ts` 直接 `import pino` |
| undici | **8.12.3** | `overrides` 强制 | 见 §5 |
| @types/node | 22.20.5 | `^22.10.2` | — |

基础设施镜像（`data/docker-compose.yml`）：

| 服务 | 镜像 | 备注 |
|---|---|---|
| PostgreSQL | **`pgvector/pgvector:pg16`** | **必须**，`postgres:16-alpine` 没有 `vector` 扩展 |
| Redis | `redis:7-alpine` | **有密码**（`requirepass`） |
| MinIO | `minio/minio:latest` | bucket `wt-dev` |
| mc（一次性） | `minio/mc:latest` | 建桶 + 连通性探测 |
| 应用容器 | `node:22-alpine` | + `poppler-utils`、**`poppler-data`**、`wget` |

> `poppler-data` 不能省：只装 `poppler-utils` 时 CJK PDF 会报 `Missing language pack for 'Adobe-GB1'`
> 并输出空文本（`Dockerfile:5`）。这是踩过的坑，写进 Dockerfile 注释了。

---

## 2. package.json（实际内容）

```json
{
  "name": "wt-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "dev": "node --env-file-if-exists=.env src/server.ts",
    "typecheck": "tsc --noEmit",
    "i18n:check": "node scripts/check-i18n.ts",
    "demo": "node --env-file-if-exists=.env scripts/demo.ts",
    "eval": "node --env-file-if-exists=.env scripts/eval.ts",
    "verify": "bash scripts/verify.sh",
    "test": "node --test --test-concurrency=1"
  },
  "overrides": { "undici": "8.12.3" },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "1.4.0",
    "fastify": "^5.2.0",
    "ioredis": "^5.4.2",
    "minio": "^8.0.2",
    "pg": "^8.13.1",
    "typebox": "1.3.27"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/pg": "^8.11.10",
    "typescript": "^5.7.2"
  }
}
```

**三个值得注意的选择**：

| 选择 | 理由 |
|---|---|
| `--env-file-if-exists=.env` 而不是 `dotenv` | Node 22 自带；`if-exists` 让容器里（env 由 compose 注入、没有 `.env` 文件）也能启动 |
| `test` 内置 `--test-concurrency=1` | 37 个测试文件共享同一套 pg/redis/minio，并发跑会互相污染计数 |
| `typebox` 精确锁 `1.3.27` | Pi 1.4.0 的 `ToolDefinition.parameters` 就是这个版本的 `TSchema`，`^` 会漂 |

---

## 3. TypeScript 口径（实际 `tsconfig.json`）

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["src", "scripts", "tests"]
}
```

| 项 | 含义 | 为什么必须有 |
|---|---|---|
| `allowImportingTsExtensions` + `noEmit` | 源码里写 `import "./db.ts"` | 运行时直接跑 `.ts`，不产出 JS |
| `verbatimModuleSyntax` | 类型导入必须写 `import type` | 否则类型擦除会留下空导入 |
| `include` 含 `tests` | 测试也过类型检查 | 门禁 G1 才能拦住测试里的类型错误 |
| `strict: true` | 全严格 | 见 §7：**没有**开 `noUncheckedIndexedAccess`，与 v1.1 相反 |

---

## 4. 运行命令矩阵

| 目的 | 命令 |
|---|---|
| 起服务 | `node --env-file-if-exists=.env src/server.ts`（`npm run dev`） |
| 类型检查 | `npx tsc --noEmit` |
| 测试（串行） | `npm test` |
| 全量门禁 | `bash scripts/verify.sh` |
| 容器跑应用 | `docker compose -f docker-compose.app.yml up -d --build` |

`Makefile` 只是薄包装：数据层命令一律转发 `data/scripts/db.sh`，不重复实现（`Makefile:1`）。

---

## 5. `undici` 覆盖（安全修复）

```json
"overrides": { "undici": "8.12.3" }
```

原因：Pi SDK 的传递依赖链上有旧版 `undici`，`npm audit --audit-level=high` 会红。
门禁 G4 要求"无 high/critical"，且**不允许**用 `npm audit fix` 自动改依赖（那会把门禁变成改依赖）。
用 `overrides` 钉死版本，`npm ci` 可复现。

---

## 6. 前端技术（无构建链）

| 项 | 实际 | 硬规则 |
|---|---|---|
| 框架 | 无（原生 DOM） | `static/` 下**不得** import 任何 npm 包 |
| 模块 | 原生 ES module，`/assets/*` 直接下发 | 只允许本地 `.js` 相互 import |
| 样式 | 手写 CSS + CSS 变量 | 无 CDN（Tailwind CDN 会带来一次外部依赖 + 首屏闪烁） |
| 图标 | 内联 SVG `<symbol>` + `<use>` | 不引 CDN |
| 构建 | 无 | `make build` 只构建**应用容器**，不构建前端 |

---

## 7. 与 v1.1 的差异（本章）

| # | v1.1 | 实际 | 编号 |
|---|---|---|---|
| 1 | `name: wotai-support-agent` | `wt-agent` | E13 |
| 2 | `dev/start/ingest/demo/eval/perf:fault` 六个脚本，带 `--experimental-strip-types` | 七个脚本（`dev/typecheck/i18n:check/demo/eval/verify/test`），Node 22.19+ 已不需要该 flag | E13 |
| 3 | 依赖含 `@earendil-works/pi-ai`、`pino`、`pino-pretty`、`typebox ^1.3.27` | 无 `pi-ai`（Pi 已内置）、无 `pino`/`pino-pretty` 声明、`typebox` 精确锁 | E14 |
| 4 | `tsconfig` 开 `noUncheckedIndexedAccess`、`target ES2022`、`include` 只含 src+scripts | 未开该选项、`ES2023`、`include` 含 `tests` | E15 |
| 5 | 有 `scripts/perf-fault.ts` | 没有；故障码耗时只打日志（`chat.ts:358` 的 `ms`） | E16 |
| 6 | `undici` 未提及 | `overrides` 钉 8.12.3（修 high 漏洞的唯一手段） | E17 |

> `pino` 未声明这件事有实际风险：它现在是 `fastify` 的传递依赖被 hoist 到顶层，`npm ci --omit=dev`
> 之后仍然存在，所以能跑；但哪天 fastify 换掉日志依赖，`logger.ts:1` 会在运行期直接 `ERR_MODULE_NOT_FOUND`。
> 处置意见见 `16` §2 E14（建议显式声明，属一行改动）。
