/**
 * 30 题评测跑分（`08-i18n-eval-handoff` spec T10 · `14-verification.md` §4/§7 · `07-retrieval.md` §10）。
 *
 * 一条命令把"检索能用""拒答准得住"从形容词变成数字：逐题走**真实 HTTP 对话流**
 * （`POST /api/session` 取令牌 → `POST /api/chat` 消费 SSE 到 `done`），不直接调用
 * `retrieve()` 之类内部函数。为什么在进程内 `buildApp()` + `listen({ port: 0 })` 仍算真实链路：
 * 请求真的经过 Fastify 路由、鉴权、会话池、检索、引用校验、拒答判定与建单，和 `curl` 打
 * 8000 端口走的是同一条代码路径；差别只是监听端口由内核分配，好处是 `make eval` 一条命令
 * 就能跑，不必先手工起服务、也不会和正在跑的服务抢 8000。
 *
 * **夹具路径偏离 `14 §4` 的 `corpus/qa_gold.json`**：`src/core/ingest.ts` 会把 `corpus/` 下
 * 所有 `.json`（除 `fault_codes*.json`）当语料入库，放根下会让 `make ingest` 多出一篇
 * "评测题"文档（引用来源里出现自己的题集），甚至因为不是正文而入库失败。
 * `corpus/.fixtures/` 以 `.` 开头，ingest 会跳过 —— 这是仓库既有约定（该目录已经是夹具目录）。
 *
 * 用法：
 *   node --env-file-if-exists=.env scripts/eval.ts               # 30 题
 *   node --env-file-if-exists=.env scripts/eval.ts --multi       # 多轮 5 题（单独跑，不计入 30）
 *   node --env-file-if-exists=.env scripts/eval.ts --ids 1,4,21  # 只跑几题（排障）
 *   node --env-file-if-exists=.env scripts/eval.ts --min-docs 40 # 预检门槛（模拟未灌语料）
 *
 * 环境变量：
 *   EVAL_MIN_DOCS    预检要求的最小 `documents` 行数（默认 1；语料健康口径见 scripts/check-corpus.ts）
 *   LLM_PROVIDER / EMBED_BACKEND  与运行时同一套（见 src/config.ts）
 *
 * 退出码：
 *   0 = 跑完（**无论指标是否达标**；达标与否打印在指标行后面，处置顺序也打印在输出里）；
 *   1 = 跑不下去（未灌语料 / 夹具 hint 解析不到 / 建不出会话 / 任一题出现 error 帧）。
 * 为什么不达标不用退出码表达：不达标是有信息量的正常结果，它的处置顺序要人按 07 §10 逐条走，
 * 用退出码把它变成"红"只会让人第一反应去改提示词——那正是规格明令禁止的。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 夹具在 `.fixtures/` 下：以 `.` 开头的目录被 ingest 跳过（见文件头）。 */
const FIXTURE_PATH = join(repoRoot, "corpus", ".fixtures", "qa_gold.json");
/** 产出目录与规格一致（`08 §交付包`：评测报告放 docs/output/）。 */
const REPORT_DIR = join(repoRoot, "docs", "output");

/**
 * 门槛（`14 §7` 唯一口径）。写常量而不是命令行参数：能现场调阈值就等于没有阈值。
 */
const THRESHOLDS = {
  /** hit@5 ≥ 0.70：`07` 跨语种策略的最低证据。 */
  hit: 0.7,
  /**
   * 引用合法率 **= 1.00**：非法角标会整条降级为拒答（`06 §5.1` ④），
   * 所以它只能是 1；低于 1 说明后端校验失效，是 bug 不是指标波动。
   */
  cite: 1,
  /** 拒答准确率 ≥ 0.90：该拒答的题里输出固定话术**且**建单。 */
  refuse: 0.9,
  /** 误拒率 ≤ 0.10：正例题被误判为拒答的比例。 */
  falseRefuse: 0.1,
} as const;

/** 故障码题的结构化语料提示：`fault_codes` 表没有 documents 行，解析时走特例。 */
const FAULT_HINT = "fault";

/** `/api/chat` 单轮上限（`CHAT_TIMEOUT_MS` 默认 30s）+ 余量：卡住就报错，别让评测挂死。 */
const TURN_DEADLINE_MS = 60_000;

/** `/api/session` 限流命中（05 §3.1：同 IP 每分钟 10 次）时的等待窗口。 */
const RATE_LIMIT_WAIT_MS = 60_000;

/** 30 题各自一个独立会话（避免上一题的上下文污染下一题），池上限必须跟着抬。 */
const POSITIVE_POOL_HEADROOM = 2;

const KNOWN_LANGS = ["zh", "en", "de", "nl", "es"] as const;
type Lang = (typeof KNOWN_LANGS)[number];

/* ────────────────────────── 类型 ────────────────────────── */

type FixtureItem = {
  lang: Lang;
  question: string;
  /** `null` = 反例题（超纲，没有期望文档）。 */
  expect_doc_hint: string | null;
  should_refuse: boolean;
  note: string;
};

type FixtureMultiItem = {
  id: string;
  lang: Lang;
  steps: [string, string];
  expect_doc_hint: string | null;
  note: string;
};

type Fixture = { version: string; items: FixtureItem[]; multi_turn: FixtureMultiItem[] };

type CitationEntry = {
  idx: number;
  doc_title: string;
  page: number | null;
  snippet: string;
  doc_lang: string;
};

/** 一帧 SSE 的语义化结果：只留判定要用的字段，帧本身不落库。 */
type TurnOutcome = {
  convId: string;
  messageId: number;
  delta: string;
  tools: string[];
  citations: CitationEntry[];
  refusal: { ticket_no: string } | null;
  error: { code: string; message: string } | null;
  done: { latency_ms: number; tokens: number; cost_usd: number } | null;
};

type ItemResult = {
  n: number;
  lang: Lang;
  question: string;
  expectHint: string | null;
  expectDocIds: string[];
  /** 引用到的文档 id（按 `doc_title` 回查 documents；解析不到的不进这个集合）。 */
  citedDocIds: string[];
  /** 引用条目逐条的合法性（标题能回查、idx ∈ 1..5、snippet 非空）。 */
  citeLegal: boolean[];
  hit: boolean;
  refused: boolean;
  /** 本轮前后该会话的工单数差 = 1（拒答必须建单）。 */
  ticketCreated: boolean;
  /** 故障码题专用：本轮是否用过 `fault_code_lookup` 或走过故障码快路。 */
  faultLookup: boolean;
  tools: string[];
  latencyMs: number;
  convId: string;
  note: string;
};

type MultiStep = {
  text: string;
  hit: boolean;
  refused: boolean;
  ticketCreated: boolean;
  citedDocIds: string[];
  citeLegal: boolean[];
  latencyMs: number;
};

