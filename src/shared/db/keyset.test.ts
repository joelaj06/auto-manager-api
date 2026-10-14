import { describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  keysetQueryParts,
  toPage,
} from "./keyset.js";

describe("cursor encoding", () => {
  it("round-trips values", () => {
    const values = ["2026-10-14T10:00:00.000Z", 42, true, null];
    expect(decodeCursor(encodeCursor(values), 4)).toEqual(values);
  });

  it.each([
    ["garbage", "%%%"],
    ["wrong length", encodeCursor(["a"])],
    ["non-array", Buffer.from('{"a":1}').toString("base64url")],
    ["nested object", encodeCursor([{} as never, 1])],
  ])("rejects %s", (_label, cursor) => {
    expect(() => decodeCursor(cursor, 2)).toThrow(InvalidCursorError);
  });
});

describe("keysetQueryParts", () => {
  const columns = [
    { column: "created_at", direction: "desc" as const },
    { column: "id", direction: "desc" as const },
  ];

  it("returns no condition for the first page", () => {
    expect(keysetQueryParts(columns, null)).toEqual({
      where: "true",
      orderBy: '"created_at" desc, "id" desc',
      params: [],
    });
  });

  it("builds a lexicographic condition after the cursor", () => {
    const parts = keysetQueryParts(columns, ["2026-10-14", "abc"]);
    expect(parts.where).toBe('(("created_at" < $1) or ("created_at" = $1 and "id" < $2))');
    expect(parts.params).toEqual(["2026-10-14", "abc"]);
  });

  it("supports mixed directions, qualified columns and a parameter offset", () => {
    const parts = keysetQueryParts(
      [
        { column: "v.status", direction: "asc" },
        { column: "v.id", direction: "desc" },
      ],
      ["active", "x"],
      3,
    );
    expect(parts.where).toBe('(("v"."status" > $3) or ("v"."status" = $3 and "v"."id" < $4))');
    expect(parts.orderBy).toBe('"v"."status" asc, "v"."id" desc');
  });

  it("rejects unsafe column names", () => {
    expect(() =>
      keysetQueryParts([{ column: "id; drop table x", direction: "asc" }], null),
    ).toThrow(/Invalid keyset column/);
  });

  it("rejects a cursor of the wrong length", () => {
    expect(() => keysetQueryParts(columns, ["only-one"])).toThrow(InvalidCursorError);
  });
});

describe("toPage", () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it("returns a next cursor when more rows exist", () => {
    const page = toPage(rows, 2, (row) => [row.id]);
    expect(page.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor ?? "", 1)).toEqual([2]);
  });

  it("returns no cursor on the last page", () => {
    expect(toPage(rows, 3, (row) => [row.id]).nextCursor).toBeNull();
  });
});
