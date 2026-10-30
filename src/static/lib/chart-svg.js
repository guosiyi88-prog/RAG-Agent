/**
 * 看板图表：纯几何 + 内联 SVG 构建（`09#04` 看板 A 方案，**零依赖、不引图表库**）。
 *
 * 为什么自己画：四张静态图不值得一个 100 KB 起步的图表库，而 `<svg>` 是浏览器自带的能力。
 *
 * 三条硬规矩（都来自工单）：
 *   1. **颜色只走令牌**：`fill` / `stroke` 全部写在 `style` 里用 `var(--c-*)`，
 *      本模块不认识任何一个色值 —— 深浅色跟着令牌走，不另做一套配色。
 *   2. **几何是纯函数**：`niceMax` / `scaleY` / `linePath` / `dayTicks` / `statusSegments` /
 *      `langBars` 一律不碰 DOM（`tests/web-admin-board-charts.test.ts` 直接喂数字断言）。
 *      只有 `build*` 接收 `doc` —— **顶层不许出现 `document`**，否则 node 里 import 就炸。
 *   3. **静态图 + 悬停数值**：每个有数据的图元挂一个 `<title>`（浏览器原生提示），
 *      不做缩放、拖拽、tooltip 库 —— 看板是"一眼看趋势"，不是数据分析工具。
 */

/** SVG 命名空间。少了它 `createElementNS` 出来的是 HTMLUnknownElement，屏幕上一片空白。 */
export const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 图表墨色：只有令牌名，没有色值。
 * 语义与工单徽标同一套（`console.css` 的 `.badge-status`）：成功用 `--c-st-closed`、
 * 警示用 `--c-st-open`、升级用 `--c-st-other`、中性文字用 `--c-muted`。
 */
export const CHART_INK = Object.freeze({
  axis: "var(--c-border)",
  label: "var(--c-muted)",
  value: "var(--c-cta)",
  complete: "var(--c-st-closed)",
  missing: "var(--c-st-open)",
});

/**
 * 四种工单状态的绘制顺序与中文名。
 * "待处理"口径与数字卡片一致（`open + claimed + escalated`），这里拆成三段画。
 */
export const TICKET_STATUSES = Object.freeze([
  { key: "open", label: "待处理", color: "var(--c-st-open)" },
  { key: "claimed", label: "已认领", color: "var(--c-st-claimed)" },
  { key: "escalated", label: "已升级", color: "var(--c-st-other)" },
  { key: "closed", label: "已关闭", color: "var(--c-st-closed)" },
]);

/** 故障码的一门语算"齐"要求 `desc_*` 与 `act_*` 都非空（与门禁同口径），所以总共 5 门。 */
export const LANG_TOTAL = 5;

const round = (value) => Math.round(value * 100) / 100;

/* ───────────────────────────── 纯几何 ───────────────────────────── */

/**
 * 取整的 Y 轴上界：1 / 2 / 5 × 10^k。
 *
 * **全 0 时返回 1，绝不返回 0** —— 上界是除数，0 会让每个点都变成 `NaN`，
 * 而整条折线消失比画错更难看懂（看板上一片空白会被当成"接口挂了"）。
 * 非数字 / null 跳过；负数忽略（计数与比率都不为负）。
 */
export function niceMax(values) {
  let max = 0;
  for (const raw of Array.isArray(values) ? values : []) {
    if (raw === null || raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= max) continue;
    max = value;
  }
  if (max <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const scaled = max / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  // `toPrecision(12)` 抹掉浮点噪声：0.1 × 10 在百分位上会露出 `1.0000000000000002`
  return Number((step * magnitude).toPrecision(12));
}

/**
 * 值 → 像素 y（SVG 的 y 向下：0 在底、上界在顶）。越界夹到 [0, height]。
 *
 * 非数字落在底线上（等价于 0）而不是返回 `NaN`：一个 `NaN` 会让整条 `<path>` 的
 * `d` 变成无效值，浏览器直接不画 —— 一条折线里一个坏数就整条消失。
 */
export function scaleY(value, max, height) {
  const top = Number(max);
  const box = Number(height);
  if (!Number.isFinite(box) || box <= 0) return 0;
  if (!Number.isFinite(top) || top <= 0) return box;
  const number = Number(value);
  if (!Number.isFinite(number)) return box;
  const clamped = Math.min(Math.max(number, 0), top);
  return box - (clamped / top) * box;
}

/** 日期 → 轴上的短标签（`2026-10-22` → `10-22`）；认不出的原样返回，不编日期。 */
function shortDay(day) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  return matched === null ? String(day) : `${matched[2]}-${matched[3]}`;
}

