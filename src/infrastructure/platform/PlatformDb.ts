import type pg from "pg";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";
import type { Queryable } from "../database/postgres/Queryable.js";

/**
 * Query access to the platform database for platform repositories: inside a platform unit of
 * work it uses that transaction, otherwise the pool (single-statement reads and writes).
 * Uses its own transaction context, separate from the tenant one.
 */
export class PlatformDb implements Queryable {
  constructor(
    private readonly pool: pg.Pool,
    readonly transactions: PostgresTransactionContext,
  ) {}

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>> {
    const target: Queryable = this.transactions.hasTransaction()
      ? this.transactions.current()
      : this.pool;
    return target.query<R>(text, params);
  }
}
