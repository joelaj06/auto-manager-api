import type { Page } from "../dto/Page.js";
import { InvalidCursorError } from "../errors/PaginationErrors.js";

export type CursorValue = string | number | boolean | null;

/**
 * Opaque keyset-pagination cursor: the sort-column values of the last row of a page, encoded
 * as base64url JSON. Clients pass it back unchanged to get the next page.
 */
export class PageCursor {
  private constructor(readonly values: readonly CursorValue[]) {}

  static of(values: readonly CursorValue[]): PageCursor {
    return new PageCursor([...values]);
  }

  /** Decodes a client-supplied cursor; throws InvalidCursorError on anything malformed. */
  static parse(token: string, expectedLength: number): PageCursor {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    } catch {
      throw new InvalidCursorError();
    }
    const valid =
      Array.isArray(parsed) &&
      parsed.length === expectedLength &&
      parsed.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
    if (!valid) throw new InvalidCursorError();
    return new PageCursor(parsed as CursorValue[]);
  }

  /**
   * Builds a page from `limit + 1` fetched rows; the extra row only signals that another page
   * exists. `cursorOf` returns a row's sort-column values in sort order.
   */
  static paginate<T>(
    rows: readonly T[],
    limit: number,
    cursorOf: (row: T) => readonly CursorValue[],
  ): Page<T> {
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const hasMore = rows.length > limit;
    return {
      items,
      nextCursor: hasMore && last !== undefined ? PageCursor.of(cursorOf(last)).toString() : null,
    };
  }

  toString(): string {
    return Buffer.from(JSON.stringify(this.values), "utf8").toString("base64url");
  }
}
