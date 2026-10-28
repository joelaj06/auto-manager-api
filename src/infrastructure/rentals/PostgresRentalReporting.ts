import type {
  BalanceRow,
  DamageCostRow,
  DepositHeldRow,
  FleetHoursRow,
  IRentalReporting,
  Period,
  RentalNoticeRow,
  RentalReportFilter,
  RevenueRow,
} from "../../application/ports/IRentalReporting.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

/** The time charges: what the rental period itself costs (for the average daily rate). */
const TIME_KINDS = ["rental", "change", "extension", "late_return", "cancellation"];

const NOTICE = `select r.id as booking_id, r.number, r.status, r.branch_id, b.name as branch_name,
    r.customer_id, c.name as customer_name, c.phone, c.email,
    v.id as vehicle_id, v.code as vehicle_code, v.plate_number, v.make, v.model,
    r.pickup_at, r.return_at, r.checked_out_at, r.currency,
    (select coalesce(sum(total_minor), 0) from rental_booking_charges x
      where x.booking_id = r.id) as charged_minor
  from rental_bookings r
  join branches b on b.id = r.branch_id
  join customers c on c.id = r.customer_id
  join vehicle_blocks k on k.id = r.block_id
  join vehicles v on v.id = k.vehicle_id`;

type NoticeRow = {
  booking_id: string;
  number: string;
  status: string;
  branch_id: string;
  branch_name: string;
  customer_id: string;
  customer_name: string;
  phone: string | null;
  email: string | null;
  vehicle_id: string;
  vehicle_code: string;
  plate_number: string | null;
  make: string;
  model: string;
  pickup_at: Date;
  return_at: Date;
  checked_out_at: Date | null;
  currency: string;
  charged_minor: string;
};

const toNotice = (r: NoticeRow): RentalNoticeRow => ({
  bookingId: r.booking_id,
  number: r.number,
  status: r.status,
  branchId: r.branch_id,
  branchName: r.branch_name,
  customerId: r.customer_id,
  customerName: r.customer_name,
  phone: r.phone,
  email: r.email,
  vehicleId: r.vehicle_id,
  vehicleCode: r.vehicle_code,
  plateNumber: r.plate_number,
  make: r.make,
  model: r.model,
  pickupAt: r.pickup_at,
  returnAt: r.return_at,
  checkedOutAt: r.checked_out_at,
  currency: r.currency,
  chargedMinor: Number(r.charged_minor),
});

/**
 * Rental reporting in SQL (docs/07 §10–11): the bookings reminders and the board need, and the
 * sums behind utilisation, revenue, balances, deposits and damages. Branch filters come as
 * parameters: `$n::uuid[]` null means every branch.
 */
export class PostgresRentalReporting implements IRentalReporting {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async notice(bookingId: string): Promise<RentalNoticeRow | null> {
    const { rows } = await this.tx.query<NoticeRow>(`${NOTICE} where r.id = $1`, [bookingId]);
    return rows[0] === undefined ? null : toNotice(rows[0]);
  }

  async pickupsBetween(
    from: Date,
    to: Date,
    filter?: RentalReportFilter,
  ): Promise<RentalNoticeRow[]> {
    return this.notices(
      "r.status = 'confirmed' and r.pickup_at >= $1 and r.pickup_at < $2",
      [from, to],
      "r.pickup_at",
      filter,
    );
  }

  async returnsBetween(
    from: Date,
    to: Date,
    filter?: RentalReportFilter,
  ): Promise<RentalNoticeRow[]> {
    return this.notices(
      "r.status = 'checked_out' and r.return_at >= $1 and r.return_at < $2",
      [from, to],
      "r.return_at",
      filter,
    );
  }

  async overdue(before: Date, filter?: RentalReportFilter): Promise<RentalNoticeRow[]> {
    return this.notices(
      "r.status = 'checked_out' and r.return_at < $1",
      [before],
      "r.return_at",
      filter,
    );
  }

  async expiringBetween(
    from: Date,
    to: Date,
    filter: RentalReportFilter,
  ): Promise<RentalNoticeRow[]> {
    return this.notices(
      "r.status = 'reserved' and r.expires_at >= $1 and r.expires_at < $2",
      [from, to],
      "r.expires_at",
      filter,
    );
  }

