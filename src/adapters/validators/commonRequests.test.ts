import { describe, expect, it } from "vitest";
import { idParams, paginationQuery } from "./commonRequests.js";

describe("paginationQuery", () => {
  it("defaults the limit and coerces strings", () => {
    expect(paginationQuery.parse({})).toEqual({ limit: 20 });
    expect(paginationQuery.parse({ limit: "50", cursor: "abc" })).toEqual({
      limit: 50,
      cursor: "abc",
    });
  });

  it.each([{ limit: "0" }, { limit: "101" }, { limit: "2.5" }, { cursor: "" }])(
    "rejects %j",
    (query) => {
      expect(paginationQuery.safeParse(query).success).toBe(false);
    },
  );
});

describe("idParams", () => {
  it("accepts UUIDs only", () => {
    expect(idParams.safeParse({ id: "0199e1c2-7a3b-7f1e-9a4c-8d2e5f6a7b8c" }).success).toBe(true);
    expect(idParams.safeParse({ id: "42" }).success).toBe(false);
  });
});
