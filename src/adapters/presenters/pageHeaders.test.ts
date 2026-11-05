import { describe, expect, it } from "vitest";
import { pageHeaders, PAGE_HEADERS } from "./pageHeaders.js";

describe("pageHeaders", () => {
  it("names the total, page and page size as text", () => {
    expect(pageHeaders({ total: 123, page: 3, pageSize: 25 })).toEqual({
      "X-Total-Count": "123",
      "X-Page": "3",
      "X-Page-Size": "25",
    });
  });

  it("gives a header for every name the browser is allowed to read", () => {
    expect(Object.keys(pageHeaders({ total: 0, page: 1, pageSize: 20 })).sort()).toEqual(
      [...PAGE_HEADERS].sort(),
    );
  });
});
