/**
 * Agent 装配与事件桥（06-agent.md §1、§6）。
 *
 * 这个文件只做四件事，**不做**拒答判定、不落库、不写 SSE：
 *   ① 装配：ResourceLoader（两份 prompt 覆盖 + 只挂本仓扩展）→ AgentSession（内存会话管理器）
 *      → 模型对象（provider + model 两段解析）→ 思考模式显式 off；
 *   ② 会话池：Map<convId, session>、上限 parallelLimit、闲置回收、Redis 租约（best-effort）；
 *   ③ 一轮对话：订阅运行时事件 → prompt/steer（`chooseSendMode`）→ agent_settled 或超时 → resolve；
 *   ④ 降级：LLM_PROVIDER=mock 时不碰模型，正文由检索结果拼出来（PRD §8）。
 *
 * 三条硬约束在本文件里的落点见 `createSupportSession()` 与 `runTurnLocked()` 的注释。
 *
 * 对外除 `createSupportSession` / `acquireSession` / `runTurn` / `shutdownSessions` 外，
 * 还导出三个**可观测口**：`poolStats()`、`reapIdle(now)`、`chooseSendMode(isStreaming)`。
 * 它们不是给业务用的，而是让"上限 5 / 闲置 10 分钟 / 连发不报错"三条能被单测
 * 走同一段代码验证 —— 前一版把时钟和定时器关在函数里，测试只能等 10 分钟或抄一份逻辑。
 *
 * 另有 `retrievalVerdict(buffer)`：本轮检索信号（`topScore`/`fallback`）→ `TurnResult` 的两个字段。
 * 它与拒答判定 ① 是同一条数据通路，抽成纯函数是为了让"没检索 == 没证据"这条能被单测钉住。
 */
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { SUPPORT_SYSTEM_PROMPT, config } from "../config.ts";
import { AppError, isAppError } from "../errors.ts";
import { logger } from "../logger.ts";
import { setLease } from "../redis.ts";
import { markPiReady } from "../routes.ts";
import {
  NO_RESULT,
  SUPPORT_TOOL_NAMES,
  kbSearch,
  supportExtension,
  type TurnBuffer,
  type TurnCitation,
  type TurnRetrieval,
  type TurnSlot,
} from "../ext/support.ts";
import type { Lang } from "./chunk.ts";
import type { RetrievalFallback } from "./retrieval.ts";
import { estimateCostUsd, estimateTokens } from "./run-log.ts";

export { SUPPORT_TOOL_NAMES };
export type { TurnBuffer, TurnCitation, TurnRetrieval };

/** 由调用方（chat.ts）自己写 SSE：这里只吐语义事件，不碰传输层。 */
export type TurnEvent =
  | { type: "delta"; t: string }
  | { type: "tool"; name: string; ms: number }
  | { type: "error"; code: string; message: string };

/** `done` 事件要的账：延迟 / token / 成本 / 最终正文，外加本轮检索的结论（拒答判定 ①）。 */
export type TurnResult = {
  latencyMs: number;
  tokens: number;
  costUsd: number;
  text: string;
  /**
   * 本轮检索的最高分（归一化融合分，0..1）。**它是判定 ①b 的唯一依据**：
   * 低置信的一轮照样有 5 条候选，所以"有没有候选"和"能不能答"是两件事。
   */
  topScore: number;
  /** 本轮检索的降级口径。`"empty"` 就是 ①a 的直接触发条件（含"根本没检索"）。 */
  fallback: RetrievalFallback;
};

/**
 * 本轮检索信号 → `done` 要的两个字段。
 *
 * **没有任何检索时是 `0 / "empty"`，不是"跳过判定"**：没检索就等于没证据，
 * 若这时给一个 `fallback: "none"`，判定 ① 就永远不会为这一轮触发 ——
 * 模型可以绕过 `kb_search` 直接凭记忆答，而拒答层看到的是"检索正常"。
 * 反过来，`topScore=0` 与 `fallback="empty"` 是"无证据"的如实表达，不是编出来的分。
 */
