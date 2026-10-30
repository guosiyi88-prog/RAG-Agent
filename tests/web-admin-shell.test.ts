/**
 * 管理面板骨架的断言（`09#05`：导航按角色渲染 + 面板懒加载 + 生命周期）。
 *
 * 两类，与仓库前端测试的既有风格一致（`tests/web-lib.test.ts` / `tests/assets.test.ts`）：
 *   1. **纯逻辑**：角色 → 可见导航项、模块路径拼写、错误码 → 文案、统计体 → 卡片。
 *      这些都是"看起来能用就没人测、坏掉也不报错"的地方：一个 `data-nav` 拼错就是永久死位，
 *      角色映射写反就是客服点开就 403。
 *   2. **静态内容**：`console.html` 的导航标记、`console.js` 的接线、`console.css` 的面板落位。
 *      文件被另一个流改坏时（少一个 `hidden`、少一条 `body[data-panel]`）这里会红。
 *
 * 生命周期用**假 DOM**（`createElement` / `replaceChildren` / `classList` 那几件）跑，不引 jsdom：
 * 仓库没有 DOM 测试依赖，也不为这一条加。
 * `src/static/lib/*.js` 是浏览器 ES module，`tsconfig.json` 没开 `allowJs`，
 * 所以按 `web-lib` 同法用**非字面量** specifier 动态导入（类型退化成 any，断言照样跑）。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_DIR = join(repoRoot, "src", "static");

const load = (name: string): Promise<any> => import(`../src/static/lib/${name}.js`);

const shellLib = await load("console-admin-shell");
const boardLib = await load("console-admin-board");

const {
  PANEL_MODULES,
  ROLES,
  DISABLED_NAV,
  applyRoleToNav,
  createAdminShell,
  isAdminNav,
  navLabelFor,
  normalizeRole,
  panelErrorHint,
  panelModulePath,
  visibleNavItems,
} = shellLib;
const { BOARD_WINDOWS, DEFAULT_WINDOW, cardsFor, countText, rateText, slaLeftText } = boardLib;

/* ───────────────────────── 假 DOM（只为跑生命周期） ───────────────────────── */

function fakeNode(tag = "div"): any {
  const node: any = {
    tagName: String(tag).toUpperCase(),
    className: "",
    textContent: "",
    hidden: false,
    dataset: {} as Record<string, string>,
    children: [] as any[],
    classList: {
      _set: new Set<string>(),
      add(value: string) {
        this._set.add(value);
      },
      remove(value: string) {
        this._set.delete(value);
      },
      toggle(value: string, on: boolean) {
        if (on) this._set.add(value);
        else this._set.delete(value);
      },
      contains(value: string) {
        return this._set.has(value);
      },
    },
    appendChild(child: any) {
      node.children.push(child);
      return child;
    },
    replaceChildren(...kids: any[]) {
      node.children = kids;
    },
    listeners: [] as Array<{ type: string; fn: (event: any) => void }>,
    addEventListener(type: string, fn: (event: any) => void) {
      node.listeners.push({ type, fn });
    },
    setAttribute() {},
  };
  return node;
}

function fakeDocument(): any {
  const doc: any = { body: { dataset: {} as Record<string, string> } };
  doc.createElement = (tag: string) => {
    const node = fakeNode(tag);
    node.ownerDocument = doc;
    return node;
  };
  return doc;
}

/** 展开一棵假节点里的所有文本（占位文案、卡片的标签与数值都靠它断言）。 */
function textsOf(node: any): string[] {
  const out: string[] = [];
  if (typeof node?.textContent === "string" && node.textContent !== "") out.push(node.textContent);
  for (const child of node?.children ?? []) out.push(...textsOf(child));
  return out;
}

const errorWith = (code: string) => async () => {
  throw Object.assign(new Error("backend rejected"), { code });
};

/* ───────────────────────── 角色 → 可见导航项 ───────────────────────── */