  async fleetHours(
    period: Period,
    now: Date,
    filter: RentalReportFilter,
  ): Promise<FleetHoursRow[]> {
    const { rows } = await this.tx.query<{
      vehicle_id: string;
      code: string;
      plate_number: string | null;
      class_id: string;
      class_name: string;
      branch_id: string;
      rented: string;
      unavailable: string;
    }>(
      `select v.id as vehicle_id, v.code, v.plate_number, v.rental_class_id as class_id,
              vc.name as class_name, v.branch_id,
              (select coalesce(sum(greatest(0, extract(epoch from
                        least(coalesce(r.returned_at, $3), $2) - greatest(r.checked_out_at, $1)))), 0)
                 from rental_bookings r join vehicle_blocks k on k.id = r.block_id
                where k.vehicle_id = v.id and r.checked_out_at is not null
                  and r.checked_out_at < $2 and coalesce(r.returned_at, $3) > $1) as rented,
              (select coalesce(sum(greatest(0, extract(epoch from
                        least(coalesce(k.released_at, k.ends_at, $2), $2) - greatest(k.starts_at, $1)))), 0)
                 from vehicle_blocks k
                where k.vehicle_id = v.id and k.reason <> 'rental' and k.status <> 'hold'
                  and k.starts_at < $2) as unavailable
         from vehicles v join vehicle_classes vc on vc.id = v.rental_class_id
        where v.deleted_at is null
          and ($4::uuid[] is null or v.branch_id = any($4))
          and ($5::uuid is null or v.branch_id = $5)
        order by vc.name, v.code`,
      [period.from, period.to, now, ...branchParams(filter)],
    );
    return rows.map((r) => ({
      vehicleId: r.vehicle_id,
      code: r.code,
      plateNumber: r.plate_number,
      classId: r.class_id,
      className: r.class_name,
      branchId: r.branch_id,
      rentedSeconds: Math.round(Number(r.rented)),
      unavailableSeconds: Math.round(Number(r.unavailable)),
    }));
  }

  async revenue(period: Period, filter: RentalReportFilter): Promise<RevenueRow[]> {
    const { rows } = await this.tx.query<{
      branch_id: string;
      branch_name: string;
      class_id: string | null;
      class_name: string | null;
      customer_type: "individual" | "corporate";
      currency: string;
      bookings: string;
      net: string;
      time_net: string;
    }>(
      `select r.branch_id, b.name as branch_name, r.class_id, vc.name as class_name,
              c.type as customer_type, r.currency, count(distinct r.id) as bookings,
              sum(x.net_minor) as net,
              sum(x.net_minor) filter (where x.kind = any($5::text[])) as time_net
         from rental_booking_charges x
         join rental_bookings r on r.id = x.booking_id
         join branches b on b.id = r.branch_id
         join customers c on c.id = r.customer_id
         left join vehicle_classes vc on vc.id = r.class_id
        where x.created_at >= $1 and x.created_at < $2
          and ($3::uuid[] is null or r.branch_id = any($3))
          and ($4::uuid is null or r.branch_id = $4)
        group by r.branch_id, b.name, r.class_id, vc.name, c.type, r.currency
        order by b.name, vc.name nulls last, c.type`,
      [period.from, period.to, ...branchParams(filter), TIME_KINDS],
    );
    return rows.map((r) => ({
      branchId: r.branch_id,
      branchName: r.branch_name,
      classId: r.class_id,
      className: r.class_name,
      customerType: r.customer_type,
      currency: r.currency,
      bookings: Number(r.bookings),
      netMinor: Number(r.net),
      timeNetMinor: Number(r.time_net ?? 0),
    }));
  }

  async balances(filter: RentalReportFilter): Promise<BalanceRow[]> {
    const { rows } = await this.tx.query<{
      booking_id: string;
      number: string;
      status: string;
      branch_id: string;
      customer_id: string;
      customer_name: string;
      currency: string;
      invoiced_open: string;
      uninvoiced: string;
      credit: string;
      return_at: Date;
    }>(
      `select * from (
         select r.id as booking_id, r.number, r.status, r.branch_id, r.customer_id,
                c.name as customer_name, r.currency, r.return_at,
                (select coalesce(sum(i.total_minor - i.paid_minor), 0) from invoices i
                  where i.source_type = 'rental_booking' and i.source_id = r.id
                    and i.status in ('issued', 'partially_paid')) as invoiced_open,
                (select coalesce(sum(x.total_minor), 0) from rental_booking_charges x
                  where x.booking_id = r.id and x.invoice_id is null) as uninvoiced,
                (select coalesce(sum(p.amount_minor - p.allocated_minor), 0) from payments p
                  where p.source_type = 'rental_booking' and p.source_id = r.id
                    and p.direction = 'in' and p.status = 'recorded') as credit
           from rental_bookings r join customers c on c.id = r.customer_id
          where ($1::uuid[] is null or r.branch_id = any($1))
            and ($2::uuid is null or r.branch_id = $2)) owed
        where invoiced_open + uninvoiced - credit > 0
        order by return_at, number`,
      branchParams(filter),
    );
    return rows.map((r) => ({
      bookingId: r.booking_id,
      number: r.number,
      status: r.status,
      branchId: r.branch_id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      currency: r.currency,
      invoicedOpenMinor: Number(r.invoiced_open),
      uninvoicedMinor: Number(r.uninvoiced),
      creditMinor: Number(r.credit),
      returnAt: r.return_at,
    }));
  }

