/**
 * 看板图表的断言（`09#04` 看板 A 方案：内联 SVG、零依赖、悬停看数值）。
 *
 * 三类：
 *   1. **纯几何**：`niceMax` / `scaleY` / `linePath` / `dayTicks` / `statusSegments` / `langBars`。
 *      这些是"画错了也不报错、只是看起来怪"的地方：Y 轴上界为 0 → 每个点 `NaN` → 整条线消失；
 *      堆叠段舍入差 1px → 条尾露底；断点没断 → 没有数据的那天被画成 0%（最糟的一种谎）。
 *   2. **构建**：四张图各喂真实接口形状（30 天补零 + 只有一天有数据），数图元、数 `<title>`、
 *      扫 `NaN`。
 *   3. **静态规矩**：零依赖、令牌取色（不许裸色值）、顶层不碰 `document`、单文件 ≤500 行。
 *
 * 假 DOM 与 `tests/web-admin-shell.test.ts` 同法（不引 jsdom），只是多实现了 `createElementNS`
 * 与 `setAttribute`（记录到 `attrs`），否则 SVG 一条都建不出来。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_DIR = join(repoRoot, "src", "static");

const load = (name: string): Promise<any> => import(`../src/static/lib/${name}.js`);
const charts = await load("chart-svg");
const board = await load("console-admin-board");

const {
  CHART_INK,
  LANG_TOTAL,
  SVG_NS,
  TICKET_STATUSES,
  buildLangBars,
  buildRefusalLine,
  buildStatusBar,
  buildTicketsBars,
  dayTicks,
  langBars,
  linePath,
  niceMax,
  percentText,
  scaleY,
  statusSegments,
} = charts;
const { BOARD_WINDOWS, CHART_EMPTY_TEXT, SERIES_FOR_WINDOW, canDrawCharts, chartBlocksFor, seriesForWindow } = board;

/* ───────────────────────── 假 DOM（带 SVG） ───────────────────────── */