test("角色映射：agent 只见工单，lead/admin 多出知识库等五个管理面板", () => {
  assert.deepEqual(
    visibleNavItems("agent"),
    ["tickets"],
    "客服不做管理：知识库 09#05 起也是管理面板（lead 起），连灰的都不给它看",
  );
  // FAQ 草稿（09#06）排在待审反馈之后：两块是"补故障码"与"补答案"的一对，挨着放。
  assert.deepEqual(visibleNavItems("lead"), ["tickets", "kb", "faults", "board", "reports", "faq"]);
  assert.deepEqual(
    visibleNavItems("admin"),
    ["tickets", "kb", "faults", "board", "reports", "faq"],
    "admin 与 lead 的入口相同：发布权、知识库写权与草稿通过权都在接口层",
  );
  for (const role of ROLES) {
    assert.ok(!visibleNavItems(role).includes("nohit"), `${role} 的导航里不该再有 nohit（本批删除的死位）`);
    assert.equal(visibleNavItems(role)[0], "tickets", "工单永远第一：它是 /console 的默认面板");
  }
  assert.deepEqual(DISABLED_NAV, [], "知识库成了真入口，已经没有常驻死位");
});

test("角色映射：未知 / 缺失角色一律按 agent（最低档），大小写与空白不影响判定", () => {
  for (const bad of [null, undefined, "", "  ", "guest", "AGENT", 42, {}]) {
    assert.deepEqual(visibleNavItems(bad as string), ["tickets"], `${String(bad)} 必须退化成 agent`);
    assert.equal(normalizeRole(bad as string), "agent");
  }
  assert.equal(normalizeRole("LEAD"), "lead");
  assert.equal(normalizeRole(" admin "), "admin", "登录响应里的 role 带空白也不该掉回 agent");
});

test("角色映射：只改导航项的 hidden，不删元素（切角色 / 断网后还要能翻回来）", () => {
  const items = ["tickets", "kb", "faults", "board", "reports", "faq"].map((key) => {
    const node = fakeNode("button");
    node.dataset.nav = key;
    return node;
  });
  const navRoot = { querySelectorAll: () => items };
  const byKey: Record<string, any> = Object.fromEntries(items.map((node) => [node.dataset.nav, node]));

  applyRoleToNav(navRoot, "agent");
  assert.equal(byKey.tickets.hidden, false);
  assert.equal(byKey.kb.hidden, true, "知识库是管理面板（lead 起）：agent 连灰的都不该看到");
  assert.equal(byKey.faults.hidden, true);
  assert.equal(byKey.board.hidden, true);
  assert.equal(byKey.reports.hidden, true, "agent 看不到待审反馈（点开就是 403）");
  assert.equal(byKey.faq.hidden, true, "agent 看不到 FAQ 草稿（未命中池与审批都是 lead 起）");

  applyRoleToNav(navRoot, "lead");
  assert.equal(byKey.kb.hidden, false);
  assert.equal(byKey.faults.hidden, false);
  assert.equal(byKey.board.hidden, false);
  assert.equal(byKey.reports.hidden, false);
  assert.equal(byKey.faq.hidden, false);

  assert.deepEqual(
    applyRoleToNav(undefined, "lead"),
    ["tickets", "kb", "faults", "board", "reports", "faq"],
    "页面少元素也不许抛",
  );
});

/* ───────────────────────── 模块路径与懒加载 ───────────────────────── */

