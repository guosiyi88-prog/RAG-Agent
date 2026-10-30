/**
 * 坐席端管理面板骨架（`09#05`）：导航按角色渲染 + 面板模块懒加载 + 生命周期。
 *
 * 解决的问题：`/console` 原来只有"工单"一个真面板，知识库 / 未命中池 / 看板是三个
 * `aria-disabled` 的死位。现在五个面板（知识库 / 故障卡 / 看板 / 待审反馈 / FAQ 草稿）都是**真入口**，
 * 实现各自一个模块，切过去才下载 —— 首屏不下载任何管理代码（`09-ui-tokens.md` §9 的下载预算
 * 对坐席端不适用，但"看不到的东西不请求"没有代价）。
 *
 * 面板模块契约（实现方按这个写 `console-admin-<name>.js`，两边必须逐字一致）：
 *
 *   // src/static/lib/console-admin-<name>.js
 *   export function mount(host, ctx) { ...; return unmountFn; }   // 默认导出同名挂载函数亦可
 *   export default mount;
 *
 *   host : 一个空的 <div>（由本文件创建并插入 `#admin-panel`）
 *   ctx  : {
 *            api: (path, init?) => Promise<{ ok, data?, error?: { code, message } }>,
 *                 // 已带会话票据；401 / 403 的处理见下面"三种失败"一段
 *            role: "lead" | "admin",
 *            toast: (msg) => void,
 *            onSignOut: () => void,   // 面板侧发现身份没了：坐席端整体退出（票据由 api() 清）
 *          }
 *
 * 唯一的口径外延：面板**可以**认 `ctx.timers = { setTimeout, clearTimeout }`（骨架不传，默认取宿主）。
 * 知识库面板的重建轮询用它，为的是"卸载时把轮询停掉"这条能在 node 里断言（不用真等 1.5 秒）。
 * 不认它的面板照旧工作。
 *
 * 三种失败的口径（与 `console.js` 的 `api()` 一致，D31）：
 *   - `403 FORBIDDEN` → toast "权限不足"，**留在当前面板**（不清登录态：那不是没登录）；
 *   - `401 AUTH_*`    → 票据已由 `api()` 清掉并弹回 gate，这里只把面板收掉（别让旧面板挂在登录页底下）；
 *   - 网络错 / 5xx   → 只读降级 + toast，**不清票据**（一次网络抖动不该踢人重新登录）。
 *
 * 前端隐藏**不是**安全措施：这里按角色藏起导航项只是省掉"点了才发现 403"的挫败感。
 * 权限判定在接口层（`src/api/roles.ts` 的 `ROUTE_MIN_ROLE` + `src/auth.ts` 的 `requireRole`），
 * 藏起来不等于拦住 —— 任何人手工发一次请求都试得出来。
 *
 * 本文件是纯 ES module：不读 `window` / `localStorage`，DOM 只经由入参 `root` 与 `document`
 * （`tests/web-admin-shell.test.ts` 用假 DOM 跑生命周期，不起浏览器）。
 */

/** 角色等级（与 `src/auth.ts` 的 `agent < lead < admin` 同序，`09#03`）。 */
export const ROLES = Object.freeze(["agent", "lead", "admin"]);

/**
 * 导航键 → 面板模块路径（`data-nav` 是稳定键，与 URL、文件名解耦）。
 *
 * **顺序即导航顺序**（`visibleNavItems` 直接按这里的键序拼），所以 `kb` 排在最前 ——
 * `console.html` 里第 2 个导航位就是知识库。
 *
 * 路径必须写成 `./console-admin-<name>.js` 这种**同目录相对路径**：浏览器按本文件所在的
 * `/assets/lib/` 解析，落到 `/assets/lib/console-admin-<name>.js`；写成 `/lib/...` 或
 * `/assets/lib/...` 都会在部署换前缀那天断掉，而断掉的表现是"点了没反应"。
 */
export const PANEL_MODULES = Object.freeze({
  kb: "./console-admin-kb.js",
  faults: "./console-admin-faults.js",
  board: "./console-admin-board.js",
  reports: "./console-admin-reports.js",
  // FAQ 草稿（`09#06` / A5）：优先于"未命中池"独立成面板 —— 未命中池是**这张面板的一节**，
  // 它的唯一用途就是告诉审批的人"哪些问题还在漏"，单独一屏只会多一次点击。
  faq: "./console-admin-faq.js",
});

