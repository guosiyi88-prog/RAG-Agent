/**
 * 演示数据一键灌入（`08-i18n-eval-handoff` spec T11 · `13-ops.md` §9 · `15-tasks.md` T11）。
 *
 * `make demo` 背后的唯一实现。做两件事，都是**幂等**的：
 *
 *   1. **评测夹具对齐**：把 `corpus/.fixtures/qa_gold.json` 的 `expect_doc_hint` 解析成
 *      `documents.id`，写进 `qa_gold` 表（`14 §4.1`："`scripts/demo.ts` 会把 hint 解析成
 *      `expect_doc_id` 写库"）。已有同 `(lang, question)` 的行就跳过，不覆盖、不 truncate。
 *   2. **示例工单**：插 8 张伪造工单，覆盖 `open/claimed/closed` × 四种 `reason`，
 *      其中 1 张 `due_at` 已超时、1 张 1 小时内到期 —— 坐席队列的 SLA 配色（红/黄）
 *      和"演示数据"标记都靠这批行。全部带 `tags = {demo}`，接口据此下发 `demo: true`。
 *      **`claimed` 那两张走真实的认领路径**（`updateTicket`）而不是直接写 `assignee` 字段：
 *      界面上没有"派发给别人"的按钮，演示数据却出现两个不同坐席的名字，等于演了一个产品
 *      做不到的动作（评审当场问"为什么派给了李娜"）。现在它们由"默认坐席点了认领"产生，
 *      `audit_log` 里也有对应记录，演示时点开详情看到的就是真的。
 *
 * **不做的事**（每一条都是刻意的）：
 *   - 不灌语料。`make ingest` 才是语料入口（换语料要重算 embedding、要网络），演示脚本
 *     混进去会让"只想造两张单"变成一次几分钟的入库。语料为空时直接退出码 1 并说清下一步。
 *   - 不 truncate / 不 delete 任何行。库里同时可能有评测跑分、别的会话、别的 agent 的测试数据；
 *     清库是 `make reset` 的职责，不是 `make demo` 的。已有 demo 工单时只打印数量。
 *   - 不用真实邮箱。`requester` 是坐席要看见的字段，写真邮箱等于把演示机上的假单变成骚扰源。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query } from "../src/db.ts";
import { updateTicket, type PatchPrincipal } from "../src/core/ticket-queue.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 夹具在 `corpus/.fixtures/` 下：以 `.` 开头的目录被 ingest 跳过（见 `scripts/eval.ts` 文件头）。 */
const FIXTURE_PATH = join(repoRoot, "corpus", ".fixtures", "qa_gold.json");
/** 语料目录：判"语料缺失"时只用来给提示，不用来读文件。 */
const CORPUS_DIR = join(repoRoot, "corpus");

/** 故障码题的结构化语料提示：`fault_codes` 表没有 documents 行（`14 §4.2` 的 `fault`）。 */
const FAULT_HINT = "fault";

/**
 * demo 工单的标记值。坐席端用 `tags @> '{demo}'` 判断"这是演示数据，不是真客户"，
 * 所以这个字符串是两个进程之间的契约，不是本地命名 —— 改它等于改接口。
 */
const DEMO_TAG = "demo";

/* ────────────────────────── 类型 ────────────────────────── */

type GoldItem = {
  lang: string;
  question: string;
  /** `null` = 反例题（超纲，没有期望文档）。 */
  expect_doc_hint: string | null;
  should_refuse: boolean;
  note?: string;
};

type GoldFixture = { version: string; items: GoldItem[]; multi_turn?: unknown[] };

type DocRow = { id: string; title: string; object_key: string };

