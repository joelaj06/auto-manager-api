import { describe, expect, it } from "vitest";
import {
  Deal,
  instalmentSchedule,
  needsApproval,
  planDates,
  planPosition,
  type DealTerms,
  type InstalmentPlan,
} from "./Deal.js";

const now = new Date("2026-10-29T09:00:00Z");
const today = "2026-10-29";
const terms: DealTerms = {
  vehicleId: "v1",
  customerId: "c1",
  salesExecutiveId: "u1",
  priceMinor: 100_000_00,
  discountMinor: 2_000_00,
  addOns: [{ kind: "tint", description: "Tint", amountMinor: 1_000_00 }],
  tradeIn: { appraisalId: "a1", valueMinor: 20_000_00 },
  financing: "cash",
  loan: null,
  plan: null,
  warrantyMonths: 6,
  serviceVouchers: 2,
  notes: null,
};
const plan: InstalmentPlan = {
  downPaymentMinor: 30_000_00,
  markupPercent: "10",
  frequency: "monthly",
  months: 12,
  firstDueOn: null,
};
const draft = (t: Partial<DealTerms> = {}, approval = false) =>
  Deal.draft({
    ...terms,
    ...t,
    id: "d1",
    number: "DEAL-1",
    branchId: "b1",
    leadId: null,
    quoteId: null,
    needsApproval: approval,
    createdBy: "u1",
    now,
  });
const sell = (d: Deal) =>
  d.sell(
    {
      soldOn: today,
      invoiceId: "i1",
      chargeInvoiceId: null,
      planChargeMinor: null,
      tradeInPaymentId: null,
    },
    now,
  );
const checklist = [{ item: "Spare key", checked: true, note: null }];

