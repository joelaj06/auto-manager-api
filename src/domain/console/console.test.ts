import { describe, expect, it } from "vitest";
import { resolveFlag, rolloutBucket, type FeatureFlag } from "./FeatureFlags.js";
import { SupportSession } from "./SupportSession.js";

const NOW = new Date("2026-11-02T10:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

const session = (mode: "read" | "write" = "read", durationMinutes = 30) =>
  SupportSession.request({
    id: "s1",
    staffId: "staff",
    staffSessionId: "cs1",
    tenantId: "t1",
    mode,
    reason: "Owner cannot see last week's remittances",
    ticket: "T-42",
    durationMinutes,
    now: NOW,
  });

describe("support sessions", () => {
  it("are read-only by default and start their clock with the first token", () => {
    const s = session();
    expect(s.snapshot().status).toBe("approved");
    s.start(minutes(5));
    expect(s.snapshot()).toMatchObject({ status: "active", expiresAt: minutes(35) });
    expect(s.isLive(minutes(34))).toBe(true);
    expect(s.isLive(minutes(35))).toBe(false);
  });

  it("need a second staff member for write mode", () => {
    const s = session("write");
    expect(() => s.start(NOW)).toThrow(/approval/);
    expect(() => s.approve("staff")).toThrow(/Another staff member/);
    s.approve("admin");
    s.start(NOW);
    expect(s.snapshot()).toMatchObject({ status: "active", approvedBy: "admin" });
  });

  it("extend to two hours in all and end", () => {
    const s = session("read", 60);
    s.start(NOW);
    s.extend(60, minutes(30));
    expect(s.snapshot().expiresAt).toEqual(minutes(120));
    expect(() => s.extend(5, minutes(40))).toThrow(/at most 120/);
    s.end("ended", minutes(50));
    expect(s.isLive(minutes(51))).toBe(false);
    expect(() => s.start(minutes(52))).toThrow(/over/);
    expect(() => session("read", 121)).toThrow(/5 to 120/);
  });
});

describe("feature flags", () => {
  const flag = (changes: Partial<FeatureFlag> = {}): FeatureFlag => ({
    key: "workpay",
    description: "Work and pay",
    kind: "feature",
    enabled: true,
    rolloutPercent: 100,
    licenceTypes: [],
    routePrefixes: ["/api/v1/workpay"],
    updatedBy: null,
    updatedAt: NOW,
    ...changes,
  });
  const tenant = { id: "t1", licenceType: "standard" };
  const override = (enabled: boolean) => ({
    flagKey: "workpay",
    tenantId: "t1",
    enabled,
    reason: "Pilot",
    setBy: "staff",
    setAt: NOW,
  });

  it("let an override decide, but never past a kill switch", () => {
    expect(resolveFlag(flag({ enabled: false }), tenant, override(true))).toEqual({
      enabled: true,
      because: "override",
    });
    expect(
      resolveFlag(flag({ kind: "kill_switch", enabled: false }), tenant, override(true)),
    ).toEqual({
      enabled: false,
      because: "kill_switch",
    });
  });

  it("limit by licence type and roll out to a stable share of tenants", () => {
    expect(resolveFlag(flag({ licenceTypes: ["enterprise"] }), tenant, null).because).toBe(
      "licence",
    );
    const bucket = rolloutBucket("workpay", "t1");
    expect(rolloutBucket("workpay", "t1")).toBe(bucket);
    expect(resolveFlag(flag({ rolloutPercent: bucket + 1 }), tenant, null).enabled).toBe(true);
    expect(resolveFlag(flag({ rolloutPercent: bucket }), tenant, null)).toEqual({
      enabled: false,
      because: "rollout",
    });
    expect(resolveFlag(flag({ enabled: false }), null, null).enabled).toBe(false);
  });
});
