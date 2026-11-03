import { describe, expect, it } from "vitest";
import { deferredCode, normaliseDeferredCode } from "./DeferredLink.js";

describe("deferred link codes", () => {
  it("makes codes that read back the same", () => {
    const code = deferredCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(normaliseDeferredCode(code)).toBe(code.replace("-", ""));
  });

  it("forgives how a code was typed or carried", () => {
    expect(normaliseDeferredCode(" abcde-f0h1k ")).toBe("ABCDEF0H1K");
    expect(normaliseDeferredCode("ABCDE-FOHIK")).toBe("ABCDEF0H1K");
    expect(normaliseDeferredCode("https://go.test/connect?hold=ABCDE-F0H1K")).toBe("ABCDEF0H1K");
  });

  it("refuses what cannot be a code", () => {
    expect(normaliseDeferredCode("short")).toBeNull();
    expect(normaliseDeferredCode("ABCDE-F0H1U")).toBeNull();
  });
});
