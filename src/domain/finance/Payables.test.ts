import { describe, expect, it } from "vitest";
import type { SystemAccountKey } from "./Journal.js";
import { ageBills, bucketOf, daysOverdue, dueOn, settleBills, withholdingOf } from "./Payables.js";
import { Postings } from "./Postings.js";

describe("bills falling due", () => {
  it("is due after the supplier's terms and ages by days past due", () => {
    expect(dueOn("2026-10-01", 30)).toBe("2026-10-31");
    expect(dueOn("2026-10-01", null)).toBe("2026-10-01");
    expect(daysOverdue("2026-10-31", "2026-10-28")).toBe(0);
    expect(daysOverdue("2026-10-01", "2026-12-01")).toBe(61);
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(bucketOf)).toEqual([
      "current",
      "days1to30",
      "days1to30",
      "days31to60",
      "days31to60",
      "days61to90",
      "days61to90",
      "over90",
    ]);
    expect(
      ageBills(
        [
          { dueOn: "2026-11-15", amountMinor: 100 },
          { dueOn: "2026-10-20", amountMinor: 200 },
          { dueOn: "2026-06-01", amountMinor: 300 },
        ],
        "2026-10-28",
      ),
    ).toEqual({ current: 100, days1to30: 200, days31to60: 0, days61to90: 0, over90: 300 });
  });
});

describe("withholding tax", () => {
  it("is a percentage of the bills before VAT, rounded half to even, at most 25%", () => {
    expect(withholdingOf(100_000, "7.5")).toBe(7_500);
    expect(withholdingOf(150, "3")).toBe(4); // 4.5 → 4
    expect(withholdingOf(250, "3")).toBe(8); // 7.5 → 8
    expect(withholdingOf(100_000, "0")).toBe(0);
    expect(() => withholdingOf(100, "26")).toThrow(/between 0 and 25/);
  });

  it("moves what was withheld from the supplier to the tax authority", () => {
    const entry = Postings.supplierWithholding(
      {
        paymentId: "p1",
        amountMinor: 7_500,
        branchId: "b1",
        supplierId: "s1",
        date: "2026-10-28",
        description: "Withholding tax",
      },
      (key: SystemAccountKey) => `acc:${key}`,
    );
    expect(entry.source).toEqual({ type: "supplier_wht", id: "p1" });
    expect(entry.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor])).toEqual([
      ["acc:payables", 7_500, 0],
      ["acc:withholding_tax", 0, 7_500],
    ]);
  });
});

describe("settling several bills", () => {
  it("shares the gross paid in base over the bills and keeps each one's exchange difference", () => {
    const settled = settleBills(
      [
        { amountMinor: 10_000, amountBaseMinor: 150_000 },
        { amountMinor: 5_000, amountBaseMinor: 76_000 },
      ],
      210_000,
      "GHS",
    );
    expect(settled).toEqual([
      { shareBaseMinor: 140_000, differenceMinor: 10_000 },
      { shareBaseMinor: 70_000, differenceMinor: 6_000 },
    ]);
    expect(settleBills([{ amountMinor: 300, amountBaseMinor: 300 }], 300, "GHS")).toEqual([
      { shareBaseMinor: 300, differenceMinor: 0 },
    ]);
  });
});