export function retrievalVerdict(buffer: TurnBuffer): { topScore: number; fallback: RetrievalFallback } {
  const signal = buffer.retrieval;
  if (signal === undefined) return { topScore: 0, fallback: "empty" };
  return { topScore: signal.topScore, fallback: signal.fallback };
}

/* ────────────────────────── 装配 ────────────────────────── */

// pi-agent-core 的 ThinkingLevel 联合类型没有从 coding-agent 的入口导出，
// 这里按同一份字面量收窄：config 里是 env 来的 string，直接传给 SDK 过不了类型检查。
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

function thinkingLevelOf(value: string): ThinkingLevelName {
  return (THINKING_LEVELS as readonly string[]).includes(value) ? (value as ThinkingLevelName) : "off";
}

// ModelRuntime.create() 会读 ~/.pi/agent 下的模型目录与凭据，一次就够；
// 每个会话都重建一遍等于把装配时间翻倍（首字预算里没有这块的余量）。
let runtimePromise: Promise<ModelRuntime> | undefined;

function modelRuntime(): Promise<ModelRuntime> {
  runtimePromise ??= ModelRuntime.create().catch((err: unknown) => {
    // 失败不缓存："这分钟拿不到"不该变成"这个进程永远拿不到"。
    runtimePromise = undefined;
    throw err;
  });
  return runtimePromise;
}

/**
 * 模型必须是**模型对象**（06 §1，`model: config.MODEL_ID` 传字符串过不了类型检查）。
 * 按 provider + model 两段解析：只给 modelId 会解析到别的 provider 上。
 *
 * 凭据有两条来源，**优先环境变量**：
 *   1. `DEEPSEEK_API_KEY`（`config.deepseekApiKey`）→ `setRuntimeApiKey()` 注入运行时；
 *   2. 没有环境变量时用 SDK 自己的凭据库 `~/.pi/agent/auth.json`（Pi 登录后就有）。
 * 两条都给是刻意的：本机靠 Pi 的登录态即开即用，容器里没有那个文件（不是用户家目录），
 * 只能靠环境变量；只留一条路就会在"换台机器部署"时静默失败成 LLM_UNAVAILABLE。
 */
async function resolveModel() {
  const runtime = await modelRuntime();

  const injectedKey = config.deepseekApiKey;
  if (injectedKey !== undefined && injectedKey !== "" && !runtimeKeyInjected) {
    runtimeKeyInjected = true;
    try {
      await runtime.setRuntimeApiKey(config.modelProvider, injectedKey);
    } catch (err) {
      // 注入失败不该挡住整条链路：auth.json 里可能已经有可用凭据，交给 getAuth 自己决定
      runtimeKeyInjected = false;
      logger.warn({ err, provider: config.modelProvider }, "注入 DEEPSEEK_API_KEY 失败，回落到 Pi 凭据库");
    }
  }

  const model = runtime.getModel(config.modelProvider, config.modelId);
  if (model === undefined) {
    throw new AppError("LLM_UNAVAILABLE", `未知模型：${config.modelProvider}/${config.modelId}`);
  }
  return model;
}

/** 运行时 key 只注入一次：`setRuntimeApiKey` 会写凭据快照，每会话重复调用是白费并可能触发同步错误。 */
let runtimeKeyInjected = false;

/** /healthz 的 `pi` 项：本进程至少成功装配过一次 AgentSession。 */
let ready = false;

export function agentReady(): boolean {
  return ready;
}