test("面板模块路径：拼写固定在同目录相对路径上", () => {
  assert.equal(panelModulePath("faults"), "./console-admin-faults.js", "另一个流按这个名字写文件，拼错就是永久 404");
  assert.equal(panelModulePath("board"), "./console-admin-board.js");
  assert.equal(panelModulePath("reports"), "./console-admin-reports.js", "待审反馈面板");
  assert.equal(panelModulePath("kb"), "./console-admin-kb.js", "知识库面板（09#05 起是真入口）");
  assert.equal(panelModulePath("faq"), "./console-admin-faq.js", "FAQ 草稿面板（09#06）");
  assert.equal(panelModulePath("tickets"), null, "工单不是懒加载面板");
  assert.equal(panelModulePath(undefined), null);
  // 键序 = 导航顺序（`visibleNavItems` 直接按它拼），所以 kb 在最前
  assert.deepEqual(Object.keys(PANEL_MODULES), ["kb", "faults", "board", "reports", "faq"]);
  assert.deepEqual(DISABLED_NAV, [], "没有常驻死位了：知识库已落地");

  assert.equal(isAdminNav("kb"), true);
  assert.equal(isAdminNav("board"), true);
  assert.equal(isAdminNav("reports"), true);
  assert.equal(isAdminNav("faq"), true);
  assert.equal(isAdminNav("nohit"), false);
  assert.equal(navLabelFor("kb"), "知识库");
  assert.equal(navLabelFor("faults"), "故障卡", "占位与导航要用同一份文案");
  assert.equal(navLabelFor("board"), "看板");
  assert.equal(navLabelFor("reports"), "待审反馈");
  assert.equal(navLabelFor("faq"), "FAQ 草稿");

  // 本卡自己写的模块必须真的在盘上（另一个流的 faults 允许还不存在 —— 那种情况面板显示"未就绪"）
  assert.ok(existsSync(join(STATIC_DIR, "lib", "console-admin-kb.js")), "知识库模块必须已落地");
  assert.ok(existsSync(join(STATIC_DIR, "lib", "console-admin-board.js")), "看板模块必须已落地");
  assert.ok(existsSync(join(STATIC_DIR, "lib", "console-admin-shell.js")), "骨架模块必须已落地");
  assert.ok(existsSync(join(STATIC_DIR, "lib", "console-admin-reports.js")), "待审反馈模块必须已落地");
  assert.ok(existsSync(join(STATIC_DIR, "lib", "console-admin-faq.js")), "FAQ 草稿模块必须已落地");
});

test("懒加载：面板模块只经动态 import 进来，首屏不下载任何管理代码", async () => {
  const shellSource = await readFile(join(STATIC_DIR, "lib", "console-admin-shell.js"), "utf8");
  const boardSource = await readFile(join(STATIC_DIR, "lib", "console-admin-board.js"), "utf8");
  const consoleSource = await readFile(join(STATIC_DIR, "console.js"), "utf8");

  for (const [label, source] of [
    ["console-admin-shell.js", shellSource],
    ["console.js", consoleSource],
  ] as const) {
    assert.ok(
      !/^\s*import\s[^;]*console-admin-(faults|board)\.js/m.test(source),
      `${label} 不得静态 import 面板模块（必须 await import()，否则 agent 也下载一份用不到的管理代码）`,
    );
  }
  assert.match(shellSource, /import\(panelModulePath\(name\)\)/, "骨架的默认加载器必须是动态 import");
  assert.ok(!/from\s*"\.\/console-admin-board\.js"/.test(boardSource), "看板不该静态 import 自己");

  // 契约兼容：`export default mount` 与 `export function mount` 两种写法都要能挂上
  assert.match(shellSource, /mod\?\.default, mod\?\.mount/, "既要认 default，也要认具名 mount");
});

/* ───────────────────────── 错误码 → 文案 ───────────────────────── */

test("错误码文案：403 说的是权限不足，401 说的是重新登录（两者不能混）", () => {
  assert.ok(panelErrorHint("FORBIDDEN").includes("权限不足"), "403 不是没登录：不许提示重新登录");
  assert.ok(panelErrorHint("AUTH_REQUIRED").includes("重新登录"));
  assert.ok(panelErrorHint("AUTH_INVALID").includes("重新登录"));
  assert.ok(panelErrorHint("NETWORK").includes("连不上"));
  assert.ok(panelErrorHint("HTTP_503").includes("服务端出错"));
  assert.equal(panelErrorHint("WEIRD_CODE", "后端原话"), "后端原话", "不认识的码不编文案：原样带回后端那句");
  assert.equal(panelErrorHint("WEIRD_CODE", ""), "请求失败。");
});

