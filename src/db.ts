import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config.ts";
import { logger } from "./logger.ts";

// 全仓唯一的 Pool 实例：其他模块只能 query/one/tx，业务代码不得 new Pool
// （02-architecture.md §2.1）。超时取 17-ai-brief.md §7 的 "DB 3s"。
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 3_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 3_000,
});

// 空闲连接被服务端掐断时 pg 会 emit error；不接住就是进程级未捕获异常。
pool.on("error", (err) => {
  logger.error({ err }, "pg pool idle client error");
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch((rollbackErr: unknown) => {
      logger.error({ err: rollbackErr }, "rollback failed");
    });
    throw err;
  } finally {
    client.release();
  }
}