describe("Deal", () => {
  it("totals the vehicle, add-ons and the trade-in", () => {
    expect(draft().totals()).toEqual({
      vehicleMinor: 98_000_00,
      addOnsMinor: 1_000_00,
      totalMinor: 99_000_00,
      tradeInMinor: 20_000_00,
      balanceMinor: 79_000_00,
    });
  });

  it("checks the terms against the financing", () => {
    expect(() => draft({ discountMinor: 200_000_00 })).toThrow();
    expect(() => draft({ financing: "bank" })).toThrow();
    expect(() => draft({ financing: "in_house" })).toThrow();
    expect(() => draft({ plan })).toThrow();
    expect(() =>
      draft({ financing: "in_house", plan: { ...plan, downPaymentMinor: 79_000_00 } }),
    ).toThrow();
    expect(() => draft({ tradeIn: { appraisalId: "a1", valueMinor: 100_000_00 } })).toThrow();
  });

  it("needs approval below the minimum or over the discount limit", () => {
    expect(needsApproval({ priceMinor: 100_00, discountMinor: 5_00 }, 90_00, 5)).toBe(false);
    expect(needsApproval({ priceMinor: 100_00, discountMinor: 6_00 }, null, 5)).toBe(true);
    expect(needsApproval({ priceMinor: 100_00, discountMinor: 11_00 }, 90_00, null)).toBe(true);
    expect(needsApproval({ priceMinor: 100_00, discountMinor: 50_00 }, null, null)).toBe(false);
  });

  it("is reserved and sold only once approved, and an approval lapses with a new price", () => {
    const d = draft({}, true);
    expect(() => d.reserve("2026-11-05", today, now)).toThrow(/approved/);
    d.approve("m1", now);
    d.revise({ ...terms, notes: "Blue mats" }, true, now);
    expect(d.snapshot().approvedBy).toBe("m1");
    d.revise({ ...terms, discountMinor: 3_000_00 }, true, now);
    expect(d.snapshot().approvedBy).toBeNull();
    d.approve("m1", now);
    expect(() => d.reserve("2026-12-29", today, now)).toThrow();
    d.reserve("2026-11-05", today, now);
    expect(d.snapshot()).toMatchObject({ status: "reserved", holdUntil: "2026-11-05" });
  });

  it("lapses back to a draft after its hold", () => {
    const d = draft();
    d.reserve("2026-11-05", today, now);
    expect(d.lapse("2026-11-05", now)).toBe(false);
    expect(d.lapse("2026-11-06", now)).toBe(true);
    expect(d.snapshot()).toMatchObject({ status: "draft", holdUntil: null });
  });

  it("is sold on a bank loan only once the bank approves", () => {
    const d = draft({
      financing: "bank",
      loan: { lender: "GCB", loanMinor: 60_000_00, reference: null },
    });
    expect(d.snapshot().loanStatus).toBe("applied");
    expect(() => d.assertSellable()).toThrow(/bank/);
    expect(() => d.loan("disbursed", null, now)).toThrow();
    d.loan("approved", "GCB-77", now);
    expect(d.snapshot().loan?.reference).toBe("GCB-77");
    sell(d);
    d.loan("disbursed", null, now);
    expect(d.snapshot()).toMatchObject({ status: "sold", loanStatus: "disbursed" });
  });

  it("is delivered once paid, with the checklist and the warranty", () => {
    const d = draft();
    expect(() => d.cancel("x", now)).toThrow(/why/);
    sell(d);
    const delivery = {
      on: today,
      odometer: 52_000,
      checklist,
      documentId: "doc",
      invoicedMinor: 99_000_00,
    };
    expect(() => d.deliver({ ...delivery, paidMinor: 98_000_00 }, now)).toThrow(/paid in full/);
    expect(() =>
      d.deliver(
        {
          ...delivery,
          checklist: [{ item: "Spare key", checked: false, note: null }],
          paidMinor: 99_000_00,
        },
        now,
      ),
    ).toThrow();
    d.deliver({ ...delivery, paidMinor: 99_000_00 }, now);
    expect(d.snapshot()).toMatchObject({
      status: "delivered",
      deliveryOdometer: 52_000,
      warrantyEndsOn: "2027-04-29",
    });
    expect(() => d.cancel("Changed mind", now)).toThrow(/sold/);
  });

  it("asks only the trade-in and down payment before delivery on in-house terms", () => {
    const d = draft({ financing: "in_house", plan });
    expect(d.dueBeforeDelivery(99_000_00)).toBe(50_000_00);
    expect(draft().dueBeforeDelivery(99_000_00)).toBe(99_000_00);
  });

  it("is cancelled before the sale", () => {
    const d = draft();
    d.reserve("2026-11-05", today, now);
    d.cancel("Bought elsewhere", now);
    expect(d.snapshot()).toMatchObject({ status: "cancelled", holdUntil: null });
  });
});

describe("in-house instalments", () => {
  it("schedules the financed balance with its flat charge from a month after the sale", () => {
    const { chargeMinor, schedule } = instalmentSchedule(plan, 49_000_00, today);
    expect(chargeMinor).toBe(4_900_00);
    expect(schedule).toHaveLength(12);
    expect(schedule[0]?.dueOn).toBe("2026-11-29");
    expect(schedule.reduce((s, i) => s + i.amountMinor, 0)).toBe(53_900_00);
    expect(planDates(plan, today)).toEqual({ firstDueOn: "2026-11-29", lastDueOn: "2027-10-29" });
  });

  it("schedules weekly for the months' weeks", () => {
    const weekly = { ...plan, frequency: "weekly" as const, months: 3 };
    expect(instalmentSchedule(weekly, 13_000_00, today).schedule).toHaveLength(13);
    expect(planDates(weekly, today).firstDueOn).toBe("2026-11-05");
  });

  it("refuses a plan with nothing to finance", () => {
    expect(() => instalmentSchedule(plan, 0, today)).toThrow(/cash/);
  });

  it("pays the instalments in order and finds the overdue ones", () => {
    const { schedule } = instalmentSchedule(plan, 49_000_00, today);
    const first = schedule[0]!.amountMinor;
    const p = planPosition(schedule, first + 100_00, "2027-01-01");
    expect(p.instalments[0]?.status).toBe("paid");
    expect(p.instalments[1]?.status).toBe("overdue");
    expect(p.overdueCount).toBe(1);
    expect(p.nextDue?.number).toBe(2);
    expect(p.paidMinor).toBe(first + 100_00);
  });
});