/**
 * 折线 `d` 串。`points` 是 `[{ value }]`，`value` 为 `null` / 非有限数 = **断点**：
 * 那天没有数据（`runs = 0`），既不能画成 0%，也不能和后面的点连起来。
 *
 * x 按下标均分（断点也占一格，日期轴才和真实时间同间距）；`n = 1` 时落在正中。
 * 单点段输出 `M x y L x y` —— 配 `stroke-linecap: round` 渲染成一个圆点，
 * 孤零零一天的数据也看得见（否则 `M` 单独一条什么都不画）。
 * 全部断点 / 空数组 → `""`（调用方据此显示"暂无数据"）。
 */
export function linePath(points, w, h, max) {
  const list = Array.isArray(points) ? points : [];
  const count = list.length;
  const width = Number(w);
  const height = Number(h);
  if (count === 0 || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return "";

  const values = list.map((point) => (point !== null && typeof point === "object" ? point.value : point));
  const asked = Number(max);
  const top = Number.isFinite(asked) && asked > 0 ? asked : niceMax(values);

  const parts = [];
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    parts.push(`M${run[0].x} ${run[0].y}`);
    for (let i = 1; i < run.length; i += 1) parts.push(`L${run[i].x} ${run[i].y}`);
    if (run.length === 1) parts.push(`L${run[0].x} ${run[0].y}`);
    run = [];
  };

  for (let index = 0; index < count; index += 1) {
    const raw = values[index];
    const value = raw === null || raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isFinite(value)) {
      flush();
      continue;
    }
    const x = round(count === 1 ? width / 2 : (index / (count - 1)) * width);
    run.push({ x, y: round(scaleY(value, top, height)) });
  }
  flush();
  return parts.join("");
}

/**
 * 日期轴的刻度：**只取首 / 中 / 末三个**。
 * 7–30 个日期全挤在轴上（每格不到 10px）会糊成一团，比没有轴更糟。
 */
export function dayTicks(days) {
  const list = Array.isArray(days) ? days : [];
  const count = list.length;
  if (count === 0) return [];
  const indexes = count === 1 ? [0] : count === 2 ? [0, 1] : [0, Math.floor((count - 1) / 2), count - 1];
  return indexes.map((index) => ({ index, day: list[index], label: shortDay(list[index]) }));
}

/**
 * 工单状态的堆叠条分段。`width` 是条子的总像素宽，返回各段 `{ key, label, value, color, x, width }`。
 *
 * **各段宽度舍入后之和必须严格等于 `width`**：差 1px 就会在条尾露出一条底色缝，
 * 看着像"还有第五种状态没画出来"。做法是最大余数法；补出来的像素只分给 `value > 0`
 * 的段（否则"已升级 0"会凭空变成 1px 宽）。
 * 总数为 0 / 没有宽度 → `[]`（调用方显示"暂无数据"，不画一条空条）。
 */