/** 一张示例工单。时间都用"相对现在多少分钟"表达，重复跑出来的 SLA 观感也一致。 */
type DemoTicket = {
  reason: "no_citation" | "out_of_scope" | "low_conf" | "user_request";
  status: "open" | "claimed" | "closed";
  question: string;
  requester: string;
  priority: "low" | "normal" | "high" | "urgent";
  /** 创建于多少分钟前（>0）。 */
  createdMinAgo: number;
  /** 截止时间相对现在多少分钟（负数 = 已超时；`0 < x <= 60` = 1 小时内到期）。 */
  dueInMin: number;
  /** `claimed` 的指派对象按 `staff` 表顺序取；`closed` 的结论文本。 */
  resolution?: string;
};

/**
 * 8 张示例工单。为什么是 8 而不是规格说的"3 张"（`13 §9`）：
 * 坐席队列要能同时演示 ① 待处理里有单、② SLA 已超时变红、③ 1 小时内到期变黄、
 * ④ 已认领的指派列有名字、⑤ 已关闭的不在待处理列表里。3 张排不下这五种形态，
 * 而"演示数据太多"不是风险（都有 `demo` 标签，一眼可辨）。
 *
 * 问题文本刻意跨语种：坐席端只做中文，但队列里的 `question` 是客户原文，
 * 这正好演示"中文界面 + 客户母语工单正文"这件事（`16 §6` L11 的例外）。
 */
const DEMO_TICKETS: DemoTicket[] = [
  {
    // 待处理 · 拒答（无引用）：演示脚本里客户现场提问生成的那张单就是这个形态
    reason: "no_citation",
    status: "open",
    question: "Kunnen jullie 20% korting geven?",
    requester: "demo-installateur-nl",
    priority: "normal",
    createdMinAgo: 12,
    dueInMin: 228,
  },
  {
    // 待处理 · 超纲（竞品对比）：需求超出知识库范围，值班坐席按话术回
    reason: "out_of_scope",
    status: "open",
    question: "Ist euer Produkt besser als der Wettbewerb?",
    requester: "demo-installateur-de",
    priority: "normal",
    createdMinAgo: 26,
    dueInMin: 214,
  },
  {
    // 待处理 · 低置信：语料只覆盖保修与安装两节（`16 §6` L3），冬季模式问题确实召回不到
    reason: "low_conf",
    status: "open",
    question: "¿Cómo funciona el modo de reserva en invierno?",
    requester: "demo-instalador-es",
    priority: "high",
    createdMinAgo: 41,
    dueInMin: 199,
  },
  {
    // 待处理 · 转人工（用户主动点按钮）+ **1 小时内到期**：坐席队列的黄色 SLA
    reason: "user_request",
    status: "open",
    question: "能否把逆变器换成 800W 型号？现场已经装好了支架",
    requester: "demo-owner-zhou",
    priority: "urgent",
    createdMinAgo: 70,
    dueInMin: 38,
  },
  {
    // 待处理 · 拒答（无引用）+ **已超时**：坐席队列的红色 SLA
    reason: "no_citation",
    status: "open",
    question: "并网点零线的接法有没有图示？我这边是三相四线",
    requester: "demo-owner-lin",
    priority: "high",
    createdMinAgo: 195,
    dueInMin: -95,
  },
  {
    // 已认领 · 拒答（无引用）：认领后指派列应有坐席姓名
    reason: "no_citation",
    status: "claimed",
    question: "What is the warranty for the battery if installed outdoors?",
    requester: "demo-installer-uk",
    priority: "normal",
    createdMinAgo: 132,
    dueInMin: 108,
  },
  {
    // 已认领 · 超纲（交期承诺）：模型不许承诺交期（`16 §1` R7），所以一律成单
    reason: "out_of_scope",
    status: "claimed",
    question: "Können Sie die Lieferzeit auf 2 Wochen garantieren?",
    requester: "demo-installateur-at",
    priority: "high",
    createdMinAgo: 270,
    dueInMin: 30,
  },
  {
    // 已关闭：带 resolution，用于演示"关单后从待处理列表消失"与工单查询返回 closed
    reason: "no_citation",
    status: "closed",
    question: "Was bedeutet Fehlercode E07?",
    requester: "demo-installateur-ch",
    priority: "normal",
    createdMinAgo: 1_200,
    dueInMin: -900,
    resolution:
      "E07 = 电网过压。已电话引导客户测量并网点电压（实测 253V，超出 230V±10%），" +
      "建议报电网公司调整分接开关；客户确认设备已自行恢复。",
  },
];

