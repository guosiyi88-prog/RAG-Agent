/**
 * 引用抽屉纯逻辑的断言（`06` spec「抽屉」/ `10-ui-user.md` §4 / 工单 `06`-02）。
 *
 * 只喂输入输出：不测 DOM、不测 CSS、不碰真实的触摸事件。这里钉的是抽屉里三件人眼极难发现的事 ——
 * 编号环绕（最后一条的"下一条"要回第一条）、下滑关闭的双条件（够远 **或** 够快）、
 * 以及"减少动态效果"必须比常规更短。任何一条写错，用户在工地上单手戴手套时就会撞上。
 *
 * `src/static/lib/*.js` 是浏览器 ES module，`tsconfig.json` 没开 `allowJs`，
 * 所以这里用**非字面量** specifier 动态导入：类型退化成 `any`，但断言照样能跑。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 运行时按名字拼路径导入，绕开 tsc 对 `.js` 的解析（浏览器运行时本来就按 URL 加载）。 */
const load = (): Promise<any> => import("../src/static/lib/" + "sheet" + ".js");

const sheet = await load();
const {
  SHEET_OPEN_MS,
  SHEET_CLOSE_MS,
  SHEET_SWIPE_CLOSE_PX,
  durationMs,
  stepIndex,
  shouldCloseBySwipe,
  nextFocusIndex,
  titleOf,
  clampPercent,
} = sheet;

/* ───────────────────────────── 常量 ───────────────────────────── */

test("常量：打开 220ms、关闭 160ms（关闭更快），下滑阈值 80px", () => {
  assert.equal(SHEET_OPEN_MS, 220, "打开动画必须是 220ms（10-ui-user.md §4）");
  assert.equal(SHEET_CLOSE_MS, 160, "关闭动画必须是 160ms");
  assert.ok(SHEET_CLOSE_MS < SHEET_OPEN_MS, "关闭必须比打开短：人按下关闭之后对'它已经没了'的预期非常短");
  assert.equal(SHEET_SWIPE_CLOSE_PX, 80, "下滑关闭阈值是 80px，页面不许自己另写一个数");
});

test("导出面：只有契约里约定的 9 个符号，没有多出别的东西", () => {
  // 接口是 controller 直接照着写页面代码的，多一个导出就是多一处没人维护的分支。
  assert.deepEqual(
    Object.keys(sheet).sort(),
    [
      "SHEET_CLOSE_MS",
      "SHEET_OPEN_MS",
      "SHEET_SWIPE_CLOSE_PX",
      "clampPercent",
      "durationMs",
      "nextFocusIndex",
      "shouldCloseBySwipe",
      "stepIndex",
      "titleOf",
    ],
    "导出面变了就要同步改 06-02 的接口约定",
  );
});

/* ───────────────────────────── 动画时长 ───────────────────────────── */

test("durationMs：常规是 220 / 160", () => {
  assert.equal(durationMs(true, false), 220);
  assert.equal(durationMs(false, false), 160);
});

test("durationMs：减少动态效果时两个方向都更短（120 打开 / 90 关闭），且关闭仍比打开短", () => {
  const reducedOpen = durationMs(true, true);
  const reducedClose = durationMs(false, true);

  assert.equal(reducedOpen, 120, "reduced-motion 打开只淡入，120ms 已经读不出位移");
  assert.equal(reducedClose, 90, "reduced-motion 关闭 90ms：关得快一点手感更干脆");
  assert.ok(reducedOpen < durationMs(true, false), "reduced-motion 的打开时长必须比常规短");
  assert.ok(reducedClose < durationMs(false, false), "reduced-motion 的关闭时长必须比常规短");
  assert.ok(reducedClose < reducedOpen, "即使减少动效，关闭也要比打开短（同一条手感规则）");
});

/* ───────────────────────────── 环绕步进 ───────────────────────────── */

test("stepIndex：末条的下一条回到第一条，第一条的上一条回末条", () => {
  assert.equal(stepIndex(2, 1, 3), 0, "最后一条的下一条要绕回第一条，不能停在原地或变灰");
  assert.equal(stepIndex(0, -1, 3), 2, "第一条的上一条要绕回最后一条");
  assert.equal(stepIndex(1, 1, 3), 2, "中间位置照常走");
  assert.equal(stepIndex(1, -1, 3), 0);
});

