import { describe, expect, it } from "vitest";
import { Part, PartRuleError, Stock } from "./Part.js";

const now = new Date("2026-10-28T08:00:00Z");

const part = (compatible: { make: string; model: string | null }[] = []) =>
  Part.create({
    id: "p1",
    sku: " bp-101 ",
    name: " Brake pads ",
    unit: "set",
    category: " ",
    compatible,
    notes: null,
    active: true,
    createdBy: "u1",
    now,
  });

const stock = (onHand = 0, avgCostMinor = 0, reorderLevel: number | null = null) =>
  Stock.restore({
    id: "s1",
    partId: "p1",
    branchId: "b1",
    onHand,
    avgCostMinor,
    reorderLevel,
    reorderQty: null,
    location: null,
    belowSince: null,
    updatedAt: now,
  });

describe("part", () => {
  it("keeps a clean upper-case SKU and name, and each fit once", () => {
    const p = part([
      { make: "Toyota", model: "Corolla" },
      { make: "toyota", model: "corolla " },
      { make: "Kia", model: null },
    ]).snapshot();
    expect(p).toMatchObject({ sku: "BP-101", name: "Brake pads", category: null });
    expect(p.compatible).toEqual([
      { make: "Toyota", model: "Corolla" },
      { make: "Kia", model: null },
    ]);
    expect(() => part().change({ sku: "no spaces" }, now)).toThrow(PartRuleError);
  });

  it("fits every vehicle without a list, else the makes and models listed", () => {
    expect(part().fits("Nissan", "Almera")).toBe(true);
    const p = part([
      { make: "Toyota", model: "Corolla" },
      { make: "Kia", model: null },
    ]);
    expect(p.fits("TOYOTA", "corolla")).toBe(true);
    expect(p.fits("Toyota", "Vitz")).toBe(false);
    expect(p.fits("Kia", "Picanto")).toBe(true);
  });
});

describe("stock", () => {
  it("averages the cost of what comes in and issues at the average", () => {
    const s = stock();
    expect(s.receive(10, 5_000, now)).toMatchObject({ valueMinor: 50_000, avgCostAfter: 5_000 });
    expect(s.receive(5, 8_000, now)).toMatchObject({
      valueMinor: 40_000,
      onHandAfter: 15,
      avgCostAfter: 6_000,
    });
    expect(s.take(2.5, "Pads", now)).toMatchObject({
      quantity: -2.5,
      unitCostMinor: 6_000,
      valueMinor: -15_000,
      onHandAfter: 12.5,
      avgCostAfter: 6_000,
    });
  });

  it("never goes below nothing and keeps two decimals", () => {
    const s = stock(1, 100);
    expect(() => s.take(1.5, "Oil", now)).toThrow(/Only 1 of Oil in stock/);
    expect(() => s.receive(0.333, 100, now)).toThrow(/two decimals/);
    expect(() => s.receive(0, 100, now)).toThrow(/more than nothing/);
  });

  it("goes low once each time it falls to the reorder level", () => {
    const s = stock(5, 100, 2);
    expect(s.take(2, "Filter", now).fellBelow).toBe(false);
    expect(s.take(1, "Filter", now).fellBelow).toBe(true);
    expect(s.snapshot().belowSince).toEqual(now);
    expect(s.take(1, "Filter", now).fellBelow).toBe(false);
    s.receive(4, 100, now);
    expect(s.snapshot().belowSince).toBeNull();
    expect(s.take(4, "Filter", now).fellBelow).toBe(true);
  });

  it("a reorder level set at or above the stock is low at once", () => {
    const s = stock(3, 100);
    expect(s.setReorder({ reorderLevel: 3, reorderQty: 10, location: " A-1 " }, now)).toBe(true);
    expect(s.snapshot()).toMatchObject({ reorderLevel: 3, reorderQty: 10, location: "A-1" });
    expect(s.low).toBe(true);
    expect(s.setReorder({ reorderLevel: null, reorderQty: null, location: null }, now)).toBe(false);
    expect(s.low).toBe(false);
  });
});