/**
 * 装配一个客服会话（唯一正确写法，06 §1）。
 *
 * 三条不可违反：
 *   C1 工具只能经 `pi.registerTool()` 注册（见 ext/support.ts）；`tools:[]` 只做**选择**。
 *   C2 `systemPromptOverride` 与 `appendSystemPromptOverride: () => []` 必须都给 ——
 *      漏了模型会拿 SDK 默认的"编码助手"开场，然后试图读文件、改代码。
 *   C3 上下文权威只有一个：`SessionManager.inMemory()`。**禁止**给
 *      `session.agent.state.messages` 赋值（那样多轮必然丢上下文）。
 */
export async function createSupportSession(): Promise<{ session: AgentSession; slot: TurnSlot }> {
  // 每会话一个 slot：hook 拿不到"请求"这个入参，只能靠装配期闭包拿到本轮 buffer。
  const slot: TurnSlot = { buffer: undefined, lang: "en" };

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => SUPPORT_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    // 磁盘上的扩展（含内置 MCP）一律不加载：装配面只留本仓的 supportExtension。
    // 否则用户机器上的 ~/.pi/agent/settings.json 就能决定这个客服 Agent 还能调什么工具。
    noExtensions: true,
    // 项目上下文（AGENTS.md 之类）会被拼进 system prompt —— 那份文档是给编码 Agent 的，
    // 进客服提示词就是把模型的角色带偏。两个开关一起用，确保一个字都不混进来。
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    // 多包一层箭头：把本会话的 slot 绑进扩展工厂。工厂每次装配只跑一次，
    // 所以一个 slot 严格对应一个会话（不存在跨会话串 buffer 的可能）。
    extensionFactories: [(pi) => supportExtension(pi, slot)],
  });
  await loader.reload();

  const model = await resolveModel();

  const { session } = await createAgentSession({
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    // 恰好四个业务工具名（kb_search / fault_code_lookup / ticket_create / ticket_lookup），
    // 且只能来自 SUPPORT_TOOL_NAMES —— 这里没有 read/bash/edit/write，
    // 也不可能从别处混进来（白名单只做选择，未注册的名字被忽略）。
    tools: [...SUPPORT_TOOL_NAMES],
    model,
    // 显式 off：SDK 缺省是 medium，思考模式会把首字延迟推高一个数量级（破 P95 < 3s）。
    thinkingLevel: thinkingLevelOf(config.thinkingLevel),
  });

  if (!ready) {
    ready = true;
    // 只在此处翻转 /healthz 的 pi 项；幂等，重复调用无副作用。
    markPiReady();
  }
  logger.info({ conv_model: `${config.modelProvider}/${config.modelId}`, thinking: config.thinkingLevel }, "agent session assembled");

  return { session, slot };
}

/* ────────────────────────── 会话池 ────────────────────────── */

type PooledSession = {
  convId: string;
  session: AgentSession;
  slot: TurnSlot;
  lastActiveAt: number;
  /** 有一轮正在跑：回收绝不能 dispose 一个跑着会话的 session。 */
  busy: boolean;
  /** 同会话轮次串行化（见 `runTurn` 的注释）。 */
  tail: Promise<void>;
};

/** 内存态、进程重启即丢（ADR-0002：不做会话持久化）。 */
const pool = new Map<string, PooledSession>();

/**
 * 正在装配的会话：`conv_id → 装配 promise`（装配结束后摘掉）。
 * 它同时干两件事：① 算进上限 —— 装配是异步的，不把它算进去就会短暂超卖；
 * ② 按 conv_id 去重 —— 同一会话的两路首轮请求共用一份装配结果（见 `acquire`）。
 */
const assembling = new Map<string, Promise<PooledSession>>();

const REAP_INTERVAL_MS = 60_000;
/** 租约 TTL 600s：只作跨请求的"会话还活着"提示，本进程的判断依据永远是 pool 本身。 */
export const LEASE_TTL_SEC = 600;

let reaper: NodeJS.Timeout | undefined;

/** 定时器懒启动：没人对话就不该有一个空转的 interval。`unref` 免得钉住只跑单测的进程。 */
function ensureReaper(): void {
  if (reaper !== undefined) return;
  reaper = setInterval(() => reapIdle(Date.now()), REAP_INTERVAL_MS);
  reaper.unref();
}