/** 导航文案（只用于占位与提示；真按钮上的文案在 `console.html` 里）。 */
export const NAV_LABELS = Object.freeze({
  tickets: "工单",
  kb: "知识库",
  faults: "故障卡",
  board: "看板",
  reports: "待审反馈",
  faq: "FAQ 草稿",
});

/**
 * 常驻但**不可用**的导航位（灰着、点得到、只给提示）。
 *
 * `09#05` 之后知识库成了真面板（`kb` 进 `PANEL_MODULES`），这里**清空**：一个"看得见、
 * 点得到、永远只给一句提示"的位子是给人希望再收回，比不放更糟。
 * 常量保留语义与位置：下一张要占位的卡（比如"未命中池"）往这个数组里加一个键，
 * 同时在 `console.html` 里放一个带 `aria-disabled="true"` 的按钮 —— 除这两处，别的地方都不用改。
 */
export const DISABLED_NAV = Object.freeze([]);

/**
 * 未知 / 缺失角色一律按最低档 `agent` 处理，与 `src/auth.ts` 的 `requireRole` 同口径
 * （未知角色按最低档，而不是当成最高档）。
 */
export function normalizeRole(role) {
  const value = typeof role === "string" ? role.trim().toLowerCase() : "";
  return value === "lead" || value === "admin" ? value : "agent";
}

/**
 * 角色 → 可见导航项（顺序即渲染顺序：`tickets` + `DISABLED_NAV` + `PANEL_MODULES` 的键序）。
 *
 *   agent → 工单**（就这一项）**
 *   lead  → 工单、知识库、故障卡、看板、待审反馈、FAQ 草稿
 *   admin → 同 lead（发布 / 归档 / 知识库写入权 / 草稿通过权在接口层，界面上没有多出来的入口）
 *
 * `09#05` 起**知识库也是管理面板**（最低角色 `lead`：`GET /api/admin/documents*`），
 * 于是 `agent` 连一个"灰着的知识库"都不再看到 —— 一个点开必然 403 的入口，
 * 灰着它等于先给人希望再收回。这条与 `boundary-change-R2.md` §7 的默认值同口径：
 * 客服不做管理，导航上不该出现自己点开就 403 的东西。
 *
 * `DISABLED_NAV` 仍然参与拼接（现在它是空的）：将来要放一个"看得见但不可用"的占位，
 * 往那个数组里加一个键、并在 `console.html` 里补一个 `aria-disabled` 按钮即可。
 */
export function visibleNavItems(role) {
  const base = ["tickets", ...DISABLED_NAV];
  return normalizeRole(role) === "agent" ? base : [...base, ...Object.keys(PANEL_MODULES)];
}

/** 是不是一个懒加载的管理面板（`kb` / `faults` / `board` / `reports`）。 */
export function isAdminNav(key) {
  return Object.prototype.hasOwnProperty.call(PANEL_MODULES, String(key ?? ""));
}

/** 面板名 → 模块路径；不是管理面板返回 `null`（调用方据此区分"不存在"与"加载失败"）。 */
export function panelModulePath(name) {
  return isAdminNav(name) ? PANEL_MODULES[String(name)] : null;
}

/** 导航文案；未知键原样返回，避免占位上出现空标题。 */
export function navLabelFor(name) {
  const key = String(name ?? "");
  return NAV_LABELS[key] ?? key;
}

/**
 * 把角色落到导航 DOM 上：不在可见清单里的项 `hidden = true`。
 *
 * 用 `hidden` 属性而不是 `display:none` 内联样式：`app.css` 有一条
 * `[hidden]{display:none!important}`（它会压过 `.nav-item` 的 `display:flex`），
 * 而内联样式会让人以后改 `.nav-item` 的布局时把它一起删掉。
 *
 * 也**不**移除元素：`console.html` 里的静态标记是唯一的一份，删掉就没有第二次机会把
 * 它加回来（角色从 gate 里刷新一次、`verifySession` 还没回来的那段时间会闪空导航）。
 */
export function applyRoleToNav(navRoot, role) {
  const visible = new Set(visibleNavItems(role));
  if (navRoot === null || navRoot === undefined || typeof navRoot.querySelectorAll !== "function") {
    return [...visible];
  }
  for (const node of navRoot.querySelectorAll("[data-nav]")) {
    node.hidden = !visible.has(String(node.dataset?.nav ?? ""));
  }
  return [...visible];
}