export function statusSegments(byStatus, width) {
  const box = byStatus !== null && typeof byStatus === "object" ? byStatus : {};
  const total = Number(width);
  if (!Number.isFinite(total) || total <= 0) return [];
  const rows = TICKET_STATUSES.map((status) => {
    const value = Number(box[status.key]);
    return { ...status, value: Number.isFinite(value) && value > 0 ? value : 0 };
  });
  const sum = rows.reduce((acc, row) => acc + row.value, 0);
  if (sum === 0) return [];

  const exact = rows.map((row) => (row.value / sum) * total);
  const widths = exact.map((value) => Math.floor(value));
  let left = Math.round(total) - widths.reduce((acc, value) => acc + value, 0);
  const order = rows
    .map((row, index) => ({ index, frac: exact[index] - widths[index], value: row.value }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let step = 0; left > 0 && order.length > 0; step += 1, left -= 1) {
    widths[order[step % order.length].index] += 1;
  }

  let x = 0;
  return rows.map((row, index) => {
    const segment = { key: row.key, label: row.label, value: row.value, color: row.color, x, width: widths[index] };
    x += widths[index];
    return segment;
  });
}

/**
 * 故障码语言完整度的六个桶（5/5 → 0/5，**好消息排在上面**）。
 *
 * 后端只回有数据的桶（`fault_langs: [{ langs, count }]`），所以缺的桶在这里补 0 ——
 * "0/5：0 条"和"没有这一行"是两件事，看板上必须能读到前者（它证明这条产线没有缺语）。
 * `status` 决定颜色：5/5 是成功色，缺语是警示色。
 */
export function langBars(faultLangs) {
  const counts = new Map();
  for (const item of Array.isArray(faultLangs) ? faultLangs : []) {
    if (item === null || typeof item !== "object") continue;
    const langs = Math.round(Number(item.langs));
    const count = Number(item.count);
    if (!Number.isFinite(langs) || !Number.isFinite(count) || count <= 0) continue;
    if (langs < 0 || langs > LANG_TOTAL) continue;
    counts.set(langs, (counts.get(langs) ?? 0) + count);
  }
  const rows = [];
  for (let langs = LANG_TOTAL; langs >= 0; langs -= 1) {
    const complete = langs === LANG_TOTAL;
    rows.push({
      langs,
      label: `${langs}/${LANG_TOTAL}`,
      count: counts.get(langs) ?? 0,
      status: complete ? "complete" : "missing",
      color: complete ? CHART_INK.complete : CHART_INK.missing,
    });
  }
  return rows;
}

/** 0–1 比率 → `53.8%`（工具提示与图例共用；不要在这里做"猜量纲"，接口给的是小数）。 */
export function percentText(value, base = 1) {
  const number = Number(value);
  const bottom = Number(base);
  if (!Number.isFinite(number) || !Number.isFinite(bottom) || bottom === 0) return "";
  return `${((number / bottom) * 100).toFixed(1)}%`;
}

/* ───────────────────────────── SVG 构建 ───────────────────────────── */

/** 一块画布的共同尺寸：左 30 留着写 Y 轴刻度，下 20 留日期，右 6 防裁切。 */
const PLOT = Object.freeze({ w: 320, h: 132, left: 30, right: 6, top: 10, bottom: 20 });

function el(doc, tag, attrs, style) {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs ?? {})) node.setAttribute(key, String(attrs[key]));
  if (typeof style === "string" && style !== "") node.setAttribute("style", style);
  return node;
}

function tip(doc, text) {
  const node = doc.createElementNS(SVG_NS, "title");
  node.textContent = text;
  return node;
}

function label(doc, text, attrs) {
  const node = el(doc, "text", { "font-size": 10, ...attrs }, `fill:${CHART_INK.label};font-family:var(--font-mono)`);
  node.textContent = text;
  return node;
}

function canvas(doc, height, ariaLabel) {
  return el(
    doc,
    "svg",
    { viewBox: `0 0 ${PLOT.w} ${height}`, role: "img", "aria-label": ariaLabel },
    "width:100%;height:auto",
  );
}

function horizontalGrid(doc, svg, plotH, max, formatter) {
  const plotW = PLOT.w - PLOT.left - PLOT.right;
  for (const value of [0, max / 2, max]) {
    const y = round(PLOT.top + scaleY(value, max, plotH));
    svg.appendChild(
      el(doc, "line", { x1: PLOT.left, y1: y, x2: PLOT.left + plotW, y2: y, "stroke-width": 1 }, `stroke:${CHART_INK.axis}`),
    );
    svg.appendChild(label(doc, formatter(value), { x: PLOT.left - 5, y: round(y + 3.5), "text-anchor": "end" }));
  }
}