function dropSession(convId: string, record: PooledSession): void {
  pool.delete(convId);
  try {
    record.session.dispose();
  } catch (err) {
    logger.warn({ err, conv: convId }, "dispose agent session failed");
  }
}

/**
 * 闲置回收：跑着的（busy 或 isStreaming）一律跳过，中途 dispose 会打断正在出的答案。
 *
 * `now` 是**入参**而不是 `Date.now()`：定时器与"池满先回收再判满"这两处都走这个函数，
 * 把时钟交出去之后单测可以直接推到 10 分钟之后（`reapIdle(基准时刻 + idleMs + 1)`），
 * 而不必真等一个 interval —— 测的是同一段代码，不是它的副本。
 */
export function reapIdle(now: number): void {
  for (const [convId, record] of pool) {
    if (record.busy || record.session.isStreaming) continue;
    if (now - record.lastActiveAt < config.sessionIdleMs) continue;
    logger.info({ conv: convId }, "reaping idle agent session");
    dropSession(convId, record);
  }
}

/** `poolStats()` 的形状：只读快照，调用方拿不到 session 本身（池的唯一出口仍是 `acquireSession`）。 */
export type PoolStats = {
  /** 池里现存的会话数（含正在跑一轮的）。 */
  size: number;
  /** 正在装配、还没进池的会话数（也占上限的额度）。 */
  assembling: number;
  /** 正在跑一轮的会话数。 */
  busy: number;
  /** 上限（`PARALLEL_LIMIT`，默认 5）。 */
  limit: number;
  /** 闲置多久算过期（`SESSION_IDLE_MS`，默认 600000）。 */
  idleMs: number;
  /** 池里的 conv_id 列表，按插入顺序。 */
  convs: string[];
};

/**
 * 池的可观测面（`/healthz` 之外的诊断口，也是单测断言"上限/回收真的生效了"的唯一依据）。
 * 只读：不 dispose、不续约、不改 `lastActiveAt`，任何时候调用都安全。
 */
export function poolStats(): PoolStats {
  let busy = 0;
  for (const record of pool.values()) if (record.busy) busy += 1;
  return {
    size: pool.size,
    assembling: assembling.size,
    busy,
    limit: config.parallelLimit,
    idleMs: config.sessionIdleMs,
    convs: [...pool.keys()],
  };
}

/**
 * Redis 租约：**best-effort**。它只是"这个会话在别处见过"的跨请求提示，
 * 不是存活判据；Redis 挂了绝不能把对话路径带崩，所以失败只记日志。
 */
async function refreshLease(convId: string): Promise<void> {
  try {
    await setLease(convId, LEASE_TTL_SEC);
  } catch (err) {
    logger.warn({ err, conv: convId }, "session lease refresh failed (ignored)");
  }
}

