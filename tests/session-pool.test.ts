/**
 * 会话池的三条上限 + 连发分支（`02-architecture.md` §4 · `06-agent.md` §6.2–§6.3 · `04#03`）。
 *
 * 这个文件要证明的是**限制真的生效**，不是"代码里写了 5"：
 *   ① 上限 `PARALLEL_LIMIT=5`：第 6 个**不同**会话得到 `SESSION_BUSY`（HTTP 层映射 503），
 *      而**复用**同一个 conv 不占额度、拿到的是同一个 session；
 *   ② 闲置 `SESSION_IDLE_MS=600000`：`reapIdle()` 是定时器自己走的那段代码，
 *      测试把时钟推到 10 分钟之后调用它，不真等一个 interval；
 *   ③ 租约 `conv:<id>:lease` TTL 600s：只作跨请求提示，**Redis 挂了不能挡住一轮对话**
 *      （用一个连不上 Redis 的子进程证明，而不是 mock 掉 setLease）；
 *   ④ 连发：`chooseSendMode(true) === "steer"`，且 mock 模式下同一会话连发两轮
 *      事件序列里**没有** `error`，两轮严格串行（第二轮排在第二轮之后）。
 *
 * 依赖与 `tests/chat-stream.test.ts` 同一套：真实 Postgres + 真实 Redis + 真实 embedding
 * （mock 路径**照样跑检索**，不然每轮都会判无引用拒答）。缺 .env 就整体 skip。
 *
 * 为什么上限要显式钉成 5：`.env.example` 的默认值也是 5，但环境里改了 `PARALLEL_LIMIT`
 * 就不该让"第 6 个被拒"这条断言变成"第 9 个被拒"。这里的数字必须与规格一致。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
// 只取类型（`import type` 在类型剥离时整行消失）：不能在顶层真 import agent.ts，
// 那样 `src/config.ts` 会在本文件设置 env 之前就把 env 读成常量。
import type { TurnBuffer, TurnEvent } from "../src/core/agent.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 tests/chat-stream.test.ts 同一套 .env 解析：行内 `#` 之后是注释、成对引号去掉。 */
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

const dotenv = await loadDotEnv();
for (const [key, value] of Object.entries(dotenv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

// 必须在任何 src 模块被 import 之前落定：`src/config.ts` 在 import 阶段就把 env 读成常量。
// 因此本文件对 src 的引用一律走动态 import（每个用例里 await import）。
process.env.LLM_PROVIDER = "mock";
// 两个数字是本文件的断言对象，不跟着 .env 走（见文件头）。
process.env.PARALLEL_LIMIT = "5";
process.env.SESSION_IDLE_MS = "600000";

const hasRuntimeEnv = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.S3_ENDPOINT);
const missingRuntimeEnvHint =
  "缺少 .env（或其中没有数据层连接串）：先按 docs/prdv1.1/13-ops.md §4.1 生成，再跑 npm test";

/** 本文件造出来的 conv id：收尾要删租约键（池里没有落库行，不会留 conversations）。 */
const createdConvs: string[] = [];

function newConvId(): string {
  const convId = randomUUID();
  createdConvs.push(convId);
  return convId;
}

after(async () => {
  if (!hasRuntimeEnv) return;
  const { redis } = await import("../src/redis.ts");
  const { pool } = await import("../src/db.ts");
  const { shutdownSessions } = await import("../src/core/agent.ts");

  // 租约键是本文件唯一的 Redis 残留（令牌没造，会话行没建）。
  const keys = createdConvs.map((convId) => `conv:${convId}:lease`);
  if (keys.length > 0) await redis.del(...keys).catch(() => undefined);

  // 池里的 session 必须 dispose：不关会把 SDK 定时器带出测试进程。
  shutdownSessions();
  await redis.quit().catch(() => undefined);
  // pg 的空闲连接 idleTimeoutMillis = 30s，不 end 就是跑完再白等 30 秒才退出。
  await pool.end().catch(() => undefined);
});

/** 轮询到条件成立（租约是 fire-and-forget 写的，不能假设 acquire 一返回键就在）。 */
async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/* ────────────────────────── ④ 连发：发送方式 ────────────────────────── */

test("chooseSendMode：streaming 时只能是 steer（06 §6.2 的连发保护）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { chooseSendMode } = await import("../src/core/agent.ts");

  // 这两行就是规格 §6.2 的全部内容：streaming 时 `prompt()` 会 reject，必须换成 steer。
  assert.equal(chooseSendMode(true), "steer", "流式途中再发一条必须走插入分支");
  assert.equal(chooseSendMode(false), "prompt", "没有流在跑就走正常发送");
});