function dateAxis(doc, svg, days, height) {
  const plotW = PLOT.w - PLOT.left - PLOT.right;
  const slot = days.length === 0 ? 0 : plotW / days.length;
  for (const tick of dayTicks(days)) {
    const x = round(PLOT.left + slot * tick.index + slot / 2);
    svg.appendChild(label(doc, tick.label, { x, y: height - 6, "text-anchor": "middle" }));
  }
}

/**
 * 1. 工单量趋势（柱）：每天一根，`tickets` 为 0 的那天只留一枚贴着底线的浅色残根
 * （有悬停值，说明"这一天是 0"而不是"这一天不存在"）。
 * 全 0 / 空序列 → `null`。
 */
export function buildTicketsBars(doc, points) {
  const list = (Array.isArray(points) ? points : []).map((point) => ({
    day: String(point?.day ?? ""),
    value: Math.max(0, Number(point?.value) || 0),
  }));
  const total = list.reduce((sum, point) => sum + point.value, 0);
  if (list.length === 0 || total === 0) return null;

  const plotW = PLOT.w - PLOT.left - PLOT.right;
  const plotH = PLOT.h - PLOT.top - PLOT.bottom;
  const max = niceMax(list.map((point) => point.value));
  const svg = canvas(doc, PLOT.h, `工单量趋势：${list.length} 天共 ${total} 张`);
  horizontalGrid(doc, svg, plotH, max, (value) => String(Math.round(value)));

  const slot = plotW / list.length;
  const barW = Math.min(Math.max(slot * 0.62, 1.5), 16);
  list.forEach((point, index) => {
    const x = round(PLOT.left + slot * index + (slot - barW) / 2);
    if (point.value === 0) {
      const stub = el(
        doc,
        "rect",
        { x, y: round(PLOT.top + plotH - 2), width: round(barW), height: 2, rx: 1 },
        `fill:${CHART_INK.axis}`,
      );
      stub.appendChild(tip(doc, `${point.day}：0 张`));
      svg.appendChild(stub);
      return;
    }
    const barH = Math.max(1, (point.value / max) * plotH);
    const bar = el(
      doc,
      "rect",
      { x, y: round(PLOT.top + plotH - barH), width: round(barW), height: round(barH), rx: 1.5 },
      `fill:${CHART_INK.value}`,
    );
    bar.appendChild(tip(doc, `${point.day}：${point.value} 张`));
    svg.appendChild(bar);
  });

  dateAxis(doc, svg, list.map((point) => point.day), PLOT.h);
  return svg;
}

/**
 * 2. 工单状态分布（水平堆叠条 + 图例）：四段宽度之和严格等于条宽。
 * 值为 0 的状态照样出现在图例里（"已升级 0"本身是信息）。
 * 总数 0 / 缺字段 → `null`。
 */
export function buildStatusBar(doc, byStatus) {
  const segments = statusSegments(byStatus, PLOT.w);
  if (segments.length === 0) return null;
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const height = 62;
  const svg = canvas(doc, height, `工单状态分布：共 ${total} 张`);

  for (const segment of segments) {
    if (segment.width <= 0) continue;
    const rect = el(
      doc,
      "rect",
      { x: round(segment.x), y: 4, width: round(segment.width), height: 18, rx: 2 },
      `fill:${segment.color}`,
    );
    rect.appendChild(tip(doc, `${segment.label} ${segment.value} 张（${percentText(segment.value, total)}）`));
    svg.appendChild(rect);
  }

  const cell = PLOT.w / segments.length;
  segments.forEach((segment, index) => {
    const x = round(index * cell);
    svg.appendChild(el(doc, "rect", { x, y: 38, width: 8, height: 8, rx: 2 }, `fill:${segment.color}`));
    svg.appendChild(label(doc, `${segment.label} ${segment.value}`, { x: round(x + 12), y: 46, "font-size": 11 }));
  });
  return svg;
}