/* ───────────────────────── 骨架生命周期 ───────────────────────── */

function mountSpy(log: string[], name: string) {
  return (host: any, ctx: any) => {
    log.push(`mount:${name}:${ctx.role}`);
    assert.equal(host.className, "admin-host", "host 必须是骨架创建的容器（面板只管往里画）");
    return () => log.push(`unmount:${name}`);
  };
}

test("生命周期：懒加载 → 挂载 → 切走先卸载 → 重复点同一项不重挂", async () => {
  const log: string[] = [];
  const root = fakeNode("section");
  root.hidden = true;
  const doc = fakeDocument();
  const shell = createAdminShell({
    root,
    document: doc,
    role: "lead",
    api: async () => ({ ok: true, data: {} }),
    toast: () => {},
    onSignOut: () => {},
    importPanel: async (name: string) => {
      log.push(`import:${name}`);
      return { default: mountSpy(log, name) };
    },
  });

  assert.equal(shell.isOpen(), false);
  assert.equal(root.hidden, true, "面板容器默认收起（静态层就 hidden）");

  assert.equal(await shell.open("board"), true);
  assert.deepEqual(log, ["import:board", "mount:board:lead"], "第一次点开才 import，且 ctx.role 来自会话角色");
  assert.equal(root.hidden, false);
  assert.equal(shell.isPanelOpen(), true, "根节点的 is-open 就是键盘处理器要查的标记");
  assert.equal(doc.body.dataset.panel, "admin", "body[data-panel] 供 CSS 让 .work 让位");

  log.length = 0;
  assert.equal(await shell.open("board"), true);
  assert.deepEqual(log, [], "重复点同一项不重挂：重挂会把面板里的草稿与滚动位置丢掉");

  assert.equal(await shell.open("faults"), true);
  assert.deepEqual(log, ["unmount:board", "import:faults", "mount:faults:lead"], "切走必须先卸载上一个");

  log.length = 0;
  shell.close();
  assert.deepEqual(log, ["unmount:faults"], "关面板必须调面板返回的卸载函数（否则它的定时器活到刷新）");
  assert.equal(root.hidden, true);
  assert.equal(shell.isPanelOpen(), false);
  assert.equal(doc.body.dataset.panel, "work");
  assert.equal(shell.isOpen(), false);
});

test("生命周期：模块还没落地 → 画「面板未就绪」占位，不抛错也不白屏", async () => {
  const root = fakeNode("section");
  const shell = createAdminShell({
    root,
    document: fakeDocument(),
    role: "admin",
    importPanel: async () => {
      // 浏览器里模块 404 的表现就是动态 import reject（TypeError: Failed to fetch …）
      throw new TypeError("Failed to fetch dynamically imported module");
    },
  });

  assert.equal(await shell.open("faults"), false);
  assert.equal(shell.isPanelOpen(), true, "占位也算面板开着：导航高亮与键盘让位要一致");
  const text = textsOf(root).join(" ");
  assert.ok(text.includes("面板未就绪"), `占位必须写清是「未就绪」，实际：${text}`);
  assert.ok(text.includes("console-admin-faults.js"), "占位里要点名缺哪个模块（否则没人知道该写什么）");
  assert.ok(!text.includes("undefined"));
});

test("生命周期：模块存在但没有导出挂载函数 → 同一套降级，文案点名契约", async () => {
  const root = fakeNode("section");
  const shell = createAdminShell({
    root,
    document: fakeDocument(),
    role: "admin",
    importPanel: async () => ({ something: 1 }),
  });
  assert.equal(await shell.open("faults"), false);
  const text = textsOf(root).join(" ");
  assert.ok(text.includes("面板未就绪"));
  assert.ok(text.includes("mount(host, ctx)"), `占位要说明契约，实际：${text}`);
});

