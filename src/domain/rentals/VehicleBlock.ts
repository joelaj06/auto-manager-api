import { DomainError } from "../errors/DomainError.js";
import type { VehicleStatus } from "../vehicles/VehicleStatus.js";

export class VehicleBlockError extends DomainError {
  readonly code = "VEHICLE_BLOCK_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const BLOCK_REASONS = [
  "rental",
  "maintenance",
  "transfer",
  "sale_hold",
  "test_drive",
  "other",
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];
/** Blocks people add by hand; rental blocks come from holds and bookings. */
export const MANUAL_BLOCK_REASONS = ["maintenance", "transfer", "sale_hold", "other"] as const;

export const BLOCK_STATUSES = ["hold", "confirmed", "out", "released"] as const;
export type BlockStatus = (typeof BLOCK_STATUSES)[number];

/** A stretch of time a vehicle is busy (docs/07 §3), turnaround included. */
export type BusyInterval = Readonly<{
  from: Date;
  /** Null: until further notice. */
  until: Date | null;
}>;

/**
 * One vehicle busy from `startsAt` (docs/07 §3, docs/22 §4). A rental also blocks the class
 * turnaround after `endsAt`; a hold lapses at `expiresAt`. A block booked by class (`classId`)
 * may be moved to another vehicle of the class until check-out.
 */
export type VehicleBlock = Readonly<{
  id: string;
  vehicleId: string;
  branchId: string;
  classId: string | null;
  reason: BlockReason;
  status: BlockStatus;
  startsAt: Date;
  endsAt: Date | null;
  blockedUntil: Date | null;
  expiresAt: Date | null;
  customerId: string | null;
  refType: string | null;
  refId: string | null;
  note: string | null;
  releasedAt: Date | null;
  releasedReason: string | null;
  releasedBy: string | null;
  createdBy: string | null;
  createdAt: Date;
}>;

/**
 * Vehicles offered for rent (decision 324): in the rental states. A vehicle off the road,
 * assigned to a driver, on work-and-pay or for sale is not offered until it is back.
 */
export const RENTABLE_STATUSES: ReadonlySet<VehicleStatus> = new Set<VehicleStatus>([
  "available",
  "reserved_rental",
  "on_rent",
]);

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** The longest rental block; longer hires are contracts, renewed. */
export const MAX_RENTAL_DAYS = 366;
/** The longest a hold may last before it lapses. */
export const MAX_HOLD_MINUTES = 7 * 24 * 60;

/** Holds the vehicle at `now`: not released, and not a hold past its expiry. */
export function isLive(block: VehicleBlock, now: Date): boolean {
  if (block.status === "released") return false;
  return !(block.status === "hold" && block.expiresAt !== null && block.expiresAt <= now);
}

export function busyOf(block: Pick<VehicleBlock, "startsAt" | "blockedUntil">): BusyInterval {
  return { from: block.startsAt, until: block.blockedUntil };
}

/** Where the vehicle is free again: the end, plus the class turnaround for rentals. */
export function blockedUntil(
  reason: BlockReason,
  endsAt: Date | null,
  turnaroundMinutes: number,
): Date | null {
  if (endsAt === null) return null;
  return reason === "rental" ? new Date(endsAt.getTime() + turnaroundMinutes * MINUTE) : endsAt;
}

/** Two busy intervals share time (half-open, as the database's `[)` ranges). */
export function overlaps(a: BusyInterval, b: BusyInterval): boolean {
  const aBeforeB = a.until !== null && a.until <= b.from;
  const bBeforeA = b.until !== null && b.until <= a.from;
  return !aBeforeB && !bBeforeA;
}

/** The checks every block's times pass. */
export function assertWindow(reason: BlockReason, startsAt: Date, endsAt: Date | null): void {
  if (Number.isNaN(startsAt.getTime()) || (endsAt !== null && Number.isNaN(endsAt.getTime())))
    throw new VehicleBlockError("Send times as ISO 8601 date-times");
  if (endsAt === null) {
    if (reason === "rental") throw new VehicleBlockError("A rental needs a return time");
    return;
  }
  if (endsAt <= startsAt) throw new VehicleBlockError("The end is after the start");
  if (reason === "rental" && endsAt.getTime() - startsAt.getTime() > MAX_RENTAL_DAYS * DAY)
    throw new VehicleBlockError(`A rental is at most ${MAX_RENTAL_DAYS} days`);
}

/** When a hold made at `now` for `minutes` lapses. */
export function holdExpiry(now: Date, minutes: number): Date {
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > MAX_HOLD_MINUTES)
    throw new VehicleBlockError(`A hold lasts from 5 minutes to ${MAX_HOLD_MINUTES / 1440} days`);
  return new Date(now.getTime() + minutes * MINUTE);
}
