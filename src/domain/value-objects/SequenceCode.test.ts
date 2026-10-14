import { describe, expect, it } from "vitest";
import { InvalidSequenceCodeError } from "../errors/SequenceErrors.js";
import { SequenceCode } from "./SequenceCode.js";

describe("SequenceCode", () => {
  it("zero-pads the number", () => {
    expect(SequenceCode.create({ prefix: "RT", number: 123 }).toString()).toBe("RT-000123");
  });

  it("includes the year when given", () => {
    expect(
      SequenceCode.create({ prefix: "INV", number: 7, year: 2026, padding: 5 }).toString(),
    ).toBe("INV-2026-00007");
  });

  it("never truncates numbers longer than the padding", () => {
    expect(SequenceCode.create({ prefix: "WP", number: 1_234_567, padding: 4 }).toString()).toBe(
      "WP-1234567",
    );
  });

  it.each(["rt", "R-T", "", "TOOLONGPREFIX"])("rejects prefix %j", (prefix) => {
    expect(() => SequenceCode.create({ prefix, number: 1 })).toThrow(InvalidSequenceCodeError);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects number %s", (number) => {
    expect(() => SequenceCode.create({ prefix: "RT", number })).toThrow(InvalidSequenceCodeError);
  });

  it("rejects an implausible year", () => {
    expect(() => SequenceCode.create({ prefix: "RT", number: 1, year: 26 })).toThrow(
      InvalidSequenceCodeError,
    );
  });
});
