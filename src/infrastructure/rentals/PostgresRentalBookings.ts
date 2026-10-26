import type {
  BookingCharge,
  BookingEvent,
  BookingEventType,
  BookingFilter,
  IRentalBookings,
  Renter,
} from "../../application/ports/IRentalBookings.js";
import type { FuelLevel } from "../../domain/assignments/VehicleAssignment.js";
import {
  RentalBooking,
  type BookingStatus,
  type ChargeKind,
  type QuoteJson,
} from "../../domain/rentals/RentalBooking.js";
import type { PricingTerms } from "../../domain/rentals/RentalPricing.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BookingRow = {
  id: string;
  number: string;
  status: BookingStatus;
  branch_id: string;
  customer_id: string;
  class_id: string | null;
  vehicle_id: string;
  by_class: boolean;
  block_id: string;
  pickup_at: Date;
  return_at: Date;
  expires_at: Date | null;
  currency: string;
  terms: PricingTerms;
  quote: QuoteJson;
  confirmed_at: Date | null;
  checked_out_at: Date | null;
  odometer_out: number | null;
  fuel_out: FuelLevel | null;
  returned_at: Date | null;
  odometer_in: number | null;
  fuel_in: FuelLevel | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

const toBooking = (r: BookingRow): RentalBooking =>
  RentalBooking.restore({
    id: r.id,
    number: r.number,
    status: r.status,
    branchId: r.branch_id,
    customerId: r.customer_id,
    classId: r.class_id,
    vehicleId: r.vehicle_id,
    byClass: r.by_class,
    blockId: r.block_id,
    pickupAt: r.pickup_at,
    returnAt: r.return_at,
    expiresAt: r.expires_at,
    currency: r.currency,
    terms: r.terms,
    quote: r.quote,
    confirmedAt: r.confirmed_at,
    checkedOutAt: r.checked_out_at,
    odometerOut: r.odometer_out,
    fuelOut: r.fuel_out,
    returnedAt: r.returned_at,
    odometerIn: r.odometer_in,
    fuelIn: r.fuel_in,
    closedAt: r.closed_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

/** The block's vehicle is the booking's; a class on the block means booked by class. */
const SELECT = `select r.*, b.vehicle_id, b.class_id is not null as by_class
  from rental_bookings r join vehicle_blocks b on b.id = r.block_id`;

type EventRow = {
  id: string;
  booking_id: string;
  type: BookingEventType;
  at: Date;
  actor_id: string | null;
  data: Record<string, unknown>;
};

type ChargeRow = {
  id: string;
  booking_id: string;
  event_id: string;
  kind: ChargeKind;
  description: string;
  net_minor: string;
  tax_minor: string;
  total_minor: string;
  created_by: string | null;
  created_at: Date;
};

export class PostgresRentalBookings implements IRentalBookings {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async get(id: string): Promise<RentalBooking | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<BookingRow>(`${SELECT} where r.id = $1`, [id]);
    return rows[0] === undefined ? null : toBooking(rows[0]);
  }

  async lock(id: string): Promise<RentalBooking | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<BookingRow>(`${SELECT} where r.id = $1 for update of r`, [
      id,
    ]);
    return rows[0] === undefined ? null : toBooking(rows[0]);
  }

  async insert(booking: RentalBooking): Promise<void> {
    const b = booking.snapshot();
    await this.tx.query(
      `insert into rental_bookings (id, number, status, branch_id, customer_id, class_id,
         block_id, pickup_at, return_at, expires_at, currency, terms, quote, confirmed_at, notes,
         created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        b.id,
        b.number,
        b.status,
        b.branchId,
        b.customerId,
        b.classId,
        b.blockId,
        b.pickupAt,
        b.returnAt,
        b.expiresAt,
        b.currency,
        JSON.stringify(b.terms),
        JSON.stringify(b.quote),
        b.confirmedAt,
        b.notes,
        b.createdBy,
        b.createdAt,
        b.updatedAt,
      ],
    );
  }

  async update(booking: RentalBooking): Promise<void> {
    const b = booking.snapshot();
    await this.tx.query(
      `update rental_bookings set status = $2, block_id = $3, pickup_at = $4, return_at = $5,
         expires_at = $6, terms = $7, quote = $8, confirmed_at = $9, checked_out_at = $10,
         odometer_out = $11, fuel_out = $12, returned_at = $13, odometer_in = $14, fuel_in = $15,
         closed_at = $16, cancelled_at = $17, cancel_reason = $18, notes = $19, updated_at = $20
       where id = $1`,
      [
        b.id,
        b.status,
        b.blockId,
        b.pickupAt,
        b.returnAt,
        b.expiresAt,
        JSON.stringify(b.terms),
        JSON.stringify(b.quote),
        b.confirmedAt,
        b.checkedOutAt,
        b.odometerOut,
        b.fuelOut,
        b.returnedAt,
        b.odometerIn,
        b.fuelIn,
        b.closedAt,
        b.cancelledAt,
        b.cancelReason,
        b.notes,
        b.updatedAt,
      ],
    );
  }

  async list(filter: BookingFilter): Promise<RentalBooking[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, ...values: unknown[]) => {
      let sql = clause;
      for (const value of values) {
        params.push(value);
        sql = sql.replace("?", `$${params.length}`);
      }
      where.push(sql);
    };
    if (filter.branchIds !== "all") add("r.branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.statuses !== undefined) add("r.status = any(?::text[])", filter.statuses);
    if (filter.customerId !== undefined) add("r.customer_id = ?", filter.customerId);
    if (filter.vehicleId !== undefined) add("b.vehicle_id = ?", filter.vehicleId);
    if (filter.from !== undefined) add("r.return_at > ?", filter.from);
    if (filter.to !== undefined) add("r.pickup_at < ?", filter.to);
    if (filter.lapsedAt !== undefined)
      add(
        filter.lapsedAt.lapsed
          ? "(r.status = 'reserved' and r.expires_at <= ?)"
          : "not (r.status = 'reserved' and r.expires_at <= ?)",
        filter.lapsedAt.now,
      );
    if (filter.after !== undefined)
      add("(r.pickup_at, r.id) < (?, ?)", filter.after.pickupAt, filter.after.id);
    params.push(filter.limit);
    const { rows } = await this.tx.query<BookingRow>(
      `${SELECT} ${where.length === 0 ? "" : `where ${where.join(" and ")}`}
        order by r.pickup_at desc, r.id desc limit $${params.length}`,
      params,
    );
    return rows.map(toBooking);
  }

  async addEvent(e: BookingEvent): Promise<void> {
    await this.tx.query(
      // The database clock, in write order: events of one transaction keep their order.
      `insert into rental_booking_events (id, booking_id, type, at, actor_id, data)
       values ($1, $2, $3, clock_timestamp(), $4, $5)`,
      [e.id, e.bookingId, e.type, e.actorId, JSON.stringify(e.data)],
    );
  }

  async events(bookingId: string): Promise<BookingEvent[]> {
    const { rows } = await this.tx.query<EventRow>(
      "select * from rental_booking_events where booking_id = $1 order by at, id",
      [bookingId],
    );
    return rows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      type: r.type,
      at: r.at,
      actorId: r.actor_id,
      data: r.data,
    }));
  }

  async addCharge(c: BookingCharge): Promise<void> {
    await this.tx.query(
      `insert into rental_booking_charges (id, booking_id, event_id, kind, description, net_minor,
         tax_minor, total_minor, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp())`,
      [
        c.id,
        c.bookingId,
        c.eventId,
        c.kind,
        c.description,
        c.netMinor,
        c.taxMinor,
        c.totalMinor,
        c.createdBy,
      ],
    );
  }

  async charges(bookingId: string): Promise<BookingCharge[]> {
    const { rows } = await this.tx.query<ChargeRow>(
      "select * from rental_booking_charges where booking_id = $1 order by created_at, id",
      [bookingId],
    );
    return rows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      eventId: r.event_id,
      kind: r.kind,
      description: r.description,
      netMinor: Number(r.net_minor),
      taxMinor: Number(r.tax_minor),
      totalMinor: Number(r.total_minor),
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }

  async renter(customerId: string): Promise<Renter | null> {
    if (!UUID.test(customerId)) return null;
    const { rows } = await this.tx.query<{
      id: string;
      name: string;
      date_of_birth: string | null;
      licence_number: string | null;
      licence_expires_on: string | null;
    }>(
      `select id, name, date_of_birth::text, licence_number, licence_expires_on::text
         from customers where id = $1 and deleted_at is null`,
      [customerId],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : {
          id: r.id,
          name: r.name,
          dateOfBirth: r.date_of_birth,
          licenceNumber: r.licence_number,
          licenceExpiresOn: r.licence_expires_on,
        };
  }
}
