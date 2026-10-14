import { describe, expect, it } from "vitest";
import { formatSequenceCode } from "./counters.js";

describe("formatSequenceCode", () => {
  it("zero-pads the value", () => {
    expect(formatSequenceCode({ prefix: "RT", value: 123 })).toBe("RT-000123");
  });

  it("includes the year when given", () => {
    expect(formatSequenceCode({ prefix: "INV", value: 7, year: 2026, padding: 5 })).toBe(
      "INV-2026-00007",
    );
  });

  it("never truncates values longer than the padding", () => {
    expect(formatSequenceCode({ prefix: "WP", value: 1_234_567, padding: 4 })).toBe("WP-1234567");
  });

  it.each(["rt", "R-T", "", "TOOLONGPREFIX"])("rejects prefix %j", (prefix) => {
    expect(() => formatSequenceCode({ prefix, value: 1 })).toThrow(/Invalid code prefix/);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects value %s", (value) => {
    expect(() => formatSequenceCode({ prefix: "RT", value })).toThrow(/Invalid sequence value/);
  });
});
