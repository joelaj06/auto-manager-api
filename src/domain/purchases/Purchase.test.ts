import { describe, expect, it } from "vitest";
import { landedCost } from "./LandedCost.js";
import { Purchase } from "./Purchase.js";

const now = new Date("2026-10-28T09:00:00Z");
const line = (id: string, priceMinor: number, vin: string | null = null) => ({
  id,
  vin,
  make: "Toyota",
  model: "Corolla",
  year: 2018,
  colour: null,
  description: null,
  priceMinor,
});
const draft = (type: "local" | "import" = "import") =>
  Purchase.draft({
    id: "p1",
    number: "PUR-2026-000001",
    type,
    supplierId: "s1",
    branchId: "b1",
    currency: "USD",
    reference: null,
    expectedOn: null,
    notes: null,
    lines: [line("l1", 800_000, "jtdbr32e720123456"), line("l2", 200_000)],
    createdBy: "u1",
    now,
  });

describe("Purchase", () => {
  it("is ordered, moved forward along the import timeline and received line by line", () => {
    const p = draft();
    expect(p.snapshot().lines[0]!.vin).toBe("JTDBR32E720123456");
    expect(() => p.advance("shipped", "2026-10-28", now)).toThrow(/not on its way/);
    p.order("2026-10-01", "u1", now);
    expect(p.snapshot()).toMatchObject({ status: "ordered", stage: "ordered" });
    p.advance("shipped", "2026-10-05", now);
    expect(() => p.advance("paid", "2026-10-06", now)).toThrow(/already at shipped/);
    p.advance("under_clearing", "2026-10-20", now);
    expect(p.snapshot()).toMatchObject({ arrivedOn: "2026-10-20", releasedOn: null });
    p.advance("released", "2026-10-25", now);
    expect(p.snapshot().releasedOn).toBe("2026-10-25");

    p.receive("l1", "v1", "2026-10-27", "u2", now);
    expect(p.status).toBe("ordered");
    expect(() => p.receive("l1", "v9", "2026-10-27", "u2", now)).toThrow(/already received/);
    expect(() => p.editLine("l1", { ...line("l1", 0), vin: null }, now)).toThrow(
      /already received/,
    );
    expect(() => p.cancel("Changed our mind", "u1", now)).toThrow(/was received/);
    p.receive("l2", "v2", "2026-10-28", "u2", now);
    expect(p.snapshot()).toMatchObject({ status: "received", receivedOn: "2026-10-28" });
  });

  it("checks its vehicles and has no stages unless it is an import", () => {
    expect(() =>
      Purchase.draft({
        ...draft().snapshot(),
        lines: [line("a", 1, "JTDBR32E720123456"), line("b", 1, "JTDBR32E720123456")],
        createdBy: null,
        now,
      }),
    ).toThrow(/listed twice/);
    expect(() =>
      Purchase.draft({
        ...draft().snapshot(),
        lines: [line("a", 1, "BADVIN")],
        createdBy: null,
        now,
      }),
    ).toThrow(/17 letters/);
    const local = draft("local");
    local.order("2026-10-01", "u1", now);
    expect(local.snapshot().stage).toBeNull();
    expect(() => local.advance("shipped", "2026-10-02", now)).toThrow(/Only an import/);
    expect(() => draft().assertTakesCosts()).toThrow(/Order the purchase first/);
  });
});

describe("landedCost", () => {
  it("adds each vehicle's own costs and splits shared ones by value or equally", () => {
    const lines = landedCost(
      ["l1", "l2"],
      [
        { lineId: "l1", kind: "vehicle_price", allocation: "value", baseMinor: 12_000_000 },
        { lineId: "l2", kind: "vehicle_price", allocation: "value", baseMinor: 4_000_000 },
        { lineId: null, kind: "shipping", allocation: "value", baseMinor: 2_000_000 },
        { lineId: null, kind: "clearing", allocation: "equal", baseMinor: 100_001 },
        { lineId: "l2", kind: "repairs", allocation: "value", baseMinor: 50_000 },
      ],
      "GHS",
    );
    expect(lines).toEqual([
      {
        lineId: "l1",
        priceMinor: 12_000_000,
        directMinor: 0,
        sharedMinor: 1_550_001,
        totalMinor: 13_550_001,
      },
      {
        lineId: "l2",
        priceMinor: 4_000_000,
        directMinor: 50_000,
        sharedMinor: 550_000,
        totalMinor: 4_600_000,
      },
    ]);
    expect(
      landedCost(
        ["a", "b"],
        [{ lineId: null, kind: "shipping", allocation: "value", baseMinor: 3 }],
        "GHS",
      ).map((l) => l.totalMinor),
    ).toEqual([2, 1]);
  });
});
