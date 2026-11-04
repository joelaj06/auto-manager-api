import { describe, expect, it } from "vitest";
import { challengeAnswered, checkDomain, CustomDomainRuleError } from "./CustomDomains.js";

const RESERVED = ["app.autoforce.example", "autoforce.example"];

describe("custom domains", () => {
  it("takes a host name in lower case", () => {
    expect(checkDomain(" Fleet.Example.COM. ", RESERVED)).toBe("fleet.example.com");
    expect(checkDomain("example.com", RESERVED)).toBe("example.com");
  });

  it.each([
    "localhost",
    "*.example.com",
    "-bad.example.com",
    "fleet.example.com/path",
    "10.0.0.1",
    "autoforce.example",
    "acme.autoforce.example",
  ])("refuses %s", (value) => {
    expect(() => checkDomain(value, RESERVED)).toThrow(CustomDomainRuleError);
  });

  it("wants the exact token in a TXT record", () => {
    expect(challengeAnswered(["other", "autoforce-verify=abc"], "abc")).toBe(true);
    expect(challengeAnswered(["autoforce-verify=abcd"], "abc")).toBe(false);
    expect(challengeAnswered([], "abc")).toBe(false);
  });
});