function fakeNode(tag = "div"): any {
  const node: any = {
    tagName: String(tag).toUpperCase(),
    className: "",
    textContent: "",
    attrs: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    children: [] as any[],
    classList: {
      _set: new Set<string>(),
      toggle(value: string, on?: boolean) {
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
    setAttribute(key: string, value: string) {
      node.attrs[key] = String(value);
    },
  };
  return node;
}

/** `svg: true` 的文档能画图（真浏览器的表现）；`svg: false` 模拟 `web-admin-shell` 那种假 DOM。 */
function fakeDocument(svg = true): any {
  const doc: any = { body: { dataset: {} as Record<string, string> } };
  doc.createElement = (tag: string) => {
    const node = fakeNode(tag);
    node.ownerDocument = doc;
    return node;
  };
  if (svg) {
    doc.createElementNS = (namespace: string, tag: string) => {
      const node = fakeNode(tag);
      node.ownerDocument = doc;
      node.namespaceURI = namespace;
      return node;
    };
  }
  return doc;
}

function walk(node: any, out: any[] = []): any[] {
  if (node === null || node === undefined) return out;
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

const tagOf = (node: any) => String(node?.tagName ?? "").toLowerCase();
const countTag = (node: any, tag: string) => walk(node).filter((child) => tagOf(child) === tag).length;

/**
 * 类名按**整词**匹配，不用 `includes`。
 *
 * `admin-charts`（装四张图卡的容器）在字符串上是 `admin-chart` 的前缀，`includes` 会把容器
 * 自己也算成一张图卡 —— 数出来 5 张，看不出是"多算了一个容器"还是"多画了一张图"。
 */
const hasClass = (node: any, token: string) =>
  String(node?.className ?? "")
    .split(/\s+/)
    .includes(token);

function textsOf(node: any): string[] {
  const out: string[] = [];
  for (const child of walk(node)) {
    if (typeof child.textContent === "string" && child.textContent !== "") out.push(child.textContent);
  }
  return out;
}

/** 一棵节点树上所有属性值 + 文本，用来扫 `NaN` / `Infinity` / `undefined`。 */
function dump(node: any): string {
  const attrs = walk(node).map((child) => Object.values(child.attrs ?? {}).join(" "));
  return [...attrs, ...textsOf(node)].join(" ");
}

/* ───────────────────────── 纯几何 ───────────────────────── */

test("niceMax：1/2/5 × 10^k 取整，全 0 / 全空给 1（上界是除数，0 会让每个点变 NaN）", () => {
  assert.equal(niceMax([0, 0, 0, 0, 0, 0, 164]), 200, "164 张单 → 上界 200");
  assert.equal(niceMax([7]), 10);
  assert.equal(niceMax([2]), 2);
  assert.equal(niceMax([100]), 100, "正好落在整刻度上不该被抬到 200");
  assert.equal(niceMax([250]), 500);
  assert.equal(niceMax([0.538]), 1, "拒答率 0–1：上界必须是 1，不是 0.6");
  assert.equal(niceMax([0.1, 0.2]), 0.2, "小数上界不许露浮点尾巴");
  assert.equal(niceMax([0, 0, 0]), 1);
  assert.equal(niceMax([]), 1);
  assert.equal(niceMax([null, undefined, Number.NaN]), 1);
  assert.equal(niceMax([-5, -1]), 1, "负数忽略（计数与比率都不为负）");
  assert.equal(niceMax(undefined), 1, "入参不是数组也不许抛");
});

test("scaleY：0 在底、上界在顶，越界夹紧，非数字落底线（不返回 NaN）", () => {
  assert.equal(scaleY(0, 200, 100), 100);
  assert.equal(scaleY(200, 200, 100), 0);
  assert.equal(scaleY(100, 200, 100), 50);
  assert.equal(scaleY(500, 200, 100), 0, "超过上界夹到顶");
  assert.equal(scaleY(-5, 200, 100), 100, "负数夹到底");
  assert.equal(scaleY(Number.NaN, 200, 100), 100, "NaN 落底线：返回 NaN 会让整条 <path> 失效");
  assert.equal(scaleY(5, 0, 100), 100, "上界为 0 时不除零");
  assert.equal(scaleY(5, 200, 0), 0);
});

test("linePath：两点一条线，断点处重新 M，单点画成圆点（M+L 同点），全断点给空串", () => {
  assert.equal(linePath([{ value: 0 }, { value: 100 }], 100, 100, 100), "M0 100L100 0");
  assert.equal(
    linePath([{ value: 0 }, { value: null }, { value: 100 }], 100, 100, 100),
    "M0 100L0 100M100 0L100 0",
    "中间那天没有数据 → 不许把两边连起来（那是编出来的趋势）；两边各是一个孤点，各画一个圆",
  );
  assert.equal(
    linePath([{ value: 1 }], 100, 100, 1),
    "M50 0L50 0",
    "单点段发一条零长度线段：配 stroke-linecap:round 就是一个看得见的点",
  );
  assert.equal(linePath([], 100, 100, 1), "");
  assert.equal(linePath([{ value: null }, { value: null }], 100, 100, 1), "");
  assert.equal(linePath(undefined, 100, 100, 1), "");
  // 不给 max 时自己取 niceMax（164 → 200）：y = 100 - 164/200*100 = 18
  assert.equal(linePath([{ value: 0 }, { value: 164 }], 200, 100), "M0 100L200 18");
  // 断点也占一格：日期轴才和真实时间同间距
  assert.equal(
    linePath([{ value: 0 }, { value: null }, { value: null }, { value: 100 }], 300, 100, 100),
    "M0 100L0 100M300 0L300 0",
  );
});

test("dayTicks：只给首 / 中 / 末三个刻度（7 与 30 天都不许把日期全挤在轴上）", () => {
  const week = ["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"];
  assert.deepEqual(dayTicks(week), [
    { index: 0, day: "2026-10-22", label: "10-22" },
    { index: 3, day: "2026-10-25", label: "10-25" },
    { index: 6, day: "2026-10-28", label: "10-28" },
  ]);

  const month = Array.from({ length: 30 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`);
  assert.deepEqual(dayTicks(month).map((tick: any) => tick.index), [0, 14, 29]);

  assert.deepEqual(dayTicks([week[0]]).map((tick: any) => tick.index), [0], "只有一天也得有一个刻度");
  assert.deepEqual(dayTicks([week[0], week[1]]).map((tick: any) => tick.index), [0, 1], "两天：首末，别重中间");
  assert.deepEqual(dayTicks([]), []);
  assert.deepEqual(dayTicks(undefined as any), []);
  assert.equal(dayTicks(["weird"])[0].label, "weird", "认不出的日期原样显示，不编一个");
});

test("statusSegments：各段舍入后宽度之和严格等于条宽，0 值段不许分到像素", () => {
  const real = statusSegments({ open: 163, claimed: 1, escalated: 0, closed: 0 }, 320);
  assert.equal(real.reduce((sum: number, seg: any) => sum + seg.width, 0), 320);
  assert.deepEqual(real.map((seg: any) => seg.value), [163, 1, 0, 0]);
  assert.equal(real[2].width, 0);
  assert.equal(real[3].width, 0);
  assert.equal(real[0].x, 0);
  assert.equal(real[1].x, real[0].width, "x 必须是前缀和，否则条上会出现 1px 的缝");

  const cases: Array<[Record<string, number>, number]> = [
    [{ open: 3, claimed: 4, escalated: 1, closed: 32 }, 320],
    [{ open: 1, claimed: 2, escalated: 0, closed: 0 }, 100],
    [{ open: 1, claimed: 1, escalated: 1, closed: 1 }, 99],
    [{ open: 5, claimed: 7, escalated: 11, closed: 13 }, 333],
    [{ open: 1, claimed: 0, escalated: 0, closed: 0 }, 7],
  ];
  for (const [status, width] of cases) {
    const segments = statusSegments(status, width);
    const sum = segments.reduce((acc: number, seg: any) => acc + seg.width, 0);
    assert.equal(sum, width, `${JSON.stringify(status)} @${width} 的段宽之和必须是 ${width}，实际 ${sum}`);
    let cursor = 0;
    for (const segment of segments) {
      assert.equal(segment.x, cursor, "x 连续无缝");
      cursor += segment.width;
    }
    for (const segment of segments) {
      if (segment.value === 0) assert.equal(segment.width, 0, "0 值的段不许凭空占 1px");
    }
  }

  const four = statusSegments({ open: 3, claimed: 4, escalated: 1, closed: 32 }, 320);
  assert.deepEqual(four.map((seg: any) => seg.key), TICKET_STATUSES.map((status: any) => status.key));
  assert.deepEqual(four.map((seg: any) => seg.label), ["待处理", "已认领", "已升级", "已关闭"]);
  for (const segment of four) {
    assert.match(segment.color, /^var\(--c-[a-z-]+\)$/, `段色必须是令牌：${segment.color}`);
  }

  assert.deepEqual(statusSegments({ open: 0, claimed: 0, escalated: 0, closed: 0 }, 320), [], "总数为 0 → 不画空条");
  assert.deepEqual(statusSegments(null, 320), []);
  assert.deepEqual(statusSegments({ open: 3 }, 0), []);
  assert.deepEqual(statusSegments({ open: 3 }, Number.NaN), []);
});

test("langBars：补齐 0–5 六个桶（后端只回有数据的桶），5/5 成功色、缺语警示色", () => {
  assert.equal(LANG_TOTAL, 5);
  const rows = langBars([{ langs: 5, count: 6 }]);
  assert.equal(rows.length, 6, "六个桶一个都不能少：缺的那行本身就是信息");
  assert.deepEqual(rows.map((row: any) => row.label), ["5/5", "4/5", "3/5", "2/5", "1/5", "0/5"]);
  assert.deepEqual(rows.map((row: any) => row.count), [6, 0, 0, 0, 0, 0]);
  assert.equal(rows[0].status, "complete");
  assert.equal(rows[0].color, CHART_INK.complete);
  for (const row of rows.slice(1)) {
    assert.equal(row.status, "missing");
    assert.equal(row.color, CHART_INK.missing);
  }
  assert.match(rows[0].color, /^var\(--c-st-[a-z]+\)$/);

  const merged = langBars([
    { langs: 4, count: 1 },
    { langs: 4, count: 2 },
  ]);
  assert.equal(merged[1].langs, 4);
  assert.equal(merged[1].count, 3, "同一个桶出现两次要相加");

  for (const bad of [null, undefined, [], "n/a", [null, 1, { langs: "x", count: 3 }, { langs: 9, count: 3 }, { langs: 2, count: -1 }]]) {
    const rows2 = langBars(bad as any);
    assert.equal(rows2.length, 6, `${JSON.stringify(bad)} 也要给六个桶`);
    assert.equal(rows2.reduce((sum: number, row: any) => sum + row.count, 0), 0);
  }
});

test("percentText：比率按 0–1 走百分比，坏值给空串（不写 NaN%）", () => {
  assert.equal(percentText(0.538), "53.8%");
  assert.equal(percentText(0), "0.0%");
  assert.equal(percentText(1), "100.0%");
  assert.equal(percentText(163, 164), "99.4%");
  assert.equal(percentText(Number.NaN), "");
  assert.equal(percentText(1, 0), "");
});

/* ───────────────────────── 四张图的构建 ───────────────────────── */

/** 真实接口形状（2026-10-28 实测：7 天补零，只有最后一天有数据）。 */
const REAL_STATS = {
  tickets_total: 164,
  tickets_pending: 164,
  tickets_by_status: { open: 163, claimed: 1, escalated: 0, closed: 0 },
  runs_total: 13,
  runs_refused: 7,
  refusal_rate: 0.538,
  sla_seconds_left_avg: 10355,
  window: "week",
  exclude_demo: true,
  reports: { new: 0, last24h: 0, merge_rate: 0 },
  series: [
    { day: "2026-10-22", tickets: 0, runs: 0, refused: 0, refusal_rate: 0 },
    { day: "2026-10-23", tickets: 0, runs: 0, refused: 0, refusal_rate: 0 },
    { day: "2026-10-24", tickets: 0, runs: 0, refused: 0, refusal_rate: 0 },
    { day: "2026-10-25", tickets: 0, runs: 0, refused: 0, refusal_rate: 0 },
    { day: "2026-10-26", tickets: 0, runs: 0, refused: 0, refusal_rate: 0 },
    { day: "2026-10-27", tickets: 0, runs: 0, refused: 0, refusal_rate: 0 },
    { day: "2026-10-28", tickets: 164, runs: 13, refused: 7, refusal_rate: 0.538 },
  ],
  fault_langs: [{ langs: 5, count: 6 }],
};

const days = (stats: any) => stats.series.map((point: any) => point.day);

test("图 1 工单量趋势：一天一根柱，0 的那天留残根（可悬停），仅 3 个日期刻度", () => {
  const doc = fakeDocument();
  const svg = buildTicketsBars(
    doc,
    REAL_STATS.series.map((point) => ({ day: point.day, value: point.tickets })),
  );
  assert.ok(svg !== null, "只有一天有单也要画：柱图不需要两个点");
  assert.equal(countTag(svg, "svg"), 1);
  assert.equal(svg.attrs.viewBox, "0 0 320 132");
  assert.equal(svg.attrs.role, "img");
  assert.equal(countTag(svg, "rect"), 7, "7 天 7 根（6 个 0 残根 + 1 根真柱）");
  assert.equal(countTag(svg, "title"), 7, "每根柱都要有悬停数值");
  assert.equal(countTag(svg, "text"), 6, "Y 轴 3 个刻度 + 日期 3 个刻度，别更多");
  assert.ok(textsOf(svg).includes("200"), "Y 轴上界取整到 200，柱高按 200 归一");
  assert.ok(textsOf(svg).includes("100"), "中间那根参考线要有刻度，否则只能靠眼睛估");
  assert.ok(dump(svg).includes("2026-10-28：164 张"), "悬停文本带日期");
  assert.ok(!/NaN|Infinity|undefined/.test(dump(svg)), `图里出现了坏数：${dump(svg)}`);

  assert.equal(buildTicketsBars(doc, REAL_STATS.series.map(() => ({ day: "2026-10-22", value: 0 }))), null, "全 0 → null");
  assert.equal(buildTicketsBars(doc, []), null);
  assert.equal(buildTicketsBars(doc, undefined), null);
});

test("图 2 工单状态分布：堆叠条 + 四行图例，值为 0 的状态照样列出来", () => {
  const doc = fakeDocument();
  const svg = buildStatusBar(doc, REAL_STATS.tickets_by_status);
  assert.ok(svg !== null);
  assert.equal(svg.attrs.viewBox, "0 0 320 62");
  assert.equal(countTag(svg, "rect"), 6, "2 段有宽度 + 4 个图例色块");
  assert.equal(countTag(svg, "title"), 2);
  const text = textsOf(svg).join("|");
  assert.ok(text.includes("已升级 0"), `0 值的状态也要出现在图例里：${text}`);
  assert.ok(text.includes("待处理 163"));
  assert.ok(dump(svg).includes("（99.4%）"), "悬停要带占比");
  assert.ok(!/NaN|Infinity|undefined/.test(dump(svg)));

  assert.equal(buildStatusBar(doc, { open: 0, claimed: 0, escalated: 0, closed: 0 }), null);
  assert.equal(buildStatusBar(doc, undefined), null);
});

test("图 3 拒答率趋势：runs=0 的日子断开；可画点 < 2 就说暂无数据（不拿一个孤点冒充走势）", () => {
  const doc = fakeDocument();

  // 真实形状：7 天里只有最后一天有运行记录 → 一个点，画不出趋势
  assert.equal(
    buildRefusalLine(
      doc,
      REAL_STATS.series.map((point) => ({ day: point.day, runs: point.runs, refused: point.refused, value: point.runs === 0 ? null : point.refusal_rate })),
    ),
    null,
  );

  // 两天有运行记录但中间隔着没有数据的一天 → 两条独立的线段（不许连成一条斜线）
  const gapped = buildRefusalLine(doc, [
    { day: "2026-10-22", runs: 4, refused: 1, value: 0.25 },
    { day: "2026-10-23", runs: 0, refused: 0, value: null },
    { day: "2026-10-24", runs: 0, refused: 0, value: null },
    { day: "2026-10-25", runs: 8, refused: 6, value: 0.75 },
  ]);
  assert.ok(gapped !== null);
  assert.equal(gapped.attrs.viewBox, "0 0 320 132");
  assert.equal(countTag(gapped, "path"), 1);
  const path = walk(gapped).find((node) => tagOf(node) === "path");
  assert.equal((path.attrs.d.match(/M/g) ?? []).length, 2, `断点处要重新起笔：${path.attrs.d}`);
  assert.match(path.attrs.style, /stroke:var\(--c-[a-z-]+\)/, "线色必须是令牌");
  assert.match(path.attrs.style, /fill:none/);
  assert.equal(countTag(gapped, "circle"), 2, "每个有数据的日子一个圆点");
  assert.ok(dump(gapped).includes("2026-10-25：75.0%（8 轮 / 6 拒答）"));
  assert.ok(textsOf(gapped).includes("100%"), "Y 轴 0–100%");
  assert.ok(textsOf(gapped).includes("0%"));
  assert.ok(!/NaN|Infinity|undefined/.test(dump(gapped)));

  // 相邻两天都有数据 → 一条线
  const joined = buildRefusalLine(doc, [
    { day: "2026-10-27", runs: 2, refused: 0, value: 0 },
    { day: "2026-10-28", runs: 13, refused: 7, value: 0.538 },
  ]);
  const joinedPath = walk(joined).find((node) => tagOf(node) === "path");
  assert.equal((joinedPath.attrs.d.match(/M/g) ?? []).length, 1);
  assert.equal(countTag(joined, "circle"), 2);
});

test("图 4 故障码语言完整度：六行横向柱，5/5 成功色、缺语警示色", () => {
  const doc = fakeDocument();
  const svg = buildLangBars(doc, REAL_STATS.fault_langs);
  assert.ok(svg !== null);
  assert.equal(svg.attrs.viewBox, "0 0 320 110", "6 行 × 18 + 2");
  assert.equal(countTag(svg, "rect"), 7, "6 条底轨 + 1 条有数据的柱");
  assert.equal(countTag(svg, "text"), 12, "6 个语言刻度 + 6 个计数");
  const styles = walk(svg).filter((node) => node.attrs.style).map((node) => node.attrs.style);
  assert.ok(styles.some((style: string) => style.includes(CHART_INK.complete)), "5/5 必须是成功色");
  assert.ok(!/NaN|Infinity|undefined/.test(dump(svg)));

  const missing = buildLangBars(doc, [
    { langs: 5, count: 6 },
    { langs: 3, count: 2 },
  ]);
  const fillStyles = walk(missing).filter((node) => node.attrs.style).map((node) => node.attrs.style);
  assert.ok(fillStyles.some((style: string) => style.includes(CHART_INK.missing)), "缺语的桶要用警示色");
  assert.equal(countTag(missing, "rect"), 8, "6 条底轨 + 2 条柱");

  assert.equal(buildLangBars(doc, []), null, "一条已发布的码都没有");
  assert.equal(buildLangBars(doc, [{ langs: 5, count: 0 }]), null);
  assert.equal(buildLangBars(doc, undefined), null);
});

/* ───────────────────────── 统计体 → 四张图卡 ───────────────────────── */

test("chartBlocksFor：真接口形状 → 四张图卡，能画的画、画不了的写「暂无数据」", () => {
  const doc = fakeDocument();
  const blocks = chartBlocksFor(doc, REAL_STATS);
  assert.equal(blocks.length, 4);
  assert.deepEqual(
    blocks.map((block: any) => textsOf(block)[0]),
    ["工单量趋势", "工单状态分布", "拒答率趋势", "故障码语言完整度"],
    "标题顺序固定：量 → 分布 → 质量 → 知识库",
  );
  assert.equal(blocks[0].className, "admin-card admin-chart");
  assert.equal(countTag(blocks[0], "svg"), 1);
  assert.equal(countTag(blocks[1], "svg"), 1);
  assert.equal(countTag(blocks[2], "svg"), 0, "只有一天有运行记录：拒答率图画不出来");
  assert.ok(textsOf(blocks[2]).join(" ").includes(CHART_EMPTY_TEXT.refusal));
  assert.ok(textsOf(blocks[2]).join(" ").includes("暂无数据"));
  assert.equal(countTag(blocks[3], "svg"), 1);
  assert.ok(!/NaN|Infinity|undefined/.test(dump({ children: blocks })));
});

test("chartBlocksFor：老后端（没有 series / fault_langs）只降级那三张，状态分布照画", () => {
  // `tickets_by_status` 从 `09#01` 起就在响应里，`series` / `fault_langs` 是 `09#04` 才加的。
  // 所以"老后端"并不等于"没有数据"：状态分布那张图仍然画得出来，另外三张各写一句"暂无数据"。
  // 断言按图逐张钉，而不是数一个总数 —— 总数说不清"少画的是哪一张"。
  const doc = fakeDocument();
  for (const legacy of [
    { ...REAL_STATS, series: undefined, fault_langs: undefined },
    { ...REAL_STATS, series: null, fault_langs: null },
    { ...REAL_STATS, series: "7d", fault_langs: 3 },
  ]) {
    const blocks = chartBlocksFor(doc, legacy as any);
    assert.equal(blocks.length, 4, `${JSON.stringify(legacy)} 也要四张（缺图不整块空着）`);
    assert.deepEqual(
      blocks.map((block: any) => countTag(block, "svg")),
      [0, 1, 0, 0],
      "只有状态分布画得出（`tickets_by_status` 在），其余三张必须降级",
    );
    const text = textsOf({ children: blocks }).join(" ");
    assert.equal(text.split("暂无数据").length - 1, 3, `三张各写一句：${text}`);
    assert.ok(!/NaN|Infinity|undefined/.test(text), `降级文案里不许漏出坏值：${text}`);
  }
});

test("chartBlocksFor：整块没有数据（{} / null / undefined）四张全「暂无数据」，不抛错", () => {
  const doc = fakeDocument();
  for (const empty of [{}, null, undefined]) {
    const blocks = chartBlocksFor(doc, empty as any);
    assert.equal(blocks.length, 4, `${JSON.stringify(empty)} 也要四张（缺图不整块空着）`);
    assert.equal(countTag({ children: blocks }, "svg"), 0, "没数据就不许画一个空白 SVG");
    const text = textsOf({ children: blocks }).join(" ");
    assert.equal(text.split("暂无数据").length - 1, 4, `四张各写一句：${text}`);
    assert.ok(!/NaN|Infinity|undefined/.test(text), `降级文案里不许漏出坏值：${text}`);
  }
});

test("chartBlocksFor：全 0 序列 + 无故障码 → 四张都是「暂无数据」（窗口里没业务量不是画错）", () => {
  const doc = fakeDocument();
  const zeros = {
    ...REAL_STATS,
    tickets_by_status: { open: 0, claimed: 0, escalated: 0, closed: 0 },
    series: REAL_STATS.series.map((point) => ({ day: point.day, tickets: 0, runs: 0, refused: 0, refusal_rate: 0 })),
    fault_langs: [{ langs: 5, count: 0 }],
  };
  const blocks = chartBlocksFor(doc, zeros);
  assert.equal(countTag({ children: blocks }, "svg"), 0);
  assert.equal(textsOf({ children: blocks }).join(" ").split("暂无数据").length - 1, 4, "四张各写一句");
});

test("时间窗 → 序列窗口：序列必须盖住当前窗口（今天/近 7 天 → 7d，全部 → 30d）", () => {
  assert.deepEqual(Object.keys(SERIES_FOR_WINDOW), BOARD_WINDOWS.map(([value]: string[]) => value), "映射表要覆盖每个时间窗");
  assert.equal(seriesForWindow("today"), "7d");
  assert.equal(seriesForWindow("week"), "7d");
  assert.equal(seriesForWindow("all"), "30d");
  assert.equal(seriesForWindow("weird"), "7d", "认不出的窗口回落 7d，不发一个会 400 的取值");
});

test("canDrawCharts：只认 createElementNS（没有它 <svg> 是一个空白元素）", () => {
  assert.equal(canDrawCharts(fakeDocument()), true);
  assert.equal(canDrawCharts(fakeDocument(false)), false);
  assert.equal(canDrawCharts(undefined), false);
  assert.equal(canDrawCharts({}), false);
});

/* ───────────────────────── 挂载（真模块 + 假 DOM） ───────────────────────── */

test("mount：能画 SVG 时按 series 一起要数据，时间窗切换同时换 window 与 series", async () => {
  const calls: string[] = [];
  const host = fakeNode("div");
  host.ownerDocument = fakeDocument();
  const unmount = board.mount(host, {
    api: async (path: string) => {
      calls.push(path);
      return { ok: true, data: REAL_STATS };
    },
    role: "lead",
    toast: () => {},
    onSignOut: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, ["/api/console/stats?exclude_demo=true&window=all&series=30d"], "首屏 window=all 配 30 天序列");
  const charts = walk(host).filter((node) => hasClass(node, "admin-chart"));
  assert.equal(charts.length, 4, "四张图卡都挂上了");
  assert.equal(countTag({ children: charts }, "svg"), 3, "拒答率只有一天运行记录 → 那一张降级");

  const click = host.listeners.find((listener: any) => listener.type === "click");
  const tab = fakeNode("button");
  tab.dataset.window = "week";
  click.fn({ target: { closest: (selector: string) => (selector === "[data-window]" ? tab : null) } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // 切时间窗要连序列一起换：否则图上是 30 天、卡片算的是今天
  assert.deepEqual(calls, [
    "/api/console/stats?exclude_demo=true&window=all&series=30d",
    "/api/console/stats?exclude_demo=true&window=week&series=7d",
  ]);
  assert.ok(!/NaN|Infinity|undefined/.test(textsOf(host).join(" ")));

  unmount();
  assert.deepEqual(host.children, [], "卸载要把图一起清掉");
});

test("mount：不能画 SVG 的 DOM 不请求 series（画不出来的响应不白花一次往返）", async () => {
  const calls: string[] = [];
  const host = fakeNode("div");
  host.ownerDocument = fakeDocument(false);
  const unmount = board.mount(host, {
    api: async (path: string) => {
      calls.push(path);
      return { ok: true, data: REAL_STATS };
    },
    role: "agent",
    toast: () => {},
    onSignOut: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, ["/api/console/stats?exclude_demo=true&window=all"]);
  assert.equal(walk(host).filter((node) => hasClass(node, "admin-chart")).length, 0);
  assert.ok(textsOf(host).join(" ").includes("工单总数"), "卡片照旧：图降级不该把数字一起带走");
  unmount();
});

/* ───────────────────────── 静态规矩 ───────────────────────── */

test("零依赖：看板只 import SLA 与自己的图表模块，图表模块一个 import 都没有", async () => {
  const boardSource = await readFile(join(STATIC_DIR, "lib", "console-admin-board.js"), "utf8");
  const chartSource = await readFile(join(STATIC_DIR, "lib", "chart-svg.js"), "utf8");

  const boardImports = [...boardSource.matchAll(/^import\s[^;]*?from\s+"([^"]+)";?$/gm)].map((match) => match[1]);
  assert.deepEqual(boardImports, ["./console-sla.js", "./chart-svg.js"], "零依赖：不引任何图表库");
  assert.equal(/^import\s/m.test(chartSource), false, "几何模块不许 import 任何东西（连自己的模块都不需要）");
  assert.equal(SVG_NS, "http://www.w3.org/2000/svg");
});

test("没有裸色值：图表的 fill / stroke 全部走 var(--…)，且令牌在 app.css 里真有定义", async () => {
  const boardSource = await readFile(join(STATIC_DIR, "lib", "console-admin-board.js"), "utf8");
  const chartSource = await readFile(join(STATIC_DIR, "lib", "chart-svg.js"), "utf8");
  const appCss = await readFile(join(STATIC_DIR, "app.css"), "utf8");

  for (const [name, source] of [
    ["console-admin-board.js", boardSource],
    ["chart-svg.js", chartSource],
  ] as const) {
    const naked = source.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
    assert.deepEqual(naked, [], `${name} 里出现了裸色值：${naked.join(" ")}`);
  }

  const used = new Set([...`${boardSource}${chartSource}`.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]));
  assert.ok(used.size >= 6, `图表应该真的用到令牌，实际只有 ${[...used].join(" ")}`);
  for (const token of used) {
    assert.ok(appCss.includes(`${token}:`), `${token} 不是 app.css 里的已有令牌（别自己编一个不存在的变量）`);
  }
});

test("模块顶层不碰 document（node 里 import 不炸）；单文件 ≤500 行", async () => {
  assert.equal(typeof (globalThis as any).document, "undefined", "本测试跑在 node 里，没有 document —— 能 import 就说明顶层没碰它");
  assert.equal(typeof charts.niceMax, "function");

  for (const name of ["console-admin-board.js", "chart-svg.js"]) {
    const source = await readFile(join(STATIC_DIR, "lib", name), "utf8");
    assert.ok(!/^(?:const|let|var)\s[^=\n]*=\s*(?:globalThis\.)?document\b/m.test(source), `${name} 顶层不许引用 document`);
    const lines = source.split("\n").length;
    assert.ok(lines <= 500, `${name} 已经 ${lines} 行，超过 500 行就该再拆一个文件`);
  }
});
