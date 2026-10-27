import { RentalBookingError } from "./RentalBooking.js";

export const DEPOSIT_STATUSES = [
  "held",
  "partially_applied",
  "applied",
  "released",
  "reversed",
] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

export type RentalDepositProps = Readonly<{
  id: string;
  bookingId: string;
  paymentId: string;
  currency: string;
  amountMinor: number;
  appliedMinor: number;
  refundedMinor: number;
  refundPaymentId: string | null;
  status: DepositStatus;
  heldBy: string | null;
  heldAt: Date;
  releasedAt: Date | null;
  updatedAt: Date;
}>;

/**
 * A booking's security deposit (docs/07 §5): held, not revenue — the payment stays the customer's
 * credit — then applied to the booking's invoices (damage, fuel, unpaid days) and the rest
 * released back: `held → partially_applied → released` (or `applied` when nothing is left).
 */
export class RentalDeposit {
  private constructor(private props: RentalDepositProps) {}

  static hold(params: {
    id: string;
    bookingId: string;
    paymentId: string;
    currency: string;
    amountMinor: number;
    heldBy: string | null;
    now: Date;
  }): RentalDeposit {
    if (!Number.isSafeInteger(params.amountMinor) || params.amountMinor <= 0)
      throw new RentalBookingError("The deposit is above zero");
    return new RentalDeposit({
      ...params,
      appliedMinor: 0,
      refundedMinor: 0,
      refundPaymentId: null,
      status: "held",
      heldAt: params.now,
      releasedAt: null,
      updatedAt: params.now,
    });
  }

  static restore(props: RentalDepositProps): RentalDeposit {
    return new RentalDeposit(props);
  }

  snapshot(): RentalDepositProps {
    return this.props;
  }

  /** What is still held. */
  heldMinor(): number {
    const p = this.props;
    return p.status === "released" || p.status === "reversed"
      ? 0
      : p.amountMinor - p.appliedMinor - p.refundedMinor;
  }

  /** Part of it pays the booking's invoices. */
  apply(amountMinor: number, now: Date): void {
    this.assertHeld();
    if (amountMinor <= 0 || amountMinor > this.heldMinor())
      throw new RentalBookingError("Apply up to what the deposit still holds");
    const appliedMinor = this.props.appliedMinor + amountMinor;
    this.props = {
      ...this.props,
      appliedMinor,
      status: appliedMinor === this.props.amountMinor ? "applied" : "partially_applied",
      updatedAt: now,
    };
  }

  /** The rest goes back to the customer (`refundPaymentId` null when nothing was left). */
  release(refundPaymentId: string | null, now: Date): void {
    this.assertHeld();
    this.props = {
      ...this.props,
      refundedMinor: this.heldMinor(),
      refundPaymentId,
      status: "released",
      releasedAt: now,
      updatedAt: now,
    };
  }

  /** The deposit payment was reversed in finance: nothing is held any more. */
  reversed(now: Date): void {
    this.props = { ...this.props, status: "reversed", updatedAt: now };
  }

  private assertHeld(): void {
    if (this.heldMinor() === 0)
      throw new RentalBookingError(
        `The deposit is ${this.props.status.replaceAll("_", " ")}: nothing is held`,
      );
  }
}
