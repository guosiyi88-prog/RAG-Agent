/**
 * 静态资源路由（`02-architecture.md` §5 · `06-user-web-ui` #01）。
 *
 * 只有三条路由，都不需要任何凭据（02 §8：静态资源公开）：
 *   `GET /`         → `src/static/index.html`（用户端）
 *   `GET /console`  → `src/static/console.html`（坐席端；`11-ui-console.md` §1）
 *   `GET /assets/*` → `src/static/` 下的其余文件（`/assets/user.js`、`/assets/console.css` …）
 *
 * **为什么不用 `@fastify/static`**：它把一棵目录整棵挂出去，还带目录索引、点文件、扩展名回退这一串
 * 默认行为，安全边界要靠一串开关才收得住；而本项目的 `static/` 只有 5～6 个已知扩展名的文件，
 * 一张 MIME 表就是完整契约（`02 §2.1`：`static/` 内禁止构建步骤，也就没有内容哈希文件名）。
 * 暴露面越小越容易在评审里一眼看完"到底发布了什么"，所以这里手写、不加依赖。
 */
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors.ts";

/** 静态目录 = 本文件所在目录的兄弟 `static/`（`src/api/` → `src/static/`）。 */
const STATIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "static");

/**
 * 扩展名 → Content-Type 全表。**不在表里的一律 404**。
 *
 * 不猜 `application/octet-stream`：配合 `nosniff`，猜错类型的结果是"下载"而不是"渲染"，
 * 猜对了也没有收益 —— 我们只发布这张表里的东西，表外的文件就是不该被拿到。
 * 位图（png/jpg/webp）刻意不进表：`10-ui-user.md` 的界面只用 CSS + SVG，
 * 多一类二进制就多一类可投放的载荷（EXIF、超大图、解码器漏洞），没有必要。
 */
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  // 浏览器原生 ES module 只认 JS 的 MIME（`10-ui-user.md` §1 用的是 `type="module"`），
  // 写成 `application/javascript` 或漏掉 charset 都会让德语变音与中文字面量变问号。
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/**
 * 入口页必须**每次回源**：`index.html` 里写的是 `/assets/user.js` 这种**没有内容哈希**的地址
 * （`static/` 无构建步骤），缓存住入口页等于在部署后继续把用户钉在旧资源的引用上。
 */
const CACHE_ENTRY_PAGE = "no-cache";

/**
 * 资源 5 分钟：不是 `immutable`，因为文件名没哈希，长缓存会让"改了 JS 但要等用户清缓存"变成事故；
 * 也不是 `no-cache`，因为一次会话里页面重载、抽屉开关都会重复取同样几个文件，
 * 5 分钟足够吸收这些重复请求，同时把最长陈旧时间压在一次部署窗口内。
 */
const CACHE_ASSET = "public, max-age=300";

/**
 * 守卫与"文件不存在"共用同一个 404。
 *
 * 越界一律 404（不是 403/400）是刻意的：403 等于告诉扫描者"这个路径存在但被拦了"，
 * 400 等于确认"你的编码我认出来了"，两者都在帮对方把路径探针变成文件探测器。
 * 在响应上与"没有这个文件"完全不可区分，才不给枚举留信号。
 */
function notFound(): AppError {
  return new AppError("NOT_FOUND", "Not found");
}

/**
 * 把通配段解析成 `static/` 内的绝对路径；任何越界意图都返回 `null`（调用方转 404）。
 *
 * 传进来的 `relPath` **已经**被路由（find-my-way）百分号解码过一次 ——
 * 所以 `/assets/%2e%2e%2fpackage.json` 到这里是 `../package.json`。
 * 这里**绝不再解一次**：文件系统本身不解码，二次解码只会把 `%252e%252e%252f`
 * 变成一次真正的穿越，等于自己造漏洞而不是防漏洞。
 */
function resolveAssetPath(relPath: string): string | null {
  if (relPath === "") return null;

  // NUL：Node 的文件 API 会把它当字符串终止符，`index.html\u0000.js` 在 C 层被截成 `index.html`，
  // 于是"MIME 按 .js 判、内容按 .html 读"，扩展名校验就此失效。
  if (relPath.includes("\u0000")) return null;

  // 反斜杠：Windows 上 `..\x` 与 `../x` 等价（`path.resolve` 真的会向上走一层），
  // Linux 上它只是个普通字符但永远不是我们要发布的文件名。
  // 两个平台都拒，守卫强度才不随部署平台变化。
  if (relPath.includes("\\")) return null;

  // 绝对路径：`path.resolve(base, "/etc/passwd")` 会**丢弃** base 直接指向文件系统根；
  // Windows 下 `C:\...` 同理。在 resolve 之前先拒，是因为 resolve 之后已经没有"原本想干什么"的信息了。
  if (relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) return null;

  // 显式 `..` 段：下面的 startsWith 已经能挡住，这里提前拒是为了让意图显式（评审看得见），
  // 也不给"某个平台的路径规范化差异让 startsWith 误判"留余地。
  if (relPath.split("/").includes("..")) return null;

  const fullPath = resolve(STATIC_DIR, relPath);
  // 最后一道：解析后的**字符串**必须落在 static 目录内。
  // 必须带上分隔符比：只比 `STATIC_DIR` 的话，兄弟目录 `static-secret/x` 会因为前缀相同而被放行。
  if (!fullPath.startsWith(STATIC_DIR + sep)) return null;

  // 说明：这里是词法解析，跟不住 `static/` 里指向外部的符号链接。可以接受 ——
  // 目录内容由本仓库的提交决定，能往里放软链接的人本来就能改 `src/`；
  // 为此每个请求多一次 realpath 系统调用，换不到实际的安全收益。
  return fullPath;
}