test("生命周期：面板挂载抛错 → 报「加载失败」，骨架不跟着崩，且允许重试", async () => {
  let attempts = 0;
  const root = fakeNode("section");
  const shell = createAdminShell({
    root,
    document: fakeDocument(),
    role: "lead",
    importPanel: async () => ({
      mount: () => {
        attempts += 1;
        throw new Error("boom");
      },
    }),
  });
  assert.equal(await shell.open("board"), false);
  assert.equal(shell.isPanelOpen(), true);
  assert.ok(textsOf(root).join(" ").includes("加载失败"));
  assert.equal(await shell.open("board"), false, "失败不是永久死位：再点一次要重试");
  assert.equal(attempts, 2);
});

test("生命周期：async 挂载返回的卸载函数也会被等到并用上", async () => {
  const log: string[] = [];
  const shell = createAdminShell({
    root: fakeNode("section"),
    document: fakeDocument(),
    role: "lead",
    importPanel: async () => ({
      async mount() {
        log.push("mount:board");
        return () => log.push("unmount:board");
      },
    }),
  });
  assert.equal(await shell.open("board"), true);
  log.length = 0;
  shell.close();
  assert.deepEqual(log, ["unmount:board"]);
});

/* ───────────────────────── ctx.api 的三种失败 ───────────────────────── */

function shellWithApi(api: any) {
  const mounted: any[] = [];
  const toasts: string[] = [];
  let signOuts = 0;
  const shell = createAdminShell({
    root: fakeNode("section"),
    document: fakeDocument(),
    role: "admin",
    api,
    toast: (message: string) => toasts.push(message),
    onSignOut: () => {
      signOuts += 1;
    },
    importPanel: async () => ({
      default: (host: any, ctx: any) => {
        mounted.push(ctx);
        return () => {};
      },
    }),
  });
  return { shell, mounted, toasts, signOuts: () => signOuts };
}

test("ctx.api：403 只提示「权限不足」并留在当前面板（不清登录态）", async () => {
  const { shell, mounted, toasts, signOuts } = shellWithApi(errorWith("FORBIDDEN"));
  await shell.open("faults");
  const result = await mounted[0].api("/api/admin/fault-codes");
  assert.deepEqual(result, {
    ok: false,
    error: { code: "FORBIDDEN", message: "权限不足：这个操作需要更高的角色。" },
  });
  assert.equal(toasts.length, 1, "403 提示一次（提示留在面板上，不要弹回队列）");
  assert.ok(toasts[0].includes("权限不足"));
  assert.equal(shell.isPanelOpen(), true, "403 必须留在当前面板");
  assert.equal(signOuts(), 0, "403 不等于没登录：不许清登录态（D31）");
});

test("ctx.api：401 收起面板并通知坐席端退出；网络错 / 5xx 只降级不踢人", async () => {
  const unauthorized = shellWithApi(errorWith("AUTH_REQUIRED"));
  await unauthorized.shell.open("faults");
  const result = await unauthorized.mounted[0].api("/api/admin/fault-codes");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTH_REQUIRED");
  assert.equal(unauthorized.signOuts(), 1, "401 要通知坐席端整体退出（票据由 api() 清）");
  assert.equal(unauthorized.shell.isPanelOpen(), false, "401 后不许把旧面板挂在登录页底下");

  for (const code of ["NETWORK", "HTTP_503"]) {
    const offline = shellWithApi(errorWith(code));
    await offline.shell.open("board");
    const degraded = await offline.mounted[0].api("/api/console/stats");
    assert.equal(degraded.ok, false);
    assert.equal(offline.shell.isPanelOpen(), true, `${code} 不清票据也不收面板`);
    assert.equal(offline.signOuts(), 0, `${code} 不许把人踢回登录页（D31）`);
    assert.equal(offline.toasts.length, 1);
    assert.ok(offline.toasts[0].includes("登录状态已保留"), `${code} 的提示要说清登录态还在：${offline.toasts[0]}`);
  }
});