async function acquire(convId: string, lang: string): Promise<{ record: PooledSession; reused: boolean }> {
  ensureReaper();

  const existing = pool.get(convId);
  if (existing !== undefined) {
    existing.lastActiveAt = Date.now();
    // 用户中途换语言提问是正常事件：会话（历史）不变，语言跟着本轮走。
    existing.slot.lang = lang;
    void refreshLease(convId);
    // 复用在**判上限之前**返回：上限数的是"同时在册的会话"，不是"同时在处理的消息"。
    // 同一个会话追问第 3 轮时池里还是那一个 session，若把复用也算一次额度，
    // 满池时老用户就再也问不了话 —— 那是把"限流"做成了"锁死"。
    return { record: existing, reused: true };
  }

  // 同一会话的**首轮**并发到达（前端双击、网络重发、SSE 重连）：上面查池查不到，
  // 因为装配还没结束。两路各装一个 session 的后果是后一个覆盖 Map 里的前一个 ——
  // 前一个既不在池里、也没有人 dispose，白白常驻一份上下文与运行时，正是上限要防的东西。
  // 所以装配本身也按 conv_id 去重：后来者等同一份 promise，拿到的是同一个会话。
  const inflight = assembling.get(convId);
  if (inflight !== undefined) {
    const record = await inflight;
    record.lastActiveAt = Date.now();
    record.slot.lang = lang;
    void refreshLease(convId);
    return { record, reused: true };
  }

  if (pool.size + assembling.size >= config.parallelLimit) {
    // 先回收再判满：5 个已经闲置 10 分钟的会话不该把服务永久挡在 503 上。
    reapIdle(Date.now());
    if (pool.size + assembling.size >= config.parallelLimit) {
      // 上限是硬约束，不是建议值：每个 AgentSession 都常驻一份上下文历史 + SDK 运行时对象，
      // 不封顶的话"同时来 200 个会话"等于一个进程吃掉 200 份内存、200 条模型调用的账单。
      // 拒绝比拖垮好 —— 503 在前端渲染成"前面还有几位"，是一条可恢复的路。
      throw new AppError("SESSION_BUSY", "并发会话已达上限，请稍后重试");
    }
  }

  const creation = (async (): Promise<PooledSession> => {
    const { session, slot } = await createSupportSession();
    slot.lang = lang;
    const record: PooledSession = {
      convId,
      session,
      slot,
      lastActiveAt: Date.now(),
      busy: false,
      tail: Promise.resolve(),
    };
    pool.set(convId, record);
    return record;
  })();
  assembling.set(convId, creation);
  try {
    const record = await creation;
    void refreshLease(convId);
    return { record, reused: false };
  } finally {
    // 装配失败也要摘掉：留一个永远 reject 的 promise 会把这个 conv_id 永久烧死。
    if (assembling.get(convId) === creation) assembling.delete(convId);
  }
}

/**
 * 会话池：上限 `parallelLimit`、闲置 `sessionIdleMs` 回收、只在内存里。
 * 池满时抛 `AppError("SESSION_BUSY")`（HTTP 层映射 503；runTurn 内部会转成 error 事件）。
 */
export async function acquireSession(convId: string, lang: string): Promise<{ session: unknown; reused: boolean }> {
  const { record, reused } = await acquire(convId, lang);
  return { session: record.session, reused };
}

/**
 * 这个会话**上一轮**用的是哪门语言（`chat.ts` 的语言回落链第三格）。
 *
 * 为什么从会话池读而不是另建一张表：语言本来就是会话状态（ADR-0002：上下文只活内存），
 * `acquire()` 每轮已经把它写进 `slot.lang`。再开一个 Map 就等于同一件事有两个真源，
 * 回收会话时还会漏一份。
 *
 * 返回 `undefined` 表示"池里没有这个会话"（首轮 / 已被回收 / 进程重启）——
 * 调用方据此继续往回落链下一格走，不要在这里给默认值。
 */
export function sessionLang(convId: string): string | undefined {
  return pool.get(convId)?.slot.lang;
}

/** 进程收尾用：dispose 全部会话并停掉回收定时器。 */
export function shutdownSessions(): void {
  if (reaper !== undefined) {
    clearInterval(reaper);
    reaper = undefined;
  }
  for (const record of pool.values()) {
    try {
      record.session.dispose();
    } catch (err) {
      logger.warn({ err }, "dispose agent session failed");
    }
  }
  pool.clear();
  // 装配中的 promise 也一并摘掉：进程都要退了，没人会再 await 它。
  assembling.clear();
}

/* ────────────────────────── 一轮对话 ────────────────────────── */

/** `runTurn` 的入参。buffer 由调用方每次请求新建（本轮候选的落点）。 */
export type TurnInput = {
  convId: string;
  text: string;
  lang: Lang;
  onEvent: (event: TurnEvent) => void;
  buffer: TurnBuffer;
  signal?: AbortSignal;
};

