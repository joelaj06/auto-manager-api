import { describe, expect, it } from "vitest";
import type { SystemAccountKey } from "../finance/Journal.js";
import { Postings } from "../finance/Postings.js";
import { TaxCode } from "../tax/TaxCode.js";
import { standardTaxCodes } from "../tax/TaxTemplates.js";
import { Expense, type ExpenseDetails } from "./Expense.js";
import {
  budgetLevel,
  fuelEfficiency,
  matchingRule,
  nextRun,
  type ApprovalRule,
} from "./ExpenseRules.js";

const now = new Date("2026-10-19T09:00:00Z");
let n = 0;
const vat = TaxCode.create(standardTaxCodes("GH", () => `c${(n += 1)}`)[0]!);
const details: ExpenseDetails = {
  categoryId: "cat-insurance",
  description: "Insurance for three cars",
  branchId: "b1",
  expenseDate: "2026-10-19",
  payee: { type: "supplier", id: "s1" },
  payeeName: "SIC Insurance",
  driverId: null,
  chargeToDriver: false,
  reference: null,
  notes: null,
};
const GHS = { currency: "GHS", fxRate: "1", base: "GHS" };
const draft = (
  overrides: Partial<Parameters<typeof Expense.draft>[0]["amount"]> = {},
  d: Partial<ExpenseDetails> = {},
  currency: Parameters<typeof Expense.draft>[0]["currency"] = GHS,
) =>
  Expense.draft({
    id: "e1",
    details: { ...details, ...d },
    amount: { amountMinor: 100_000, taxCode: null, split: [], ...overrides },
    currency,
    source: null,
    createdBy: "u1",
    now,
  });
const accounts = (key: SystemAccountKey) => `acc:${key}`;

describe("Expense", () => {
  it("splits one bill across vehicles so the shares always add up", () => {
    const split = ["v1", "v2", "v3"].map((vehicleId) => ({ vehicleId, weight: 1 }));
    const expense = draft({ split }).snapshot();
    expect(expense.lines.map((l) => l.amountMinor)).toEqual([33_334, 33_333, 33_333]);
  });

  it("works the recoverable VAT back from the receipt total and shares it out", () => {
    const expense = draft({
      amountMinor: 120_000,
      taxCode: vat,
      split: [
        { vehicleId: "v1", weight: 1 },
        { vehicleId: "v2", weight: 1 },
      ],
    }).snapshot();
    expect([expense.netMinor, expense.taxMinor]).toEqual([100_000, 20_000]);
    expect(expense.lines.map((l) => [l.netMinor, l.taxMinor])).toEqual([
      [50_000, 10_000],
      [50_000, 10_000],
    ]);
  });

  it("separates submitting, approving (by someone else) and paying", () => {
    const expense = draft();
    expect(() => expense.approve("u2", null, now)).toThrow(/cannot be approved/);
    expense.submit("EXP-2026-000001", "u1", now);
    expect(() => expense.approve("u1", null, now)).toThrow(/Someone else approves/);
    expense.reject("u2", "Wrong amount", now);
    expense.submit("EXP-2026-000002", "u1", now);
    expect(expense.snapshot().number).toBe("EXP-2026-000001");
    expense.approve("u2", null, now);
    expense.markPaid("p1", now);
    expect(() => expense.void("u2", "nope", now)).toThrow(/Reverse the payment/);
    expense.reopen(now);
    expect(expense.status).toBe("approved");
  });

  it("keeps a foreign-currency bill's base amounts at its rate, split by the same shares", () => {
    const usd = { currency: "USD", fxRate: "15.5", base: "GHS" };
    const expense = draft(
      {
        amountMinor: 12_000,
        taxCode: vat,
        split: [
          { vehicleId: "v1", weight: 1 },
          { vehicleId: "v2", weight: 1 },
        ],
      },
      {},
      usd,
    ).snapshot();
    expect([expense.currency, expense.fxRate, expense.amountMinor]).toEqual([
      "USD",
      "15.5",
      12_000,
    ]);
    expect([expense.amountBaseMinor, expense.netBaseMinor, expense.taxBaseMinor]).toEqual([
      186_000, 155_000, 31_000,
    ]);
    expect(expense.lines.map((l) => [l.amountBaseMinor, l.netBaseMinor, l.taxBaseMinor])).toEqual([
      [93_000, 77_500, 15_500],
      [93_000, 77_500, 15_500],
    ]);
    expect(() => draft({ amountMinor: 1 }, {}, { ...usd, fxRate: "0.001" })).toThrow(/too small/);
    expect(draft().snapshot().fxRate).toBe("1");
  });

  it("records the exchange difference of the payment and clears it when reopened", () => {
    const expense = draft({}, {}, { currency: "USD", fxRate: "15", base: "GHS" });
    expense.submit("EXP-2026-000003", "u1", now);
    expense.approve("u2", null, now);
    expense.markPaid("p1", now, -5_000);
    expect(expense.snapshot().fxDifferenceMinor).toBe(-5_000);
    expense.reopen(now);
    expect(expense.snapshot().fxDifferenceMinor).toBe(0);
  });
});