/**
 * 3. 拒答率趋势（折线，Y 轴 0–100%）。
 *
 * `runs = 0` 的日期**必须断开**：后端那天给的 `refusal_rate` 是 0，但那是"没有数据"，
 * 不是"没拒答"—— 连成一条压到 0% 的线，看板的人会以为那天答得特别好。
 * 可画的点少于 2 个 → `null`（一个点画不出趋势，硬画就是一个孤点冒充"走势"）。
 */
export function buildRefusalLine(doc, points) {
  const list = (Array.isArray(points) ? points : []).map((point) => {
    const runs = Number(point?.runs);
    const refused = Number(point?.refused);
    const rate = Number(point?.value);
    const has = Number.isFinite(runs) && runs > 0 && Number.isFinite(rate);
    return {
      day: String(point?.day ?? ""),
      runs: Number.isFinite(runs) && runs > 0 ? runs : 0,
      refused: Number.isFinite(refused) && refused > 0 ? refused : 0,
      value: has ? Math.min(Math.max(rate, 0), 1) : null,
    };
  });
  const drawable = list.filter((point) => point.value !== null).length;
  if (drawable < 2) return null;

  const plotW = PLOT.w - PLOT.left - PLOT.right;
  const plotH = PLOT.h - PLOT.top - PLOT.bottom;
  const svg = canvas(doc, PLOT.h, `拒答率趋势：${drawable} 天有运行记录，共 ${list.length} 天`);
  horizontalGrid(doc, svg, plotH, 1, (value) => `${Math.round(value * 100)}%`);

  svg.appendChild(
    el(
      doc,
      "path",
      { d: linePath(list, plotW, plotH, 1), "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", transform: `translate(${PLOT.left} ${PLOT.top})` },
      `stroke:${CHART_INK.value};fill:none`,
    ),
  );

  list.forEach((point, index) => {
    if (point.value === null) return;
    const x = round(PLOT.left + (list.length === 1 ? plotW / 2 : (index / (list.length - 1)) * plotW));
    const y = round(PLOT.top + scaleY(point.value, 1, plotH));
    const dot = el(doc, "circle", { cx: x, cy: y, r: 2.5 }, `fill:${CHART_INK.value}`);
    dot.appendChild(tip(doc, `${point.day}：${percentText(point.value)}（${point.runs} 轮 / ${point.refused} 拒答）`));
    svg.appendChild(dot);
  });

  dateAxis(doc, svg, list.map((point) => point.day), PLOT.h);
  return svg;
}

/**
 * 4. 故障码语言完整度（横向柱，5/5 → 0/5）：5/5 用成功色、缺语用警示色。
 * 一条已发布的码都没有 → `null`。
 */
export function buildLangBars(doc, faultLangs) {
  const rows = langBars(faultLangs);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) return null;

  const rowH = 18;
  const height = rows.length * rowH + 2;
  const labelW = 26;
  const trackW = 200;
  const max = niceMax(rows.map((row) => row.count));
  const svg = canvas(doc, height, `已发布故障码的语言完整度：共 ${total} 条`);

  rows.forEach((row, index) => {
    const cy = 2 + index * rowH + rowH / 2;
    svg.appendChild(label(doc, row.label, { x: labelW - 6, y: round(cy + 3.5), "text-anchor": "end" }));
    const track = el(doc, "rect", { x: labelW, y: round(cy - 4), width: trackW, height: 8, rx: 4 }, `fill:${CHART_INK.axis}`);
    track.appendChild(tip(doc, `${row.label}：${row.count} 条`));
    svg.appendChild(track);
    if (row.count > 0) {
      const bar = el(
        doc,
        "rect",
        { x: labelW, y: round(cy - 4), width: Math.max(2, round((row.count / max) * trackW)), height: 8, rx: 4 },
        `fill:${row.color}`,
      );
      bar.appendChild(tip(doc, `${row.label}：${row.count} 条`));
      svg.appendChild(bar);
    }
    svg.appendChild(label(doc, String(row.count), { x: labelW + trackW + 6, y: round(cy + 3.5) }));
  });
  return svg;
}