/**
 * 驱动一轮对话：取/建会话 → 订阅运行时事件 → prompt 或 steer → settled/超时后返回。
 *
 * `onEvent` 是唯一输出通道（SSE 由调用方写）。**超时与 5xx 不抛**：
 * 先发 error 事件再 resolve —— 抛出去会变成"连接被重置"，前端拿不到任何可展示的话。
 */
export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const startedAt = performance.now();
  const done = (text: string, tokens: number, costUsd: number): TurnResult => ({
    latencyMs: Math.round(performance.now() - startedAt),
    tokens,
    costUsd,
    text,
    // 在这里取（而不是开始时取）：buffer 是在整轮里被 kb_search 逐步写满的，
    // 早开始的路径（池满 / abort）拿到的就是默认的 `0 / "empty"`。
    ...retrievalVerdict(input.buffer),
  });

  let record: PooledSession;
  try {
    record = (await acquire(input.convId, input.lang)).record;
  } catch (err) {
    // 池满（SESSION_BUSY）/ 模型不可用（LLM_UNAVAILABLE）都走这里：error 事件 + resolve。
    const code = isAppError(err) ? err.code : "INTERNAL";
    logger.error({ err, conv: input.convId }, "turn rejected before start");
    input.onEvent({
      type: "error",
      code,
      message: isAppError(err) ? err.message : "服务暂时不可用，请稍后重试或转人工",
    });
    return done("", 0, 0);
  }

  // 同一会话的轮次串行化：slot.buffer 与 subscribe 都是"单轮"语义。
  // 两轮并行会让后一轮覆盖前一轮的 buffer —— 正文里的 [n] 就和候选对不上了。
  const gate = record.tail;
  let open!: () => void;
  record.tail = new Promise<void>((resolve) => {
    open = resolve;
  });

  try {
    await gate.catch(() => {});
    if (input.signal?.aborted) return done("", 0, 0);
    return await runTurnLocked(record, input, startedAt);
  } finally {
    open();
  }
}

async function runTurnLocked(record: PooledSession, input: TurnInput, startedAt: number): Promise<TurnResult> {
  record.busy = true;
  record.lastActiveAt = Date.now();
  record.slot.lang = input.lang;
  // 工具要能带上会话 id 建单（`ticket_create` → `/internal/ticket` 的 `conv_id`）：
  // slot 是 hook 唯一的入参通道，会话 id 只能在这里写进去。
  record.slot.convId = input.convId;
  // 本轮 buffer 的唯一挂载点：`tool_result` hook 通过同一个 slot 往这里塞候选。
  record.slot.buffer = input.buffer;
  void refreshLease(input.convId);

  try {
    if (config.llmProvider === "mock") return await mockTurn(input, startedAt);
    return await liveTurn(record, input, startedAt);
  } finally {
    record.slot.buffer = undefined;
    record.slot.convId = undefined;
    record.busy = false;
    record.lastActiveAt = Date.now();
  }
}

/**
 * 发送方式选择（06 §6.2）—— 连发保护规则的**唯一落点**。
 *
 * 为什么单独成函数：`isStreaming` 只有在真实模型流式途中才为 true，测试里造不出来
 * （mock 是同步的、真模型不可控）。把判断抽成纯函数，规则本身就能被单测钉死；
 * `liveTurn` 只负责按它的返回值挑调用方式，不再自己判一次 —— 两处各写一份就会分叉。
 *
 * `steer` 与 `prompt` 的区别是运行时语义：前者把这句话插进正在跑的那一轮，
 * 后者开新的一轮。streaming 时用 `prompt` 不是"慢一点"，而是 SDK 直接 reject。
 */
export function chooseSendMode(isStreaming: boolean): "prompt" | "steer" {
  return isStreaming ? "steer" : "prompt";
}

