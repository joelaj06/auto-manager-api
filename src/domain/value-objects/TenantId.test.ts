import { describe, expect, it } from "vitest";
import { InvalidTenantIdError } from "../errors/TenantErrors.js";
import { TenantId } from "./TenantId.js";

describe("TenantId", () => {
  it("normalises to lowercase", () => {
    expect(TenantId.from("0199E1C2-7A3B-7F1E-9A4C-8D2E5F6A7B8C").value).toBe(
      "0199e1c2-7a3b-7f1e-9a4c-8d2e5f6a7b8c",
    );
  });

  it("compares by value", () => {
    const a = TenantId.from("0199e1c2-7a3b-7f1e-9a4c-8d2e5f6a7b8c");
    const b = TenantId.from("0199E1C2-7A3B-7F1E-9A4C-8D2E5F6A7B8C");
    expect(a.equals(b)).toBe(true);
  });

  it.each([
    "",
    "not-a-uuid",
    "0199e1c2-7a3b-7f1e-9a4c",
    "0199e1c27a3b7f1e9a4c8d2e5f6a7b8c",
    "../etc",
  ])("rejects %j", (value) => {
    expect(() => TenantId.from(value)).toThrow(InvalidTenantIdError);
  });

  it("exposes a stable error code", () => {
    expect(new InvalidTenantIdError().code).toBe("INVALID_TENANT_ID");
  });
});