type MultiResult = {
  id: string;
  lang: Lang;
  steps: MultiStep[];
  expectHint: string | null;
  expectDocIds: string[];
  note: string;
  convId: string;
  hit: boolean;
};

type DocRow = { id: string; title: string; object_key: string; lang: string };

/** 判定不通过时抛这个：它是"跑不下去"，不是"指标不好"。 */
class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalError";
  }
}

/* ────────────────────────── 参数 ────────────────────────── */

type Args = { multi: boolean; ids: number[] | null; minDocs: number | null; help: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { multi: false, ids: null, minDocs: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--multi":
        args.multi = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--ids": {
        const raw = argv[i + 1] ?? "";
        i += 1;
        const ids = raw
          .split(",")
          .map((part) => Number(part.trim()))
          .filter((n) => Number.isInteger(n) && n > 0);
        if (ids.length === 0) throw new EvalError("--ids 需要逗号分隔的题号，例如 --ids 1,4,21");
        args.ids = ids;
        break;
      }
      case "--min-docs": {
        const raw = argv[i + 1] ?? "";
        i += 1;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) throw new EvalError("--min-docs 需要一个非负整数");
        args.minDocs = n;
        break;
      }
      default:
        throw new EvalError(`未知参数：${arg}（--help 看用法）`);
    }
  }
  return args;
}

/* ────────────────────────── .env ────────────────────────── */

/**
 * 与 `tests/chat-stream.test.ts` 同一套解析：行内 `#` 之后是注释、成对引号去掉。
 *
 * `node --env-file-if-exists=.env` 已经会灌一遍，这里再解析一次是为了支持
 * `node scripts/eval.ts`（不带 --env-file）也能跑。已存在的变量不覆盖：
 * 命令行/CI 显式传入的 `LLM_PROVIDER=mock` 必须赢过 .env。
 */
async function loadDotEnv(): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, ".env"), "utf8");
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1] as string;
    const value = (match[2] as string).replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "") env[key] = value;
  }
  return env;
}

/**
 * 模型可用性预检 —— 只改**本进程**的 env，不碰配置与服务端。
 *
 * `LLM_PROVIDER=deepseek` 但缺 `DEEPSEEK_API_KEY` 时，每一题都会以 `error` 帧收尾
 * （`core/agent.ts` 的 `liveTurn` 在 prompt 阶段失败），跑分就变成"全链路不可用"的证明，
 * 而不是检索/拒答的证明。评测的目的是后者，所以这里降级成 mock，并把原因大声打出来：
 * mock 路径**照样真跑检索**（`kbSearch()`），拒答判定也是真的（`core/refusal.ts`）。
 *
 * 不静默降级：输出里写明原 provider 与缺失的 key 名（只打名字，绝不打值）。
 */
function applyLlmProviderGuard(): { provider: string; note: string } {
  const provider = (process.env.LLM_PROVIDER ?? "deepseek").trim() || "deepseek";
  if (provider === "mock") return { provider: "mock", note: "LLM_PROVIDER=mock，不调模型，正文由检索结果拼出" };
  const keyByProvider: Record<string, string> = {
    deepseek: "DEEPSEEK_API_KEY",
    openai: "OPENAI_API_KEY",
    dashscope: "DASHSCOPE_API_KEY",
  };
  const keyName = keyByProvider[provider];
  // 不在表里的 provider 走 Pi 自己的凭据库（`~/.pi/agent/auth.json`），不猜它缺什么。
  if (keyName === undefined) return { provider, note: "" };
  const hasKey = (process.env[keyName] ?? "").trim() !== "";
  if (hasKey) return { provider, note: "" };

  process.env.LLM_PROVIDER = "mock";
  const note = `LLM_PROVIDER=${provider} 但缺少 ${keyName}，脚本已降级为 mock`;
  process.stdout.write(
    `[eval] 模型：mock（${note}；` +
      `不降级的话每题只会出 error 帧，跑分没有意义。mock 仍然真跑检索与拒答判定）\n`,
  );
  return { provider: "mock", note };
}

/**
 * 会话池上限必须 ≥ 本次题数。
 *
 * 池上限数的是"同时在册的会话数"（`core/agent.ts` 的 `acquire`），而评测**每题一个独立会话**
 * （不复用会话，避免上一题的历史污染下一题的指代与检索）。用默认 5 的话第 6 题起就是 503。
 */
function raiseParallelLimit(turns: number): void {
  const needed = turns + POSITIVE_POOL_HEADROOM;
  const current = Number(process.env.PARALLEL_LIMIT ?? "5");
  if (Number.isFinite(current) && current >= needed) return;
  process.env.PARALLEL_LIMIT = String(needed);
}

/* ────────────────────────── SSE ────────────────────────── */

function parseFrame(raw: string): { event: string; data: unknown } | null {
  let event = "";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice("event: ".length);
    else if (line.startsWith("data: ")) dataLines.push(line.slice("data: ".length));
  }
  if (event === "" || dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  try {
    return { event, data: JSON.parse(payload) as unknown };
  } catch {
    throw new EvalError(`SSE 帧不是合法 JSON：${payload.slice(0, 200)}`);
  }
}

/**
 * 消费一条 SSE 到流关闭，把帧语义化。
 *
 * 逐块读（`reader.read()`）而不是 `await res.text()`：后者的语义是"等流结束"，
 * 一旦服务端不 close，评测就挂在这里；逐块也顺便证明了"事件是逐帧到达的"。
 */
