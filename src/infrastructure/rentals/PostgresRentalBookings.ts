import type {
  BookingCharge,
  BookingEvent,
  BookingEventType,
  BookingFilter,
  Exposure,
  IRentalBookings,
  Prepayment,
  Renter,
  RenterHistory,
} from "../../application/ports/IRentalBookings.js";
import type { FuelLevel } from "../../domain/assignments/VehicleAssignment.js";
import {
  RentalBooking,
  type BookingStatus,
  type ChargeKind,
  type QuoteJson,
} from "../../domain/rentals/RentalBooking.js";
import { RentalDeposit, type DepositStatus } from "../../domain/rentals/RentalDeposit.js";
import type { PricingTerms } from "../../domain/rentals/RentalPricing.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BookingRow = {
  id: string;
  number: string;
  status: BookingStatus;
  branch_id: string;
  customer_id: string;
  driver_id: string | null;
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
    driverId: r.driver_id,
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
  damage_id: string | null;
  invoice_id: string | null;
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
         created_by, created_at, updated_at, driver_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19)`,
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
        b.driverId,
      ],
    );
  }

  async update(booking: RentalBooking): Promise<void> {
    const b = booking.snapshot();
    await this.tx.query(
      `update rental_bookings set status = $2, block_id = $3, pickup_at = $4, return_at = $5,
         expires_at = $6, terms = $7, quote = $8, confirmed_at = $9, checked_out_at = $10,
         odometer_out = $11, fuel_out = $12, returned_at = $13, odometer_in = $14, fuel_in = $15,
         closed_at = $16, cancelled_at = $17, cancel_reason = $18, notes = $19, updated_at = $20,
         driver_id = $21
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
        b.driverId,
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
         tax_minor, total_minor, damage_id, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())`,
      [
        c.id,
        c.bookingId,
        c.eventId,
        c.kind,
        c.description,
        c.netMinor,
        c.taxMinor,
        c.totalMinor,
        c.damageId,
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
      damageId: r.damage_id,
      invoiceId: r.invoice_id,
      netMinor: Number(r.net_minor),
      taxMinor: Number(r.tax_minor),
      totalMinor: Number(r.total_minor),
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }

  async renter(customerId: string): Promise<Renter | null> {
    if (!UUID.test(customerId)) return null;
    const { rows } = await this.tx.query<RenterRow>(
      `${RENTERS} where c.id = $1 and c.deleted_at is null`,
      [customerId],
    );
    return rows[0] === undefined ? null : toRenter(rows[0]);
  }

  async history(customerId: string): Promise<RenterHistory> {
    const { rows } = await this.tx.query<{
      statuses: Record<string, number> | null;
      charged: string;
      damages: number;
      last_pickup_at: Date | null;
    }>(
      `select (select jsonb_object_agg(status, n) from (select status, count(*)::int as n
                 from rental_bookings where customer_id = $1 group by status) s) as statuses,
              (select coalesce(sum(c.total_minor), 0) from rental_booking_charges c
                 join rental_bookings r on r.id = c.booking_id where r.customer_id = $1) as charged,
              (select count(*)::int from vehicle_damages d join rental_bookings r on r.id = d.booking_id
                 where r.customer_id = $1 and d.liability = 'customer') as damages,
              (select max(pickup_at) from rental_bookings where customer_id = $1
                 and status not in ('cancelled', 'no_show')) as last_pickup_at`,
      [customerId],
    );
    const r = rows[0]!;
    return {
      bookings: r.statuses ?? {},
      chargedMinor: Number(r.charged),
      damages: r.damages,
      lastPickupAt: r.last_pickup_at,
    };
  }

  async exposure(customerId: string): Promise<Exposure> {
    const { rows } = await this.tx.query<{ open: string; uninvoiced: string }>(
      `select (select coalesce(sum(total_minor - paid_minor), 0) from invoices
                where party_type = 'customer' and party_id = $1
                  and status in ('issued', 'partially_paid')) as open,
              (select coalesce(sum(c.total_minor), 0) from rental_booking_charges c
                 join rental_bookings r on r.id = c.booking_id
                where r.customer_id = $1 and c.invoice_id is null) as uninvoiced`,
      [customerId],
    );
    return {
      openInvoicesMinor: Number(rows[0]!.open),
      uninvoicedMinor: Number(rows[0]!.uninvoiced),
    };
  }

  // --- invoicing and payments ---

  async markInvoiced(chargeIds: readonly string[], invoiceId: string): Promise<void> {
    if (chargeIds.length === 0) return;
    await this.tx.query(
      "update rental_booking_charges set invoice_id = $2 where id = any($1::uuid[]) and invoice_id is null",
      [chargeIds, invoiceId],
    );
  }

  async invoiceIds(bookingId: string): Promise<string[]> {
    const { rows } = await this.tx.query<{ id: string }>(
      `select id from invoices where source_type = 'rental_booking' and source_id = $1
        order by created_at, id`,
      [bookingId],
    );
    return rows.map((r) => r.id);
  }

  async prepayments(bookingId: string): Promise<Prepayment[]> {
    const { rows } = await this.tx.query<{ id: string; unallocated: string }>(
      `select id, amount_minor - allocated_minor as unallocated from payments
        where source_type = 'rental_booking' and source_id = $1 and direction = 'in'
          and status = 'recorded' and allocated_minor < amount_minor
        order by recorded_at, id`,
      [bookingId],
    );
    return rows.map((r) => ({ paymentId: r.id, unallocatedMinor: Number(r.unallocated) }));
  }

  async deposit(bookingId: string, lock = false): Promise<RentalDeposit | null> {
    const { rows } = await this.tx.query<DepositRow>(
      `select * from rental_deposits where booking_id = $1${lock ? " for update" : ""}`,
      [bookingId],
    );
    return rows[0] === undefined ? null : toDeposit(rows[0]);
  }

  async depositByPayment(paymentId: string): Promise<RentalDeposit | null> {
    const { rows } = await this.tx.query<DepositRow>(
      "select * from rental_deposits where payment_id = $1 for update",
      [paymentId],
    );
    return rows[0] === undefined ? null : toDeposit(rows[0]);
  }

  async saveDeposit(deposit: RentalDeposit): Promise<void> {
    const d = deposit.snapshot();
    await this.tx.query(
      `insert into rental_deposits (id, booking_id, payment_id, currency, amount_minor,
         applied_minor, refunded_minor, refund_payment_id, status, held_by, held_at, released_at,
         updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (id) do update set applied_minor = excluded.applied_minor,
         refunded_minor = excluded.refunded_minor, refund_payment_id = excluded.refund_payment_id,
         status = excluded.status, released_at = excluded.released_at,
         updated_at = excluded.updated_at`,
      [
        d.id,
        d.bookingId,
        d.paymentId,
        d.currency,
        d.amountMinor,
        d.appliedMinor,
        d.refundedMinor,
        d.refundPaymentId,
        d.status,
        d.heldBy,
        d.heldAt,
        d.releasedAt,
        d.updatedAt,
      ],
    );
  }

  // --- corporate accounts ---

  async authorisedDrivers(corporateId: string): Promise<Renter[]> {
    const { rows } = await this.tx.query<RenterRow>(
      `${RENTERS} join customer_authorised_drivers a on a.driver_id = c.id
        where a.corporate_id = $1 and c.deleted_at is null order by c.name, c.id`,
      [corporateId],
    );
    return rows.map(toRenter);
  }

  async isAuthorisedDriver(corporateId: string, driverId: string): Promise<boolean> {
    const { rows } = await this.tx.query(
      `select 1 from customer_authorised_drivers a join customers c on c.id = a.driver_id
        where a.corporate_id = $1 and a.driver_id = $2 and c.deleted_at is null`,
      [corporateId, driverId],
    );
    return rows.length > 0;
  }

  async addAuthorisedDriver(
    corporateId: string,
    driverId: string,
    actorId: string | null,
  ): Promise<void> {
    await this.tx.query(
      `insert into customer_authorised_drivers (corporate_id, driver_id, added_by)
       values ($1, $2, $3) on conflict do nothing`,
      [corporateId, driverId, actorId],
    );
  }

  async removeAuthorisedDriver(corporateId: string, driverId: string): Promise<boolean> {
    const { rowCount } = await this.tx.query(
      "delete from customer_authorised_drivers where corporate_id = $1 and driver_id = $2",
      [corporateId, driverId],
    );
    return (rowCount ?? 0) > 0;
  }
}

type RenterRow = {
  id: string;
  name: string;
  type: "individual" | "corporate";
  date_of_birth: string | null;
  licence_number: string | null;
  licence_expires_on: string | null;
  has_id_document: boolean;
  risk_status: Renter["riskStatus"];
  risk_reason: string | null;
  credit_limit_minor: string | null;
  payment_terms_days: number | null;
};

const RENTERS = `select c.id, c.name, c.type, c.date_of_birth::text, c.licence_number,
    c.licence_expires_on::text, c.risk_status, c.risk_reason, c.credit_limit_minor,
    c.payment_terms_days,
    (c.ghana_card_number is not null or exists (select 1 from party_documents d
       where d.party_type = 'customer' and d.party_id = c.id
         and d.type in ('ghana_card', 'passport', 'voters_id'))) as has_id_document
  from customers c`;

const toRenter = (r: RenterRow): Renter => ({
  id: r.id,
  name: r.name,
  type: r.type,
  dateOfBirth: r.date_of_birth,
  licenceNumber: r.licence_number,
  licenceExpiresOn: r.licence_expires_on,
  hasIdDocument: r.has_id_document,
  riskStatus: r.risk_status,
  riskReason: r.risk_reason,
  creditLimitMinor: r.credit_limit_minor === null ? null : Number(r.credit_limit_minor),
  paymentTermsDays: r.payment_terms_days,
});

type DepositRow = {
  id: string;
  booking_id: string;
  payment_id: string;
  currency: string;
  amount_minor: string;
  applied_minor: string;
  refunded_minor: string;
  refund_payment_id: string | null;
  status: DepositStatus;
  held_by: string | null;
  held_at: Date;
  released_at: Date | null;
  updated_at: Date;
};

const toDeposit = (r: DepositRow): RentalDeposit =>
  RentalDeposit.restore({
    id: r.id,
    bookingId: r.booking_id,
    paymentId: r.payment_id,
    currency: r.currency,
    amountMinor: Number(r.amount_minor),
    appliedMinor: Number(r.applied_minor),
    refundedMinor: Number(r.refunded_minor),
    refundPaymentId: r.refund_payment_id,
    status: r.status,
    heldBy: r.held_by,
    heldAt: r.held_at,
    releasedAt: r.released_at,
    updatedAt: r.updated_at,
  });
