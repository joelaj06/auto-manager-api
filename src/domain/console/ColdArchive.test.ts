import { describe, expect, it } from "vitest";
import { ArchiveRuleError, checkArchive, verificationDue } from "./ColdArchive.js";

const DAY = 86_400_000;
const now = new Date("2026-11-03T10:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const tenant = (over: Partial<Parameters<typeof checkArchive>[0]> = {}) => ({
  status: "deactivated",
  statusChangedAt: ago(400),
  hasDatabase: true,
  moving: false,
  ...over,
});

describe("cold archive", () => {
  it("archives a tenant deactivated for a year", () => {
    expect(() => checkArchive(tenant(), false, now)).not.toThrow();
    expect(() => checkArchive(tenant({ statusChangedAt: ago(365) }), false, now)).not.toThrow();
  });

  it("refuses tenants that may not be archived", () => {
    for (const [over, open] of [
      [{ status: "active" }, false],
      [{ statusChangedAt: ago(364) }, false],
      [{ statusChangedAt: null }, false],
      [{ moving: true }, false],
      [{ hasDatabase: false }, false],
      [{}, true],
    ] as const)
      expect(() => checkArchive(tenant(over), open, now)).toThrow(ArchiveRuleError);
    expect(() => checkArchive(tenant({ statusChangedAt: ago(10) }), false, now)).toThrow(
      /deactivated on 2026-10-24/,
    );
  });

  it("is due its restore test a year after the last one", () => {
    const archive = { status: "archived" as const, archivedAt: ago(400), lastVerifiedAt: null };
    expect(verificationDue(archive, now)).toBe(true);
    expect(verificationDue({ ...archive, lastVerifiedAt: ago(100) }, now)).toBe(false);
    expect(verificationDue({ ...archive, archivedAt: ago(30) }, now)).toBe(false);
    expect(verificationDue({ ...archive, status: "restored" }, now)).toBe(false);
  });
});
