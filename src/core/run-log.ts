/**
 * 运行记账（`06-agent.md` §9）。
 *
 * 一轮对话结束后落一条 `ai_runs`，同时把 token/成本累加到 `conversations`。
 * 两件事必须在**同一个事务**里：只写 `ai_runs` 而没加上累计值，会话统计就永久偏低；
 * 只加累计值而没有 `ai_runs`，"这笔钱是哪一轮花的"就查不回来了。半条记录比没有记录更难查。
 *
 * 记账失败**不向上抛**：这段代码跑在 SSE 的收尾流程里，抛出去会把一条已经生成好的回答
 * 变成 `error` 事件 —— 用户看得见的东西不该被一本账搞坏。但也不许静默：
 * 记账烂掉意味着成本报表与拒答率统计开始悄悄失真，必须留下 `logger.error` 的痕迹。
 */
import { tx } from "../db.ts";
import { logger } from "../logger.ts";

/** `06-agent.md` §9 的 Flash 单价（美元 / 百万 token）。 */
const INPUT_USD_PER_MTOK = 0.3;
const OUTPUT_USD_PER_MTOK = 1.2;

/**
 * 模型单价换算。
 * 保持纯函数、不做四舍五入：落库的 `numeric(10,6)` 本来就会截到 6 位，
 * 在这里再截一次只会让"调用方算的钱"和"库里记的钱"出现两处口径。
 */
export function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1e6) * INPUT_USD_PER_MTOK + (outputTokens / 1e6) * OUTPUT_USD_PER_MTOK;
}

/**
 * mock 模式没有 `usage` 时按字符数粗估：`tokens ≈ chars / 3`（`06-agent.md` §9 末行）。
 *
 * 用 ceil 而不是 round：空以外的任何一段文本都至少记 1 个 token。
 * round 会把 1–2 个字符的回答记成 0，累计出"这轮没花钱"的假象。
 * 这只是 mock 的兜底值，不承担"精确计费"的责任 —— 真实用量永远优先取 `usage`。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface RunRecord {
  convId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  refused: boolean;
  /** 本轮工具调用轨迹，落 `ai_runs.tool_calls`（jsonb 数组）。 */
  toolCalls?: { name: string; ms: number }[];
}

/**
 * 一轮结束后记账：插入 `ai_runs` + 累加 `conversations` 的 token/成本 + 刷新 `last_active_at`。
 *
 * 只写 `001_init.sql` 里真实存在的列：`message_id` / `intent` 这两个可空列不入参，
 * 因为调用方（`api/chat.ts`）此刻未必已经把消息落库拿到 id，塞 null 进去只会造出
 * "有运行记录但挂不上消息"的半残行；需要时由上层补一条 update，不在这里猜。
 */
export async function recordRun(input: RunRecord): Promise<void> {
  try {
    await tx(async (client) => {
      // tool_calls 是 jsonb：`pg` 会把 JS 数组序列化成 Postgres 数组字面量 `{...}`，
      // 往 jsonb 列里塞会直接报类型错误，所以必须显式 JSON.stringify。
      await client.query(
        `insert into ai_runs
           (conv_id, model, tool_calls, input_tokens, output_tokens, cost_usd, latency_ms, refused)
         values ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)`,
        [
          input.convId,
          input.model,
          JSON.stringify(input.toolCalls ?? []),
          input.inputTokens,
          input.outputTokens,
          input.costUsd,
          input.latencyMs,
          input.refused,
        ],
      );

      // 累计值用 `+ $n` 而不是读改写：并发的两轮会互相覆盖，而且这里是同一行热更新，
      // 交给数据库做加法天然串行。last_active_at 也在这里刷新 —— 会话回收（10 分钟闲置）
      // 依据的就是这一列，漏刷会把还在聊的会话判成闲置。
      await client.query(
        `update conversations
            set total_tokens   = total_tokens + $2,
                total_cost_usd = total_cost_usd + $3,
                last_active_at = now()
          where id = $1`,
        [input.convId, input.inputTokens + input.outputTokens, input.costUsd],
      );
    });
  } catch (err) {
    // 只记不抛（见文件头）。带上 conv_id 才能在日志里定位是哪一轮烂掉了；
    // 不记 prompt/回答原文 —— 日志会被贴进评审记录（logger 的脱敏口径）。
    logger.error({ err, convId: input.convId, model: input.model }, "run-log: 记账失败（本轮回答照常返回）");
  }
}
