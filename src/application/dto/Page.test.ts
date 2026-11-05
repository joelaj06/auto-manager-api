import { describe, expect, it } from "vitest";
import { pageOf, pageWindow, slicePage } from "./Page.js";

describe("pageWindow", () => {
  it("starts page 1 at the first row", () => {
    expect(pageWindow({ page: 1, pageSize: 20 })).toEqual({ limit: 20, offset: 0 });
  });

  it("skips the pages before the one asked for", () => {
    expect(pageWindow({ page: 4, pageSize: 25 })).toEqual({ limit: 25, offset: 75 });
  });
});

describe("pageOf", () => {
  const request = { page: 2, pageSize: 2 };

  it("carries the rows, total and request", () => {
    expect(pageOf(request, { rows: ["a", "b"], total: 5 })).toEqual({
      items: ["a", "b"],
      total: 5,
      page: 2,
      pageSize: 2,
    });
  });

  it("maps each row to its view", () => {
    expect(pageOf(request, { rows: [1, 2], total: 2 }, (n) => n * 10).items).toEqual([10, 20]);
  });
});

describe("slicePage", () => {
  const rows = [1, 2, 3, 4, 5];

  it("cuts a page out of rows in hand and keeps their total", () => {
    expect(slicePage({ page: 2, pageSize: 2 }, rows)).toEqual({
      items: [3, 4],
      total: 5,
      page: 2,
      pageSize: 2,
    });
  });

  it("is empty past the end", () => {
    expect(slicePage({ page: 9, pageSize: 2 }, rows)).toMatchObject({ items: [], total: 5 });
  });
});
