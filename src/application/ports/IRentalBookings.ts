import type { RentalDeposit } from "../../domain/rentals/RentalDeposit.js";
import type {
  BookingStatus,
  ChargeAmount,
  ChargeKind,
  RentalBooking,
} from "../../domain/rentals/RentalBooking.js";

export const BOOKING_EVENT_TYPES = [
  "reserved",
  "confirmed",
  "changed",
  "vehicle_changed",
  "checked_out",
  "extended",
  "returned",
  "closed",
  "cancelled",
  "no_show",
  "damage_charged",
  "driver_named",
  "invoiced",
  "payment_recorded",
  "deposit_held",
  "deposit_applied",
  "deposit_released",
] as const;
export type BookingEventType = (typeof BOOKING_EVENT_TYPES)[number];

export type BookingEvent = Readonly<{
  id: string;
  bookingId: string;
  type: BookingEventType;
  at: Date;
  actorId: string | null;
  data: Readonly<Record<string, unknown>>;
}>;

export type BookingCharge = ChargeAmount &
  Readonly<{
    id: string;
    bookingId: string;
    eventId: string;
    kind: ChargeKind;
    description: string;
    /** The damage a `damage` charge is for (P5-4). */
    damageId: string | null;
    /** The invoice that billed it (P5-5); null until invoiced. */
    invoiceId?: string | null;
    createdBy: string | null;
    createdAt: Date;
  }>;

export type BookingFilter = Readonly<{
  branchIds: "all" | readonly string[];
  statuses?: readonly BookingStatus[];
  customerId?: string;
  vehicleId?: string;
  /** Bookings sharing time with [from, to). */
  from?: Date;
  to?: Date;
  /** Reservations past their expiry only (or none of them, with false). */
  lapsedAt?: Readonly<{ now: Date; lapsed: boolean }>;
  after?: Readonly<{ pickupAt: string; id: string }>;
  limit: number;
}>;

/** What booking checks about the renter (docs/07 §8). */
export type Renter = Readonly<{
  id: string;
  name: string;
  type: "individual" | "corporate";
  dateOfBirth: string | null;
  licenceNumber: string | null;
  licenceExpiresOn: string | null;
  /** Ghana Card number, or an identity document on file (passport, voter's ID …). */
  hasIdDocument: boolean;
  riskStatus: "ok" | "watch" | "blacklisted";
  riskReason: string | null;
  /** On account (docs/07 §5): invoiced with payment terms up to this limit; null: pays as it goes. */
  creditLimitMinor: number | null;
  paymentTermsDays: number | null;
}>;

/** What a customer owes and will owe (the credit limit check). */
export type Exposure = Readonly<{
  /** Issued invoices not yet paid, in the base currency. */
  openInvoicesMinor: number;
  /** Booking charges not yet invoiced (bookings not cancelled). */
  uninvoicedMinor: number;
}>;

/** A payment the customer made for a booking, still partly unallocated. */
export type Prepayment = Readonly<{ paymentId: string; unallocatedMinor: number }>;

/** A customer's rentals at a glance (docs/07 §8). */
export type RenterHistory = Readonly<{
  bookings: Readonly<Record<string, number>>;
  chargedMinor: number;
  damages: number;
  lastPickupAt: Date | null;
}>;

/** Rental bookings of the current tenant (tenant unit of work), docs/07 §2. */
export interface IRentalBookings {
  get(id: string): Promise<RentalBooking | null>;
  /** Locks the booking row until the unit of work ends. */
  lock(id: string): Promise<RentalBooking | null>;
  insert(booking: RentalBooking): Promise<void>;
  update(booking: RentalBooking): Promise<void>;
  /** Newest pickup first. */
  list(filter: BookingFilter): Promise<RentalBooking[]>;
  /** Stored at the database's clock, so the events of one unit of work keep their order. */
  addEvent(event: BookingEvent): Promise<void>;
  events(bookingId: string): Promise<BookingEvent[]>;
  /** Stored at the database's clock, like events. */
  addCharge(charge: BookingCharge): Promise<void>;
  charges(bookingId: string): Promise<BookingCharge[]>;
  /** A customer not removed. */
  renter(customerId: string): Promise<Renter | null>;
  history(customerId: string): Promise<RenterHistory>;
  exposure(customerId: string): Promise<Exposure>;

  // --- invoicing and payments (P5-5) ---
  markInvoiced(chargeIds: readonly string[], invoiceId: string): Promise<void>;
  /** The booking's invoices, oldest first. */
  invoiceIds(bookingId: string): Promise<string[]>;
  /** Payments recorded for the booking (not its deposit) with money left to allocate. */
  prepayments(bookingId: string): Promise<Prepayment[]>;
  deposit(bookingId: string, lock?: boolean): Promise<RentalDeposit | null>;
  depositByPayment(paymentId: string): Promise<RentalDeposit | null>;
  saveDeposit(deposit: RentalDeposit): Promise<void>;

  // --- corporate accounts ---
  authorisedDrivers(corporateId: string): Promise<Renter[]>;
  isAuthorisedDriver(corporateId: string, driverId: string): Promise<boolean>;
  addAuthorisedDriver(corporateId: string, driverId: string, actorId: string | null): Promise<void>;
  removeAuthorisedDriver(corporateId: string, driverId: string): Promise<boolean>;
}
