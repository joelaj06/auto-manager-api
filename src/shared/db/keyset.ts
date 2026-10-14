import pg from "pg";

/**
 * Keyset (cursor) pagination helpers. Instead of OFFSET, each page continues after the last
 * row of the previous one, so pages stay fast and stable while rows are being inserted.
 *
 * The sort must end with a unique column (usually `id`) so the order is total.
 */

export type SortDirection = "asc" | "desc";

export type KeysetColumn = Readonly<{
  /** Column name or qualified name (e.g. "v.created_at"); must come from code, never from input. */
  column: string;
  direction: SortDirection;
}>;

export type CursorValue = string | number | boolean | null;

export class InvalidCursorError extends Error {
  readonly code = "INVALID_CURSOR";

  constructor() {
    super("The pagination cursor is invalid or expired");
    this.name = "InvalidCursorError";
  }
}

export function encodeCursor(values: readonly CursorValue[]): string {
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, expectedLength: number): CursorValue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.length === expectedLength &&
    parsed.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
  if (!valid) throw new InvalidCursorError();
  return parsed as CursorValue[];
}

const COLUMN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

function quoteColumn(column: string): string {
  if (!COLUMN.test(column)) throw new Error(`Invalid keyset column: ${column}`);
  return column
    .split(".")
    .map((part) => pg.escapeIdentifier(part))
    .join(".");
}

export type KeysetQueryParts = Readonly<{
  /** Condition selecting rows after the cursor, or "true" for the first page. */
  where: string;
  orderBy: string;
  params: CursorValue[];
}>;

/**
 * Builds the WHERE condition and ORDER BY for a page. Placeholders start at `$<firstParam>` so
 * the result can be appended to a query that already has parameters.
 *
 * For columns (a desc, id desc) and cursor [x, y] the condition is
 * (a < x) or (a = x and id < y).
 */
export function keysetQueryParts(
  columns: readonly KeysetColumn[],
  cursor: readonly CursorValue[] | null,
  firstParam = 1,
): KeysetQueryParts {
  if (columns.length === 0) throw new Error("Keyset pagination needs at least one column");
  const quoted = columns.map((c) => ({ ...c, sql: quoteColumn(c.column) }));
  const orderBy = quoted.map((c) => `${c.sql} ${c.direction}`).join(", ");

  if (cursor === null) return { where: "true", orderBy, params: [] };
  if (cursor.length !== columns.length) throw new InvalidCursorError();

  const placeholder = (i: number) => `$${firstParam + i}`;
  const branches = quoted.map((column, i) => {
    const equalities = quoted.slice(0, i).map((prev, j) => `${prev.sql} = ${placeholder(j)}`);
    const comparison = `${column.sql} ${column.direction === "asc" ? ">" : "<"} ${placeholder(i)}`;
    return `(${[...equalities, comparison].join(" and ")})`;
  });

  return { where: `(${branches.join(" or ")})`, orderBy, params: [...cursor] };
}

export type Page<T> = Readonly<{ items: T[]; nextCursor: string | null }>;

/**
 * Turns `limit + 1` fetched rows into a page: the extra row only signals that another page
 * exists. `cursorOf` returns the sort-column values of a row, in the same order as the columns.
 */
export function toPage<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (row: T) => readonly CursorValue[],
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const hasMore = rows.length > limit;
  return { items, nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null };
}