/* ────────────────────────── ① 上限 5 ────────────────────────── */

test("上限 5：5 个不同会话都拿到 session，第 6 个是 SESSION_BUSY；复用不占额度", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { acquireSession, poolStats, shutdownSessions } = await import("../src/core/agent.ts");
  const { isAppError } = await import("../src/errors.ts");

  // 从干净的池开始：前序用例（如果有）不该影响"第 6 个被拒"。
  shutdownSessions();
  assert.equal(poolStats().size, 0);
  assert.equal(poolStats().limit, 5, "上限必须是 5（PARALLEL_LIMIT）");

  const convs = Array.from({ length: 5 }, () => newConvId());
  const sessions: unknown[] = [];
  for (const convId of convs) {
    const acquired = await acquireSession(convId, "de");
    assert.equal(acquired.reused, false, `${convId} 是首轮，应该是新建`);
    sessions.push(acquired.session);
  }
  assert.equal(poolStats().size, 5, "5 个不同会话应全部在池里");
  assert.equal(poolStats().assembling, 0, "装配结束后不该有残留的装配中会话");

  // 复用：同一个 conv 再取一次，必须还是那一个 session，reused = true。
  const reused = await acquireSession(convs[0], "en");
  assert.equal(reused.reused, true, "已存在的会话必须标记为复用");
  assert.equal(reused.session, sessions[0], "复用必须返回同一个 AgentSession，不是新装的");
  assert.equal(poolStats().size, 5, "复用不得让池变大（否则上限形同虚设）");

  // 第 6 个**不同**会话：池满，必须是可识别的 SESSION_BUSY（HTTP 层映射 503）。
  const sixth = newConvId();
  await assert.rejects(
    () => acquireSession(sixth, "de"),
    (err: unknown) => {
      assert.ok(isAppError(err), `必须是 AppError，实际 ${String(err)}`);
      assert.equal(err.code, "SESSION_BUSY");
      assert.equal(err.status, 503, "SESSION_BUSY 对外必须是 503（前端据此显示排队）");
      return true;
    },
    "第 6 个不同会话应被上限拒绝",
  );
  assert.equal(poolStats().size, 5, "被拒的第 6 个会话不得进池");
  assert.ok(!poolStats().convs.includes(sixth), "被拒的 conv 不得出现在池里");
});

/* ────────────────────────── ② 闲置 10 分钟回收 ────────────────────────── */

test("闲置回收：差 1ms 不回收，超过 SESSION_IDLE_MS 全部释放，且释放后额度回来了", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { acquireSession, poolStats, reapIdle, shutdownSessions } = await import("../src/core/agent.ts");

  const idleMs = poolStats().idleMs;
  assert.equal(idleMs, 600_000, "闲置阈值必须是 10 分钟（SESSION_IDLE_MS）");

  // 自己造满 5 个会话（不蹭上一个用例的残留）：边界断言需要知道 `lastActiveAt` 的下界。
  shutdownSessions();
  const base = Date.now();
  for (let index = 0; index < 5; index += 1) await acquireSession(newConvId(), "de");
  const afterAll = Date.now();
  assert.equal(poolStats().size, 5, "5 个会话应全部在池里");

  // 时钟是入参：这里的 `now` 就是定时器调用的那一个参数（每 60s 走一次 `reapIdle`）。
  // 每个会话的 lastActiveAt 都 ≥ base，所以 now = base + idleMs - 1 时"已闲置"永远差 1ms。
  reapIdle(base + idleMs - 1);
  assert.equal(poolStats().size, 5, "差 1ms 到 10 分钟，一个都不该回收");

  // 反过来：lastActiveAt ≤ afterAll，所以 now = afterAll + idleMs + 1 时每个都已过期。
  reapIdle(afterAll + idleMs + 1);
  assert.equal(poolStats().size, 0, "超过 10 分钟，5 个会话应全部释放");
  assert.deepEqual(poolStats().convs, [], "池必须真的为空");

  // 回收的意义是"额度回来了"：池满时被拒的那个会话，回收后应该能建起来。
  const fresh = newConvId();
  const acquired = await acquireSession(fresh, "de");
  assert.equal(acquired.reused, false, "回收后的新会话应是新建");
  assert.equal(poolStats().size, 1);

  // 跑着的那一轮**绝不能**被回收：中途 dispose 等于把客服正在看的答案掐断。
  // 判据用 onEvent 而不是轮询 `busy` —— onEvent 回调只在"这一轮已经锁住会话"时才会被调，
  // 所以这里的时机是确定的，不靠 sleep 猜。推一个远超阈值的时间戳，剩下的只可能是
  // `busy` 这条跳过规则在起作用。
  const { runTurn } = await import("../src/core/agent.ts");
  let convStillThere = false;
  let busyDuringTurn = 0;
  const result = await runTurn({
    convId: fresh,
    text: "Wie hoch ist die Garantie?",
    lang: "de",
    buffer: { citations: [] },
    onEvent: () => {
      reapIdle(Date.now() + idleMs * 10);
      busyDuringTurn = poolStats().busy;
      convStillThere = poolStats().convs.includes(fresh);
    },
  });
  assert.equal(busyDuringTurn, 1, "一轮对话进行中，池里应有 1 个 busy 会话");
  assert.equal(convStillThere, true, "跑着的会话不得被回收（否则答案会被掐断）");
  assert.equal(poolStats().busy, 0, "一轮结束后 busy 必须复位，否则这个会话永远不会被回收");
  assert.ok(poolStats().convs.includes(fresh), "跑完的会话仍在池里（等 10 分钟闲置才回收）");
  assert.ok(result.latencyMs >= 0);
});

