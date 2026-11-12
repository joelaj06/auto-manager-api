import { divideHalfEven } from "../money/Decimal.js";
import { marginOf } from "./StockUnit.js";

/** One vehicle on the lot as the tally counts it (base currency, minor units). */
export type TalliedUnit = Readonly<{
  /** Null: not priced yet. */
  askingMinor: number | null;
  /** Null: the caller does not see this vehicle's cost. */
  costMinor: number | null;
}>;

export type StockTotals = Readonly<{
  units: number;
  /** Units with an asking price. */
  priced: number;
  unpriced: number;
  askingMinor: number;
  averageAskingMinor: number | null;
  /** Units whose cost is counted. */
  costed: number;
  costMinor: number;
  averageCostMinor: number | null;
  /** Asking less cost over the units that have both. */
  profitMinor: number;
  /** Profit as a percentage of those units' asking value, to one decimal. */
  marginPercent: string | null;
}>;

/**
 * A running count of stock with its asking value, cost and profit (docs/10 §2, decision 541):
 * each figure is over the units that have it, so an unpriced car neither lowers the asking value
 * nor shows its whole cost as a loss, and the counts say how many units each figure covers.
 */
export class StockTally {
  private units = 0;
  private priced = 0;
  private asking = 0;
  private costed = 0;
  private cost = 0;
  private profit = 0;
  /** Asking value of the units in the profit. */
  private profitBase = 0;

  add(unit: TalliedUnit): void {
    this.units += 1;
    if (unit.askingMinor !== null) {
      this.priced += 1;
      this.asking += unit.askingMinor;
    }
    if (unit.costMinor !== null) {
      this.costed += 1;
      this.cost += unit.costMinor;
    }
    if (unit.askingMinor !== null && unit.costMinor !== null) {
      this.profit += unit.askingMinor - unit.costMinor;
      this.profitBase += unit.askingMinor;
    }
  }

  totals(): StockTotals {
    const average = (sum: number, count: number) =>
      count === 0 ? null : Number(divideHalfEven(BigInt(sum), BigInt(count)));
    return {
      units: this.units,
      priced: this.priced,
      unpriced: this.units - this.priced,
      askingMinor: this.asking,
      averageAskingMinor: average(this.asking, this.priced),
      costed: this.costed,
      costMinor: this.cost,
      averageCostMinor: average(this.cost, this.costed),
      profitMinor: this.profit,
      marginPercent:
        this.profitBase === 0
          ? null
          : marginOf(this.profitBase, this.profitBase - this.profit).percent,
    };
  }
}
