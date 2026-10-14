import { describe, expect, it } from "vitest";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import { TenantDatabaseNaming } from "./TenantDatabaseNaming.js";

const tenantId = TenantId.from("0199E1C2-7A3B-7F1E-9A4C-8D2E5F6A7B8C");

describe("TenantDatabaseNaming", () => {
  it("builds prefix + uuid without dashes, lowercased", () => {
    expect(new TenantDatabaseNaming("t_").databaseNameFor(tenantId)).toBe(
      "t_0199e1c27a3b7f1e9a4c8d2e5f6a7b8c",
    );
  });

  it("stays within PostgreSQL's 63-character identifier limit", () => {
    const name = new TenantDatabaseNaming("abcdefghijklmno_").databaseNameFor(tenantId);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it.each(["", "t", "T_", "1_", "t-", "a".repeat(17) + "_"])("rejects prefix %j", (prefix) => {
    expect(() => new TenantDatabaseNaming(prefix)).toThrow(/Invalid tenant database prefix/);
  });
});
