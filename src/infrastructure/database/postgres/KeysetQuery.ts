import pg from "pg";
import { InvalidCursorError } from "../../../application/errors/PaginationErrors.js";
import type { CursorValue } from "../../../application/services/PageCursor.js";

export type SortDirection = "asc" | "desc";

export type KeysetColumn = Readonly<{
  /** Column or qualified name (e.g. "v.created_at"); must come from code, never from input. */
  column: string;
  direction: SortDirection;
}>;

export type KeysetQueryParts = Readonly<{
  /** Condition selecting rows after the cursor, or "true" for the first page. */
  where: string;
  orderBy: string;
  params: CursorValue[];
}>;

const COLUMN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/**
 * SQL for keyset (cursor) pagination: each page continues after the last row of the previous
 * one, so pages stay fast and stable while rows are inserted.
 *
 * The sort columns must be NOT NULL and end with a unique column (usually `id`).
 */
export class KeysetQuery {
  private readonly columns: readonly (KeysetColumn & { sql: string })[];

  constructor(columns: readonly KeysetColumn[]) {
    if (columns.length === 0) throw new Error("Keyset pagination needs at least one column");
    this.columns = columns.map((c) => ({ ...c, sql: KeysetQuery.quote(c.column) }));
  }

  get size(): number {
    return this.columns.length;
  }

  /**
   * WHERE condition and ORDER BY for the page after `cursor` (null = first page). Placeholders
   * start at `$<firstParam>` so the parts can be appended to a query that already has params.
   *
   * For (a desc, id desc) and cursor [x, y]: (a < x) or (a = x and id < y).
   */
  build(cursor: readonly CursorValue[] | null, firstParam = 1): KeysetQueryParts {
    const orderBy = this.columns.map((c) => `${c.sql} ${c.direction}`).join(", ");
    if (cursor === null) return { where: "true", orderBy, params: [] };
    if (cursor.length !== this.columns.length) throw new InvalidCursorError();

    const placeholder = (i: number) => `$${firstParam + i}`;
    const branches = this.columns.map((column, i) => {
      const equalities = this.columns
        .slice(0, i)
        .map((previous, j) => `${previous.sql} = ${placeholder(j)}`);
      const comparison = `${column.sql} ${column.direction === "asc" ? ">" : "<"} ${placeholder(i)}`;
      return `(${[...equalities, comparison].join(" and ")})`;
    });

    return { where: `(${branches.join(" or ")})`, orderBy, params: [...cursor] };
  }

  private static quote(column: string): string {
    if (!COLUMN.test(column)) throw new Error(`Invalid keyset column: ${column}`);
    return column
      .split(".")
      .map((part) => pg.escapeIdentifier(part))
      .join(".");
  }
}
