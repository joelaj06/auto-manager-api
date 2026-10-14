import { describe, expect, it } from "vitest";
import { InvalidCursorError } from "../errors/PaginationErrors.js";
import { PageCursor } from "./PageCursor.js";

describe("PageCursor", () => {
  it("round-trips values", () => {
    const values = ["2026-10-14T10:00:00.000Z", 42, true, null];
    expect(PageCursor.parse(PageCursor.of(values).toString(), 4).values).toEqual(values);
  });

  it.each([
    ["garbage", "%%%"],
    ["wrong length", PageCursor.of(["a"]).toString()],
    ["non-array", Buffer.from('{"a":1}').toString("base64url")],
    ["nested object", Buffer.from("[{},1]").toString("base64url")],
  ])("rejects %s", (_label, token) => {
    expect(() => PageCursor.parse(token, 2)).toThrow(InvalidCursorError);
  });

  it("paginates with a next cursor when more rows exist", () => {
    const page = PageCursor.paginate([{ id: 1 }, { id: 2 }, { id: 3 }], 2, (row) => [row.id]);
    expect(page.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(PageCursor.parse(page.nextCursor ?? "", 1).values).toEqual([2]);
  });

  it("returns no cursor on the last page", () => {
    expect(PageCursor.paginate([{ id: 1 }], 1, (row) => [row.id]).nextCursor).toBeNull();
  });
});
