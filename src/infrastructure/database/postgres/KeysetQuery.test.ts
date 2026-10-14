import { describe, expect, it } from "vitest";
import { InvalidCursorError } from "../../../application/errors/PaginationErrors.js";
import { KeysetQuery } from "./KeysetQuery.js";

const newestFirst = new KeysetQuery([
  { column: "created_at", direction: "desc" },
  { column: "id", direction: "desc" },
]);

describe("KeysetQuery", () => {
  it("returns no condition for the first page", () => {
    expect(newestFirst.build(null)).toEqual({
      where: "true",
      orderBy: '"created_at" desc, "id" desc',
      params: [],
    });
  });

  it("builds a lexicographic condition after the cursor", () => {
    const parts = newestFirst.build(["2026-10-14", "abc"]);
    expect(parts.where).toBe('(("created_at" < $1) or ("created_at" = $1 and "id" < $2))');
    expect(parts.params).toEqual(["2026-10-14", "abc"]);
  });

  it("supports mixed directions, qualified columns and a parameter offset", () => {
    const parts = new KeysetQuery([
      { column: "v.status", direction: "asc" },
      { column: "v.id", direction: "desc" },
    ]).build(["active", "x"], 3);
    expect(parts.where).toBe('(("v"."status" > $3) or ("v"."status" = $3 and "v"."id" < $4))');
    expect(parts.orderBy).toBe('"v"."status" asc, "v"."id" desc');
  });

  it("rejects unsafe column names", () => {
    expect(() => new KeysetQuery([{ column: "id; drop table x", direction: "asc" }])).toThrow(
      /Invalid keyset column/,
    );
  });

  it("rejects a cursor of the wrong length", () => {
    expect(() => newestFirst.build(["only-one"])).toThrow(InvalidCursorError);
  });
});