test("stepIndex：只有一条时怎么走都留在 0", () => {
  assert.equal(stepIndex(0, 1, 1), 0);
  assert.equal(stepIndex(0, -1, 1), 0);
  assert.equal(stepIndex(0, 7, 1), 0, "多步也要能绕回来");
});

test("stepIndex：count <= 0 返回 -1（没有引用就没有位置）", () => {
  assert.equal(stepIndex(0, 1, 0), -1);
  assert.equal(stepIndex(2, 1, -3), -1, "负数条数当没有");
  assert.equal(stepIndex(0, 1, Number.NaN), -1, "NaN 不能漏成一个合法序号");
  assert.equal(stepIndex(0, 1, Number.POSITIVE_INFINITY), -1);
});

test("stepIndex：大步数与脏输入都收敛回 0..count-1", () => {
  assert.equal(stepIndex(0, 5, 3), 2, "跨多步同样按环绕算，不能溢出到 5");
  assert.equal(stepIndex(0, -5, 3), 1);
  assert.equal(stepIndex(4, 1, 3), 2, "当前值本身越界时先归一到合法区间");
  assert.equal(stepIndex(-1, 0, 3), 2, "负的当前值也按环绕解释");
  assert.equal(stepIndex(0, 0, 3), 0, "delta 为 0 是原地");
  assert.equal(stepIndex(Number.NaN, 1, 3), 1, "当前值脏了就从 0 出发，绝不返回 NaN");
  assert.equal(stepIndex(0, Number.NaN, 3), 0, "步数脏了当原地，不许污染结果");
  assert.equal(stepIndex(0, 1.5, 3), 0, "非整数步数当 0：宁可不动，也不要停在 .5 上");
});

/* ───────────────────────────── 下滑关闭 ───────────────────────────── */

test("shouldCloseBySwipe：滑过阈值关闭，阈值本身就是越线", () => {
  assert.equal(shouldCloseBySwipe(79, 0), false, "79px 还差一点，回到原位才对");
  assert.equal(shouldCloseBySwipe(80, 0, SHEET_SWIPE_CLOSE_PX), true, "正好 80px 就算越线，边界不留死区");
  assert.equal(shouldCloseBySwipe(200, 0), true);
});

test("shouldCloseBySwipe：甩得够快也算关闭（快手只滑一点点）", () => {
  assert.equal(shouldCloseBySwipe(30, 0.9), true, "30px 但速度 0.9px/ms：一甩就该关，弹回去像手机不听话");
  assert.equal(shouldCloseBySwipe(10, 1), false, "只滑 10px 就关会把'想微调位置'误判成关闭");
  assert.equal(shouldCloseBySwipe(21, 0.51), true, "刚好过两条门线");
  assert.equal(shouldCloseBySwipe(30, 0.5), false, "速度必须严格大于 0.5");
  assert.equal(shouldCloseBySwipe(20, 1), false, "位移必须严格大于 20");
});

test("shouldCloseBySwipe：向上推（dy < 0）永不关闭，脏输入按不关处理", () => {
  assert.equal(shouldCloseBySwipe(-50, 1), false, "向上是想推回去看内容，不是关闭");
  assert.equal(shouldCloseBySwipe(Number.NaN, Number.NaN), false);
  assert.equal(shouldCloseBySwipe(undefined, undefined), false, "事件对象缺字段时不能误关抽屉");
  assert.equal(shouldCloseBySwipe(120, 0, 0), true, "阈值穿了垃圾值就回落到默认 80");
});

/* ───────────────────────────── 焦点环 ───────────────────────────── */

test("nextFocusIndex：Tab 在环内环绕，最后一项之后回第一项", () => {
  assert.equal(nextFocusIndex(2, 3, false), 0, "最后一项 Tab 要回第一项，不能跑到地址栏");
  assert.equal(nextFocusIndex(0, 3, false), 1);
  assert.equal(nextFocusIndex(1, 3, false), 2);
});

test("nextFocusIndex：Shift+Tab 反向环绕", () => {
  assert.equal(nextFocusIndex(0, 3, true), 2, "第一项 Shift+Tab 要回最后一项");
  assert.equal(nextFocusIndex(2, 3, true), 1);
  assert.equal(nextFocusIndex(1, 3, true), 0);
});

