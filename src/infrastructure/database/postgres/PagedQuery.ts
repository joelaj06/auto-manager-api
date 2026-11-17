import type pg from "pg";
import type { ListSums, Paged, PageWindow, Summed } from "../../../domain/value-objects/Paged.js";

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

/**
 * What to add up over a whole list. Each is an SQL expression over the columns the list's query
 * selects (as `listed`), in minor units of one currency: the main `amount`, the `status` it is
 * broken down by, and other `measures`.
 */
export type SumsQuery = Readonly<{
  amount?: string;
  status?: string;
  measures?: Readonly<Record<string, string>>;
}>;

/** Adds up a list's rows, grouped by status, which also counts them. */
export async function listSums(
  db: Queryable,
  query: Readonly<{ sql: string; params: readonly unknown[] }>,
  sums: SumsQuery,
): Promise<ListSums & Readonly<{ count: number }>> {
  const names = Object.keys(sums.measures ?? {});
  const measureColumns = names.map(
    (name, i) => `, coalesce(sum(${sums.measures?.[name]}), 0)::text as m${i}`,
  );
  const { rows } = await db.query<Record<string, string | null>>(
    `select ${sums.status ?? "null"}::text as status, count(*)::text as n,
            coalesce(sum(${sums.amount ?? "0"}), 0)::text as amount${measureColumns.join("")}
       from (${query.sql}) listed
      group by 1`,
    [...query.params],
  );
  let count = 0;
  let amount = 0;
  const byStatus: Record<string, number> = {};
  const measures: Record<string, number> = Object.fromEntries(names.map((name) => [name, 0]));
  for (const row of rows) {
    const value = Number(row.amount ?? 0);
    count += Number(row.n ?? 0);
    amount += value;
    if (row.status !== null && row.status !== undefined)
      byStatus[row.status] = (byStatus[row.status] ?? 0) + value;
    names.forEach((name, i) => {
      measures[name] = (measures[name] ?? 0) + Number(row[`m${i}`] ?? 0);
    });
  }
  return { count, amount, byStatus, measures };
}

/** One window of a query, the size of the whole list and its sums. */
export async function summedPagedQuery<R extends pg.QueryResultRow>(
  db: Queryable,
  query: Readonly<{ sql: string; orderBy: string; params: readonly unknown[] }>,
  window: PageWindow,
  sums: SumsQuery,
): Promise<Summed<R>> {
  const { sql, orderBy, params } = query;
  const { limit, offset = 0 } = window;
  const { rows } = await db.query<R>(
    `${sql} order by ${orderBy} limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, offset],
  );
  const { count, ...totals } = await listSums(db, { sql, params }, sums);
  return { rows, total: count, sums: totals };
}