/* ────────────────────────── 输出 ────────────────────────── */

/** 与 `scripts/eval.ts` 同一套前缀约定：脚本自己的输出一眼能从应用日志里分出来。 */
function log(message: string): void {
  process.stdout.write(`[demo] ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`[demo] ${message}\n`);
  process.exit(1);
}

/* ────────────────────────── 夹具 → documents.id ────────────────────────── */

/**
 * `expect_doc_hint` → `documents.id`（`14 §4.1`）。
 *
 * 解析顺序与 `scripts/eval.ts` 的 `resolveHint()` 完全一致，三档兜底：
 *   1. `documents.title` 全等（当前语料里 title 就是文件名去扩展名，如 `warranty.de`）；
 *   2. `object_key` 去扩展名后的文件名兜底（`warranty.de.md` → `warranty.de`）；
 *   3. `documents.id` 前缀兜底（按 id 前 8 位写的 hint 还能工作）。
 *
 * 与 eval 的差异只有一处：解析不到时**返回 null 并告警**，不抛错。理由是这个脚本的
 * 职责是"把能对齐的先对齐、把演示能跑起来"，一条 hint 对不上不该让 8 张工单都建不出来；
 * 而 eval 的职责恰恰相反 —— 期望文档对不上会让它算出假的命中率，必须当场停下。
 */
function resolveHint(hint: string, documents: DocRow[]): string | null {
  const byTitle = documents.find((doc) => doc.title === hint);
  if (byTitle !== undefined) return byTitle.id;

  const byFile = documents.find((doc) => {
    const base = doc.object_key.split("/").pop() ?? doc.object_key;
    return base.replace(/\.[^.]+$/, "") === hint;
  });
  if (byFile !== undefined) return byFile.id;

  const byId = documents.find((doc) => doc.id.startsWith(hint));
  if (byId !== undefined) return byId.id;

  return null;
}

/* ────────────────────────── 主流程 ────────────────────────── */

async function loadFixture(): Promise<GoldFixture> {
  if (!existsSync(FIXTURE_PATH)) {
    fail(`找不到评测夹具 ${FIXTURE_PATH}（它是仓库文件，不该缺失）`);
  }
  const raw = await readFile(FIXTURE_PATH, "utf8");
  return JSON.parse(raw) as GoldFixture;
}

/** 语料体检：空语料时演示毫无意义（检索全空、队列里的单也没法点开原文）。 */
async function assertCorpus(): Promise<{ documents: number; chunks: number }> {
  const rows = await query<{ documents: number; chunks: number }>(
    `select (select count(*) from documents)::int as documents,
            (select count(*) from chunks)::int    as chunks`,
  );
  const stat = rows[0] ?? { documents: 0, chunks: 0 };
  if (stat.documents === 0 || stat.chunks === 0) {
    process.stderr.write(
      `[demo] 语料为空：documents=${stat.documents}、chunks=${stat.chunks}。\n` +
        `[demo] 先跑 make ingest（本机没有 make 时：\n` +
        `[demo]   node --env-file-if-exists=.env scripts/ingest.ts corpus\n` +
        `[demo] ）—— 语料目录是 ${CORPUS_DIR}\n`,
    );
    process.exit(1);
  }
  return stat;
}

/**
 * 把 30 题（含反例题）的 `expect_doc_id` 落到 `qa_gold`。
 *
 * 幂等键是 `(lang, question)`：`qa_gold` 表没有唯一约束（`sql/001_init.sql` 第 12 节），
 * 所以"已存在就跳过"只能在脚本里判断。选这两个字段而不是自增 id：题面 + 语种是题目的
 * 业务身份，改一个字的题就是另一道题，重复插入没有意义。
 */
async function seedQaGold(fixture: GoldFixture): Promise<{ inserted: number; skipped: number; unresolved: string[] }> {
  const documents = await query<DocRow>("select id, title, object_key from documents");
  const existing = await query<{ lang: string; question: string }>("select lang, question from qa_gold");
  const seen = new Set(existing.map((row) => `${row.lang}\u0000${row.question}`));

  let inserted = 0;
  let skipped = 0;
  const unresolved: string[] = [];

  for (const item of fixture.items) {
    const key = `${item.lang}\u0000${item.question}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }

    let expectDocId: string | null = null;
    if (item.expect_doc_hint === FAULT_HINT) {
      // 故障码题的结构化语料在 fault_codes 表，没有 documents 行 —— 期望 id 留空
      // （NULL 是"这篇没有文档可指"，不是"解析失败"）。
    } else if (item.expect_doc_hint !== null) {
      expectDocId = resolveHint(item.expect_doc_hint, documents);
      if (expectDocId === null) unresolved.push(`${item.lang}/${item.expect_doc_hint}`);
    }

    await query(
      `insert into qa_gold (lang, question, expect_doc_id, expect_doc, should_refuse, note)
       values ($1, $2, $3::uuid, $4, $5, $6)`,
      [item.lang, item.question, expectDocId, item.expect_doc_hint, item.should_refuse, item.note ?? null],
    );
    seen.add(key);
    inserted += 1;
  }

  return { inserted, skipped, unresolved };
}