test("ctx.api：成功只回 { ok: true, data }，且不弹提示", async () => {
  const { shell, mounted, toasts } = shellWithApi(async (path: string) => ({ tickets_total: 3, path }));
  await shell.open("board");
  const result = await mounted[0].api("/api/console/stats");
  assert.deepEqual(result, { ok: true, data: { tickets_total: 3, path: "/api/console/stats" } });
  assert.deepEqual(toasts, []);
});

/* ───────────────────────── 看板面板 ───────────────────────── */

test("看板：时间窗与接口默认值同集同序", () => {
  assert.deepEqual(
    BOARD_WINDOWS.map((pair: string[]) => pair[0]),
    ["today", "week", "all"],
  );
  assert.equal(DEFAULT_WINDOW, "all", "与 api/console.ts 的 stats 默认值一致");
});

test("看板：数值格式化 —— 认不出给破折号，比率按 0–1 换算", () => {
  assert.equal(countText(12), "12");
  assert.equal(countText("7"), "7");
  assert.equal(countText(null), "—");
  assert.equal(countText(undefined), "—");
  assert.equal(countText("abc"), "—");

  assert.equal(rateText(0), "0.0%");
  assert.equal(rateText(0.125), "12.5%", "后端给 0–1 小数（refusal_rate 三位小数）");
  assert.equal(rateText(1), "100.0%");
  assert.equal(rateText(87.5), "87.5", "已经像百分数的值不再乘 100（差 100 倍的看板比不显示更糟）");
  assert.equal(rateText(undefined), "—");

  assert.equal(slaLeftText(-130), "超时 2m", "复用工单队列的 SLA 格式化，两处口径不能分叉");
  assert.equal(slaLeftText(8040), "2h 14m");
  assert.equal(slaLeftText(null), "—");
});

test("看板：工单侧五张卡片，口径写清时间窗与演示数据", () => {
  const doc = fakeDocument();
  const stats = {
    tickets_total: 40,
    tickets_pending: 8,
    tickets_by_status: { open: 3, claimed: 4, escalated: 1, closed: 32 },
    runs_total: 0,
    runs_refused: 0,
    refusal_rate: 0,
    sla_seconds_left_avg: -130,
    window: "week",
    exclude_demo: true,
  };
  const cards = cardsFor(doc, stats);
  assert.equal(cards.length, 5, "reports 不存在时只有工单侧五张卡");
  const text = cards.map((card: any) => textsOf(card).join("|"));
  assert.deepEqual(text, [
    "工单总数|40|口径：近 7 天 · 已排除演示工单",
    "待处理|8|待处理 + 已认领 + 已升级",
    "已关闭|32|未关闭：8",
    "拒答率|—|0 / 0 轮拒答",
    "平均剩余 SLA|超时 2m|仅未关闭且有截止时间的单",
  ]);
  for (const line of text) {
    assert.ok(!line.includes("undefined"), `卡片里不许出现 undefined：${line}`);
    assert.ok(!line.includes("NaN"), `卡片里不许出现 NaN：${line}`);
  }
});

test("看板：reports 字段还不存在时安静少三张卡，存在时才画（不显示 undefined）", () => {
  const doc = fakeDocument();
  const base = {
    tickets_total: 1,
    tickets_pending: 1,
    tickets_by_status: { closed: 0 },
    window: "all",
    exclude_demo: true,
  };

  for (const missing of [undefined, null, 0, "n/a"]) {
    const cards = cardsFor(doc, { ...base, reports: missing });
    assert.equal(cards.length, 5, `reports=${String(missing)} 时不该多画卡片`);
    assert.ok(!textsOf({ children: cards }).join(" ").includes("合并率"));
  }

  const cards = cardsFor(doc, { ...base, reports: { new: 3, last24h: 9, merge_rate: 0.4 } });
  assert.equal(cards.length, 8);
  assert.deepEqual(
    cards.slice(5).map((card: any) => textsOf(card).join("|")),
    ["待审计反馈|3|未处理的用户反馈", "24 小时新增|9|同口径时间窗之外，固定 24 小时", "合并率|40.0%|已并入知识库的反馈占比"],
  );

  // 残缺的 reports（只给了合并率）只画它，其余不补 0、不写 undefined
  const partial = cardsFor(doc, { ...base, reports: { merge_rate: 0.5 } });
  assert.equal(partial.length, 6, "三个字段各自独立：只给 merge_rate 时也只多一张卡");
  const partialText = textsOf({ children: partial.slice(5) }).join(" ");
  assert.ok(!partialText.includes("undefined"));
  assert.ok(partialText.includes("50.0%"));
});

