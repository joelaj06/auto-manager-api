import type pg from "pg";

/**
 * The SQL surface infrastructure code works with: run a parameterised query. Implemented by
 * transaction handles and pools; never exposes connection lifecycle methods.
 */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}