async function postChat(
  baseUrl: string,
  token: string,
  body: { text: string; lang: Lang; conv_id?: string },
): Promise<TurnOutcome> {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-session": token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TURN_DEADLINE_MS),
  });
  if (response.status !== 200) {
    const text = await response.text();
    throw new EvalError(`/api/chat 返回 HTTP ${response.status}（${body.lang}）：${text.slice(0, 300)}`);
  }
  if (response.body === null) throw new EvalError("/api/chat 没有响应体");

  const outcome: TurnOutcome = {
    convId: "",
    messageId: 0,
    delta: "",
    tools: [],
    citations: [],
    refusal: null,
    error: null,
    done: null,
  };

  const handle = (frame: { event: string; data: unknown }): void => {
    const data = frame.data as Record<string, unknown>;
    switch (frame.event) {
      case "meta":
        outcome.convId = String(data.conv_id ?? "");
        outcome.messageId = Number(data.message_id ?? 0);
        return;
      case "delta":
        outcome.delta += typeof data.t === "string" ? data.t : "";
        return;
      case "tool":
        if (typeof data.name === "string") outcome.tools.push(data.name);
        return;
      case "citations":
        if (Array.isArray(frame.data)) outcome.citations.push(...(frame.data as CitationEntry[]));
        return;
      case "refusal":
        outcome.refusal = { ticket_no: String(data.ticket_no ?? "") };
        return;
      case "error":
        outcome.error = { code: String(data.code ?? "UNKNOWN"), message: String(data.message ?? "") };
        return;
      case "done":
        outcome.done = {
          latency_ms: Number(data.latency_ms ?? 0),
          tokens: Number(data.tokens ?? 0),
          cost_usd: Number(data.cost_usd ?? 0),
        };
        return;
      default:
        // 未知事件不抛：协议可能加帧，评测不该因此全红（判定只读上面几种）。
        return;
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const frame = parseFrame(raw);
      if (frame !== null) handle(frame);
      boundary = buffer.indexOf("\n\n");
    }
  }
  // 末尾可能没有补空的 `\n\n`（服务端正常 end 时不会有，但不假设）
  const tail = parseFrame(buffer);
  if (tail !== null) handle(tail);

  if (outcome.convId === "") throw new EvalError("SSE 没有 meta 帧：拿不到 conv_id");
  if (outcome.error !== null) {
    throw new EvalError(
      `本轮出现 error 帧（${body.lang} ${body.text.slice(0, 40)}）：` +
        `${outcome.error.code} ${outcome.error.message}`,
    );
  }
  if (outcome.done === null) throw new EvalError("SSE 没有 done 帧：事件流没有正常收尾");
  return outcome;
}

/**
 * 取匿名令牌（唯一一次 `/api/session` 调用）。
 *
 * 一个令牌可以开任意多个会话（`/api/chat` 不带 conv_id 就是新会话），所以 30 题只需要
 * 一次签发 —— 也顺带避开了"同 IP 每分钟 10 次"的限流。命中 429 时按 05 §6 的语义
 * 等一个窗口再试：那是共享限流键，不能把它当成本次评测的失败。
 */
async function issueToken(baseUrl: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/session`, { method: "POST" });
    if (response.status === 200) {
      const payload = (await response.json()) as { ok: boolean; data?: { token?: string } };
      const token = payload.data?.token ?? "";
      if (!token) throw new EvalError("/api/session 返回里没有 data.token");
      return token;
    }
    if (response.status === 429) {
      process.stdout.write(
        `[eval] /api/session 限流（429，同 IP 10 次/分钟）：等 ${RATE_LIMIT_WAIT_MS / 1000}s 后重试\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
      continue;
    }
    const text = await response.text();
    throw new EvalError(`/api/session 返回 HTTP ${response.status}：${text.slice(0, 300)}`);
  }
  throw new EvalError("/api/session 连续 429：限流键被其它进程占满，稍后再跑");
}

/* ────────────────────────── 数据库 ────────────────────────── */

type Db = {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
};

async function loadDocuments(db: Db): Promise<DocRow[]> {
  return await db.query<DocRow>("select id, title, object_key, lang from documents order by title");
}

/**
 * `expect_doc_hint` → `documents.id`。
 *
 * 解析顺序（规格要求"不能静默当成没命中"）：
 *   1. `documents.title` 全等（当前语料里 title 就是文件名去扩展名，如 `warranty.de`）；
 *   2. `object_key` 去扩展名后的文件名兜底（`warranty.de.md` → `warranty.de`）；
 *   3. `documents.id` 前缀兜底（按 id 前 8 位引用文档时还能工作）。
 * 三条都不中 → 抛 EvalError，由调用方打印"是哪条 hint"并以 1 退出。
 */
function resolveHint(hint: string, documents: DocRow[]): string {
  if (hint === FAULT_HINT) return FAULT_HINT;

  const byTitle = documents.find((doc) => doc.title === hint);
  if (byTitle !== undefined) return byTitle.id;

  const byFile = documents.find((doc) => {
    const base = doc.object_key.split("/").pop() ?? doc.object_key;
    return base.replace(/\.[^.]+$/, "") === hint;
  });
  if (byFile !== undefined) return byFile.id;

  const byId = documents.find((doc) => doc.id.startsWith(hint));
  if (byId !== undefined) return byId.id;

  throw new EvalError(
    `期望文档提示解析不到 documents.id：hint="${hint}"。` +
      `现有文档：${documents.map((doc) => doc.title).join(",") || "（空表）"}`,
  );
}

/** 该会话当前工单数。用会话维度而不是全表计数：库是和其它进程共享的，全局差值会被别人改动污染。 */
async function ticketCount(db: Db, convId: string): Promise<number> {
  const rows = await db.query<{ n: number }>(
    "select count(*)::int as n from tickets where conv_id = $1::uuid",
    [convId],
  );
  return rows[0]?.n ?? 0;
}

/* ────────────────────────── 单题 ────────────────────────── */

/** 引用条目 → 合法判定。标题能回查 documents、编号落在 top5 区间、片段非空，三者缺一即非法。 */
function citationLegality(entry: CitationEntry, docIdsByTitle: Map<string, string>): boolean {
  const titleKnown = docIdsByTitle.has(entry.doc_title);
  const idxSane = Number.isInteger(entry.idx) && entry.idx >= 1 && entry.idx <= 5;
  const snippetNonEmpty = typeof entry.snippet === "string" && entry.snippet.trim() !== "";
  return titleKnown && idxSane && snippetNonEmpty;
}

/**
 * 引用帧 → `documents.id` 集合。
 *
 * `05 §3.2` 的 `citations` 帧**不带 `doc_id`**（只带 `idx/doc_title/page/snippet/doc_lang`），
 * 所以这里用 `doc_title` 回查 documents 拿到 id —— 仍然只读真实对话流下发的字段，
 * 没有绕到 `retrieve()` 内部。标题解析不到的条目不计入（并在合法性里记一笔非法）。
 */