/**
 * 真实模型路径：订阅 → prompt（streaming 时 steer）→ settled 收尾。
 *
 * 事件桥（06 §6.1）：`message_update` + `text_delta` → delta；
 * `tool_execution_end` → tool（耗时字段是 SDK 的 `durationMs`，PRD 猜对了）；
 * `agent_settled` → 收尾。**不在这里做拒答判定**（那是 05#02 的事）。
 */
async function liveTurn(record: PooledSession, input: TurnInput, startedAt: number): Promise<TurnResult> {
  const session = record.session;

  return new Promise<TurnResult>((resolve) => {
    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    let unsubscribe: () => void = () => {};

    const finish = (text: string, tokens: number, costUsd: number): void => {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      input.signal?.removeEventListener("abort", onAbort);
      resolve({
        latencyMs: Math.round(performance.now() - startedAt),
        tokens,
        costUsd,
        text,
        // 本轮 kb_search 已经把信号写进 buffer（工具经 slot.buffer 拿到的是同一个对象）；
        // 模型一次都没检索时这里是 `0 / "empty"`，拒答判定 ① 照样会触发。
        ...retrievalVerdict(input.buffer),
      });
    };

    // 客户端断开：把运行时那一轮真的停掉（继续跑等于白烧 token），并且不再发事件。
    const onAbort = (): void => {
      void session.abort().catch(() => {});
      const usage = usageOf(session);
      finish(session.getLastAssistantText() ?? "", usage.tokens, usage.costUsd);
    };

    timer = setTimeout(() => {
      // 超时以 error 事件收尾并关流（不是 reset 连接），同时 abort 运行时那一轮。
      input.onEvent({ type: "error", code: "LLM_TIMEOUT", message: "响应超时，请稍后重试或转人工" });
      void session.abort().catch(() => {});
      const usage = usageOf(session);
      finish(session.getLastAssistantText() ?? "", usage.tokens, usage.costUsd);
    }, config.turnTimeoutMs);

    unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            input.onEvent({ type: "delta", t: event.assistantMessageEvent.delta });
          }
          return;
        case "tool_execution_end":
          input.onEvent({ type: "tool", name: event.toolName, ms: event.durationMs ?? 0 });
          return;
        case "agent_settled": {
          const usage = usageOf(session);
          finish(session.getLastAssistantText() ?? "", usage.tokens, usage.costUsd);
          return;
        }
        default:
          return;
      }
    });

    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        onAbort();
        return;
      }
      input.signal.addEventListener("abort", onAbort, { once: true });
    }

    void (async () => {
      try {
        // 连发保护（06 §6.2）：streaming 时 `prompt()` 不带 streamingBehavior 会直接 reject，
        // 不处理就是客服场景必然 500 —— 用户"催一下"是最常见的输入，不是异常输入。
        // 分支判断收在 `chooseSendMode` 里：它是这条规则的唯一落点，单测直接钉那一行。
        if (chooseSendMode(session.isStreaming) === "steer") {
          await session.prompt(input.text, { streamingBehavior: "steer", expandPromptTemplates: false });
        } else {
          // expandPromptTemplates: false —— 客户输入里的 "/xxx" 绝不能被当成斜杠命令展开。
          await session.prompt(input.text, { expandPromptTemplates: false });
        }
      } catch (err) {
        // 没有 API Key、模型不可用都落在这里（SDK 在 prompt 前校验凭据）。
        logger.error({ err, conv: input.convId }, "prompt failed");
        if (!closed) {
          input.onEvent({ type: "error", code: "LLM_ERROR", message: "模型暂时不可用，请稍后重试或转人工" });
        }
        const usage = usageOf(session);
        finish(session.getLastAssistantText() ?? "", usage.tokens, usage.costUsd);
      }
    })();
  });
}

