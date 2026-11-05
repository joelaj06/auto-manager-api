import type pg from "pg";
import type { Paged, PageWindow } from "../../../domain/value-objects/Paged.js";

type Queryable = Readonly<{
  query<R extends pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<Readonly<{ rows: R[] }>>;
}>;

/**
 * How many rows a list has, given the rows of one window of it. A short window that isn't empty
 * ends the list, so the total is known without counting; an empty one may be past the end.
 */
export async function pageTotal(
  db: Queryable,
  rowCount: number,
  { limit, offset = 0 }: PageWindow,
  /** The list's rows, without an order: `select … from … where …`, or a `count(*) as total`. */
  count: Readonly<{ sql: string; params: readonly unknown[] }>,
): Promise<number> {
  if (rowCount < limit && (rowCount > 0 || offset === 0)) return offset + rowCount;
  const { rows } = await db.query<{ total: string }>(count.sql, [...count.params]);
  return Number(rows[0]?.total ?? 0);
}

/**
 * One window of a query, and the size of the whole list. `orderBy` must end with a unique column
 * so that a row is on exactly one page.
 */
export async function pagedQuery<R extends pg.QueryResultRow>(
  db: Queryable,
  query: Readonly<{ sql: string; orderBy: string; params: readonly unknown[] }>,
  window: PageWindow,
): Promise<Paged<R>> {
  const { sql, orderBy, params } = query;
  const { limit, offset = 0 } = window;
  const { rows } = await db.query<R>(
    `${sql} order by ${orderBy} limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, offset],
  );
  return {
    rows,
    total: await pageTotal(db, rows.length, window, {
      sql: `select count(*) as total from (${sql}) listed`,
      params,
    }),
  };
}