function citedDocIdsOf(
  citations: CitationEntry[],
  docIdsByTitle: Map<string, string>,
): string[] {
  const ids = new Set<string>();
  for (const entry of citations) {
    const id = docIdsByTitle.get(entry.doc_title);
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

/**
 * 五语的快路尾行（`src/static/i18n.json` 的 `fault.source`）。
 *
 * 直接读那份 JSON，而不是 import `src/core/i18n-table.ts`：本脚本的一条设计红线是"只用 node
 * 内置，不把 src 的模块图拉进来"（否则跑分要连带 `config.ts` 的 `.env` 校验一起起）。文件本身
 * 就是文案的唯一真源，读它就够。读不到时返回空数组 —— 判据退化成"tool 事件"，并明确警告，
 * 绝不静默当成命中。
 */
async function loadFaultSources(): Promise<string[]> {
  const tablePath = join(repoRoot, "src", "static", "i18n.json");
  try {
    const table = JSON.parse(await readFile(tablePath, "utf8")) as Record<string, Record<string, string>>;
    const lines = Object.values(table)
      .map((messages) => messages["fault.source"])
      .filter((line): line is string => typeof line === "string" && line.trim() !== "");
    return [...new Set(lines)];
  } catch (err) {
    process.stderr.write(
      `[eval] 警告：读不到文案表 ${tablePath}（${err instanceof Error ? err.message : String(err)}），` +
        `故障码题的快路判据退化为 tool 事件\n`,
    );
    return [];
  }
}

/**
 * 跑分依赖。`faultSources` 是**五语**的快路尾行（`src/static/i18n.json` 的 `fault.source`）：
 * 故障码题是否走了快路，不能只比对中文那一行 —— `07#02` 已把快路尾行改成按请求语种下发
 * （德语 `Quelle: Fehlercodetabelle`），只认中文字面量会把一道德语裸故障码题误判成"没走快路"。
 */
type RunDeps = {
  baseUrl: string;
  token: string;
  db: Db;
  docIdsByTitle: Map<string, string>;
  faultSources: string[];
};

async function runGoldItem(
  item: FixtureItem,
  n: number,
  expectHintResolved: string | null,
  deps: RunDeps,
): Promise<ItemResult> {
  const outcome = await postChat(deps.baseUrl, deps.token, { text: item.question, lang: item.lang });

  const expectDocIds =
    expectHintResolved !== null && expectHintResolved !== FAULT_HINT ? [expectHintResolved] : [];
  const citedDocIds = citedDocIdsOf(outcome.citations, deps.docIdsByTitle);
  const citeLegal = outcome.citations.map((entry) => citationLegality(entry, deps.docIdsByTitle));

  // 拒答的工单是"本轮建单"：会话是这道题刚建的，所以会话内工单数就是本轮的增量。
  const tickets = await ticketCount(deps.db, outcome.convId);

  // 故障码题（hint=fault）没有 documents 行：命中只能靠结构化语料那条路
  // （快路的固定尾行，或真实模型调 `fault_code_lookup` 的 tool 事件）。
  // 它**不计入** hit@5 的分子 —— hit@5 的口径是"引用到的 doc_id ∈ 期望文档集合"。
  //
  // 尾行按语种下发，所以要拿 `deps.faultSources`（五语）比对，而不是写死中文那一行。
  const faultLookup =
    outcome.tools.includes("fault_code_lookup") ||
    deps.faultSources.some((line) => outcome.delta.includes(line));

  const hit = expectDocIds.length > 0 && citedDocIds.some((id) => expectDocIds.includes(id));

  return {
    n,
    lang: item.lang,
    question: item.question,
    expectHint: item.expect_doc_hint,
    expectDocIds,
    citedDocIds,
    citeLegal,
    hit,
    refused: outcome.refusal !== null,
    ticketCreated: tickets > 0,
    faultLookup,
    tools: outcome.tools,
    latencyMs: outcome.done?.latency_ms ?? 0,
    convId: outcome.convId,
    note: item.note,
  };
}

/** 多轮：只有第二问参与命中判定（第一问是上下文），两问的拒答/建单都如实记录。 */
async function runMultiItem(
  item: FixtureMultiItem,
  expectHintResolved: string | null,
  deps: RunDeps,
): Promise<MultiResult> {
  const expectDocIds =
    expectHintResolved !== null && expectHintResolved !== FAULT_HINT ? [expectHintResolved] : [];
  const steps: MultiStep[] = [];
  let convId = "";

  for (const [index, text] of item.steps.entries()) {
    const before = index === 0 ? 0 : await ticketCount(deps.db, convId);
    const outcome = await postChat(deps.baseUrl, deps.token, {
      text,
      lang: item.lang,
      ...(index === 0 ? {} : { conv_id: convId }),
    });
    convId = outcome.convId;
    const after = await ticketCount(deps.db, convId);
    const citedDocIds = citedDocIdsOf(outcome.citations, deps.docIdsByTitle);
    steps.push({
      text,
      hit: expectDocIds.length > 0 && citedDocIds.some((id) => expectDocIds.includes(id)),
      refused: outcome.refusal !== null,
      ticketCreated: after > before,
      citedDocIds,
      citeLegal: outcome.citations.map((entry) => citationLegality(entry, deps.docIdsByTitle)),
      latencyMs: outcome.done?.latency_ms ?? 0,
    });
  }

  const last = steps.at(-1);
  return {
    id: item.id,
    lang: item.lang,
    steps,
    expectHint: item.expect_doc_hint,
    expectDocIds,
    note: item.note,
    convId,
    hit: last?.hit ?? false,
  };
}

/* ────────────────────────── 指标与输出 ────────────────────────── */

type Metrics = {
  /** hit@5 / 误拒率的分母：**有文档期望**的正例题（20 道正例里的 4 道故障码题单列，见下）。 */
  positives: number;
  hit: number;
  hitRate: number;
  citedItems: number;
  citeOkItems: number;
  citeRate: number;
  negatives: number;
  refuseOk: number;
  refuseRate: number;
  falseRefusals: number;
  falseRefuseRate: number;
  /** 故障码题（hint=fault）：结构化语料，没有 documents 行，单独报，不进上面两个比率。 */
  faultItems: number;
  faultHits: number;
  /** 把故障码题也算进误拒率时的分子/分母（透明口径：报告里两个数都写）。 */
  falseRefusalsAll: number;
  positivesAll: number;
};

/**
 * 指标口径（唯一一份，报告与输出共用）。
 *
 * 两处分母必须写清楚，否则会被读成"挑好看的数"：
 *   - **hit@5** 的分母是**有期望文档**的正例题：`expect_doc_id` 为空的题在 PRD 的 SQL 口径里
 *     永远不会等于任何 doc_id（NULL 比较），把它们算进分母等于用"没有答案的题"拉低命中率。
 *   - **故障码题**（hint=`fault`）的期望来源是 `fault_codes` 表。它们不是文档检索题，
 *     所以既不在 hit@5 的分子/分母里，也不在误拒率的分母里；它们的证据单列
 *     （「故障码路命中 n/4」）。同时把"若计入误拒率"的分子分母也算出来，报告里两个数都写，
 *     不让人需要自己猜口径。
 */
function computeMetrics(results: ItemResult[]): Metrics {
  // 正/反例的判据只有一个：题集里有没有期望文档提示（`14 §4.2` 的反例那一列写的是「—」）。
  // 不用「有没有拒答」反推 —— 那会把误拒当成反例，正好把要测的东西抹掉。
  const positiveItems = results.filter((item) => item.expectHint !== null);
  const negativeItems = results.filter((item) => item.expectHint === null);
  const docPositiveItems = positiveItems.filter((item) => item.expectDocIds.length > 0);
  const faultItems = positiveItems.filter((item) => item.expectHint === FAULT_HINT);

  const hit = docPositiveItems.filter((item) => item.hit).length;
  const citedItems = results.filter((item) => item.citeLegal.length > 0);
  const citeOkItems = citedItems.filter((item) => item.citeLegal.every(Boolean)).length;
  const refuseOk = negativeItems.filter((item) => item.refused && item.ticketCreated).length;
  const falseRefusals = docPositiveItems.filter((item) => item.refused).length;

  return {
    positives: docPositiveItems.length,
    hit,
    hitRate: docPositiveItems.length === 0 ? 0 : hit / docPositiveItems.length,
    citedItems: citedItems.length,
    citeOkItems,
    // 全部题都拒答时没有任何引用条目：按不变量记 1.00，并在输出里注明「无引用事件」。
    citeRate: citedItems.length === 0 ? 1 : citeOkItems / citedItems.length,
    negatives: negativeItems.length,
    refuseOk,
    refuseRate: negativeItems.length === 0 ? 0 : refuseOk / negativeItems.length,
    falseRefusals,
    falseRefuseRate: docPositiveItems.length === 0 ? 0 : falseRefusals / docPositiveItems.length,
    faultItems: faultItems.length,
    faultHits: faultItems.filter((item) => item.faultLookup).length,
    falseRefusalsAll: positiveItems.filter((item) => item.refused).length,
    positivesAll: positiveItems.length,
  };
}

function verdict(ok: boolean): string {
  return ok ? "达标" : "未达标";
}

function percentPair(numerator: number, denominator: number): string {
  return `${numerator}/${denominator}`;
}

function printMetrics(metrics: Metrics, title: string): boolean {
  const hitOk = metrics.hitRate >= THRESHOLDS.hit;
  const citeOk = metrics.citeRate >= THRESHOLDS.cite;
  const refuseOk = metrics.refuseRate >= THRESHOLDS.refuse;
  const falseRefuseOk = metrics.falseRefuseRate <= THRESHOLDS.falseRefuse;

  process.stdout.write(
    `[eval] ${title}\n` +
      `[eval] hit@5        ${metrics.hitRate.toFixed(4)}  (${percentPair(metrics.hit, metrics.positives)} 文档正例)  ` +
      `门槛 ≥${THRESHOLDS.hit.toFixed(2)}  ${verdict(hitOk)}\n` +
      `[eval] 引用合法率   ${metrics.citeRate.toFixed(4)}  (${percentPair(metrics.citeOkItems, metrics.citedItems)} 有引用的题` +
      `${metrics.citedItems === 0 ? "；无引用事件，按不变量记 1.00" : ""})  ` +
      `门槛 =${THRESHOLDS.cite.toFixed(2)}  ${verdict(citeOk)}\n` +
      `[eval] 拒答准确率   ${metrics.refuseRate.toFixed(4)}  (${percentPair(metrics.refuseOk, metrics.negatives)} 反例)  ` +
      `门槛 ≥${THRESHOLDS.refuse.toFixed(2)}  ${verdict(refuseOk)}\n` +
      `[eval] 误拒率       ${metrics.falseRefuseRate.toFixed(4)}  (${percentPair(metrics.falseRefusals, metrics.positives)} 文档正例)  ` +
      `门槛 ≤${THRESHOLDS.falseRefuse.toFixed(2)}  ${verdict(falseRefuseOk)}\n`,
  );
  return hitOk && citeOk && refuseOk && falseRefuseOk;
}

/**
 * 不达标时的处置顺序（`07 §10` / `14 §7`）。**禁止**改提示词掩盖：
 * 提示词不是检索质量的变量，改它只会把"检索坏了"变成"模型答得更像样"，指标原地不动而证据消失。
 */
function printRemediation(): void {
  process.stdout.write(
    "[eval] 指标未达标。处置顺序（逐条走，连续两轮调参无改善就停下）：\n" +
      "  1) 语言过滤：先确认 LANG_SCOPE 覆盖了该语种（07 §2）；漏了 lang 的召回是「看起来分数低」，其实是查错了范围\n" +
      "  2) 归一化：确认阈值比较用的是 07 §5.2 的融合分（归一化 RRF × 余弦²），不是 RRF 原始分、也不是单独归一化的 RRF\n" +
      "  3) 候选数：VECTOR_CANDIDATES / FTS_CANDIDATES（20 → 40）是否太小；top5 是否被同一文档占满（per doc ≤3）\n" +
      "  4) 权重：RETRIEVAL_FTS_WEIGHT 0.2 → 0.35（型号/故障码这类精确术语召不回时）\n" +
      "  5) 阈值：RETRIEVAL_MIN_SCORE（拒答过多降到 0.22；该拒答却答了提到 0.38）\n" +
      "  连续两轮调参无改善 → 停止调参，回到 07 §11 的自检用例判断是检索坏了还是评测集标注错了。\n" +
      "  **禁止**改 SUPPORT_SYSTEM_PROMPT / 提示词或放宽引用校验来「凑」指标。\n",
  );
}

/* ────────────────────────── 报告 ────────────────────────── */

function stamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function isoNow(): string {
  return new Date().toISOString();
}

/** markdown 表格里的 `|` 与换行必须转义，否则一条问题就能把表拆掉。 */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function yesNo(value: boolean): string {
  return value ? "是" : "否";
}

function renderGoldReport(input: {
  fixtureVersion: string;
  llm: string;
  /** 模型选择的原因（例如"缺 key 已降级为 mock"）：写进报告，避免读者以为 mock 是手工挑的。 */
  llmNote: string;
  embed: string;
  minDocs: number;
  metrics: Metrics;
  results: ItemResult[];
  runId: string | null;
}): string {
  const { metrics, results } = input;
  const allFalseRefuseRate =
    metrics.positivesAll === 0 ? 0 : metrics.falseRefusalsAll / metrics.positivesAll;
  const rows = results.map((item) => {
    const expect = item.expectHint === null ? "—" : item.expectHint;
    const cite = item.citeLegal.length === 0
      ? "无引用"
      : `${item.citeLegal.filter(Boolean).length}/${item.citeLegal.length} 合法`;
    const fault = item.expectHint === FAULT_HINT
      ? `故障码工具=${yesNo(item.faultLookup)}`
      : "";
    const note = [item.note, fault].filter((part) => part !== "").join("；");
    return `| ${item.n} | ${item.lang} | ${cell(item.question)} | ${cell(expect)} | ${yesNo(item.hit)} | ${cite} | ${yesNo(item.refused)} | ${yesNo(item.ticketCreated)} | ${cell(note)} |`;
  });

  const lines = [
    `# 评测报告 · ${results.length} 题（${isoNow()}）`,
    "",
    `- 夹具：\`corpus/.fixtures/qa_gold.json\`（version ${input.fixtureVersion}）`,
    `- 模型：\`${input.llm}\`${input.llmNote === "" ? "" : `（${input.llmNote}）`}；嵌入：\`${input.embed}\``,
    `- 预检：documents ≥ ${input.minDocs}`,
    `- 结果行：${input.runId === null ? "未写入 eval_runs" : `\`eval_runs.id = ${input.runId}\``}`,
    "",
    "## 指标",
    "",
    "| 指标 | 实测 | 门槛 | 判定 |",
    "|---|---|---|---|",
    `| hit@5 | ${metrics.hitRate.toFixed(4)}（${metrics.hit}/${metrics.positives} 文档正例） | ≥ ${THRESHOLDS.hit.toFixed(2)} | ${verdict(metrics.hitRate >= THRESHOLDS.hit)} |`,
    `| 引用合法率 | ${metrics.citeRate.toFixed(4)}（${metrics.citeOkItems}/${metrics.citedItems} 有引用的题） | = ${THRESHOLDS.cite.toFixed(2)} | ${verdict(metrics.citeRate >= THRESHOLDS.cite)} |`,
    `| 拒答准确率 | ${metrics.refuseRate.toFixed(4)}（${metrics.refuseOk}/${metrics.negatives} 反例） | ≥ ${THRESHOLDS.refuse.toFixed(2)} | ${verdict(metrics.refuseRate >= THRESHOLDS.refuse)} |`,
    `| 误拒率 | ${metrics.falseRefuseRate.toFixed(4)}（${metrics.falseRefusals}/${metrics.positives} 文档正例） | ≤ ${THRESHOLDS.falseRefuse.toFixed(2)} | ${verdict(metrics.falseRefuseRate <= THRESHOLDS.falseRefuse)} |`,
    ...(metrics.faultItems === 0
      ? []
      : [
          `| 误拒率（透明口径：含 ${metrics.faultItems} 题故障码） | ${allFalseRefuseRate.toFixed(4)}（${metrics.falseRefusalsAll}/${metrics.positivesAll} 正例） | ≤ ${THRESHOLDS.falseRefuse.toFixed(2)} | ${verdict(allFalseRefuseRate <= THRESHOLDS.falseRefuse)} |`,
        ]),
    "",
    "## 口径",
    "",
    "- **hit@5**：正例题里「引用事件中的 `doc_id` ∈ 期望文档集合」的占比。引用事件是 `kb_search` 候选集的子集",
    "  （05 §3.2：只下发正文实际引用到的片段），所以这是 hit@5 的保守下界，不是候选集的直接测量。",
    `  分母是**有文档期望**的正例题（${metrics.positives} 道）：没有 \`expect_doc_id\` 的题在 PRD 的 SQL 口径里永远不可能等于任何 doc_id。`,
    `- **故障码题**（hint=\`fault\`，共 ${metrics.faultItems} 题）：期望来源是 \`fault_codes\` 表，没有 documents 行，`,
    "  **单独报**（「故障码路命中 n/m」：快路尾行（按语种取 `fault.source`，五语任一）或真实模型调用 `fault_code_lookup`），",
    `  不进 hit@5 / 误拒率的分子分母。透明口径：若把这 ${metrics.faultItems} 题也当成「不该拒答」，误拒率为 ` +
      `${allFalseRefuseRate.toFixed(4)}（${metrics.falseRefusalsAll}/${metrics.positivesAll}）` +
      "——mock 只调 `kb_search`，不调 `fault_code_lookup`，这是已知缺口（见工单 Comments）。",
    "- **引用合法率**：每题引用条目逐条校验（标题能回查 documents、`idx ∈ 1..5`、片段非空），分母是「有引用事件的题」；",
    "  一道题只要有一条非法引用即整题不合法。它是开关不是指标：低于 1 说明后端校验失效。",
    "- **拒答准确率**：反例题里「出现 refusal 事件」且「该会话工单数 +1」的占比（固定话术前端替换，建单是后端动作）。",
    `- **误拒率**：有文档期望的正例题（${metrics.positives} 道）里出现 refusal 事件的占比。`,
    "",
    "## 题号级明细",
    "",
    "| 题号 | 语种 | 问题 | 期望文档 | 命中 | 引用 | 拒答 | 建单 | 备注 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ];
  return lines.join("\n");
}

function renderMultiReport(input: {
  fixtureVersion: string;
  llm: string;
  llmNote: string;
  embed: string;
  results: MultiResult[];
}): string {
  const rows = input.results.map((item) => {
    const steps = item.steps.map(
      (step, index) =>
        `第${index + 1}问 ${cell(step.text)} → 命中=${yesNo(step.hit)} 拒答=${yesNo(step.refused)} ` +
        `建单=${yesNo(step.ticketCreated)} 引用=${step.citedDocIds.length}`,
    );
    return `| ${item.id} | ${item.lang} | ${cell(item.note)} | ${cell(item.expectHint ?? "—")} | ${steps.join("<br>")} | ${yesNo(item.hit)} |`;
  });
  const hits = input.results.filter((item) => item.hit).length;
  return [
    `# 评测报告 · 多轮指代 5 题（${isoNow()}）`,
    "",
    `- 夹具：\`corpus/.fixtures/qa_gold.json\`（version ${input.fixtureVersion}，\`multi_turn\`）`,
    `- 模型：\`${input.llm}\`${input.llmNote === "" ? "" : `（${input.llmNote}）`}；嵌入：\`${input.embed}\``,
    "- 本组**不计入** 30 题、不写 `eval_runs`：它是「指代拼接有没有生效」的独立证据，不是 hit@5 的分母。",
    `- 第二问命中：${hits}/${input.results.length}（本组不设门槛，只作证据）。`,
    "- 已知边界：mock 路径的 `kbSearch()` 不接收上一轮用户问题（`retrieve()` 的 `prevUser` 只有",
    "  `/internal/search` 传），所以 07 §3 的拼接规则在 mock 对话里**不生效**；真实模型靠会话历史",
    "  自己带上下文时才会体现。1/5 这个数字就是这条边的证据，不是检索公式坏了。",
    "",
    "| 用例 | 语种 | 考察 | 期望文档 | 两问结果 | 第二问命中 |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/* ────────────────────────── 主流程 ────────────────────────── */

/** 只把对外要用的导出留着：测试以子进程方式跑本脚本，不 import 它。 */
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "用法: node --env-file-if-exists=.env scripts/eval.ts [--multi] [--ids 1,4,21] [--min-docs N]\n",
    );
    return 0;
  }

  const dotenv = await loadDotEnv();
  for (const [key, value] of Object.entries(dotenv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as Fixture;
  if (!Array.isArray(fixture.items) || fixture.items.length !== 30) {
    throw new EvalError(
      `夹具损坏：items 必须是 30 条（14 §4.2 的权威口径），实际 ${fixture.items?.length ?? "?"} 条`,
    );
  }
  if (!Array.isArray(fixture.multi_turn) || fixture.multi_turn.length !== 5) {
    throw new EvalError(`夹具损坏：multi_turn 必须是 5 条（14 §4.3），实际 ${fixture.multi_turn?.length ?? "?"} 条`);
  }
  for (const item of fixture.items) {
    if (!(KNOWN_LANGS as readonly string[]).includes(item.lang)) {
      throw new EvalError(`夹具损坏：未知语种 ${String(item.lang)}（${item.question}）`);
    }
    // 正/反例的判据是 expect_doc_hint 是否为空（computeMetrics 也这么分）。
    // 两个字段自相矛盾时立刻停下：否则一条标错的题会静默地把误拒率算进反例，指标失真还没人知道。
    if (item.should_refuse !== (item.expect_doc_hint === null)) {
      throw new EvalError(
        `夹具标注矛盾：「${item.question}」的 should_refuse=${String(item.should_refuse)} ` +
          `与 expect_doc_hint=${JSON.stringify(item.expect_doc_hint)} 不一致`,
      );
    }
  }
  for (const item of fixture.multi_turn) {
    if (item.steps.length !== 2) throw new EvalError(`夹具损坏：${item.id} 必须恰好两步问`);
  }

  const selected = args.ids === null
    ? fixture.items
    : fixture.items.filter((_, index) => args.ids?.includes(index + 1));
  if (selected.length === 0) throw new EvalError(`--ids 没有匹配到任何题：${args.ids?.join(",") ?? ""}`);
  // 多轮的 hint 总是解析：`--multi --ids 1` 这种组合会忽略 --ids，但命中判定仍要拿到期望文档 id。
  const multiSelected = fixture.multi_turn;

  const minDocs = args.minDocs ?? Number(process.env.EVAL_MIN_DOCS ?? "1");
  if (!Number.isInteger(minDocs) || minDocs < 0) throw new EvalError("EVAL_MIN_DOCS 需要一个非负整数");

  // 会话数先定：池上限必须在 config 被 import 之前写进 env（config 在 import 阶段读常量）。
  const turns = args.multi ? fixture.multi_turn.length : selected.length;
  raiseParallelLimit(turns);

  const llmChoice = applyLlmProviderGuard();
  const llm = llmChoice.provider;

  // ── 数据层预检：空库必须明确报错，绝不输出 0% 让误读 ─────────────────────
  const { query, pool } = await import("../src/db.ts");
  const db: Db = { query };
  const counts = await query<{ docs: number; chunks: number }>(
    `select (select count(*) from documents)::int as docs,
            (select count(*) from chunks where embedding is not null)::int as chunks`,
  );
  const docs = counts[0]?.docs ?? 0;
  const chunks = counts[0]?.chunks ?? 0;
  if (docs < minDocs || chunks === 0) {
    await pool.end().catch(() => undefined);
    process.stderr.write(
      `[eval] 评测无法开始：库里没有可用的检索数据。\n` +
        `[eval]   documents=${docs}（要求 ≥${minDocs}）、chunks(embedding 非空)=${chunks}（要求 ≥1）\n` +
        `[eval] 先灌语料再评测：node --env-file-if-exists=.env scripts/ingest.ts corpus\n` +
        `[eval] 然后自检：node --env-file-if-exists=.env scripts/check-corpus.ts\n` +
        `[eval] 本次不输出任何指标行 —— 空库跑出来的 "0%" 会被读成"检索全坏"，而不是"还没灌语料"。\n`,
    );
    return 1;
  }

  const { embedBackend } = await import("../src/core/embed.ts");
  const embed = embedBackend();

  // ── hint 解析：解析不到就停下，不把"标注找不到"混进"没命中" ────────────────
  const documents = await loadDocuments(db);
  const docIdsByTitle = new Map(documents.map((doc) => [doc.title, doc.id]));
  const resolvedHints = new Map<string, string>();
  try {
    for (const item of [...selected, ...multiSelected]) {
      const hint = item.expect_doc_hint;
      if (hint === null || resolvedHints.has(hint)) continue;
      resolvedHints.set(hint, resolveHint(hint, documents));
    }
  } catch (err) {
    await pool.end().catch(() => undefined);
    process.stderr.write(`[eval] 夹具 hint 解析失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // 查询向量与库内向量是否同源：hash 查询打 dashscope 入库的库，分数方向没有意义。
  // 这条诊断只影响"怎么读分"，不影响判定，所以是 warn 而不是 error。
  if (embed === "hash") {
    const sameSource = await corpusLooksHashEmbedded(query);
    process.stdout.write(
      sameSource
        ? "[eval] 向量同源：库内片段就是 hash 兜底向量产物，本轮分数可横向比较\n"
        : "[eval] 警告：EMBED_BACKEND=hash 但库内向量不是 hash 产物（很可能是 DashScope 入库）。\n" +
            "[eval]       查询向量与库内向量不同源，本轮只能验证确定性，不能解读分数方向；\n" +
            "[eval]       要比较检索质量，请用与入库同源的 EMBED_BACKEND。\n",
    );
  }

  // ── 起真实 HTTP 服务（端口 0）：同一条路由/鉴权/检索/拒答路径 ───────────────
  const { buildApp } = await import("../src/server.ts");
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  let baseUrl = "";
  try {
    app = await buildApp();
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    const token = await issueToken(baseUrl);
    const deps: RunDeps = { baseUrl, token, db, docIdsByTitle, faultSources: await loadFaultSources() };

    process.stdout.write(
      `[eval] 夹具 ${FIXTURE_PATH}（version ${fixture.version}）；模型 ${llm}；嵌入 ${embed}\n` +
        `[eval] 开始：${args.multi ? `多轮 ${fixture.multi_turn.length} 题` : `${selected.length} 题`}` +
        `（逐题走 POST /api/chat 的 SSE，消费到 done）\n`,
    );

    // ── 多轮：单独跑、不计入 30 题、不写 eval_runs ─────────────────────────
    if (args.multi) {
      const results: MultiResult[] = [];
      for (const [index, item] of fixture.multi_turn.entries()) {
        const result = await runMultiItem(item, resolvedHints.get(item.expect_doc_hint ?? "") ?? null, deps);
        results.push(result);
        process.stdout.write(
          `[eval] ${index + 1}/${fixture.multi_turn.length} ${result.id} ${result.lang} ` +
            `第二问命中=${yesNo(result.hit)} 拒答=${yesNo(result.steps[1]?.refused ?? false)} ` +
            `引用=${result.steps[1]?.citedDocIds.length ?? 0}\n`,
        );
      }
      const hits = results.filter((item) => item.hit).length;
      process.stdout.write(
        `[eval] 多轮指代 5 题（不计入 30 题）：第二问命中 ${hits}/${results.length}；未写 eval_runs\n`,
      );

      await mkdir(REPORT_DIR, { recursive: true });
      const reportPath = join(REPORT_DIR, `eval-multi-${stamp()}.md`);
      await writeFile(
        reportPath,
        renderMultiReport({ fixtureVersion: fixture.version, llm, llmNote: llmChoice.note, embed, results }),
        "utf8",
      );
      process.stdout.write(`[eval] 报告：${reportPath}\n`);
      return 0;
    }

    // ── 30 题 ────────────────────────────────────────────────────────────
    const results: ItemResult[] = [];
    for (const [index, item] of selected.entries()) {
      const n = fixture.items.indexOf(item) + 1;
      const result = await runGoldItem(item, n, resolvedHints.get(item.expect_doc_hint ?? "") ?? null, deps);
      results.push(result);
      process.stdout.write(
        `[eval] ${index + 1}/${selected.length} #${String(n).padEnd(2)} ${item.lang} ` +
          `hit=${yesNo(result.hit)} 拒答=${yesNo(result.refused)} 建单=${yesNo(result.ticketCreated)} ` +
          `引用=${result.citeLegal.filter(Boolean).length}/${result.citeLegal.length} ${result.latencyMs}ms  ` +
          `${item.question.slice(0, 48)}\n`,
      );
    }

    const metrics = computeMetrics(results);
    const allOk = printMetrics(metrics, `${results.length} 题结果（14 §7 门槛）`);
    if (!allOk) printRemediation();

    const faultItems = results.filter((item) => item.expectHint === FAULT_HINT);
    if (faultItems.length > 0) {
      const allRate = metrics.positivesAll === 0 ? 0 : metrics.falseRefusalsAll / metrics.positivesAll;
      process.stdout.write(
        `[eval] 故障码题 ${faultItems.length} 题（结构化语料 fault_codes，无 documents 行）：` +
          `故障码路命中 ${metrics.faultHits}/${metrics.faultItems}；` +
          `不计入 hit@5 与误拒率（那两个指标的口径是文档检索）。\n` +
          `[eval] 透明口径：若把这 ${faultItems.length} 题也当成"不该拒答"，误拒率 = ` +
          `${allRate.toFixed(4)}（${metrics.falseRefusalsAll}/${metrics.positivesAll}）——` +
          `本题集里是 mock 只调 kb_search、不调 fault_code_lookup 的必然结果，不是检索坏了。\n`,
      );
    }

    // 结果行：detail 放题号级明细，任何一次跑分都能事后复核到单题。
    const detail = {
      // `--ids` 跑的是子集：标出来，免得事后把 5 题的比率当成 30 题的口径。
      kind: args.ids === null ? "gold30" : "gold30-subset",
      fixture: { path: "corpus/.fixtures/qa_gold.json", version: fixture.version },
      env: { llm, embed, minDocs },
      metrics,
      items: results.map((item) => ({
        n: item.n,
        lang: item.lang,
        question: item.question,
        expect_hint: item.expectHint,
        expect_doc_ids: item.expectDocIds,
        cited_doc_ids: item.citedDocIds,
        cite_legal: item.citeLegal,
        hit: item.hit,
        refused: item.refused,
        ticket_created: item.ticketCreated,
        fault_lookup: item.faultLookup,
        tools: item.tools,
        latency_ms: item.latencyMs,
        conv_id: item.convId,
        note: item.note,
      })),
      created_at: isoNow(),
    };
    const inserted = await query<{ id: string }>(
      `insert into eval_runs (total, hit, cite_ok, refuse_ok, hit_rate, cite_rate, refuse_rate, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       returning id`,
      [
        results.length,
        metrics.hit,
        metrics.citeOkItems,
        metrics.refuseOk,
        Number(metrics.hitRate.toFixed(4)),
        Number(metrics.citeRate.toFixed(4)),
        Number(metrics.refuseRate.toFixed(4)),
        JSON.stringify(detail),
      ],
    );
    const runId = inserted[0]?.id ?? null;
    process.stdout.write(`[eval] eval_runs: id=${runId ?? "?"}\n`);

    await mkdir(REPORT_DIR, { recursive: true });
    const reportPath = join(REPORT_DIR, `eval-${stamp()}.md`);
    await writeFile(
      reportPath,
      renderGoldReport({
        fixtureVersion: fixture.version,
        llm,
        llmNote: llmChoice.note,
        embed,
        minDocs,
        metrics,
        results,
        runId,
      }),
      "utf8",
    );
    process.stdout.write(`[eval] 报告：${reportPath}\n`);
    return 0;
  } finally {
    // 生命周期要主动收尾：pg 空闲连接 30s、Redis 客户端、SDK 会话定时器都会拖住进程退出，
    // 不关的话 `make eval` 看起来像卡死（同 scripts/ingest.ts 的说明）。
    if (app !== null) await app.close().catch(() => undefined);
    const { shutdownSessions } = await import("../src/core/agent.ts");
    shutdownSessions();
    const { redis } = await import("../src/redis.ts");
    await redis.quit().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

/**
 * 库内片段是不是 hash 兜底向量产物（抽样 3 条算余弦）。
 *
 * 这不是"调用内部检索"：它只回答"这份语料的向量来自哪个后端"，
 * 好让 hash 模式的分数不被误读成检索质量。失败一律当作"无法判断"，不阻断评测。
 */
async function corpusLooksHashEmbedded(
  query: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
): Promise<boolean> {
  try {
    const { hashEmbed } = await import("../src/core/hash-embed.ts");
    const rows = await query<{ content: string; emb: string }>(
      `select content, embedding::text as emb
         from chunks where embedding is not null and length(content) >= 120
        order by id limit 3`,
    );
    if (rows.length === 0) return false;
    let best = -1;
    for (const row of rows) {
      const values = row.emb.replace(/^\[|\]$/g, "").split(",").map(Number);
      if (values.length !== 1024) continue;
      const hashed = hashEmbed(row.content);
      let dot = 0;
      let a = 0;
      let b = 0;
      for (let i = 0; i < values.length; i += 1) {
        const left = values[i] as number;
        const right = hashed[i] as number;
        dot += left * right;
        a += left * left;
        b += right * right;
      }
      if (a === 0 || b === 0) continue;
      best = Math.max(best, dot / Math.sqrt(a * b));
    }
    return best > 0.99;
  } catch {
    return false;
  }
}

const entry = process.argv[1];
if (entry !== undefined && process.argv[1]?.endsWith("eval.ts") === true) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`[eval] 失败：${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
