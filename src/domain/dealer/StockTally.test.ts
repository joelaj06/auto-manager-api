import { describe, expect, it } from "vitest";
import { StockTally } from "./StockTally.js";

describe("StockTally", () => {
  it("adds up twelve cars at the same cost and price", () => {
    const tally = new StockTally();
    for (let i = 0; i < 12; i += 1) tally.add({ askingMinor: 50_000_00, costMinor: 30_000_00 });
    expect(tally.totals()).toEqual({
      units: 12,
      priced: 12,
      unpriced: 0,
      askingMinor: 600_000_00,
      averageAskingMinor: 50_000_00,
      costed: 12,
      costMinor: 360_000_00,
      averageCostMinor: 30_000_00,
      profitMinor: 240_000_00,
      marginPercent: "40.0",
    });
  });

  it("counts an unpriced car's cost but leaves it out of the profit", () => {
    const tally = new StockTally();
    tally.add({ askingMinor: 50_000_00, costMinor: 30_000_00 });
    tally.add({ askingMinor: null, costMinor: 20_000_00 });
    expect(tally.totals()).toMatchObject({
      units: 2,
      priced: 1,
      unpriced: 1,
      askingMinor: 50_000_00,
      averageAskingMinor: 50_000_00,
      costed: 2,
      costMinor: 50_000_00,
      averageCostMinor: 25_000_00,
      profitMinor: 20_000_00,
      marginPercent: "40.0",
    });
  });

  it("shows a loss and no cost when the cost is hidden", () => {
    const loss = new StockTally();
    loss.add({ askingMinor: 10_000_00, costMinor: 12_500_00 });
    expect(loss.totals()).toMatchObject({ profitMinor: -2_500_00, marginPercent: "-25.0" });

    const hidden = new StockTally();
    hidden.add({ askingMinor: 10_000_00, costMinor: null });
    expect(hidden.totals()).toMatchObject({
      costed: 0,
      costMinor: 0,
      averageCostMinor: null,
      profitMinor: 0,
      marginPercent: null,
    });
  });

  it("rounds averages half-even and is empty with nothing added", () => {
    const tally = new StockTally();
    tally.add({ askingMinor: 1, costMinor: 1 });
    tally.add({ askingMinor: 2, costMinor: 2 });
    expect(tally.totals()).toMatchObject({ averageAskingMinor: 2, averageCostMinor: 2 });
    expect(new StockTally().totals()).toMatchObject({
      units: 0,
      averageAskingMinor: null,
      marginPercent: null,
    });
  });
});
