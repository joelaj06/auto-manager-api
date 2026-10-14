import { describe, expect, it } from "vitest";
import { InvalidTenantIdError, isUuid, tenantDatabaseName } from "./naming.js";

describe("tenantDatabaseName", () => {
  it("builds prefix + uuid without dashes, lowercased", () => {
    expect(tenantDatabaseName("t_", "0199E1C2-7A3B-7F1E-9A4C-8D2E5F6A7B8C")).toBe(
      "t_0199e1c27a3b7f1e9a4c8d2e5f6a7b8c",
    );
  });

  it("stays within PostgreSQL's 63-character identifier limit", () => {
    const name = tenantDatabaseName("abcdefghijklmno_", "0199e1c2-7a3b-7f1e-9a4c-8d2e5f6a7b8c");
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it.each(["", "not-a-uuid", "0199e1c2-7a3b-7f1e-9a4c", "x; drop database y"])(
    "rejects tenant id %j",
    (tenantId) => {
      expect(() => tenantDatabaseName("t_", tenantId)).toThrow(InvalidTenantIdError);
    },
  );

  it.each(["", "t", "T_", "1_", "t-", "a".repeat(17) + "_"])("rejects prefix %j", (prefix) => {
    expect(() => tenantDatabaseName(prefix, "0199e1c2-7a3b-7f1e-9a4c-8d2e5f6a7b8c")).toThrow(
      /Invalid tenant database prefix/,
    );
  });
});

describe("isUuid", () => {
  it("accepts UUIDs of any version and rejects everything else", () => {
    expect(isUuid("0199e1c2-7a3b-7f1e-9a4c-8d2e5f6a7b8c")).toBe(true);
    expect(isUuid("0199e1c27a3b7f1e9a4c8d2e5f6a7b8c")).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});
