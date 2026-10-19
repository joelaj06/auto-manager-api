import { FinanceRuleError } from "./Journal.js";

export type CashSessionProps = Readonly<{
  id: string;
  branchId: string;
  cashierId: string;
  status: "open" | "closed";
  openedAt: Date;
  openingFloatMinor: number;
  cashInMinor: number;
  cashOutMinor: number;
  closedAt: Date | null;
  countedMinor: number | null;
  varianceMinor: number | null;
  closedBy: string | null;
  notes: string | null;
}>;

/**
 * A cashier's till for a shift (docs/13 §4): opening float, cash in and out from recorded
 * payments, counted at close; the difference to what is expected is the variance (posted to
 * cash over and short). Amounts are in the base currency.
 */
export class CashSession {
  private constructor(private props: CashSessionProps) {}

  static open(
    params: Readonly<{
      id: string;
      branchId: string;
      cashierId: string;
      floatMinor: number;
      now: Date;
    }>,
  ): CashSession {
    if (!Number.isSafeInteger(params.floatMinor) || params.floatMinor < 0)
      throw new FinanceRuleError("The opening float is zero or more");
    return new CashSession({
      id: params.id,
      branchId: params.branchId,
      cashierId: params.cashierId,
      status: "open",
      openedAt: params.now,
      openingFloatMinor: params.floatMinor,
      cashInMinor: 0,
      cashOutMinor: 0,
      closedAt: null,
      countedMinor: null,
      varianceMinor: null,
      closedBy: null,
      notes: null,
    });
  }

  static restore(props: CashSessionProps): CashSession {
    return new CashSession(props);
  }

  get id(): string {
    return this.props.id;
  }

  get expectedMinor(): number {
    return this.props.openingFloatMinor + this.props.cashInMinor - this.props.cashOutMinor;
  }

  snapshot(): CashSessionProps {
    return this.props;
  }

  /** A cash payment in (positive) or out (negative), or its reversal. */
  record(direction: "in" | "out", amountMinor: number): void {
    if (this.props.status !== "open") throw new FinanceRuleError("This cash session is closed");
    if (direction === "out" && amountMinor > this.expectedMinor)
      throw new FinanceRuleError("There is not that much cash in this till");
    this.props =
      direction === "in"
        ? { ...this.props, cashInMinor: this.props.cashInMinor + amountMinor }
        : { ...this.props, cashOutMinor: this.props.cashOutMinor + amountMinor };
  }

  /** Undoes a reversed payment's effect on an open session. */
  unrecord(direction: "in" | "out", amountMinor: number): void {
    if (this.props.status !== "open")
      throw new FinanceRuleError(
        "The cash session of this payment is closed; reverse it with a new entry",
      );
    this.props =
      direction === "in"
        ? { ...this.props, cashInMinor: this.props.cashInMinor - amountMinor }
        : { ...this.props, cashOutMinor: this.props.cashOutMinor - amountMinor };
  }

  close(countedMinor: number, closedBy: string, notes: string | null, now: Date): number {
    if (this.props.status !== "open")
      throw new FinanceRuleError("This cash session is already closed");
    if (!Number.isSafeInteger(countedMinor) || countedMinor < 0)
      throw new FinanceRuleError("The counted cash is zero or more");
    const variance = countedMinor - this.expectedMinor;
    this.props = {
      ...this.props,
      status: "closed",
      closedAt: now,
      countedMinor,
      varianceMinor: variance,
      closedBy,
      notes: notes?.trim() === "" ? null : (notes?.trim().slice(0, 2_000) ?? null),
    };
    return variance;
  }
}