/** `*.html` 是入口页，其余是资源 —— 两者的缓存语义不同，见上面两个常量。 */
function cacheControlFor(fullPath: string): string {
  return extname(fullPath).toLowerCase() === ".html" ? CACHE_ENTRY_PAGE : CACHE_ASSET;
}

/**
 * 读文件并发出响应。路径已由调用方确认在 `static/` 内。
 *
 * 用 `readFile` 而不是 `createReadStream`：这些文件都是几十 KB，一次读进内存就结束；
 * 流式读要处理"响应头已经发出之后流才报错"的半截 200 —— 浏览器会把截断的 JS 当完好文件执行
 * （报的错会指向一个不存在的语法问题，极难查）。`readFile` 的失败发生在任何字节发出之前，
 * 能干净地变成 404/500。
 *
 * 内容也**不**做进程内缓存：`static/` 没有构建步骤，文件名没有内容哈希，而进程是长活的，
 * 缓存字节就得再造一套失效机制（按 mtime？部署时广播？），出错的代价是"改了前端但服务器还发旧字节"。
 * 这几个文件经 OS page cache 重复读取本来就接近零成本，不值得为它引入状态。
 */
async function sendStatic(
  request: FastifyRequest,
  reply: FastifyReply,
  fullPath: string,
): Promise<FastifyReply> {
  const mime = MIME_TYPES[extname(fullPath).toLowerCase()];
  // 表外扩展名：不发布，也就不用解释为什么。
  if (mime === undefined) throw notFound();

  let content: Buffer;
  try {
    content = await readFile(fullPath);
  } catch (err) {
    // 只把"没有这个文件 / 不是文件"翻译成 404。EACCES、EIO 一律向上抛成 500：
    // 权限配错或磁盘出问题是运维事故，装成 404 会让它永远查不出来。
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR" || code === "ELOOP") {
      throw notFound();
    }
    throw err;
  }

  // nosniff 每个成功响应都带：IE 时代的老把戏（把 .js 当 HTML 解释）现在换成了
  // "上传一个内容像 HTML 的 .json 让浏览器当页面渲染"，声明一次就能整类关掉。
  reply.header("x-content-type-options", "nosniff");
  reply.header("cache-control", cacheControlFor(fullPath));
  request.log.debug({ path: fullPath }, "assets: serving static file");
  return reply.type(mime).send(content);
}

export async function registerAssetRoutes(app: FastifyInstance): Promise<void> {
  // HEAD 由 Fastify 的 `exposeHeadRoutes`（默认 true）随 `app.get` 自动注册：
  // 同一处理器照跑、响应头与 GET 一致、正文被框架丢掉。所以不额外写 `app.head(...)` ——
  // 手写一份反而会 FST_ERR_DUPLICATED_ROUTE（实测见 `tests/assets.test.ts` 的 HEAD 用例）。
  app.get("/", async (request, reply) => {
    // 常量路径，不走守卫：它不来自 URL。
    return sendStatic(request, reply, resolve(STATIC_DIR, "index.html"));
  });

  // 坐席端入口（`11-ui-console.md` §1：`GET /console`）。它是**第二个常量入口页**，仍然不走守卫：
  // 路径不来自 URL，也就没有穿越面。为什么不放在 `/assets/console.html`：
  //   - 入口页与资源的缓存语义不同（`no-cache` vs `public, max-age`），靠扩展名区分已经够用，
  //     但让人从地址栏敲 `/console` 才是内部工具该有的入口；
  //   - `/assets/*` 的通配段是"发布清单"的语义，入口页混进去会让评审时"到底发布了什么"变得含混。
  // 它引用的 `console.css` / `console.js` 走的就是 `/assets/*` + 上面那张 MIME 表（.css/.js 都在表内），
  // 所以这里不需要新增 MIME 项。
  app.get("/console", async (request, reply) => {
    return sendStatic(request, reply, resolve(STATIC_DIR, "console.html"));
  });

  // 通配段必须放在 `/assets/*`：`10-ui-user.md` §1 的 `<script src="/assets/user.js">`，
  // 以及稍后拆出来的 `/assets/lib/stream.js` 都在这一棵下面。
  app.get("/assets/*", async (request, reply) => {
    const wildcard = (request.params as Record<string, string | undefined>)["*"] ?? "";
    const fullPath = resolveAssetPath(wildcard);
    if (fullPath === null) {
      // 意图只进日志（能看到谁在扫），不进响应：外面一律 404，与"文件不存在"不可区分。
      request.log.debug({ path: wildcard }, "assets: 路径被守卫拒绝");
      throw notFound();
    }
    return sendStatic(request, reply, fullPath);
  });
}
