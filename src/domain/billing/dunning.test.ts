import { describe, expect, it } from "vitest";
import { TenantLifecycle } from "../entities/TenantLifecycle.js";
import {
  addDays,
  checkExtension,
  circuitBreakerTrips,
  deactivationDate,
  dunningPolicy,
  DunningRuleError,
  planDunning,
  type DunningPolicy,
} from "./Dunning.js";

const POLICY: DunningPolicy = {
  invoiceLeadDays: 7,
  reminderDaysBefore: [7, 3, 1],
  overdueReminderDays: [1, 3, 5],
  graceDays: 7,
  readOnlyAfterDays: null,
  skipSundays: false,
  extension: { maxDays: 10, maxPer90Days: 2, finalGraceDays: 1 },
  dryRun: false,
  circuitBreaker: { maxCount: 5, maxPercent: 10 },
  reviewBranchThreshold: 5,
  gatewayGuard: { maxFailedWebhooks24h: 5 },
  channels: ["email", "sms", "in_app", "push"],
};
const DUE = "2026-11-10";
const on = (offset: number, policy = POLICY, extended: string | null = null) =>
  planDunning(DUE, addDays(DUE, offset), policy, extended);

describe("the dunning schedule", () => {
  it("reminds before the due date, charges on it and the day after", () => {
    expect(on(-7).notices).toEqual(["reminder_7"]);
    expect(on(-5).notices).toEqual([]);
    expect(on(-1)).toMatchObject({ notices: ["reminder_1"], charge: false, pastDue: false });
    expect(on(0)).toMatchObject({ notices: ["due"], charge: true, pastDue: false });
    expect(on(1)).toMatchObject({ notices: ["overdue_1"], charge: true, pastDue: true });
    expect(on(2)).toMatchObject({ notices: [], charge: false, pastDue: true });
  });

  it("gives a final notice and deactivates at the end of grace, catching up missed runs", () => {
    expect(on(6).notices).toEqual(["final_notice"]);
    expect(on(6).deactivate).toBe(false);
    expect(on(7)).toMatchObject({ deactivate: true, notices: [], deactivateOn: "2026-11-17" });
    expect(on(12).deactivate).toBe(true);
  });

  it("moves the deadline to the extension's date plus a short final grace", () => {
    const until = "2026-11-20";
    expect(deactivationDate(DUE, POLICY, until)).toBe("2026-11-21");
    expect(on(7, POLICY, until).deactivate).toBe(false);
    expect(on(7, POLICY, until).notices).toEqual(["extension_reminder_3"]);
    expect(on(9, POLICY, until).notices).toEqual(["extension_reminder_1"]);
    expect(on(10, POLICY, until).notices).toEqual(["final_notice"]);
    expect(on(11, POLICY, until).deactivate).toBe(true);
    // An extension never shortens the normal grace.
    expect(deactivationDate(DUE, POLICY, "2026-11-11")).toBe("2026-11-17");
  });

  it("can skip Sundays when counting grace and insert the read-only step", () => {
    // 2026-11-10 is a Tuesday: +7 days crosses one Sunday (the 15th).
    expect(deactivationDate(DUE, { ...POLICY, skipSundays: true }, null)).toBe("2026-11-18");
    const readOnly = { ...POLICY, readOnlyAfterDays: 3 };
    expect(on(2, readOnly).readOnly).toBe(false);
    expect(on(3, readOnly).readOnly).toBe(true);
    expect(on(7, readOnly).readOnly).toBe(false);
  });

  it("checks a policy staff save", () => {
    expect(
      dunningPolicy({ ...POLICY, reminderDaysBefore: [1, 7, 3, 7] }).reminderDaysBefore,
    ).toEqual([7, 3, 1]);
    expect(() =>
      dunningPolicy({ ...POLICY, extension: { ...POLICY.extension, maxDays: 11 } }),
    ).toThrow(DunningRuleError);
    expect(() => dunningPolicy({ ...POLICY, overdueReminderDays: [7] })).toThrow(/grace/);
    expect(() => dunningPolicy({ ...POLICY, readOnlyAfterDays: 9 })).toThrow(/read-only/);
    expect(() => dunningPolicy({ ...POLICY, channels: [] })).toThrow(/channel/);
  });
});

describe("extensions and safeguards", () => {
  it("allows at most 10 days after the due date, and flags requests over the 90-day limit", () => {
    const base = { dueOn: DUE, today: "2026-11-12", policy: POLICY, approvedInLast90Days: 0 };
    expect(checkExtension({ ...base, until: "2026-11-20" })).toEqual({ overLimit: false });
    expect(() => checkExtension({ ...base, until: "2026-11-21" })).toThrow(/10 days/);
    expect(() => checkExtension({ ...base, until: "2026-11-12" })).toThrow(/future/);
    expect(checkExtension({ ...base, until: "2026-11-15", approvedInLast90Days: 2 })).toEqual({
      overLimit: true,
    });
  });

  it("trips the circuit breaker on a count, or a percent of a large base", () => {
    expect(circuitBreakerTrips(0, 10, POLICY)).toBe(false);
    expect(circuitBreakerTrips(5, 10, POLICY)).toBe(false);
    expect(circuitBreakerTrips(6, 1_000, POLICY)).toBe(true);
    const strict = { ...POLICY, circuitBreaker: { maxCount: 50, maxPercent: 5 } };
    expect(circuitBreakerTrips(4, 60, strict)).toBe(true);
    expect(circuitBreakerTrips(3, 60, strict)).toBe(false);
    // Below 50 operating tenants only the count applies.
    expect(circuitBreakerTrips(4, 49, strict)).toBe(false);
  });
});

describe("the tenant status in billing", () => {
  const tenant = (status: "active" | "trialing" = "active") =>
    TenantLifecycle.restore({
      id: "t1",
      slug: "acme",
      name: "Acme",
      status,
      previousStatus: null,
      deactivationReason: null,
      statusMessage: null,
      autoRestoreLocked: false,
      statusChangedAt: null,
    });
  const now = new Date("2026-11-18T07:00:00Z");

  it("goes past due, then deactivated for non-payment, and back to active on payment", () => {
    const t = tenant();
    expect(t.markPastDue(now)).toMatchObject({ from: "active", to: "past_due" });
    expect(t.markPastDue(now)).toBeNull();
    t.deactivate("non_payment", "Unpaid", false, now);
    expect(t.recordLicencePayment(now)).toMatchObject({ from: "deactivated", to: "active" });
  });

  it("is restored by an extension unless staff locked the deactivation", () => {
    const billing = tenant();
    billing.markPastDue(now);
    billing.deactivate("non_payment", null, false, now);
    expect(billing.liftBillingDeactivation(now)).toMatchObject({ to: "past_due" });
    const locked = tenant();
    locked.deactivate("non_payment", null, true, now);
    expect(locked.liftBillingDeactivation(now)).toBeNull();
    const manual = tenant();
    manual.deactivate("abuse", null, true, now);
    expect(manual.liftBillingDeactivation(now)).toBeNull();
  });

  it("leaves the billing read-only step with the payment, not a staff read-only", () => {
    const billing = tenant();
    billing.markPastDue(now);
    billing.setReadOnly("Pay", now, "non_payment");
    expect(billing.recordLicencePayment(now)).toMatchObject({ from: "read_only", to: "active" });
    const staff = tenant();
    staff.setReadOnly("Audit", now);
    expect(staff.recordLicencePayment(now)).toBeNull();
    expect(staff.status).toBe("read_only");
  });
});