/* ────────────────────────── ③ Redis 租约 600s ────────────────────────── */

test("租约：conv:<id>:lease 的 TTL 落在 (0, 600]（只作跨请求提示）", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { acquireSession, LEASE_TTL_SEC } = await import("../src/core/agent.ts");
  const { redis } = await import("../src/redis.ts");

  assert.equal(LEASE_TTL_SEC, 600, "租约 TTL 必须是 600 秒（02 §4）");

  const convId = newConvId();
  await acquireSession(convId, "de");
  const key = `conv:${convId}:lease`;

  // 租约是 `void refreshLease()` 写的（不能占住对话主链路），所以要轮询而不是立即断言。
  const ttl = await waitFor(async () => {
    const value = await redis.ttl(key);
    return value > 0 ? value : undefined;
  });
  assert.equal(await redis.exists(key), 1, "acquire 之后租约键必须存在");
  assert.ok(ttl > 0 && ttl <= 600, `TTL 应在 (0, 600]，实际 ${ttl}`);

  // 续租：复用时再写一次，TTL 仍然 ≤ 600（不会因为续租变成无限）。
  await acquireSession(convId, "de");
  const renewed = await waitFor(async () => {
    const value = await redis.ttl(key);
    return value > 0 ? value : undefined;
  });
  assert.ok(renewed > 0 && renewed <= 600, `续租后 TTL 仍应在 (0, 600]，实际 ${renewed}`);
  // 值不重要（只是一个"见过"的标记），这里只钉它非空，免得把实现细节写进断言。
  assert.notEqual(await redis.get(key), null);
});

/**
 * Redis 挂掉时的一轮对话（子进程）。
 *
 * 为什么起子进程：`refreshLease` 里的失败分支用 `import` 绑定，本进程内没有干净的替换点；
 * 而"把 URL 指到一个关着的端口"是最接近线上事故的模拟 —— ioredis 会一直重连、命令 reject，
 * 与"Redis 容器被摘掉"的表现一致。子进程用完即弃，也不会污染本进程的 redis 客户端。
 */
test("Redis 不可达时一轮对话照常完成：没有 error 事件，只有 warn 日志", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const convId = newConvId();

  // 子进程脚本是纯 JS（无类型）：`-e` 的代码不经过 type stripping，import .ts 靠 Node 的类型剥离。
  const script = `
const { pathToFileURL } = await import("node:url");
const { runTurn } = await import(pathToFileURL(process.env.WT_REPO_ROOT + "/src/core/agent.ts").href);
const events = [];
const result = await runTurn({
  convId: process.env.WT_CONV_ID,
  text: "Wie hoch ist die Garantie?",
  lang: "de",
  onEvent: (event) => events.push(event),
  buffer: { citations: [] },
});
process.stdout.write("\\nWT_RESULT " + JSON.stringify({ events, chars: result.text.length }) + "\\n");
// Redis 客户端在无限重连，正常退出会被它拖住；结论已经打出来了，直接退。
process.exit(0);
`;

  const run = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        cwd: repoRoot,
        env: {
          ...process.env,
          // 关着的端口：config 只校验"非空"，所以这里能走到真正的连接失败分支。
          REDIS_URL: "redis://:outage@127.0.0.1:1",
          LLM_PROVIDER: "mock",
          WT_REPO_ROOT: repoRoot,
          WT_CONV_ID: convId,
        },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`子进程 90s 未结束；stdout 尾部：${stdout.slice(-800)}`));
      }, 90_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`子进程退出码 ${String(code)}；stderr 尾部：${stderr.slice(-800)}`));
          return;
        }
        resolve(stdout);
      });
    });

  const stdout = await run();
  const line = stdout
    .split(/\r?\n/)
    .filter((candidate) => candidate.startsWith("WT_RESULT "))
    .at(-1);
  assert.ok(line !== undefined, `子进程没有输出结果行；stdout 尾部：${stdout.slice(-800)}`);

  const payload = JSON.parse(line.slice("WT_RESULT ".length)) as {
    events: { type: string; code?: string }[];
    chars: number;
  };
  const errors = payload.events.filter((event) => event.type === "error");
  assert.deepEqual(errors, [], `Redis 挂了不该产生 error 事件，实际：${JSON.stringify(errors)}`);
  // mock 路径必然发一次 kb_search（检索不依赖 Redis）：证明这一轮真的跑完了，不是空转。
  assert.ok(
    payload.events.some((event) => event.type === "tool"),
    `一轮对话应有 tool 事件，实际：${JSON.stringify(payload.events.map((event) => event.type))}`,
  );
  assert.ok(payload.chars > 0, "正文不应为空（mock 正文来自检索候选）");
  // 子进程日志里必须有 warn：静默降级是禁止的（18 §1 第四类错误）。
  assert.match(stdout, /session lease refresh failed|redis error/, "Redis 失败必须留下 warn 日志");
});

