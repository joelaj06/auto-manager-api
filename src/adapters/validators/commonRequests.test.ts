import { describe, expect, it } from "vitest";
import { z } from "zod";
import { idParams, pageParams, paginationQuery } from "./commonRequests.js";

describe("paginationQuery", () => {
  it("defaults to the first page and coerces strings", () => {
    expect(paginationQuery.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(paginationQuery.parse({ page: "3", pageSize: "50" })).toEqual({ page: 3, pageSize: 50 });
  });

  it.each([
    { page: "0" },
    { page: "1.5" },
    { page: "1000001" },
    { pageSize: "0" },
    { pageSize: "101" },
    { pageSize: "2.5" },
  ])("rejects %j", (query) => {
    expect(paginationQuery.safeParse(query).success).toBe(false);
  });
});

describe("pageParams", () => {
  it("takes a route's own largest and default page size", () => {
    const query = z.object(pageParams(200, 50));
    expect(query.parse({})).toEqual({ page: 1, pageSize: 50 });
    expect(query.parse({ pageSize: "200" }).pageSize).toBe(200);
    expect(query.safeParse({ pageSize: "201" }).success).toBe(false);
  });
});

describe("idParams", () => {
  it("accepts UUIDs only", () => {
    expect(idParams.safeParse({ id: "0199e1c2-7a3b-7f1e-9a4c-8d2e5f6a7b8c" }).success).toBe(true);
    expect(idParams.safeParse({ id: "42" }).success).toBe(false);
  });
});
