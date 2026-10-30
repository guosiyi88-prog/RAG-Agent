/**
 * 静态资源路由的黑盒验收（`06-user-web-ui` #01 · `02-architecture.md` §5）。
 *
 * **不**起 `buildApp()`：静态资源不碰 PG / Redis / MinIO，只注册本卡的 `registerAssetRoutes`。
 * 少一层依赖，红了就知道是这一条路由的锅，而且不需要数据层在跑。
 * 两个处理器（errorHandler / notFoundHandler）与 `src/server.ts` 同形且共用同一个 `toErrorBody`，
 * 否则"404 信封与其余 404 一致"这句断言就只是在测测试自己搭的处理器。
 *
 * 资源文件由另外两个流写（`src/static/index.html`、`user.js`、`app.css`…）。
 * 文件还没落地时相关用例 **skip 并点名缺哪个文件**，不假装通过；文件在时这些用例是硬的。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_DIR = join(repoRoot, "src", "static");

const INDEX_HTML = join(STATIC_DIR, "index.html");
const USER_JS = join(STATIC_DIR, "user.js");
const APP_CSS = join(STATIC_DIR, "app.css");
/** 子目录里的原生 ES module：`10-ui-user.md` 把事件流分帧、角标替换、语言回落拆成了这几个文件。 */
const STREAM_JS = join(STATIC_DIR, "lib", "stream.js");

/** 缺文件的 skip 文案要直接告诉人"谁在写"与"什么时候该重跑"。 */
function missingHint(file: string): string {
  return `缺少 ${file}（该文件由 06-user-web-ui 的界面流写入）；文件落地后重跑本文件`;
}

let app: FastifyInstance | undefined;
let port = 0;

before(async () => {
  const { default: Fastify } = await import("fastify");
  const { registerAssetRoutes } = await import("../src/api/assets.ts");
  const { toErrorBody } = await import("../src/errors.ts");

  const instance = Fastify({ logger: false });
  // 与 src/server.ts 的两个处理器同形：404 信封必须是**线上那一个**，不是这里另写的一份。
  instance.setErrorHandler((err, request, reply) => {
    const { status, body } = toErrorBody(err, String(request.id));
    return reply.code(status).send(body);
  });
  instance.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ ok: false, error: { code: "NOT_FOUND", message: "Not found", trace_id: String(request.id) } }),
  );
  await registerAssetRoutes(instance);
  await instance.ready();
  // 真的 listen：有一类穿越（`/assets/../src/config.ts`）会被 HTTP 客户端的 URL 规范化吃掉，
  // 只有"原样发出 path"才能验到守卫本身。inject 仍然照用，两者读同一个服务器。
  await instance.listen({ port: 0, host: "127.0.0.1" });
  const address = instance.server.address();
  assert.ok(address !== null && typeof address === "object", "listen 之后必须拿到端口");
  port = address.port;
  app = instance;
});

after(async () => {
  if (app !== undefined) await app.close();
});

function instance(): FastifyInstance {
  assert.ok(app !== undefined, "app 未初始化");
  return app;
}

/** 原样发出请求行里的 path（`http.request` 不做 `..` 规范化），用来验守卫本身。 */
function rawGet(path: string): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", rejectPromise);
    req.end();
  });
}

/**
 * 仓库统一 404 信封（`02 §6` / `errors.ts` 的 `toErrorBody`）。
 * 逐键断言而不是 `includes("NOT_FOUND")`：多一个字段或少一个 trace_id 都该红。
 */
function assertNotFoundEnvelope(payload: unknown, label: string): void {
  assert.equal(typeof payload, "object", `${label} 的响应体应是 JSON 对象，实际 ${JSON.stringify(payload)}`);
  const body = payload as { ok?: unknown; error?: Record<string, unknown> };
  assert.deepEqual(Object.keys(body).sort(), ["error", "ok"], `${label} 的信封顶层键应正好是 ok/error`);
  assert.equal(body.ok, false, `${label} 的 ok 必须是 false`);
  const error = body.error;
  assert.ok(error !== undefined && error !== null, `${label} 必须有 error 字段`);
  assert.deepEqual(
    Object.keys(error).sort(),
    ["code", "message", "trace_id"],
    `${label} 的 error 键应正好是 code/message/trace_id`,
  );
  assert.equal(error.code, "NOT_FOUND", `${label} 的 code 必须是 NOT_FOUND`);
  assert.equal(error.message, "Not found", `${label} 的 message 必须是 "Not found"`);
  assert.equal(typeof error.trace_id, "string", `${label} 的 trace_id 必须是字符串`);
  assert.ok((error.trace_id as string).length > 0, `${label} 的 trace_id 不能为空`);
}

