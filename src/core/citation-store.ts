/**
 * 引用快照落库（`05-api.md` §4 / §5.5、`05-refusal-and-tickets` T06）。
 *
 * 只做一件事：把一次回答的引用**快照**写进 `citations`，并把 `messages.citations_count`
 * 刷成同一个数。不做引用校验 —— 校验（角标是否落在本轮候选序号集合内）发生在收尾流程里，
 * 顺序不能反：先校验再落库，落进来的每一行才都是"正文里真的出现过"的引用。
 *
 * 为什么是快照而不是外键引用片段的可读视图：`chunks` 会在每次灌语料时先删后建，
 * 片段 id 与正文都可能变。历史回答里的角标必须永远点得开，所以
 * doc_title / doc_lang / page / snippet / score 落库即冻结 —— 片段行没了（`on delete set null`）
 * 也不影响"这句话出自哪份文档第几页"这个事实。
 */
import type { PoolClient } from "pg";
import { tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { logger } from "../logger.ts";
import type { Citation } from "./citations.ts";

/**
 * 把不存在的 `chunk_id` 置空。
 *
 * 为什么需要：`citations.chunk_id` 有外键。检索发生在几十毫秒之前，而灌语料是"先删后建"，
 * 两者撞上时那个片段已经不在了 —— 外键会抛 23503 把整批快照打回 500，
 * 用户看到的就是一条本该有引用的回答突然变成没有角标。快照本来就不依赖片段存活
 * （见文件头），所以这里把对不上的 id 落成 null：丢一个跳转锚点，保住整条引用。
 * 不能放在 insert 之后补救：整条 insert 会失败，没有"之后"。
 */
async function nullOutMissingChunks(client: PoolClient, chunkIds: (number | null)[]): Promise<Set<string>> {
  const present = new Set<string>();
  const ids = chunkIds.filter((id): id is number => id !== null);
  if (ids.length === 0) return present;

  const result = await client.query<{ id: string }>("select id from chunks where id = any($1::bigint[])", [ids]);
  for (const row of result.rows) present.add(row.id);
  return present;
}

/**
 * 一次批量写入引用快照并回填 `messages.citations_count`；同一事务，可重复执行。
 *
 * **必须整批在同一个 `tx()` 里**：引用行与消息上的计数是同一件事的两个视图。
 * 只写了行没刷计数，历史回放里消息会显示"无引用"；只刷了计数没写行，
 * 前端按计数画出的角标点开是空的。半条记录比没有记录更难查。
 *
 * 幂等靠 **先删后插**：收尾步骤可能被 SSE 重连重放（同一条 assistant 消息会被再 finalize 一次），
 * 若只做追加，同一条消息的 `citations` 会留下两份快照，前端角标列表就重复一遍，
 * 且 `citations_count` 会翻倍。删除与插入在同一事务里，重试要么整体生效要么整体回滚，
 * 不会出现"删了一半"的中间态。`citations` 空数组也是合法输入：
 * 拒答/无引用的回答需要把计数归零（先删旧行，写 0）。
 *
 * 入参假定**已校验**（`idx ≥ 1`、字段类型、`citations.length ≤ 20` 由路由层把关）：
 * 这一层再校验一次只会造出两份口径。
 */
export async function saveCitations(input: {
  messageId: number;
  citations: readonly Citation[];
}): Promise<{ inserted: number }> {
  const { messageId, citations } = input;

  return tx(async (client) => {
    // `messages.id` 不存在时外键会抛 23503，被统一错误处理器翻成 500 —— 但调用方是我们自己的
    // 收尾流程，id 错是**我们的 bug**，400 在日志里一眼能认出，500 只会被当成数据库故障。
    // `for update` 顺带把并发重试串起来：两条重试若交错执行（都 delete 完再各自 insert），
    // 先删后插的幂等就失效了，而二次插入的重复快照正是这个函数最不能产出的东西。
    const message = await client.query("select 1 from messages where id = $1::bigint for update", [messageId]);
    if (message.rowCount === 0) {
      throw new AppError("VALIDATION", `message_id ${messageId} 不存在`);
    }

    // 先删（见上方幂等说明）。删掉的是**这条消息的**旧快照，与消息存在性检查同事务。
    await client.query("delete from citations where message_id = $1::bigint", [messageId]);

    let inserted = 0;
    if (citations.length > 0) {
      const presentChunks = await nullOutMissingChunks(
        client,
        citations.map((citation) => citation.chunk_id),
      );

      // 七个数组一起 unnest：一条语句写完 N 条快照。列顺序 = 参数顺序，逐项对齐。
      const chunkIds = citations.map((citation) =>
        citation.chunk_id !== null && presentChunks.has(String(citation.chunk_id)) ? citation.chunk_id : null,
      );
      const result = await client.query(
        `insert into citations (message_id, idx, chunk_id, doc_title, doc_lang, page, snippet, score)
         select $1::bigint,
                batch.idx,
                batch.chunk_id,
                batch.doc_title,
                batch.doc_lang::char(2),
                batch.page,
                batch.snippet,
                batch.score
           from unnest($2::int[], $3::bigint[], $4::text[], $5::text[], $6::int[], $7::text[], $8::real[])
                  as batch(idx, chunk_id, doc_title, doc_lang, page, snippet, score)`,
        [
          messageId,
          citations.map((citation) => citation.idx),
          chunkIds,
          citations.map((citation) => citation.doc_title),
          citations.map((citation) => citation.doc_lang),
          citations.map((citation) => citation.page),
          citations.map((citation) => citation.snippet),
          citations.map((citation) => citation.score),
        ],
      );
      inserted = result.rowCount ?? 0;
    }

    // 计数用**实际插入行数**而不是入参长度：这两个数在数据库层面必须相等，
    // 若因为某种原因不等，计数该跟着库里的行数走（前端按它画角标）。
    if (inserted !== citations.length) {
      logger.warn(
        { messageId, expected: citations.length, inserted },
        "citation-store: 插入行数与入参长度不一致",
      );
    }

    // 同一个事务：计数与行数要么一起生效，要么一起回滚（见函数头）。
    await client.query("update messages set citations_count = $2 where id = $1::bigint", [messageId, inserted]);

    return { inserted };
  });
}
