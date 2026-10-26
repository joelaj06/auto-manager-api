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
  dateOfBirth: string | null;
  licenceNumber: string | null;
  licenceExpiresOn: string | null;
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
}
