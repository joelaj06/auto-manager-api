import type { FuelLevel } from "../assignments/VehicleAssignment.js";
import { DomainError } from "../errors/DomainError.js";
import { Money } from "../money/Money.js";
import type { PricingTerms, QuoteLineKind, RentalQuote } from "./RentalPricing.js";
import type { RentalSettings } from "./RentalRates.js";

export class RentalBookingError extends DomainError {
  readonly code = "RENTAL_BOOKING_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const BOOKING_STATUSES = [
  "reserved",
  "confirmed",
  "checked_out",
  "returned",
  "closed",
  "cancelled",
  "no_show",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
/** As shown: a reservation past its expiry is "expired" until someone acts on it. */
export type ShownStatus = BookingStatus | "expired";

export const CHARGE_KINDS = [
  "rental",
  "change",
  "extension",
  "late_return",
  "mileage",
  "cancellation",
  "cancellation_fee",
  "no_show_fee",
] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

/** An amount the booking adds to what the customer owes, in minor units (negative: a credit). */
export type ChargeAmount = Readonly<{ netMinor: number; taxMinor: number; totalMinor: number }>;

/** The quote as stored (Money as `{ amountMinor, currency, formatted }`). */
export type QuoteJson = Readonly<Record<string, unknown>>;

export type RentalBookingProps = Readonly<{
  id: string;
  number: string;
  status: BookingStatus;
  branchId: string;
  customerId: string;
  classId: string | null;
  vehicleId: string;
  byClass: boolean;
  blockId: string;
  pickupAt: Date;
  returnAt: Date;
  expiresAt: Date | null;
  currency: string;
  terms: PricingTerms;
  quote: QuoteJson;
  confirmedAt: Date | null;
  checkedOutAt: Date | null;
  odometerOut: number | null;
  fuelOut: FuelLevel | null;
  returnedAt: Date | null;
  odometerIn: number | null;
  fuelIn: FuelLevel | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type Placement = Readonly<{ vehicleId: string; blockId: string }>;

const HOUR = 3_600_000;

/**
 * A rental booking (docs/07 §2): reserved (held until it lapses) → confirmed → checked out →
 * returned → closed, or cancelled / no-show before check-out. The vehicle is held by one block;
 * the application keeps the block in step with every change here.
 */
export class RentalBooking {
  private constructor(private props: RentalBookingProps) {}

  static reserve(
    params: Omit<
      RentalBookingProps,
      | "status"
      | "confirmedAt"
      | "checkedOutAt"
      | "odometerOut"
      | "fuelOut"
      | "returnedAt"
      | "odometerIn"
      | "fuelIn"
      | "closedAt"
      | "cancelledAt"
      | "cancelReason"
      | "updatedAt"
    > &
      Readonly<{ confirmed: boolean }>,
  ): RentalBooking {
    const { confirmed, ...props } = params;
    if (props.returnAt <= props.pickupAt)
      throw new RentalBookingError("The return is after the pickup");
    if (!confirmed && props.expiresAt === null)
      throw new RentalBookingError("A reservation needs an expiry");
    return new RentalBooking({
      ...props,
      status: confirmed ? "confirmed" : "reserved",
      expiresAt: confirmed ? null : props.expiresAt,
      confirmedAt: confirmed ? props.createdAt : null,
      checkedOutAt: null,
      odometerOut: null,
      fuelOut: null,
      returnedAt: null,
      odometerIn: null,
      fuelIn: null,
      closedAt: null,
      cancelledAt: null,
      cancelReason: null,
      notes: props.notes?.trim() || null,
      updatedAt: props.createdAt,
    });
  }

  static restore(props: RentalBookingProps): RentalBooking {
    return new RentalBooking(props);
  }

  snapshot(): RentalBookingProps {
    return this.props;
  }

  get id(): string {
    return this.props.id;
  }

  get status(): BookingStatus {
    return this.props.status;
  }

  isLapsed(now: Date): boolean {
    return (
      this.props.status === "reserved" &&
      this.props.expiresAt !== null &&
      this.props.expiresAt <= now
    );
  }

  shownStatus(now: Date): ShownStatus {
    return this.isLapsed(now) ? "expired" : this.props.status;
  }

  /** Not yet with the customer: times, extras and the vehicle may still change. */
  isUpcoming(): boolean {
    return this.props.status === "reserved" || this.props.status === "confirmed";
  }

  confirm(now: Date): void {
    if (this.props.status !== "reserved")
      throw new RentalBookingError(`Only a reservation is confirmed (this one is ${this.shown()})`);
    this.props = {
      ...this.props,
      status: "confirmed",
      expiresAt: null,
      confirmedAt: now,
      updatedAt: now,
    };
  }

  /** New times or terms before check-out, re-quoted and re-placed by the caller. */
  change(
    params: Readonly<{
      pickupAt: Date;
      returnAt: Date;
      terms: PricingTerms;
      quote: QuoteJson;
      placement: Placement;
      expiresAt: Date | null;
      notes?: string | null;
      now: Date;
    }>,
  ): void {
    this.assertUpcoming("changed");
    if (params.returnAt <= params.pickupAt)
      throw new RentalBookingError("The return is after the pickup");
    this.props = {
      ...this.props,
      pickupAt: params.pickupAt,
      returnAt: params.returnAt,
      terms: params.terms,
      quote: params.quote,
      ...params.placement,
      expiresAt: this.props.status === "reserved" ? params.expiresAt : null,
      notes: params.notes === undefined ? this.props.notes : params.notes?.trim() || null,
      updatedAt: params.now,
    };
  }

  changeVehicle(placement: Placement, now: Date): void {
    this.assertUpcoming("given another vehicle");
    this.props = { ...this.props, ...placement, updatedAt: now };
  }

  /** The keys handed over (docs/07 §6). */
  checkOut(
    params: Readonly<{ at: Date; odometer: number; fuel: FuelLevel; vehicleId: string; now: Date }>,
  ): void {
    if (this.props.status !== "confirmed")
      throw new RentalBookingError(
        `Only a confirmed booking is checked out (this one is ${this.shown()})`,
      );
    if (!Number.isInteger(params.odometer) || params.odometer < 0)
      throw new RentalBookingError("The odometer is a whole number of km");
    if (params.at >= this.props.returnAt)
      throw new RentalBookingError("The booking ended already: change its times first");
    this.props = {
      ...this.props,
      status: "checked_out",
      vehicleId: params.vehicleId,
      checkedOutAt: params.at,
      odometerOut: params.odometer,
      fuelOut: params.fuel,
      updatedAt: params.now,
    };
  }

  /** A later return (docs/07 §7), re-quoted by the caller; a confirmed booking may extend too. */
  extend(params: Readonly<{ returnAt: Date; quote: QuoteJson; now: Date }>): void {
    if (this.props.status !== "confirmed" && this.props.status !== "checked_out")
      throw new RentalBookingError(`A booking that is ${this.shown()} is not extended`);
    if (params.returnAt <= this.props.returnAt)
      throw new RentalBookingError("An extension moves the return later");
    this.props = {
      ...this.props,
      returnAt: params.returnAt,
      quote: params.quote,
      updatedAt: params.now,
    };
  }

  /** The vehicle back (docs/07 §6). */
  checkIn(
    params: Readonly<{ at: Date; odometer: number; fuel: FuelLevel; quote: QuoteJson; now: Date }>,
  ): void {
    if (this.props.status !== "checked_out")
      throw new RentalBookingError(
        `Only a checked-out booking is returned (this one is ${this.shown()})`,
      );
    if (this.props.checkedOutAt === null || params.at <= this.props.checkedOutAt)
      throw new RentalBookingError("The return is after the check-out");
    if (params.at > params.now) throw new RentalBookingError("The return is not in the future");
    if (!Number.isInteger(params.odometer) || params.odometer < (this.props.odometerOut ?? 0))
      throw new RentalBookingError(
        `The odometer is at least what it was at check-out (${this.props.odometerOut})`,
      );
    this.props = {
      ...this.props,
      status: "returned",
      returnedAt: params.at,
      odometerIn: params.odometer,
      fuelIn: params.fuel,
      quote: params.quote,
      updatedAt: params.now,
    };
  }

  close(now: Date): void {
    if (this.props.status !== "returned")
      throw new RentalBookingError(
        `Only a returned booking is closed (this one is ${this.shown()})`,
      );
    this.props = { ...this.props, status: "closed", closedAt: now, updatedAt: now };
  }

  cancel(reason: string, now: Date): void {
    this.assertUpcoming("cancelled");
    this.props = {
      ...this.props,
      status: "cancelled",
      expiresAt: null,
      cancelledAt: now,
      cancelReason: reason.trim(),
      updatedAt: now,
    };
  }

  /** The customer did not come (from the pickup time). */
  noShow(reason: string, now: Date): void {
    this.assertUpcoming("marked a no-show");
    if (now < this.props.pickupAt)
      throw new RentalBookingError("A booking is a no-show only once its pickup time has come");
    this.props = {
      ...this.props,
      status: "no_show",
      expiresAt: null,
      cancelledAt: now,
      cancelReason: reason.trim(),
      updatedAt: now,
    };
  }

  /** Km driven between check-out and check-in. */
  drivenKm(): number | null {
    const { odometerIn, odometerOut } = this.props;
    return odometerIn === null || odometerOut === null ? null : odometerIn - odometerOut;
  }

  private assertUpcoming(what: string): void {
    if (!this.isUpcoming())
      throw new RentalBookingError(`A booking that is ${this.shown()} is not ${what}`);
  }

  private shown(): string {
    return this.props.status.replaceAll("_", " ");
  }
}

/**
 * The fee for cancelling at `now` (decision 336): free until the free-cancellation hours before
 * pickup, then the late-cancellation percent of the booking's charges; a no-show pays the
 * no-show percent. The fee carries no tax of its own: it is a share of charges already taxed.
 */
export function cancellationFee(
  settings: Pick<
    RentalSettings,
    "freeCancellationHours" | "lateCancellationFeePercent" | "noShowFeePercent"
  >,
  booking: Readonly<{ pickupAt: Date; chargedMinor: number; currency: string }>,
  now: Date,
  kind: "cancellation" | "no_show",
): Readonly<{ percent: string; amountMinor: number }> {
  if (kind === "cancellation") {
    const hoursBefore = (booking.pickupAt.getTime() - now.getTime()) / HOUR;
    if (hoursBefore >= settings.freeCancellationHours) return { percent: "0", amountMinor: 0 };
  }
  const percent =
    kind === "no_show" ? settings.noShowFeePercent : settings.lateCancellationFeePercent;
  const charged = Money.ofMinor(Math.max(0, booking.chargedMinor), booking.currency);
  return { percent, amountMinor: charged.percent(percent).amountMinor };
}

const MILEAGE_LINES: ReadonlySet<QuoteLineKind> = new Set(["extra_km_estimate"]);

/** The lines of a quote that are the mileage, or the rest. */
export function isMileage(kind: QuoteLineKind): boolean {
  return MILEAGE_LINES.has(kind);
}

/** What `after` adds over `before`, over the lines `which` keeps (all by default). */
export function quoteDelta(
  before: RentalQuote,
  after: RentalQuote,
  which: (kind: QuoteLineKind) => boolean = () => true,
): ChargeAmount {
  const sum = (q: RentalQuote) =>
    q.lines
      .filter((l) => which(l.kind))
      .reduce(
        (acc, l) => ({
          netMinor: acc.netMinor + l.net.amountMinor,
          taxMinor: acc.taxMinor + l.tax.amountMinor,
          totalMinor: acc.totalMinor + l.total.amountMinor,
        }),
        { netMinor: 0, taxMinor: 0, totalMinor: 0 },
      );
  const a = sum(after);
  const b = sum(before);
  return {
    netMinor: a.netMinor - b.netMinor,
    taxMinor: a.taxMinor - b.taxMinor,
    totalMinor: a.totalMinor - b.totalMinor,
  };
}

/** A quote's whole charge as one amount. */
export function quoteAmount(quote: RentalQuote): ChargeAmount {
  return {
    netMinor: quote.totals.net.amountMinor,
    taxMinor: quote.totals.tax.amountMinor,
    totalMinor: quote.totals.total.amountMinor,
  };
}
