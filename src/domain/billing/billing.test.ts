import { describe, expect, it } from "vitest";
import { TenantLifecycle, type TenantLifecycleProps } from "../entities/TenantLifecycle.js";
import { Invoice, InvoiceRuleError, invoiceLine } from "./Invoice.js";
import {
  addMonths,
  LicenceTypeLockedError,
  resolveEntitlements,
  Subscription,
  SubscriptionRuleError,
  type Plan,
} from "./Subscription.js";

const now = new Date("2026-10-18T10:00:00Z");
const standard: Plan = {
  id: "p-std",
  code: "standard",
  name: "Standard",
  currency: "GHS",
  pricing: "flat_per_branch",
  branchPriceMinor: 25_000,
  trialDays: 14,
  trialBranchLimit: 3,
  features: [],
};
const enterprise: Plan = {
  ...standard,
  id: "p-ent",
  code: "enterprise",
  pricing: "custom",
  branchPriceMinor: null,
};
const trial = () =>
  Subscription.startTrial({
    id: "s1",
    tenantId: "t1",
    plan: standard,
    trialEndsAt: new Date("2026-11-01T10:00:00Z"),
  });

describe("addMonths", () => {
  it("adds calendar months and clamps the day", () => {
    expect(addMonths("2026-10-18", 1)).toBe("2026-11-18");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
  });
});

describe("Subscription", () => {
  it("starts as a trial: entitlement is the trial branch limit", () => {
    const s = trial();
    expect(resolveEntitlements(s, standard, now)).toMatchObject({
      status: "trialing",
      branchesMax: 3,
      canBuyBranches: false,
      trialEnded: false,
    });
    expect(resolveEntitlements(s, standard, new Date("2026-11-02T00:00:00Z")).trialEnded).toBe(
      true,
    );
  });

  it("invoices the first period from the trial end, then period after period", () => {
    const s = trial();
    expect(s.nextPeriod("2026-10-18")).toEqual({ start: "2026-11-01", end: "2026-12-01" });
    expect(s.nextPeriod("2026-11-20")).toEqual({ start: "2026-11-20", end: "2026-12-20" });
    s.applyPaidPeriod({ start: "2026-11-01", end: "2026-12-01" }, now);
    expect(s.nextPeriod("2026-11-20")).toEqual({ start: "2026-12-01", end: "2027-01-01" });
  });

  it("becomes active and locks the licence type on the first payment", () => {
    const s = trial();
    s.setLicenceType("enterprise", enterprise);
    expect(s.snapshot().planId).toBe("p-ent");
    expect(() => s.setLicenceType("standard", enterprise)).toThrow(SubscriptionRuleError);
    s.setLicenceType("standard", standard);
    s.applyPaidPeriod({ start: "2026-11-01", end: "2026-12-01" }, now);
    expect(s.status).toBe("active");
    expect(() => s.setLicenceType("enterprise", enterprise)).toThrow(LicenceTypeLockedError);
    expect(resolveEntitlements(s, standard, now)).toMatchObject({
      branchesMax: 1,
      canBuyBranches: true,
    });
  });

  it("extends trials within limits only", () => {
    const s = trial();
    expect(() => s.extendTrial(new Date("2026-10-30T00:00:00Z"), now)).toThrow(
      SubscriptionRuleError,
    );
    expect(() => s.extendTrial(new Date("2027-02-01T00:00:00Z"), now)).toThrow(
      SubscriptionRuleError,
    );
    s.extendTrial(new Date("2026-11-15T00:00:00Z"), now);
    expect(s.snapshot().trialEndsAt).toEqual(new Date("2026-11-15T00:00:00Z"));
    expect(() => s.setBranchCount(0)).toThrow(SubscriptionRuleError);
  });
});

describe("Invoice", () => {
  const issue = () =>
    Invoice.issue({
      id: "i1",
      code: "AF-INV-2026-000001",
      tenantId: "t1",
      subscriptionId: "s1",
      period: { start: "2026-11-01", end: "2026-12-01" },
      lines: [
        invoiceLine({
          kind: "branch_rate",
          description: "Branches",
          quantity: 2,
          unitMinor: 25_000,
          countsAsLicence: true,
        }),
        invoiceLine({
          kind: "discount",
          description: "Launch discount",
          quantity: 1,
          unitMinor: -5_000,
          countsAsLicence: true,
        }),
      ],
      currency: "GHS",
      now,
      dueAt: now,
      createdBy: null,
    });

  it("totals lines and is paid only when fully paid", () => {
    const invoice = issue();
    expect(invoice.snapshot()).toMatchObject({ subtotalMinor: 45_000, totalMinor: 45_000 });
    expect(invoice.recordPayment(20_000, "GHS", now)).toBe(false);
    expect(invoice.status).toBe("open");
    expect(() => invoice.recordPayment(30_000, "GHS", now)).toThrow(InvoiceRuleError);
    expect(() => invoice.recordPayment(1_000, "USD", now)).toThrow(InvoiceRuleError);
    expect(() => invoice.void("Mistake", now)).toThrow(InvoiceRuleError);
    expect(invoice.recordPayment(25_000, "GHS", now)).toBe(true);
    expect(invoice.status).toBe("paid");
    expect(() => invoice.recordPayment(1, "GHS", now)).toThrow(InvoiceRuleError);
  });

  it("refuses bad lines and empty or zero invoices", () => {
    expect(() =>
      invoiceLine({
        kind: "setup",
        description: "x",
        quantity: 1,
        unitMinor: -1,
        countsAsLicence: false,
      }),
    ).toThrow(InvoiceRuleError);
    expect(() =>
      invoiceLine({
        kind: "branch_rate",
        description: "x",
        quantity: 0,
        unitMinor: 1,
        countsAsLicence: true,
      }),
    ).toThrow(InvoiceRuleError);
    const open = issue();
    open.void("Issued by mistake", now);
    expect(open.status).toBe("void");
  });
});

describe("TenantLifecycle.recordLicencePayment", () => {
  const tenant = (overrides: Partial<TenantLifecycleProps>) =>
    TenantLifecycle.restore({
      id: "t1",
      slug: "acme",
      name: "Acme",
      status: "trialing",
      previousStatus: null,
      deactivationReason: null,
      statusMessage: null,
      autoRestoreLocked: false,
      statusChangedAt: null,
      ...overrides,
    });

  it("activates trials, restores billing deactivations, never manual ones", () => {
    expect(tenant({}).recordLicencePayment(now)).toMatchObject({ from: "trialing", to: "active" });
    expect(tenant({ status: "active" }).recordLicencePayment(now)).toBeNull();
    const billing = tenant({
      status: "deactivated",
      previousStatus: "past_due",
      deactivationReason: "non_payment",
    });
    expect(billing.recordLicencePayment(now)).toMatchObject({ from: "deactivated", to: "active" });
    const manual = tenant({
      status: "deactivated",
      previousStatus: "active",
      deactivationReason: "abuse",
      autoRestoreLocked: true,
    });
    expect(manual.recordLicencePayment(now)).toBeNull();
    expect(manual.status).toBe("deactivated");
    const readOnly = tenant({ status: "read_only", previousStatus: "trialing" });
    expect(readOnly.recordLicencePayment(now)).toBeNull();
    expect(readOnly.snapshot().previousStatus).toBe("active");
  });
});
