import { describe, expect, it } from "vitest";
import { Quote, type QuoteTerms } from "./Quote.js";

const now = new Date("2026-10-29T09:00:00Z");
const today = "2026-10-29";
const terms: QuoteTerms = {
  vehicleId: "v1",
  customerId: null,
  customerName: " Ama ",
  priceMinor: 100_000_00,
  discountMinor: 5_000_00,
  addOns: [{ kind: "tint", description: " Tint ", amountMinor: 1_000_00 }],
  tradeInDescription: "Old Vitz",
  tradeInMinor: 20_000_00,
  financing: "cash",
  depositMinor: null,
  termMonths: null,
  financingNote: null,
  validUntil: "2026-11-12",
  notes: null,
};
const draft = (t: Partial<QuoteTerms> = {}, minimum: number | null = 90_000_00) =>
  Quote.draft({
    ...terms,
    ...t,
    id: "q1",
    number: "QUO-1",
    branchId: "b1",
    leadId: null,
    minimumPriceMinor: minimum,
    today,
    createdBy: "u1",
    now,
  });

describe("Quote", () => {
  it("totals the vehicle, add-ons and the trade-in", () => {
    const q = draft();
    expect(q.totals()).toEqual({
      vehicleMinor: 95_000_00,
      addOnsMinor: 1_000_00,
      totalMinor: 96_000_00,
      balanceMinor: 76_000_00,
    });
    expect(q.snapshot()).toMatchObject({ customerName: "Ama", belowMinimum: false });
    expect(draft({ tradeInMinor: 200_000_00 }).totals().balanceMinor).toBe(0);
  });

  it("checks its terms", () => {
    expect(() => draft({ discountMinor: 200_000_00 })).toThrow("discount is above the price");
    expect(() => draft({ validUntil: "2026-10-28" })).toThrow("valid from today on");
    expect(() => draft({ tradeInDescription: null })).toThrow("Describe the trade-in");
    expect(() => draft({ depositMinor: 10_00 })).toThrow("A cash quote has no deposit or term");
    expect(() => draft({ financing: "bank", termMonths: 121 })).toThrow("1 to 120 months");
    expect(() => draft({ financing: "bank", depositMinor: 200_000_00 })).toThrow(
      "deposit is above the total",
    );
  });

  it("needs approval below the minimum, dropped when the price changes", () => {
    const q = draft({ discountMinor: 15_000_00 });
    expect(q.snapshot().belowMinimum).toBe(true);
    expect(() => q.send("d1", today, now)).toThrow("have it approved first");
    q.approve("m1", now);
    q.revise({ ...terms, discountMinor: 15_000_00, notes: "x" }, 90_000_00, today, now);
    expect(q.snapshot().approvedBy).toBe("m1");
    q.revise({ ...terms, discountMinor: 16_000_00 }, 90_000_00, today, now);
    expect(q.snapshot().approvedBy).toBeNull();
    expect(() => draft().approve("m1", now)).toThrow("not below the minimum");
  });

  it("is sent, then accepted, rejected or withdrawn; a sent quote lapses", () => {
    const q = draft();
    expect(() => q.decide("accepted", null, today, now)).toThrow("Only a sent quote is answered");
    q.send("d1", today, now);
    expect(() => q.revise(terms, null, today, now)).toThrow("Only a draft quote is edited");
    expect(() => q.decide("accepted", null, "2026-11-13", now)).toThrow("has run out");
    expect(q.expire("2026-11-12", now)).toBe(false);
    expect(q.expire("2026-11-13", now)).toBe(true);
    expect(q.status).toBe("expired");
    expect(() => q.decide("withdrawn", null, today, now)).toThrow("closed");

    const r = draft();
    r.send("d1", today, now);
    r.decide("accepted", " Deal ", today, now);
    expect(r.snapshot()).toMatchObject({ status: "accepted", decisionNote: "Deal" });
  });
});