  async depositsHeld(filter: RentalReportFilter): Promise<DepositHeldRow[]> {
    const { rows } = await this.tx.query<{
      booking_id: string;
      number: string;
      status: string;
      branch_id: string;
      customer_name: string;
      currency: string;
      held: string;
      held_at: Date;
    }>(
      `select r.id as booking_id, r.number, r.status, r.branch_id, c.name as customer_name,
              d.currency, d.amount_minor - d.applied_minor - d.refunded_minor as held, d.held_at
         from rental_deposits d
         join rental_bookings r on r.id = d.booking_id
         join customers c on c.id = r.customer_id
        where d.status in ('held', 'partially_applied')
          and ($1::uuid[] is null or r.branch_id = any($1))
          and ($2::uuid is null or r.branch_id = $2)
        order by d.held_at, r.number`,
      branchParams(filter),
    );
    return rows.map((r) => ({
      bookingId: r.booking_id,
      number: r.number,
      status: r.status,
      branchId: r.branch_id,
      customerName: r.customer_name,
      currency: r.currency,
      heldMinor: Number(r.held),
      heldAt: r.held_at,
    }));
  }

  async damages(period: Period, filter: RentalReportFilter): Promise<DamageCostRow[]> {
    const { rows } = await this.tx.query<{
      id: string;
      vehicle_id: string;
      plate_number: string | null;
      branch_id: string;
      booking_number: string | null;
      severity: string;
      status: string;
      liability: string;
      currency: string;
      cost: string | null;
      charged: string;
      created_at: Date;
    }>(
      `select d.id, d.vehicle_id, v.plate_number, d.branch_id, r.number as booking_number,
              d.severity, d.status, d.liability, d.currency,
              coalesce(d.final_minor, d.estimate_minor) as cost,
              (select coalesce(sum(x.total_minor), 0) from rental_booking_charges x
                where x.damage_id = d.id) as charged,
              d.created_at
         from vehicle_damages d
         join vehicles v on v.id = d.vehicle_id
         left join rental_bookings r on r.id = d.booking_id
        where d.created_at >= $1 and d.created_at < $2
          and ($3::uuid[] is null or d.branch_id = any($3))
          and ($4::uuid is null or d.branch_id = $4)
        order by d.created_at, d.id`,
      [period.from, period.to, ...branchParams(filter)],
    );
    return rows.map((r) => ({
      damageId: r.id,
      vehicleId: r.vehicle_id,
      plateNumber: r.plate_number,
      branchId: r.branch_id,
      bookingNumber: r.booking_number,
      severity: r.severity,
      status: r.status,
      liability: r.liability,
      currency: r.currency,
      costMinor: r.cost === null ? null : Number(r.cost),
      chargedMinor: Number(r.charged),
      createdAt: r.created_at,
    }));
  }

  private async notices(
    where: string,
    params: readonly unknown[],
    order: string,
    filter?: RentalReportFilter,
  ): Promise<RentalNoticeRow[]> {
    const n = params.length;
    const { rows } = await this.tx.query<NoticeRow>(
      `${NOTICE} where ${where}
          and ($${n + 1}::uuid[] is null or r.branch_id = any($${n + 1}))
          and ($${n + 2}::uuid is null or r.branch_id = $${n + 2})
        order by ${order}, r.number`,
      [...params, ...branchParams(filter ?? { branchIds: "all", branchId: null })],
    );
    return rows.map(toNotice);
  }
}

const branchParams = (filter: RentalReportFilter): [readonly string[] | null, string | null] => [
  filter.branchIds === "all" ? null : filter.branchIds,
  filter.branchId,
];