describe("expense posting", () => {
  it("debits each vehicle's share and input VAT, and owes the supplier the total", () => {
    const expense = draft({
      amountMinor: 120_000,
      taxCode: vat,
      split: [
        { vehicleId: "v1", weight: 1 },
        { vehicleId: "v2", weight: 1 },
      ],
    });
    const entry = Postings.expenseApproved(
      expense,
      "acc:vehicle_expenses",
      true,
      accounts,
      "2026-10-19",
    );
    expect(entry.lines.map((l) => [l.accountId, l.vehicleId, l.debitMinor, l.creditMinor])).toEqual(
      [
        ["acc:vehicle_expenses", "v1", 50_000, 0],
        ["acc:input_tax", null, 20_000, 0],
        ["acc:vehicle_expenses", "v2", 50_000, 0],
        ["acc:payables", null, 0, 120_000],
      ],
    );
  });

  it("posts a foreign-currency bill at its base amounts and the payment's exchange difference", () => {
    const expense = draft(
      { amountMinor: 10_000 },
      {},
      { currency: "USD", fxRate: "15", base: "GHS" },
    );
    const entry = Postings.expenseApproved(
      expense,
      "acc:vehicle_expenses",
      true,
      accounts,
      "2026-10-19",
    );
    expect(entry.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor])).toEqual([
      ["acc:vehicle_expenses", 150_000, 0],
      ["acc:payables", 0, 150_000],
    ]);
    const loss = Postings.payableExchangeDifference(
      {
        paymentId: "p1",
        difference: -10_000,
        branchId: "b1",
        party: { type: "supplier", id: "s1" },
        date: "2026-10-25",
        description: "Exchange difference",
      },
      accounts,
    );
    expect(loss.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor])).toEqual([
      ["acc:fx_difference", 10_000, 0],
      ["acc:payables", 0, 10_000],
    ]);
  });

  it("charges a driver who bears the cost instead of the business", () => {
    const expense = draft(
      {},
      { driverId: "d1", chargeToDriver: true, description: "Traffic fine" },
    );
    const entry = Postings.expenseApproved(
      expense,
      "acc:other_expenses",
      false,
      accounts,
      "2026-10-19",
    );
    expect(entry.lines[0]).toMatchObject({
      accountId: "acc:driver_receivables",
      party: { type: "driver", id: "d1" },
      debitMinor: 100_000,
    });
  });
});

describe("expense rules", () => {
  const rule = (overrides: Partial<ApprovalRule>): ApprovalRule => ({
    id: "r",
    name: "rule",
    priority: 100,
    categoryId: null,
    branchId: null,
    minAmountMinor: 0,
    maxAmountMinor: null,
    action: "require_approval",
    active: true,
    ...overrides,
  });

  it("takes the first matching rule by priority, categories including subcategories", () => {
    const rules = [
      rule({ id: "big", priority: 20, minAmountMinor: 500_001 }),
      rule({ id: "small", priority: 10, maxAmountMinor: 50_000, action: "auto_approve" }),
      rule({ id: "fuel", priority: 5, categoryId: "fuel", action: "auto_approve" }),
    ];
    const match = (amountMinor: number, categoryIds: string[]) =>
      matchingRule(rules, { amountMinor, branchId: "b1", categoryIds })?.id ?? null;
    expect(match(10_000, ["cat"])).toBe("small");
    expect(match(900_000, ["diesel", "fuel"])).toBe("fuel");
    expect(match(900_000, ["cat"])).toBe("big");
    expect(match(100_000, ["cat"])).toBeNull();
  });

  it("warns at 80% of a budget and exceeds at 100%", () => {
    expect([budgetLevel(79, 100), budgetLevel(80, 100), budgetLevel(100, 100)]).toEqual([
      "ok",
      "warning",
      "exceeded",
    ]);
  });

  it("keeps the anchor day of monthly runs", () => {
    expect(nextRun("2026-01-31", "monthly", 31)).toBe("2026-02-28");
    expect(nextRun("2026-02-28", "monthly", 31)).toBe("2026-03-31");
    expect(nextRun("2026-11-15", "quarterly", 15)).toBe("2027-02-15");
    expect(nextRun("2026-10-19", "weekly", 19)).toBe("2026-10-26");
  });

  it("measures km per litre between full tanks and flags the odd interval", () => {
    const fills = [
      { id: "a", odometer: 10_000, litres: 40, fullTank: true },
      { id: "b", odometer: 10_480, litres: 40, fullTank: true },
      { id: "c", odometer: 10_720, litres: 20, fullTank: false },
      { id: "d", odometer: 10_960, litres: 20, fullTank: true },
      { id: "e", odometer: 11_440, litres: 40, fullTank: true },
      { id: "f", odometer: 11_640, litres: 40, fullTank: true },
    ];
    expect(fuelEfficiency(fills).map((e) => [e.fillId, e.kmPerLitre, e.flagged])).toEqual([
      ["b", 12, false],
      ["d", 12, false],
      ["e", 12, false],
      ["f", 5, true],
    ]);
  });
});
