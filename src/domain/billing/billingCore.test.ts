import { describe, expect, it } from "vitest";
import {
  billingSettings,
  BillingSettingsError,
  billingTax,
  sellerParty,
  type BillingSettings,
} from "./BillingSettings.js";
import { Invoice, invoiceLine } from "./Invoice.js";
import { PaymentAttempt } from "./PaymentAttempt.js";
import { prorate } from "./Proration.js";
import { Subscription, type Plan } from "./Subscription.js";

const ghanaRates = [
  {
    key: "vat",
    name: "VAT",
    rate: "15",
    base: "net" as const,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  },
  {
    key: "nhil",
    name: "NHIL",
    rate: "2.5",
    base: "net" as const,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  },
  {
    key: "getfund",
    name: "GETFund Levy",
    rate: "2.5",
    base: "net" as const,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  },
];

const settings = (overrides: Partial<BillingSettings> = {}): BillingSettings =>
  billingSettings({
    sellerName: "Autoforce Ltd",
    sellerAddress: "Accra",
    sellerTin: "C0001112223",
    sellerEmail: "billing@autoforce.example",
    sellerPhone: null,
    vatRegistered: false,
    vatNumber: null,
    taxComponents: ghanaRates,
    paymentInstructions: null,
    invoiceDueDays: 7,
    ...overrides,
  });

const plan: Plan = {
  id: "p",
  code: "standard",
  name: "Standard",
  currency: "GHS",
  pricing: "flat_per_branch",
  branchPriceMinor: 30_000,
  trialDays: 14,
  trialBranchLimit: 3,
  features: [],
};

describe("VAT on the subscription", () => {
  it("charges nothing until Autoforce is VAT-registered", () => {
    expect(billingTax(settings(), 60_000, "GHS", "2026-11-01")).toEqual([]);
  });

  it("charges VAT, NHIL and GETFund on the same subtotal once registered", () => {
    const registered = settings({ vatRegistered: true, vatNumber: "V0012345678" });
    expect(billingTax(registered, 60_000, "GHS", "2026-11-01")).toEqual([
      { key: "vat", name: "VAT", rate: "15", amountMinor: 9_000 },
      { key: "nhil", name: "NHIL", rate: "2.5", amountMinor: 1_500 },
      { key: "getfund", name: "GETFund Levy", rate: "2.5", amountMinor: 1_500 },
    ]);
    expect(sellerParty(registered)).toMatchObject({ vatNumber: "V0012345678", tin: "C0001112223" });
    expect(sellerParty(settings()).vatNumber).toBeNull();
  });

  it("refuses a registered seller without a VAT number or rates, and bad rates", () => {
    expect(() => settings({ vatRegistered: true })).toThrow(BillingSettingsError);
    expect(() => settings({ vatRegistered: true, vatNumber: "V1", taxComponents: [] })).toThrow(
      /rates/,
    );
    expect(() => settings({ taxComponents: [{ ...ghanaRates[0]!, rate: "150" }] })).toThrow(
      /0 and 100/,
    );
    expect(() => settings({ invoiceDueDays: 90 })).toThrow(/0 to 60/);
  });

  it("adds the tax to the invoice total", () => {
    const registered = settings({ vatRegistered: true, vatNumber: "V0012345678" });
    const lines = [
      invoiceLine({
        kind: "branch_rate",
        description: "Standard licence, 2 branches",
        quantity: 2,
        unitMinor: 30_000,
        countsAsLicence: true,
      }),
      invoiceLine({
        kind: "proration",
        description: "1 branch added on 2026-11-11: 20 of 30 days",
        quantity: 1,
        unitMinor: 20_000,
        countsAsLicence: true,
      }),
    ];
    const invoice = Invoice.issue({
      id: "i",
      code: "AF-INV-2026-000001",
      tenantId: "t",
      subscriptionId: "s",
      period: { start: "2026-12-01", end: "2027-01-01" },
      lines,
      taxLines: billingTax(registered, 80_000, "GHS", "2026-12-01"),
      seller: sellerParty(registered),
      buyer: { name: "Kumasi Cabs", address: null, tin: null },
      currency: "GHS",
      now: new Date("2026-12-01T08:00:00Z"),
      dueAt: new Date("2026-12-08T08:00:00Z"),
      createdBy: null,
    }).snapshot();
    expect(invoice).toMatchObject({ subtotalMinor: 80_000, taxMinor: 16_000, totalMinor: 96_000 });
  });
});