/**
 * mock 模式（PRD §8）：**完全不碰模型**，但不跳过检索 —— 检索不跑就没有候选，
 * 每轮都会被判"无引用"拒答，这条路等于没测到。
 *
 * 正文 = 第一条候选的首句 + `[1]`（`[1]` 用候选自己的 idx，不写死）。
 * 候选为空时返回空正文、不发 delta：调用方按 §5.1 ② 走拒答。
 */
async function mockTurn(input: TurnInput, startedAt: number): Promise<TurnResult> {
  const searchStarted = performance.now();
  // buffer 一起传进去：mock 走的是与 `kb_search` 工具**同一个** `kbSearch()`，
  // 所以拒答判定 ① 的信号在 mock 下也必须是真的（信号只由 kbSearch 写，不在这里另算一份）。
  const { text: toolText, citations } = await kbSearch({ query: input.text }, input.lang, input.buffer);
  const ms = Math.round(performance.now() - searchStarted);

  // 与 tool_result hook 同一个落点：候选只进本轮缓冲，不下发、不落库。
  input.buffer.citations.push(...citations);
  // 工具确实跑了，就得让前端看见（空结果也算跑过；toolText 只在日志里有意义）。
  logger.debug({ conv_result: toolText === NO_RESULT ? "empty" : "hit", n: citations.length }, "mock kb_search");
  input.onEvent({ type: "tool", name: "kb_search", ms });

  const answer = mockAnswer(input.buffer.citations);
  if (answer !== "") input.onEvent({ type: "delta", t: answer });

  return {
    latencyMs: Math.round(performance.now() - startedAt),
    // mock 没有真实 usage：按字符数粗估 tokens ≈ chars/3（06 §9），成本记 0（真的没花钱）。
    // 估法用的是 run-log.ts 的 `estimateTokens` —— 单价与估法只能有一处（见 `usageOf`）。
    tokens: estimateTokens(answer),
    costUsd: 0,
    text: answer,
    ...retrievalVerdict(input.buffer),
  };
}

/** mock 正文上限：规则 6 说普通问题不超过 200 字。 */
const MOCK_MAX_CHARS = 200;

function mockAnswer(citations: TurnCitation[]): string {
  const first = citations.find((citation) => citation.snippet.trim() !== "");
  if (first === undefined) return "";
  return `${firstSentence(first.snippet)} [${first.idx}]`;
}

/** 摘首句：正文按句末标点切，切不动就截断。语料是五语的，标点要认全。 */
function firstSentence(snippet: string, max = MOCK_MAX_CHARS): string {
  const flat = snippet.replace(/\s+/g, " ").trim();
  const match = /^(.*?[.!?。！？])(?:\s|$)/.exec(flat);
  const sentence = match?.[1] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max)}…` : sentence;
}

/** 只读最后一条 assistant 消息的 usage：per-turn 记账口径（06 §9）。 */
function usageOf(session: AgentSession): { tokens: number; costUsd: number } {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    // SDK 的 Usage 形状是 `{ input, output, cost: { total } }`，不是 PRD 写的
    // `inputTokens/outputTokens`：按真实形状取，取不到就按 0 记（宁可少记，不编数）。
    const usage = (message as { usage?: { input?: number; output?: number; cost?: { total?: number } } }).usage;
    if (usage === undefined) return { tokens: 0, costUsd: 0 };
    const tokensIn = usage.input ?? 0;
    const tokensOut = usage.output ?? 0;
    // SDK 自己报了总价（含缓存读写分价）就以它为准；没报才用 06 §9 的单价公式。
    // 单价表在 run-log.ts：它才是把 cost_usd 写进库的地方，两处各写一份必然分叉。
    const reported = usage.cost?.total;
    const costUsd =
      reported !== undefined && Number.isFinite(reported) && reported > 0
        ? reported
        : estimateCostUsd(tokensIn, tokensOut);
    return { tokens: tokensIn + tokensOut, costUsd };
  }
  return { tokens: 0, costUsd: 0 };
}