/** 4xx/404 一律不得夹带目标文件的内容；这里挑每个目标文件独有的记号来验。 */
const CONTENT_MARKERS: Readonly<Record<string, readonly string[]>> = {
  "/assets/../src/config.ts": ["process.env", "export const"],
  "/assets/%2e%2e%2fpackage.json": ["dependencies", "devDependencies"],
  "/assets/..%5cpackage.json": ["dependencies", "devDependencies"],
  "/assets//etc/passwd": ["root:", "/bin/"],
};

/* ───────────────────────────── 入口页 ───────────────────────────── */

test("GET / 返回 index.html：text/html + no-cache + nosniff", async (t) => {
  if (!existsSync(INDEX_HTML)) {
    t.skip(missingHint("src/static/index.html"));
    return;
  }
  const response = await instance().inject({ method: "GET", url: "/" });
  assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body.slice(0, 200)}`);

  const contentType = String(response.headers["content-type"] ?? "");
  assert.ok(contentType.startsWith("text/html"), `content-type 应为 text/html，实际 "${contentType}"`);
  assert.ok(contentType.includes("charset=utf-8"), `content-type 应带 charset=utf-8（五语界面必有非 ASCII），实际 "${contentType}"`);

  // 入口页必须回源：它引用的是没有内容哈希的 `/assets/*`，缓存住就会在部署后钉住旧资源。
  assert.equal(response.headers["cache-control"], "no-cache", "入口页必须是 cache-control: no-cache");
  assert.equal(response.headers["x-content-type-options"], "nosniff");

  const html = response.body;
  assert.ok(html.length > 0, "index.html 不应为空");
  assert.match(html, /<html/i, "应当返回真正的 HTML");
  // 10-ui-user.md §1 的模板：入口页靠 `<script type="module" src="/assets/user.js">` 起逻辑。
  assert.ok(html.includes("/assets/"), "index.html 必须引用 /assets/ 下的资源（否则页面拿不到 user.js）");
});

/**
 * 首屏兜底语言必须与界面语言的回落终点一致（`lib/lang.js:FALLBACK_LANG = "en"`）。
 *
 * 为什么值得一条断言：`index.html` 的静态文字是"JS 还没跑"那一小段时间里唯一可见的内容。
 * 它曾经整份是德语，而 `user.js` 的默认语言又写成 `|| "de"`，两个德语互相印证，于是
 * "中文/荷兰语/西班牙语浏览器的人都先看到一闪德语"这件事在两个文件里都看不出来。
 * 现在两端都以 `en` 为终点，这条断言钉住"静态层不许再回到德语"。
 */
test("GET / 的首屏兜底语言与界面回落终点一致（en，不是 de）", async (t) => {
  if (!existsSync(INDEX_HTML)) {
    t.skip(missingHint("src/static/index.html"));
    return;
  }
  const { body: html } = await instance().inject({ method: "GET", url: "/" });
  assert.match(html, /<html lang="en"/, "根元素必须声明 lang=\"en\"（applyLang 之后才按用户选择改写）");
  // 首屏可见的三处：输入框占位符、底部导航、语言按钮上的语种代码。
  assert.ok(html.includes('placeholder="Type your question…"'), "输入框的静态占位符应为英文");
  assert.ok(html.includes(">Fault code<"), "底部导航的静态兜底应为英文");
  assert.match(html, /<span class="lang-code">EN<\/span>/, "语言按钮的静态代码应为 EN");
  // 反向断言：再出现德语兜底就说明有人只改了一半。
  for (const german of ["Zurück", "Frage eingeben", "Fußnavigation", "Netzwerk getrennt"]) {
    assert.ok(!html.includes(german), `首屏静态层不应再出现德语 "${german}"（改用英文兜底）`);
  }
});

/**
 * 语言菜单（D7）：常驻菜单、五项母语名字、默认收起。
 *
 * 为什么断言在"发出去的 HTML"上而不是 `lib/lang.js` 上：菜单是静态写死的（JS 还没跑也要点得动），
 * 而语言表的单一真源在 `lib/lang.js`。两边必须一致 —— 一个语言在表里有、菜单里没有，
 * 用户就永远选不到它；反过来就是选了一个后端不认的值（`lang` 400）。
 */
test("GET / 的语言菜单：五项母语名字、默认收起、与 SUPPORTED_LANGS 一致", async (t) => {
  if (!existsSync(INDEX_HTML)) {
    t.skip(missingHint("src/static/index.html"));
    return;
  }
  const { body: html } = await instance().inject({ method: "GET", url: "/" });

  assert.match(html, /id="lang-menu"[^>]*hidden/, "菜单默认收起（首访不许弹层）");
  assert.match(html, /aria-haspopup="menu"/, "语言按钮要声明弹出类型");
  assert.match(html, /aria-expanded="false"/, "折叠状态的 aria-expanded 必须是 false");

  const codes = [...html.matchAll(/<button class="lang-item"[^>]*data-lang="([a-z]{2})"/g)].map((m) => m[1]);
  assert.deepEqual(codes, ["zh", "en", "de", "nl", "es"], "菜单项与 SUPPORTED_LANGS 同序同集");
  for (const name of ["中文", "English", "Deutsch", "Nederlands", "Español"]) {
    assert.ok(html.includes(`<span>${name}</span>`), `菜单里必须有母语名字 "${name}"（不能写成界面语言的译名）`);
  }
});

/**
 * 头像（客户 / AI 各一个）：图标必须在 sprite 里、样式必须在 CSS 里、渲染时必须在 user.js 里。
 *
 * 三处都要断，是因为它们的失败方式不同且都不会报错：
 *   - sprite 缺 `#i-bot` → `<use>` 指向不存在的符号，**屏幕上什么都不显示**（没有报错）；
 *   - CSS 缺 `.avatar` → 图标会顶到气泡里，看起来像排版坏了；
 *   - `user.js` 里换成 `#i-chat` 之类的字面量 → 又是一个静默空头像。
 */
test("消息头像：sprite 有 #i-bot/#i-user，样式与渲染各就各位", async (t) => {
  if (!existsSync(INDEX_HTML)) {
    t.skip(missingHint("src/static/index.html"));
    return;
  }
  const { body: html } = await instance().inject({ method: "GET", url: "/" });
  assert.match(html, /<symbol id="i-bot"/, "AI 头像图标必须在 sprite 里（否则 <use> 静默不显示）");
  assert.match(html, /<symbol id="i-user"/, "客户头像图标必须在 sprite 里");

  const { body: css } = await instance().inject({ method: "GET", url: "/assets/app.css" });
  assert.match(css, /\.avatar\{/, "头像样式必须在 app.css 里");
  assert.match(css, /\.row-u\{/, "客户消息行要右对齐");
  assert.match(css, /\.row-a\{/, "AI 消息行要左对齐");

  // **入口页的内联样式才是浏览器真正用的那份**（app.css 只是同一份样式的可读副本）。
  // 踩过一次：只改了 app.css，页面上头像仍是一行一个、堆在气泡下面。
  // 所以这两处必须成对断言 —— 单看 app.css 绿了不代表页面对。
  for (const rule of [".row{display:flex", ".row .msg{max-width:calc(80% - 32px", ".avatar{flex:0 0 auto"]) {
    assert.ok(html.includes(rule), `index.html 的内联样式里必须有 "${rule}"（否则和 app.css 漂了）`);
  }

  const { body: js } = await instance().inject({ method: "GET", url: "/assets/user.js" });
  assert.match(js, /#i-bot/, "user.js 必须给 AI 气泡挂 #i-bot");
  assert.match(js, /#i-user/, "user.js 必须给客户气泡挂 #i-user");
  assert.match(js, /aria-hidden/, "头像只是装饰：必须 aria-hidden，读屏不再多念一遍");
});

/* ───────────────────────────── 资源文件 ───────────────────────────── */

test("GET /assets/user.js 返回 text/javascript + 公共缓存 + nosniff", async (t) => {
  if (!existsSync(USER_JS)) {
    t.skip(missingHint("src/static/user.js"));
    return;
  }
  const response = await instance().inject({ method: "GET", url: "/assets/user.js" });
  assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body.slice(0, 200)}`);

  // `type="module"` 的 script 只认 JS 的 MIME，写错整页逻辑不执行（10-ui-user.md §1）。
  assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  const cacheControl = String(response.headers["cache-control"] ?? "");
  assert.ok(cacheControl.startsWith("public"), `资源的 cache-control 应以 public 开头，实际 "${cacheControl}"`);
  assert.ok(!cacheControl.includes("no-cache"), `资源不该和入口页一样 no-cache，实际 "${cacheControl}"`);
  assert.ok(!cacheControl.includes("immutable"), `文件名没有内容哈希，不能声明 immutable，实际 "${cacheControl}"`);

  // 返回的必须是文件本身，而不是被某个 404 页面 200 掉（那就是"页面白屏但状态码好看"）。
  assert.ok(response.body.length > 0, "user.js 不应为空");
  assert.ok(!response.body.includes("NOT_FOUND"), "user.js 的响应体不该是错误信封");
});

test("GET /assets/app.css 返回 text/css（设计令牌与组件样式）", async (t) => {
  if (!existsSync(APP_CSS)) {
    t.skip(missingHint("src/static/app.css"));
    return;
  }
  const response = await instance().inject({ method: "GET", url: "/assets/app.css" });
  assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body.slice(0, 200)}`);
  assert.equal(response.headers["content-type"], "text/css; charset=utf-8");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.ok(response.body.length > 0, "app.css 不应为空");
});

test("GET /assets/lib/stream.js（子目录）也发布：路径按目录解析，不只有顶层文件", async (t) => {
  if (!existsSync(STREAM_JS)) {
    t.skip(missingHint("src/static/lib/stream.js"));
    return;
  }
  const response = await instance().inject({ method: "GET", url: "/assets/lib/stream.js" });
  assert.equal(response.statusCode, 200, `期望 200，实际 ${response.statusCode}：${response.body.slice(0, 200)}`);
  assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.match(String(response.headers["cache-control"] ?? ""), /^public, max-age=\d+$/, "子目录资源同一套缓存策略");
  assert.ok(response.body.length > 0, "stream.js 不应为空");
});

/* ───────────────────────────── 404 与信封 ───────────────────────────── */

test("未知资源 → 404，且信封与其余 404 完全一致", async () => {
  for (const url of ["/assets/__nope__.js", "/assets/", "/assets", "/assets/nope/nope/nope.js", "/assets/x.txt"]) {
    const response = await instance().inject({ method: "GET", url });
    assert.equal(response.statusCode, 404, `${url} 期望 404，实际 ${response.statusCode}`);
    assertNotFoundEnvelope(response.json(), url);
  }
});

test("表外扩展名（.txt）与目录路径都不发布：一律 404，不猜 octet-stream", async () => {
  // `.txt` 不在 MIME 表里，即使文件真的存在也不发（表就是发布清单）。
  // 这里断言的是"不可发布"这一侧：响应不能是 200 + 任意 content-type。
  for (const url of ["/assets/readme.txt", "/assets/i18n.yaml", "/assets/lib"]) {
    const response = await instance().inject({ method: "GET", url });
    assert.equal(response.statusCode, 404, `${url} 期望 404，实际 ${response.statusCode}：${response.body.slice(0, 120)}`);
    assertNotFoundEnvelope(response.json(), url);
  }
});

/* ───────────────────────────── 路径穿越 ───────────────────────────── */

test("路径穿越（原样发出 path）：../、%2e%2e、尾随 .. 全部 404 且不含文件内容", async () => {
  // 这一组必须走 rawGet：`inject` 与浏览器一样会先做 URL 规范化，
  // `/assets/../src/config.ts` 会变成 `/src/config.ts`、`/assets/..` 会变成 `/`，
  // 那样测到的是客户端的规范化，而不是守卫。`curl --path-as-is` 与扫描器发的正是原样 path。
  const cases = [
    "/assets/../src/config.ts",
    "/assets/%2e%2e/package.json",
    "/assets/../package.json",
    // 尾随 `..`：规范化后就是 `/`（该 200 的是入口页），原样发出时守卫必须拒。
    "/assets/..",
    "/assets/%2e%2e",
    "/assets/sub/../..",
  ];
  for (const path of cases) {
    const response = await rawGet(path);
    assert.equal(response.status, 404, `${path} 期望 404，实际 ${response.status}：${response.body.slice(0, 120)}`);
    assertNotFoundEnvelope(JSON.parse(response.body) as unknown, path);
    for (const marker of CONTENT_MARKERS[path] ?? []) {
      assert.ok(!response.body.includes(marker), `${path} 的响应体不得出现目标文件内容（命中 "${marker}"）`);
    }
  }
});

test("路径穿越：百分号编码 / 反斜杠 / 绝对路径 → 全部 404 且不含目标文件内容", async () => {
  // 这一组走 inject：这些 path 不会被客户端规范化（只有 `..` 段才会），路由（find-my-way）
  // 会把它们**百分号解码一次**再交给守卫，所以这里测的正是守卫的判定。
  for (const url of [
    "/assets/%2e%2e%2fpackage.json",
    "/assets/..%5cpackage.json",
    "/assets//etc/passwd",
    "/assets/%2e%2e/%2e%2e/package.json",
    "/assets/sub/%2e%2e/%2e%2e/%2e%2e/package.json",
    "/assets/%00user.js",
    "/assets/a%00b.js",
    // 空通配段（`/assets/.` 规范化后就是它）：没有文件名，不可能是文件。
    "/assets/.",
  ]) {
    const response = await instance().inject({ method: "GET", url });
    assert.equal(response.statusCode, 404, `${url} 期望 404，实际 ${response.statusCode}：${response.body.slice(0, 120)}`);
    assertNotFoundEnvelope(response.json(), url);
    for (const marker of CONTENT_MARKERS[url] ?? []) {
      assert.ok(!response.body.includes(marker), `${url} 的响应体不得出现目标文件内容（命中 "${marker}"）`);
    }
    // 兜底：任何越界响应都不能带着"外面文件"的特征串。
    assert.ok(!response.body.includes("postgresql://"), `${url} 的响应体不得出现连接串`);
  }
});

/* ───────────────────────────── HEAD 与缓存头 ───────────────────────────── */

test("HEAD / 可用：状态与响应头同 GET，正文为空", async (t) => {
  if (!existsSync(INDEX_HTML)) {
    t.skip(missingHint("src/static/index.html"));
    return;
  }
  const head = await instance().inject({ method: "HEAD", url: "/" });
  assert.equal(head.statusCode, 200, `HEAD / 期望 200（Fastify 的 exposeHeadRoutes 随 app.get 自动注册），实际 ${head.statusCode}`);
  assert.equal(head.body, "", "HEAD 不得有正文");
  assert.ok(String(head.headers["content-type"] ?? "").startsWith("text/html"), "HEAD 也要带 content-type");
  assert.equal(head.headers["cache-control"], "no-cache", "HEAD 的缓存头必须与 GET 一致");
  assert.equal(head.headers["x-content-type-options"], "nosniff");

  // content-length 必须体现真实长度（缓存/CDN 靠它判断），而不是 0。
  const length = Number(head.headers["content-length"] ?? "0");
  assert.ok(length > 0, `HEAD 应带真实 content-length，实际 "${head.headers["content-length"]}"`);

  const headAsset = await instance().inject({ method: "HEAD", url: "/assets/user.js" });
  assert.ok(
    headAsset.statusCode === 200 || headAsset.statusCode === 404,
    `HEAD /assets/user.js 只允许 200（文件已在）或 404（还没写），实际 ${headAsset.statusCode}`,
  );
  if (headAsset.statusCode === 200) {
    assert.equal(headAsset.body, "", "HEAD 资源也不得有正文");
    assert.equal(headAsset.headers["x-content-type-options"], "nosniff");
  }
});

test("缓存头在入口页与资源之间不同（no-cache vs public, max-age）", async (t) => {
  const assetFile = existsSync(USER_JS) ? "/assets/user.js" : existsSync(APP_CSS) ? "/assets/app.css" : undefined;
  if (!existsSync(INDEX_HTML) || assetFile === undefined) {
    t.skip(`缺 src/static/index.html 或任一资源文件（user.js / app.css），两侧都要有才比得出来`);
    return;
  }
  const entry = await instance().inject({ method: "GET", url: "/" });
  const asset = await instance().inject({ method: "GET", url: assetFile });
  assert.equal(entry.statusCode, 200);
  assert.equal(asset.statusCode, 200, `${assetFile} 期望 200，实际 ${asset.statusCode}`);

  assert.equal(entry.headers["cache-control"], "no-cache", "入口页 no-cache");
  assert.match(String(asset.headers["cache-control"] ?? ""), /^public, max-age=\d+$/, "资源应是 public + max-age");
  assert.notEqual(entry.headers["cache-control"], asset.headers["cache-control"], "两者的缓存语义必须不同");
});