test("看板：空 / 坏统计体不抛错（接口换形状时面板不许白屏）", () => {
  const doc = fakeDocument();
  for (const bad of [null, undefined, {}, { tickets_by_status: null }, { reports: "x" }]) {
    const cards = cardsFor(doc, bad);
    assert.ok(Array.isArray(cards) && cards.length >= 1);
    const text = textsOf({ children: cards }).join(" ");
    assert.ok(!text.includes("undefined"));
    assert.ok(!text.includes("NaN"));
  }
});

test("看板 mount：真模块跑一遍（加载 → 换时间窗 → 卸载后不再动 DOM）", async () => {
  const calls: string[] = [];
  const host = fakeNode("div");
  host.ownerDocument = fakeDocument();
  const stats = {
    tickets_total: 5,
    tickets_pending: 2,
    tickets_by_status: { open: 2, claimed: 0, escalated: 0, closed: 3 },
    runs_total: 0,
    runs_refused: 0,
    refusal_rate: 0,
    sla_seconds_left_avg: 3600,
    window: "all",
    exclude_demo: true,
  };
  const unmount = boardLib.mount(host, {
    api: async (path: string) => {
      calls.push(path);
      return { ok: true, data: stats };
    },
    role: "lead",
    toast: () => {},
    onSignOut: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, ["/api/console/stats?exclude_demo=true&window=all"], "首屏按默认口径打一次");
  const text = textsOf(host).join("|");
  assert.ok(text.includes("工单总数"), "卡片要真的画出来");
  assert.ok(text.includes("加载中…") === false, "成功后状态行要清空");
  assert.ok(!text.includes("undefined"));
  assert.ok(text.includes("当前账号角色：lead"), "面板上要写清当前角色（403 时人得知道为什么）");

  // 点「今天」：重打一次，且窗口参数真的换了
  const click = host.listeners.find((listener: any) => listener.type === "click");
  assert.ok(click !== undefined, "时间窗切换要用事件委托（面板会重画，不能各绑一份）");
  const tab = fakeNode("button");
  tab.dataset.window = "today";
  click.fn({ target: { closest: (selector: string) => (selector === "[data-window]" ? tab : null) } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [
    "/api/console/stats?exclude_demo=true&window=all",
    "/api/console/stats?exclude_demo=true&window=today",
  ]);

  unmount();
  assert.deepEqual(host.children, [], "卸载要把自己画的东西清掉");

  // 卸载之后回来的响应不许再动 DOM（alive 守卫）：面板已经不在了，写进去只会是幽灵节点
  let release: (value: unknown) => void = () => {};
  const late = fakeNode("div");
  late.ownerDocument = fakeDocument();
  const unmountLate = boardLib.mount(late, {
    api: () =>
      new Promise<unknown>((resolve) => {
        release = resolve;
      }),
    role: "admin",
    toast: () => {},
    onSignOut: () => {},
  });
  unmountLate();
  release({ ok: true, data: stats });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(late.children, [], "卸载后迟到的响应不得往面板里写东西");
});

/* ───────────────────────── 静态内容 ───────────────────────── */

test("console.html：五个管理面板都是真入口（知识库不再是死位），未命中池并进 FAQ 面板", async () => {
  const html = await readFile(join(STATIC_DIR, "console.html"), "utf8");

  for (const key of ["kb", "faults", "board", "reports", "faq"]) {
    assert.match(
      html,
      new RegExp(`data-nav="${key}"[^>]*\\bhidden\\b`),
      `${key} 必须先隐藏：角色要等 /api/console/me 回来才定`,
    );
  }
  assert.ok(!html.includes('data-nav="nohit"'), "未命中池不是独立导航项：它是 FAQ 面板的一节（09#06）");
  assert.ok(!html.includes('aria-disabled="true"'), "知识库成了真面板：导航上不该再有 aria-disabled 的死位");
  assert.ok(!html.includes("本期未开放"), "导航上不该再有「本期未开放」的提示（它是死位时代的产物）");
  assert.match(html, /id="admin-panel"[^>]*hidden/, "面板容器必须是页面上固定的根节点，且默认收起");
  assert.match(html, /<use href="#i-book">/, "知识库的图标要在 sprite 里（否则 <use> 静默不显示）");
  assert.match(html, /<use href="#i-alert">/, "故障卡的图标要在 sprite 里（否则 <use> 静默不显示）");
  assert.match(html, /<use href="#i-chart">/, "看板的图标要在 sprite 里");
  assert.match(html, /<use href="#i-inbox">/, "待审反馈的图标要在 sprite 里");
  assert.match(html, /<use href="#i-message-circle">/, "FAQ 草稿的图标要在 sprite 里");
  assert.match(html, /<symbol id="i-book"/);
  assert.match(html, /<symbol id="i-alert"/);
  assert.match(html, /<symbol id="i-chart"/);
  assert.match(html, /<symbol id="i-inbox"/);
  assert.match(html, /<symbol id="i-message-circle"/);
  // 转 FAQ 草稿的弹窗（09#06）：问题/语言/答案三个字段必须都在，语言不能靠猜。
  assert.match(html, /id="faq-modal"[^>]*hidden/);
  assert.match(html, /id="faq-question"/);
  assert.match(html, /id="faq-lang"/);
  assert.match(html, /id="faq-answer"/);
});

test("console.js：接的是骨架、角色取自已有的会话校验、快捷键让位靠 is-open 标记", async () => {
  const source = await readFile(join(STATIC_DIR, "console.js"), "utf8");

  assert.ok(source.includes('from "./lib/console-admin-shell.js"'), "console.js 必须复用骨架，不许再写一份角色表");
  assert.match(source, /querySelector\("#admin-panel"\)/, "面板根节点要被 bind 起来");
  assert.match(source, /applyRole\(data\?\.staff\?\.role\)/, "登录响应里的 role 就地用掉（不再多打一次 /api/console/me）");
  assert.match(source, /applyRole\(me\?\.role\)/, "刷新页面走 verifySession 里同一个 role");
  assert.match(source, /adminPanelOpen\(\)\) return/, "键盘处理器必须**先**查面板标记再吃键");
  assert.match(source, /classList\.contains\("is-open"\)/, "标记类是 is-open（骨架打开面板时加）");
  assert.match(source, /state\.token === null \|\| adminPanelOpen\(\)/, "面板开着时不轮询队列");
  assert.match(source, /isAdminNav\(key\)/, "导航点击要区分真入口与死位");
});

test("console.css：面板与 #work 同一格、打开时 .work 让位，且不引裸色值", async () => {
  const css = await readFile(join(STATIC_DIR, "console.css"), "utf8");

  assert.match(css, /\.admin-panel\{grid-area:work/, "面板要落在工作区那一格（不是盖在队列上）");
  assert.match(css, /body\[data-panel="admin"\] \.work\{display:none\}/, "面板打开时队列让位");
  assert.match(css, /\.admin-cards\{display:grid/, "数字卡片用网格（提示词 §6：不引图表库）");
  assert.match(css, /\.admin-placeholder\{/, "「面板未就绪」占位要有样式，否则和真面板分不开");

  // 面板区块里不许出现裸色值（09 §1：底色只能由令牌混出）
  const block = css.slice(css.indexOf(".admin-panel{"));
  const naked = block.match(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/g) ?? [];
  assert.deepEqual(naked, [], `面板样式里出现了裸色值：${naked.join(" ")}`);
});
