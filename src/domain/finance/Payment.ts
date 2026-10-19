import { Money } from "../money/Money.js";
import { FinanceRuleError, type LedgerPartyType, type SystemAccountKey } from "./Journal.js";

export const PAYMENT_METHODS = ["cash", "momo", "bank_transfer", "cheque", "card"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type PaymentDirection = "in" | "out";

/** Where the money sits after a payment of each method. */
export const METHOD_ACCOUNT: Readonly<Record<PaymentMethod, SystemAccountKey>> = {
  cash: "cash",
  momo: "momo",
  bank_transfer: "bank",
  // Not yet in the bank: the deposit moves them (reconciliation, later).
  cheque: "undeposited",
  card: "undeposited",
};

export type PaymentProps = Readonly<{
  id: string;
  number: string;
  direction: PaymentDirection;
  method: PaymentMethod;
  status: "recorded" | "reversed";
  party: Readonly<{ type: LedgerPartyType; id: string }> | null;
  partyName: string;
  branchId: string;
  paidOn: string;
  currency: string;
  fxRate: string;
  amountMinor: number;
  amountBaseMinor: number;
  allocatedMinor: number;
  /** Money out: the account it is for (party credit for a refund, an expense …). */
  counterAccountId: string | null;
  reference: string | null;
  momoNetwork: "mtn" | "telecel" | "at" | null;
  cashSessionId: string | null;
  vehicleId: string | null;
  notes: string | null;
  /** What the payment settles (an expense …), when a module recorded it. */
  source: Readonly<{ type: string; id: string }> | null;
  recordedBy: string | null;
  recordedAt: Date;
  reversedAt: Date | null;
  reversedBy: string | null;
  reverseReason: string | null;
}>;

/**
 * A payment recorded by staff (decision 16: record only — the money moved outside the system).
 * Money in always lands in the party's credit first and is then allocated to invoices; what is
 * not allocated stays as credit. A payment is never edited: it is reversed (allocations
 * released first) and recorded again.
 */
export class Payment {
  private constructor(private props: PaymentProps) {}

  static record(
    props: Omit<
      PaymentProps,
      "status" | "allocatedMinor" | "reversedAt" | "reversedBy" | "reverseReason"
    >,
  ): Payment {
    if (!Number.isSafeInteger(props.amountMinor) || props.amountMinor <= 0)
      throw new FinanceRuleError("A payment has an amount");
    if (props.direction === "in" && props.party === null)
      throw new FinanceRuleError("Money in comes from a customer, driver or supplier");
    if (props.direction === "out" && props.counterAccountId === null)
      throw new FinanceRuleError("Say what the money out was for");
    if (props.method === "momo" && props.momoNetwork === null)
      throw new FinanceRuleError("A mobile money payment needs its network");
    if (props.method !== "cash" && props.cashSessionId !== null)
      throw new FinanceRuleError("Only cash belongs to a cash session");
    const text = (value: string | null, max: number) => {
      const trimmed = value?.trim() ?? "";
      if (trimmed.length > max) throw new FinanceRuleError(`Keep it under ${max} characters`);
      return trimmed === "" ? null : trimmed;
    };
    const partyName = props.partyName.trim();
    if (partyName === "") throw new FinanceRuleError("Say who paid or was paid");
    return new Payment({
      ...props,
      partyName,
      reference: text(props.reference, 100),
      notes: text(props.notes, 2_000),
      status: "recorded",
      allocatedMinor: 0,
      reversedAt: null,
      reversedBy: null,
      reverseReason: null,
    });
  }

  static restore(props: PaymentProps): Payment {
    return new Payment(props);
  }

  get id(): string {
    return this.props.id;
  }

  get unallocatedMinor(): number {
    return this.props.amountMinor - this.props.allocatedMinor;
  }

  snapshot(): PaymentProps {
    return this.props;
  }

  allocate(amountMinor: number): void {
    if (this.props.status !== "recorded") throw new FinanceRuleError("This payment was reversed");
    if (this.props.direction !== "in") throw new FinanceRuleError("Only money in pays invoices");
    if (
      !Number.isSafeInteger(amountMinor) ||
      amountMinor <= 0 ||
      amountMinor > this.unallocatedMinor
    )
      throw new FinanceRuleError(
        `At most ${Money.ofMinor(this.unallocatedMinor, this.props.currency).format()} of this payment is left`,
      );
    this.props = { ...this.props, allocatedMinor: this.props.allocatedMinor + amountMinor };
  }

  release(amountMinor: number): void {
    if (amountMinor <= 0 || amountMinor > this.props.allocatedMinor)
      throw new FinanceRuleError("More is released than was allocated");
    this.props = { ...this.props, allocatedMinor: this.props.allocatedMinor - amountMinor };
  }

  reverse(reason: string, userId: string | null, now: Date): void {
    if (this.props.status === "reversed")
      throw new FinanceRuleError("This payment was already reversed");
    if (this.props.allocatedMinor > 0)
      throw new FinanceRuleError("Release the allocations of this payment first");
    if (reason.trim().length < 3) throw new FinanceRuleError("Give a reason for reversing it");
    this.props = {
      ...this.props,
      status: "reversed",
      reversedAt: now,
      reversedBy: userId,
      reverseReason: reason.trim(),
    };
  }
}