/**
 * 错误码 → 面板里能直接显示的一句话。
 *
 * 后端 `error.message` 是英文给日志看的，直接贴进面板既难读也不一致；这里只翻译面板真的会遇到的几种，
 * 其余原样带回 `fallback`（宁可显示后端原文，也不编一句看起来合理的话）。
 */
export function panelErrorHint(code, fallback) {
  const value = String(code ?? "");
  if (value === "AUTH_REQUIRED" || value === "AUTH_INVALID") return "登录状态已失效，请重新登录。";
  if (value === "FORBIDDEN") return "权限不足：这个操作需要更高的角色。";
  if (value === "NOT_FOUND") return "接口或数据不存在（404）。";
  if (value === "VALIDATION") return "参数不合法。";
  if (value === "CONFLICT") return "数据已变化，请刷新后重试。";
  if (value === "RATE_LIMITED") return "请求过于频繁，请稍后再试。";
  if (value === "NETWORK") return "连不上服务端。";
  if (/^HTTP_5\d\d$/.test(value)) return "服务端出错了，这一屏的数据可能不是最新。";
  return typeof fallback === "string" && fallback !== "" ? fallback : "请求失败。";
}

/** 面板返回值可能是 `mount` 本身、`{ default: mount }` 或 `default` 上的 `mount` —— 三种都认。 */
function pickMount(mod) {
  if (typeof mod === "function") return mod;
  for (const candidate of [mod?.default, mod?.mount, mod?.default?.mount]) {
    if (typeof candidate === "function") return candidate;
  }
  return null;
}

const UNAVAILABLE_NOTE = "面板模块还没落地。导航与骨架已就绪，刷新页面会重新尝试加载。";

/**
 * 面板骨架。
 *
 * 入参（全部可省，省掉的按"没有"处理，不抛错 —— 骨架崩了整页就白屏）：
 *   root        `#admin-panel` 根节点（面板容器的唯一出口，`hidden` / `is-open` 标记都落在它上面）
 *   api         `(path, init) => Promise<{ok,data?,error?}>`，即 `console.js` 的请求出口
 *   toast       `(msg) => void`
 *   onSignOut   `() => void`，面板侧发现身份没了时调
 *   role        初始角色（未知按 agent）
 *   importPanel 可选，`(name) => Promise<module>`，仅供测试注入；默认动态 `import()`
 *   document    可选，默认 `globalThis.document`（同样为了能在 Node 里跑生命周期）
 *
 * 返回 `{ open, close, isOpen, isPanelOpen, name, setRole }`。
 */
