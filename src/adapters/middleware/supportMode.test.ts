import { describe, expect, it } from "vitest";
import { maskSensitive, supportVerdict } from "./supportMode.js";

describe("support mode", () => {
  it("reads in read mode, writes in write mode, never signs in, pays or exports", () => {
    expect(supportVerdict("GET", "/api/v1/vehicles", "read")).toBe("allowed");
    expect(supportVerdict("POST", "/api/v1/vehicles", "read")).toBe("read_only");
    expect(supportVerdict("POST", "/api/v1/vehicles", "write")).toBe("allowed");
    expect(supportVerdict("GET", "/api/v1/vehicles/export.csv", "write")).toBe("blocked");
    expect(supportVerdict("GET", "/api/v1/billing/invoices/1/pdf", "write")).toBe("blocked");
    expect(supportVerdict("GET", "/api/v1/billing/invoices", "read")).toBe("allowed");
    expect(supportVerdict("POST", "/api/v1/billing/invoices/1/checkout", "write")).toBe("blocked");
    expect(supportVerdict("POST", "/api/v1/auth/logout", "write")).toBe("blocked");
    expect(supportVerdict("PUT", "/api/v1/me/password", "write")).toBe("blocked");
  });

  it("masks identity and bank numbers deep in responses", () => {
    expect(
      maskSensitive({
        data: [
          { name: "Kwame", ghanaCardNumber: "GHA-123456789-1", guarantors: [{ tin: "C0012345" }] },
        ],
        when: new Date(0),
      }),
    ).toEqual({
      data: [{ name: "Kwame", ghanaCardNumber: "••••89-1", guarantors: [{ tin: "••••2345" }] }],
      when: new Date(0),
    });
  });
});
