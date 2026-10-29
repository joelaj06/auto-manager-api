import { describe, expect, it } from "vitest";
import {
  checkSplit,
  Commission,
  CommissionPlan,
  grossProfit,
  type CommissionTier,
} from "./Commission.js";

const now = new Date("2026-10-29T09:00:00Z");
const plan = (basis: "gross_profit_percent" | "price_percent" | "flat", tiers: CommissionTier[]) =>
  CommissionPlan.define({
    id: "p1",
    name: " Sales ",
    userId: null,
    basis,
    tiers,
    createdBy: "u1",
    now,
  });
const pct = (fromUnits: number, percent: string): CommissionTier => ({
  fromUnits,
  percent,
  amountMinor: null,
});
const accrue = () =>
  Commission.accrue({
    id: "c1",
    dealId: "d1",
    userId: "u1",
    branchId: "b1",
    planId: "p1",
    basis: "flat",
    rate: "50000",
    baseMinor: 500_00,
    sharePercent: 100,
    amountMinor: 500_00,
    accruedOn: "2026-10-29",
    now,
  });

describe("CommissionPlan", () => {
  it("takes a share of the gross profit by the month's tier", () => {
    const p = plan("gross_profit_percent", [pct(1, "10"), pct(4, "12.5")]);
    expect(p.snapshot().name).toBe("Sales");
    const figures = { grossProfitMinor: 8_000_00, priceMinor: 60_000_00 };
    expect(p.earn(figures, 1, 100)).toEqual({
      rate: "10",
      baseMinor: 8_000_00,
      amountMinor: 800_00,
    });
    expect(p.earn(figures, 4, 100).amountMinor).toBe(1_000_00);
    expect(p.earn(figures, 9, 50).amountMinor).toBe(500_00);
    expect(p.earn({ grossProfitMinor: -100_00, priceMinor: 1 }, 1, 100).amountMinor).toBe(0);
  });

  it("pays on the price or a flat amount", () => {
    const price = plan("price_percent", [pct(1, "1.5")]);
    expect(price.earn({ grossProfitMinor: 0, priceMinor: 60_000_00 }, 1, 100).amountMinor).toBe(
      900_00,
    );
    const flat = plan("flat", [{ fromUnits: 1, percent: null, amountMinor: 500_00 }]);
    expect(flat.earn({ grossProfitMinor: 0, priceMinor: 0 }, 3, 40).amountMinor).toBe(200_00);
  });

  it("checks its tiers", () => {
    expect(() => plan("flat", [])).toThrow(/tiers/);
    expect(() => plan("price_percent", [pct(2, "1")])).toThrow(/first vehicle/);
    expect(() => plan("price_percent", [pct(1, "1"), pct(1, "2")])).toThrow(/go up/);
    expect(() => plan("price_percent", [pct(1, "101")])).toThrow(/percentage/);
    expect(() => plan("flat", [pct(1, "5")])).toThrow(/amount/);
  });

  it("is revised and retired", () => {
    const p = plan("price_percent", [pct(1, "1")]);
    p.retire(now);
    expect(() => p.revise({ name: "x", basis: "flat", tiers: [] }, now)).toThrow(/retired/);
  });
});

describe("commission split", () => {
  it("shares between up to five sellers adding up to 100", () => {
    expect(
      checkSplit([
        { userId: "a", percent: 60 },
        { userId: "b", percent: 40 },
      ]),
    ).toHaveLength(2);
    expect(() => checkSplit([{ userId: "a", percent: 60 }])).toThrow(/100/);
    expect(() =>
      checkSplit([
        { userId: "a", percent: 50 },
        { userId: "a", percent: 50 },
      ]),
    ).toThrow(/once/);
    expect(() => checkSplit([])).toThrow();
  });
});

describe("Commission", () => {
  it("becomes payable, is paid, and a paid one is recovered by a negative entry", () => {
    const c = accrue();
    expect(c.snapshot()).toMatchObject({ period: "2026-10", status: "accrued", kind: "earned" });
    expect(() => c.pay("po1", now)).toThrow(/not payable/);
    expect(c.makePayable("2026-10-30", now)).toBe(true);
    expect(c.makePayable("2026-10-30", now)).toBe(false);
    c.pay("po1", now);
    const recovery = c.clawBack("Vehicle returned", { id: "c2", today: "2026-11-02", now });
    expect(recovery?.snapshot()).toMatchObject({
      kind: "clawback",
      amountMinor: -500_00,
      status: "payable",
      period: "2026-11",
      clawsBackId: "c1",
    });
    expect(c.snapshot()).toMatchObject({ status: "paid", clawbackReason: "Vehicle returned" });
    expect(() => recovery!.clawBack("Again", { id: "c3", today: "2026-11-02", now })).toThrow();
  });

  it("cancels an unpaid one", () => {
    const c = accrue();
    expect(() => c.clawBack(" ", { id: "x", today: "2026-10-30", now })).toThrow(/why/);
    expect(c.clawBack("Sale undone", { id: "x", today: "2026-10-30", now })).toBeNull();
    expect(c.status).toBe("clawed_back");
    expect(() => c.clawBack("Twice", { id: "x", today: "2026-10-30", now })).toThrow(/already/);
  });
});

describe("gross profit", () => {
  it("takes the costs and the commission from the revenue", () => {
    expect(
      grossProfit({
        revenueMinor: 60_000_00,
        costMinor: 45_000_00,
        reconditioningMinor: 2_000_00,
        holdingMinor: 500_00,
        commissionMinor: 1_000_00,
      }),
    ).toMatchObject({ beforeCommissionMinor: 12_500_00, grossProfitMinor: 11_500_00 });
  });
});