export function createAdminShell(options = {}) {
  const root = options.root ?? null;
  const doc = options.document ?? globalThis.document;
  const api =
    typeof options.api === "function"
      ? options.api
      : async () => ({ ok: false, error: { code: "NETWORK", message: "没有可用的请求出口" } });
  const toast = typeof options.toast === "function" ? options.toast : () => {};
  const onSignOut = typeof options.onSignOut === "function" ? options.onSignOut : () => {};
  const importPanel =
    typeof options.importPanel === "function"
      ? options.importPanel
      : (name) => import(panelModulePath(name));

  let role = normalizeRole(options.role);
  let active = null; // 当前面板名（null = 没开）
  let failed = false; // 上一次挂载失败：允许再点一次重试
  let unmount = null; // 面板 return 的卸载函数
  let generation = 0; // 竞态令牌：连点两个导航项时只有最后一次有效

  function makeNode(className, text) {
    const node = doc.createElement("div");
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clearRoot() {
    if (root !== null && typeof root.replaceChildren === "function") root.replaceChildren();
  }

  /** 卸载上一个面板。卸载函数自己抛错不该把坐席端带走（面板是别人写的）。 */
  function teardown() {
    if (typeof unmount === "function") {
      try {
        unmount();
      } catch {
        // 面板收尾失败：忽略。最坏的结果是它自己的定时器活到刷新页面。
      }
    }
    unmount = null;
    clearRoot();
  }

  /**
   * 打开 / 关闭的标记：根节点一个类（键盘处理器先查它）、`body[data-panel]` 一个属性（CSS 查它）。
   *
   * 有 `body` 这个属性的原因：`.work` 与 `#admin-panel` 占同一个网格格（`grid-area:work`），
   * 面板打开时得让 `.work` 让位；只靠 `#admin-panel[hidden]` 做不到"另一个也让开"。
   */
  function mark(open) {
    if (root !== null) {
      root.hidden = !open;
      if (open) root.classList.add("is-open");
      else root.classList.remove("is-open");
    }
    const body = doc?.body;
    if (body !== null && body !== undefined && body.dataset !== undefined) {
      body.dataset.panel = open ? "admin" : "work";
    }
  }

  function placeholder(title, hint) {
    clearRoot();
    if (root === null) return;
    const box = makeNode("admin-placeholder");
    box.appendChild(makeNode("admin-placeholder-title", title));
    if (typeof hint === "string" && hint !== "") box.appendChild(makeNode("admin-placeholder-hint", hint));
    if (typeof root.replaceChildren === "function") root.replaceChildren(box);
  }

  /**
   * 面板拿到的请求出口：**绝不抛**，一律回 `{ ok, data?, error? }`。
   * 面板里有 `await` 的地方就不会因为一次 403 而把整块 UI 冻在"加载中"。
   */
  async function panelApi(path, init) {
    let data;
    try {
      data = await api(path, init ?? {});
    } catch (err) {
      const code = String(err?.code ?? "UNKNOWN");
      const result = {
        ok: false,
        error: { code, message: panelErrorHint(code, err?.message) },
      };
      if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID") {
        // 票据已经由 `api()` 清掉并弹回 gate；把面板收掉，别让过期面板盖在登录页底下。
        close();
        onSignOut();
      } else if (code === "FORBIDDEN") {
        // 403 不等于没登录：只提示，留在当前面板（D31）。
        toast(panelErrorHint(code));
      } else if (code === "NETWORK" || /^HTTP_5\d\d$/.test(code)) {
        // 只读降级：不清票据，面板自己决定要不要显示空态。
        toast("暂时连不上服务端，这一屏的数据可能不是最新；登录状态已保留。");
      }
      return result;
    }
    return { ok: true, data: data ?? {} };
  }

  function makeContext() {
    return { api: panelApi, role, toast, onSignOut };
  }

  async function open(name) {
    const key = String(name ?? "");
    const path = panelModulePath(key);
    if (path === null || root === null) return false;
    if (active === key && !failed) return true; // 幂等：重复点同一项不重挂（重挂等于把面板里的草稿丢掉）

    const token = ++generation;
    teardown();
    active = key;
    failed = false;
    mark(true);
    placeholder(`${navLabelFor(key)}加载中…`, "");

    let mod;
    try {
      mod = await importPanel(key);
    } catch {
      if (token !== generation) return false;
      failed = true;
      placeholder(`${navLabelFor(key)}面板未就绪`, `${UNAVAILABLE_NOTE}（期望 ${path}）`);
      return false;
    }
    if (token !== generation) return false; // 下载期间已经切走了：别把过期的面板插进来

    const mount = pickMount(mod);
    if (mount === null) {
      failed = true;
      placeholder(`${navLabelFor(key)}面板未就绪`, `模块 ${path} 没有导出挂载函数 mount(host, ctx)。`);
      return false;
    }

    const host = doc.createElement("div");
    host.className = "admin-host";
    clearRoot();
    if (typeof root.appendChild === "function") root.appendChild(host);
    try {
      const returned = mount(host, makeContext());
      // 挂载函数允许是 async：等它 settle 再认卸载函数，否则定时器会在"还没拿到卸载句柄"时泄漏
      unmount = typeof returned?.then === "function" ? await returned : returned;
    } catch {
      failed = true;
      unmount = null;
      placeholder(`${navLabelFor(key)}面板加载失败`, "面板在挂载时抛错，详见浏览器控制台；可切到其它导航项再回来重试。");
      return false;
    }
    if (token !== generation) {
      // 挂载是异步的，等它回来的这段时间里坐席可能已经切走了：立刻把刚挂上的那块卸掉
      if (typeof unmount === "function") {
        try {
          unmount();
        } catch {
          // 同上：面板收尾失败不影响坐席端
        }
      }
      unmount = null;
      return false;
    }
    if (typeof unmount !== "function") unmount = null;
    return true;
  }

  function close() {
    generation += 1;
    active = null;
    failed = false;
    teardown();
    mark(false);
  }

  return {
    open,
    close,
    isOpen: () => active !== null,
    /** 键盘处理器查的那个标记：根节点上有 `is-open` 就说明面板占着屏。 */
    isPanelOpen: () => root !== null && typeof root.classList?.contains === "function" && root.classList.contains("is-open"),
    name: () => active,
    setRole: (next) => {
      role = normalizeRole(next);
    },
  };
}
