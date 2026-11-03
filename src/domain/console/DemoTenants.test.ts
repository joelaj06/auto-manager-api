import { describe, expect, it } from "vitest";
import { demoDays, demoSlug, demoState, extendDemo } from "./DemoTenants.js";

const DAY_MS = 86_400_000;
const now = new Date("2026-11-03T10:00:00Z");
const days = (n: number) => new Date(now.getTime() + n * DAY_MS);

describe("demo tenants", () => {
  it("last 14 days unless told otherwise, at most 90", () => {
    expect(demoDays(undefined)).toBe(14);
    expect(demoDays(30)).toBe(30);
    expect(() => demoDays(0)).toThrow(/1 to 90/);
    expect(() => demoDays(91)).toThrow(/1 to 90/);
  });

  it("are live, then expired, then due their purge a week later, then purged", () => {
    const demo = { expiresAt: days(1), expiredAt: null, purgedAt: null };
    expect(demoState(demo, now)).toBe("live");
    expect(demoState(demo, days(1))).toBe("expiring");
    expect(demoState({ ...demo, expiredAt: days(1) }, days(5))).toBe("expired");
    expect(demoState({ ...demo, expiredAt: days(1) }, days(8))).toBe("purge_due");
    expect(demoState({ ...demo, expiredAt: days(1), purgedAt: days(8) }, days(9))).toBe("purged");
  });

  it("are extended from their end, or from today once ended, never past 90 days nor once purged", () => {
    expect(extendDemo({ expiresAt: days(10), purgedAt: null }, 7, now)).toEqual(days(17));
    expect(extendDemo({ expiresAt: days(-3), purgedAt: null }, 7, now)).toEqual(days(7));
    expect(() => extendDemo({ expiresAt: days(85), purgedAt: null }, 10, now)).toThrow(
      /90 days ahead/,
    );
    expect(() => extendDemo({ expiresAt: days(-9), purgedAt: days(-1) }, 7, now)).toThrow(/gone/);
  });

  it("get a demo- address", () => {
    expect(demoSlug("A1b2C3d4")).toBe("demo-a1b2c3");
    expect(() => demoSlug("ab")).toThrow();
  });
});