/* ────────────────────────── ④ 连发：mock 下连发两轮 ────────────────────────── */

test("mock 连发：同一会话两轮并行发起，都正常收尾且事件序列里没有 error", async (t) => {
  if (!hasRuntimeEnv) {
    t.skip(missingRuntimeEnvHint);
    return;
  }
  const { runTurn, poolStats } = await import("../src/core/agent.ts");

  const convId = newConvId();
  // 共享一条时间线：`turn` 标记这一帧属于哪一轮，用来证明两轮是**串行**的（各自成块，不交错）。
  const timeline: { turn: 1 | 2; type: TurnEvent["type"] }[] = [];
  // 两个 buffer 是"两轮各自的候选落点"，不能共用：共用就是真实世界里的串 buffer。
  const buffers: TurnBuffer[] = [{ citations: [] }, { citations: [] }];

  const turn = (index: 0 | 1, text: string) =>
    runTurn({
      convId,
      text,
      lang: "de",
      onEvent: (event) => timeline.push({ turn: index === 0 ? 1 : 2, type: event.type }),
      buffer: buffers[index],
    });

  // 两轮同时发起：池里还没有这个 conv，等于考"首轮并发到达"那条路（装配去重）。
  const [first, second] = await Promise.all([turn(0, "Wie hoch ist die Garantie?"), turn(1, "Und die Anmeldung?")]);

  const errors = timeline.filter((frame) => frame.type === "error");
  assert.deepEqual(errors, [], `连发不该产生 error 事件，实际：${JSON.stringify(errors)}`);

  // 两轮都正常 resolve（不是抛错、不是空转）：latency/tokens 都是数。
  for (const [index, result] of [first, second].entries()) {
    assert.equal(typeof result.latencyMs, "number", `第 ${index + 1} 轮应有 latencyMs`);
    assert.ok(result.latencyMs >= 0);
    assert.equal(typeof result.tokens, "number");
  }

  // 串行化：两轮各自成块，**不交错**（slot.buffer 与 subscribe 都是单轮语义）。
  // 不断言"先 1 后 2"：并发发起时谁先拿到 gate 取决于微任务顺序，那是实现细节，
  // 真正的契约是"不会两轮同时写同一个 slot"，等价于时间线上只有一次轮次切换。
  const sequence = timeline.map((frame) => frame.turn);
  const switches = sequence.filter((turn, index) => index > 0 && turn !== sequence[index - 1]).length;
  assert.ok(sequence.includes(1) && sequence.includes(2), `两轮都应有事件，实际：${JSON.stringify(timeline)}`);
  assert.equal(switches, 1, `两轮必须串行且各自成块，实际事件序列：${JSON.stringify(timeline)}`);

  // 同一个 conv 只应有一个 session：并发的两轮没有各装一个（那是内存与账单的双倍开销）。
  assert.equal(
    poolStats().convs.filter((id) => id === convId).length,
    1,
    `同一 conv 在池里只能有一条，实际：${JSON.stringify(poolStats().convs)}`,
  );

  // mock 每轮都会真跑一次 kb_search：两轮各一个 tool 事件。
  assert.equal(
    timeline.filter((frame) => frame.type === "tool").length,
    2,
    `两轮应各发一次 tool 事件，实际：${JSON.stringify(timeline)}`,
  );
});