test("nextFocusIndex：环里没有可聚焦元素时返回 -1（页面别把焦点丢到 body）", () => {
  assert.equal(nextFocusIndex(0, 0, false), -1);
  assert.equal(nextFocusIndex(0, 0, true), -1);
  assert.equal(nextFocusIndex(0, -1, true), -1);
});

/* ───────────────────────────── 标题 ───────────────────────────── */

test("titleOf：0 基序号 +1 后展示，形如 \"引用 1 / 3\"", () => {
  assert.equal(titleOf(0, 3), "引用 1 / 3", "第一条（citingIdx = 0）显示 1 / 3");
  assert.equal(titleOf(1, 3), "引用 2 / 3", "与 stepIndex / state.citingIdx 同一套 0 基口径");
  assert.equal(titleOf(2, 3), "引用 3 / 3");
  assert.equal(titleOf(0, 1), "引用 1 / 1", "单条引用也要给位置，界面靠它决定隐藏上一条/下一条");
});

test("titleOf：没有引用时退化成 \"引用\"，越界序号先环绕回合法区间", () => {
  assert.equal(titleOf(0, 0), "引用");
  assert.equal(titleOf(3, 0), "引用", "count<=0 一律兜底，不看序号");
  assert.equal(titleOf(0, -2), "引用");
  assert.equal(titleOf(0, Number.NaN), "引用");
  assert.equal(titleOf(5, 3), "引用 3 / 3", "越界不许显示成 6 / 3");
  assert.equal(titleOf(-1, 3), "引用 3 / 3", "负序号同样是环绕");
  assert.equal(titleOf(Number.NaN, 3), "引用 1 / 3", "脏序号从第一条开始");
});

/* ───────────────────────────── 下滑视觉进度 ───────────────────────────── */

test("clampPercent：两端正好是 0 与 1", () => {
  assert.equal(clampPercent(0, 300), 0);
  assert.equal(clampPercent(300, 300), 1, "拖到底必须正好 1，否则最后会留一条缝再跳一下");
});

test("clampPercent：中间线性，向上推夹到 0，超过高度夹到 1", () => {
  assert.equal(clampPercent(150, 300), 0.5);
  assert.equal(clampPercent(75, 300), 0.25);
  assert.equal(clampPercent(-120, 300), 0, "向上推不能反向把抽屉顶出屏幕");
  assert.equal(clampPercent(900, 300), 1, "超过高度也只到 1，transform 不许继续放大");
});

test("clampPercent：抽屉还没布局出来（height <= 0）时返回 0，且永不返回 NaN", () => {
  assert.equal(clampPercent(50, 0), 0, "除零会得到 Infinity，写进 style 就是抽屉当场消失");
  assert.equal(clampPercent(50, -300), 0);
  assert.equal(clampPercent(Number.NaN, 300), 0);
  assert.equal(clampPercent(50, Number.NaN), 0);
  assert.equal(clampPercent(undefined, undefined), 0);
  for (const value of [clampPercent(1, 3), clampPercent(0, 0), clampPercent(-5, 10)]) {
    assert.ok(Number.isFinite(value), "任何输入都不能产出 NaN / Infinity");
    assert.ok(value >= 0 && value <= 1, `结果必须夹在 0..1，实际 ${value}`);
  }
});

/* ───────────────────────────── 反回归（静态） ───────────────────────────── */

test("静态：sheet.js 不碰 DOM / 宿主全局 / 定时器，也没有任何模块依赖", async () => {
  const source = await readFile(join(repoRoot, "src/static/lib", "sheet.js"), "utf8");

  // 这些是"能在 node 里直接跑断言"的前提：一旦有人加了宿主对象或模块依赖，这条先红。
  assert.doesNotMatch(source, /\bdocument\b/, "sheet.js 不许碰 DOM");
  assert.doesNotMatch(source, /\bwindow\b/, "sheet.js 不许读宿主全局对象");
  assert.doesNotMatch(source, /\bsetTimeout\b|\bsetInterval\b/, "sheet.js 不许起定时器（时长由页面拿常量去用）");
  assert.doesNotMatch(source, /\bimport\b/, "sheet.js 必须自包含：零模块依赖");
  assert.doesNotMatch(source, /\brequire\s*\(/, "sheet.js 不许走 CommonJS 旁路");
  assert.match(source, /^export /m, "sheet.js 必须导出供页面使用的符号");
});