describe("proration", () => {
  const period = { start: "2026-11-01", end: "2026-12-01" };

  it("charges the days left of the period, the day added included", () => {
    expect(prorate({ branches: 1, unitMinor: 30_000, from: "2026-11-11", period })).toEqual({
      branches: 1,
      unitMinor: 30_000,
      days: 20,
      periodDays: 30,
      amountMinor: 20_000,
      startsOn: "2026-11-11",
      periodEnd: "2026-12-01",
    });
    expect(
      prorate({ branches: 2, unitMinor: 25_000, from: "2026-11-30", period })?.amountMinor,
    ).toBe(1_667);
    expect(prorate({ branches: 1, unitMinor: 30_000, from: "2026-12-01", period })).toBeNull();
  });

  it("charges a period once per branch, even if a branch is removed and added again", () => {
    const s = Subscription.startTrial({
      id: "s",
      tenantId: "t",
      plan,
      trialEndsAt: new Date("2026-10-15T00:00:00Z"),
    });
    s.setBranchCount(2);
    s.setBranchCount(3);
    // No paid period yet (trial): nothing to prorate.
    expect(s.chargeAddedBranches("2026-10-20")).toBeNull();
    s.applyPaidPeriod(period, new Date("2026-11-01T09:00:00Z"), 2);
    expect(s.snapshot().periodBranchCount).toBe(2);
    expect(s.chargeAddedBranches("2026-11-11")).toEqual({ branches: 1, period });
    expect(s.chargeAddedBranches("2026-11-12")).toBeNull();
    s.setBranchCount(2); // removed: no credit, the period stays charged for 3
    s.setBranchCount(3); // added again: already charged
    expect(s.chargeAddedBranches("2026-11-20")).toBeNull();
    s.setBranchCount(4);
    expect(s.chargeAddedBranches("2026-12-01")).toBeNull(); // the period is over
  });
});

describe("gateway payment attempts", () => {
  const attempt = () =>
    PaymentAttempt.start({
      id: "a",
      reference: "AF-INV-2026-000001-abc",
      tenantId: "t",
      invoiceId: "i",
      provider: "paystack",
      kind: "checkout",
      amountMinor: 30_000,
      currency: "GHS",
      paymentMethodId: null,
      saveMethod: false,
      momoPhone: null,
      momoNetwork: null,
      initiatedByType: "user",
      initiatedBy: "u",
      createdAt: new Date("2026-11-01T08:00:00Z"),
    });
  const result = { channel: "card", providerTransactionId: "1", feesMinor: 585 };

  it("accepts only exactly the amount and currency asked, once", () => {
    const ok = attempt();
    expect(ok.succeeded({ ...result, amountMinor: 30_000, currency: "GHS" }, new Date())).toBe(
      true,
    );
    expect(ok.status).toBe("succeeded");
    expect(ok.succeeded({ ...result, amountMinor: 30_000, currency: "GHS" }, new Date())).toBe(
      false,
    );
    ok.failed("late", new Date());
    expect(ok.status).toBe("succeeded");

    const short = attempt();
    expect(short.succeeded({ ...result, amountMinor: 100, currency: "GHS" }, new Date())).toBe(
      false,
    );
    expect(short.snapshot()).toMatchObject({
      status: "review",
      failureReason: expect.stringMatching(/expected/),
    });
    expect(() => PaymentAttempt.start({ ...attempt().snapshot(), amountMinor: 0 })).toThrow(
      /Nothing is left/,
    );
  });
});

describe("invoice refunds", () => {
  it("reopen the invoice for what was given back", () => {
    const invoice = Invoice.issue({
      id: "i",
      code: "AF-INV-2026-000002",
      tenantId: "t",
      subscriptionId: "s",
      period: { start: "2026-11-01", end: "2026-12-01" },
      lines: [
        invoiceLine({
          kind: "branch_rate",
          description: "1 branch",
          quantity: 1,
          unitMinor: 30_000,
          countsAsLicence: true,
        }),
      ],
      taxLines: [],
      seller: null,
      buyer: null,
      currency: "GHS",
      now: new Date(),
      dueAt: new Date(),
      createdBy: null,
    });
    invoice.recordPayment(30_000, "GHS", new Date());
    expect(() => invoice.refund(40_000)).toThrow(/At most/);
    invoice.refund(10_000);
    expect(invoice.snapshot()).toMatchObject({ status: "open", paidMinor: 20_000, paidAt: null });
    expect(invoice.outstandingMinor).toBe(10_000);
  });
});
