import { describe, expect, it } from "vitest";
import { invoiceLine } from "../billing/Invoice.js";
import {
  basisPoints,
  clawbackAmount,
  commissionAmount,
  commissionTerms,
  CommissionRuleError,
  licenceBase,
  payoutRecord,
} from "./Commissions.js";

const line = (
  kind: Parameters<typeof invoiceLine>[0]["kind"],
  unitMinor: number,
  countsAsLicence: boolean,
) => invoiceLine({ kind, description: kind, quantity: 1, unitMinor, countsAsLicence });

describe("the commission base", () => {
  it("is the licence share collected, excluding VAT", () => {
    // GHS 500 licence + 20 % tax = 600: a full payment's base is 500.
    const invoice = { lines: [line("branch_rate", 50_000, true)], totalMinor: 60_000 };
    expect(licenceBase(invoice, 60_000)).toBe(50_000);
    // Half paid: half the base.
    expect(licenceBase(invoice, 30_000)).toBe(25_000);
  });

  it("never counts one-time costs, and spreads discounts pro rata", () => {
    const invoice = {
      lines: [
        line("branch_rate", 80_000, true),
        line("setup", 20_000, false),
        line("discount", -10_000, false),
      ],
      totalMinor: 90_000,
    };
    // Licence 80k of 100k gross takes 80 % of the 10k discount: 72k.
    expect(licenceBase(invoice, 90_000)).toBe(72_000);
    expect(licenceBase({ lines: [line("setup", 5_000, false)], totalMinor: 5_000 }, 5_000)).toBe(0);
  });
});

describe("commission amounts", () => {
  it("applies basis points within the cap", () => {
    expect(basisPoints("10")).toBe(1_000);
    expect(basisPoints("12.5")).toBe(1_250);
    expect(commissionAmount(50_000, 1_000, null)).toBe(5_000);
    expect(commissionAmount(50_000, 1_000, 3_000)).toBe(3_000);
    expect(commissionAmount(50_000, 1_000, 0)).toBe(0);
  });

  it("claws back the refunded share, never more than was earned", () => {
    expect(clawbackAmount(5_000, 0, 60_000, 30_000)).toBe(2_500);
    expect(clawbackAmount(5_000, 2_500, 60_000, 60_000)).toBe(2_500);
    expect(clawbackAmount(5_000, 5_000, 60_000, 1_000)).toBe(0);
  });
});

describe("terms and payout records", () => {
  it("normalises terms and refuses nonsense", () => {
    expect(
      commissionTerms({
        standardPercent: "10",
        enterprisePercent: null,
        holdDays: 0,
        minPayoutMinor: 0,
        capPerTenantMinor: null,
      }),
    ).toMatchObject({ standardPercent: "10.00", enterprisePercent: null });
    const base = {
      enterprisePercent: null,
      holdDays: 0,
      minPayoutMinor: 0,
      capPerTenantMinor: null,
    };
    expect(() => commissionTerms({ ...base, standardPercent: "0" })).toThrow(/empty/);
    expect(() => commissionTerms({ ...base, standardPercent: "101" })).toThrow(CommissionRuleError);
    expect(() => commissionTerms({ ...base, standardPercent: "5", holdDays: 200 })).toThrow(/hold/);
  });

  it("asks each method for its record", () => {
    const ok = {
      reference: "TX1",
      details: { network: "mtn", number: "0244…567" },
      proofFileIds: [],
    };
    expect(() => payoutRecord("momo", ok)).not.toThrow();
    expect(() => payoutRecord("momo", { ...ok, reference: null })).toThrow(/transaction ID/);
    expect(() =>
      payoutRecord("bank", { ...ok, details: { bank: "GCB", account: "••12" } }),
    ).toThrow(/proof/);
    expect(() =>
      payoutRecord("cash", { reference: null, details: {}, proofFileIds: [] }),
    ).not.toThrow();
    expect(() => payoutRecord("other", { reference: "R", details: {}, proofFileIds: [] })).toThrow(
      /description/,
    );
  });
});