/** 已有多少张 demo 工单（幂等判据，与坐席端的 `tags @> '{demo}'` 同一条谓词）。 */
async function countDemoTickets(): Promise<number> {
  const rows = await query<{ n: number }>(
    "select count(*)::int as n from tickets where tags @> array[$1]::text[]",
    [DEMO_TAG],
  );
  return rows[0]?.n ?? 0;
}

/**
 * 插 8 张示例工单。
 *
 * 用一条 `insert ... values` 逐行参数化（而不是 8 条硬编码 SQL）：时间偏移都在
 * `make_interval(mins => ...)` 里算，SQL 文本里没有一个字面量时间，重复跑得到的相对
 * 时序完全一致。`status` / `closed_at` 显式写在 insert 里 —— `guard_ticket_status()`
 * 只挂在 UPDATE 上（closed 行不可再改），insert 直接把一行建成就绪状态是允许的。
 */
async function seedTickets(): Promise<number> {
  // 认领人 = `staff` 表里最早建的那个账号（张伟 `agent`）。演示时坐席端点"认领"，落到的是
  // 同一个人，队列里的名字才对得上。
  //
  // `role` 从库里**原样**取出交给 `updateTicket`（`09#03` 第三段起它要判派发权限）：
  // 认领（把单派给自己）在权限矩阵里 `agent` 就做得到，所以这里既不需要借一个 lead 身份，
  // 也不需要绕过判定。认不出的角色会被 core 按最低处理 —— 那正好是"只能认领自己"，
  // 与脚本真正做的动作一致。
  const staff = await query<{ id: string; name: string; role: string }>(
    "select id, name, role from staff where active order by created_at, id limit 1",
  );
  const principal: PatchPrincipal | null =
    staff[0] === undefined
      ? null
      : { staffId: staff[0].id, staffName: staff[0].name, role: staff[0].role as PatchPrincipal["role"] };

  let inserted = 0;
  for (const ticket of DEMO_TICKETS) {
    // 只有"claimed 样本"要绕一道真实认领；其余（open / closed）照旧直接建成目标状态。
    // `closed` 直插是允许的：`guard_ticket_status()` 只挂 UPDATE，而演示要的是"一小时前关的单"
    // （走 update 会把 `closed_at` 写成 now()，SLA 与"关单时间"就都对不上了）。
    const claimNow = ticket.status === "claimed" && principal !== null;
    if (ticket.status === "claimed" && principal === null) {
      // 没跑 `02_seed.sql`：降级为 open，绝不留一行"claimed 却没人"——那会让坐席端的
      // "认领"按钮语义错乱（看起来已认领，点开却不是任何人的单）。
      log("演示：staff 表为空，claimed 样本降级为 open（先跑 sql/002_seed.sql）");
    }
    const status = claimNow ? "open" : ticket.status;

    const row = await query<{ id: string }>(
      `insert into tickets
         (reason, question, requester, priority, status, assignee, tags, due_at, resolution, created_at, closed_at)
       values ($1, $2, $3, $4, $5, null, array[$6]::text[],
               now() + make_interval(mins => $7::int),
               $8,
               now() - make_interval(mins => $9::int),
               case when $5 = 'closed' then now() - make_interval(mins => $10::int) else null end)
       returning id`,
      [
        ticket.reason,
        ticket.question,
        ticket.requester,
        ticket.priority,
        status,
        DEMO_TAG,
        ticket.dueInMin,
        ticket.resolution ?? null,
        ticket.createdMinAgo,
        // 关闭时间取"创建后 1 小时"，永远早于 now()，也必早于任何一场演示
        Math.max(1, ticket.createdMinAgo - 60),
      ],
    );
    const id = Number(row[0]!.id);

    // 真实认领路径：`updateTicket` 会 ①把 `assignee` 落成"我"（默认坐席）②写一条 `audit_log`。
    // 这样队列里的"处理中"是产品能产生的状态，而不是演示脚本替产品编出来的（评审问的就是
    // "没有派发功能，为什么派给了李娜/张伟"）。
    if (claimNow && principal !== null) {
      await updateTicket({ id, patch: { status: "claimed" }, principal });
    }
    inserted += 1;
  }

  return inserted;
}

async function main(): Promise<void> {
  const corpus = await assertCorpus();
  log(`语料：documents=${corpus.documents}、chunks=${corpus.chunks}`);

  const fixture = await loadFixture();
  const gold = await seedQaGold(fixture);
  log(
    `qa_gold：新增 ${gold.inserted} 题、已有 ${gold.skipped} 题（夹具 version=${fixture.version}，共 ${fixture.items.length} 题）`,
  );
  if (gold.unresolved.length > 0) {
    // 空嵌入/缺文档才会走到这里。降级为告警：演示要能跑，但必须留痕。
    process.stderr.write(
      `[demo] 警告：${gold.unresolved.length} 条 expect_doc_hint 解析不到 documents.id（expect_doc_id 落空）：` +
        `${gold.unresolved.join(", ")} —— 检查是否少灌了语料\n`,
    );
  }

  const existing = await countDemoTickets();
  if (existing > 0) {
    log(`已存在 ${existing} 条 demo 工单，未重复插入（要重造先 make reset）`);
  } else {
    const inserted = await seedTickets();
    log(`新增 ${inserted} 条 demo 工单（tags 含 '${DEMO_TAG}'：open/claimed/closed × 四种 reason）`);
  }

  const final = await query<{ documents: number; chunks: number; demoTickets: number }>(
    `select (select count(*) from documents)::int as documents,
            (select count(*) from chunks)::int    as chunks,
            (select count(*) from tickets where tags @> array[$1]::text[])::int as "demoTickets"`,
    [DEMO_TAG],
  );
  const stat = final[0];
  if (stat === undefined) fail("汇总查询没有返回行（数据库状态异常）");

  log(
    `完成：documents=${stat.documents}、chunks=${stat.chunks}、demo 工单=${stat.demoTickets}。` +
      `下一步 node --env-file-if-exists=.env src/server.ts → http://127.0.0.1:8000/console`,
  );
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  fail(`执行失败：${message}`);
} finally {
  await pool.end().catch(() => undefined);
}
