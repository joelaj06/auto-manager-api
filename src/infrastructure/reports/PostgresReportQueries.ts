import type {
  CashDayRow,
  CashSessionRow,
  DayBookRow,
  DriverPerformanceRow,
  DriverRemittanceRow,
  ExpectedInflows,
  ExpenseApprovalRow,
  FleetRegisterRow,
  FuelAnomalyCount,
  IncidentRegisterRow,
  IReportQueries,
  OpenInvoiceRow,
  PaymentRegisterRow,
  RentalBookingRow,
  TaxAccountRow,
} from "../../application/ports/IReportQueries.js";
import type { BranchFilter } from "../../application/ports/IReporting.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type Row = Record<string, unknown>;
type Period = Readonly<{ from: string; to: string; fromAt: Date; untilAt: Date }>;

const n = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const s = (value: unknown) => (typeof value === "string" ? value : null);
const scope = (filter: BranchFilter) => [
  filter.branchIds === "all" ? null : filter.branchIds,
  filter.branchId,
];
const DRIVER = `d.first_name || ' ' || d.last_name`;
const VEHICLE = `v.code || coalesce(' · ' || v.plate_number, '')`;

/** The catalogue's read queries (docs/14 §3); branch filters are always $1 and $2. */
export class PostgresReportQueries implements IReportQueries {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async branchNames(): Promise<Readonly<Record<string, string>>> {
    const { rows } = await this.tx.query<{ id: string; name: string }>(
      `select id, name from branches`,
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.name]));
  }

  async userNames(ids: readonly string[]): Promise<Readonly<Record<string, string>>> {
    if (ids.length === 0) return {};
    const { rows } = await this.tx.query<{ id: string; name: string }>(
      `select id, name from users where id = any($1::uuid[])`,
      [ids],
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.name]));
  }

  async fleetRegister(filter: BranchFilter, today: string): Promise<FleetRegisterRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select v.id, v.code, v.plate_number, v.make, v.model, v.year, v.status, v.usage,
              v.ownership_type, b.name as branch_name, v.current_odometer, v.mileage_unit,
              (select ${DRIVER} from vehicle_assignments a join drivers d on d.id = a.driver_id
                where a.vehicle_id = v.id and a.ended_at is null
                order by a.started_at desc limit 1) as driver_name,
              doc.type as doc_type, doc.expires_on::text as doc_expires_on,
              coalesce(doc.expired, 0) as expired
         from vehicles v
         join branches b on b.id = v.branch_id
         left join lateral (
           select (array_agg(latest.type order by latest.expires_on))[1] as type,
                  min(latest.expires_on) as expires_on,
                  count(*) filter (where latest.expires_on < $3) as expired
             from (select distinct on (x.type) x.type, x.expires_on
                     from vehicle_documents x
                    where x.vehicle_id = v.id and x.expires_on is not null
                    order by x.type, x.expires_on desc) latest
         ) doc on true
        where v.deleted_at is null
          and ($1::uuid[] is null or v.branch_id = any($1::uuid[]))
          and ($2::uuid is null or v.branch_id = $2)
        order by v.code`,
      [...scope(filter), today],
    );
    return rows.map((r) => ({
      vehicleId: r.id as string,
      code: r.code as string,
      plateNumber: s(r.plate_number),
      make: r.make as string,
      model: r.model as string,
      year: r.year === null ? null : n(r.year),
      status: r.status as string,
      usage: r.usage as string,
      ownership: r.ownership_type as string,
      branchName: r.branch_name as string,
      driverName: s(r.driver_name),
      odometer: r.current_odometer === null ? null : n(r.current_odometer),
      mileageUnit: r.mileage_unit as "km" | "mi",
      nextDocument:
        r.doc_type === null
          ? null
          : { type: r.doc_type as string, expiresOn: r.doc_expires_on as string },
      documentsExpired: n(r.expired),
    }));
  }

  async fuelAnomalies(filter: BranchFilter, from: Date, until: Date): Promise<FuelAnomalyCount[]> {
    const { rows } = await this.tx.query<{ vehicle_id: string; anomalies: string }>(
      `select vehicle_id, count(*) as anomalies from fuel_anomalies
        where status <> 'dismissed' and created_at >= $3 and created_at < $4
          and ($1::uuid[] is null or branch_id = any($1::uuid[]))
          and ($2::uuid is null or branch_id = $2)
        group by vehicle_id`,
      [...scope(filter), from, until],
    );
    return rows.map((r) => ({ vehicleId: r.vehicle_id, anomalies: n(r.anomalies) }));
  }

  async incidents(filter: BranchFilter, period: Period): Promise<IncidentRegisterRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select * from (
         select i.occurred_at as at, 'incident' as kind, i.number as reference, i.type,
                ${VEHICLE} as vehicle, ${DRIVER} as driver_name, b.name as branch_name,
                i.status, null::bigint as amount,
                i.severity || coalesce(' · ' || i.location, '') as detail
           from incidents i
           join vehicles v on v.id = i.vehicle_id
           join branches b on b.id = i.branch_id
           left join drivers d on d.id = i.driver_id
          where i.occurred_at >= $3 and i.occurred_at < $4
            and ($1::uuid[] is null or i.branch_id = any($1::uuid[]))
            and ($2::uuid is null or i.branch_id = $2)
         union all
         select o.offence_at, 'offence', o.notice_ref, o.type, ${VEHICLE}, ${DRIVER}, b.name,
                o.status, o.fine_minor, o.authority || coalesce(' · ' || o.location, '')
           from traffic_offences o
           join vehicles v on v.id = o.vehicle_id
           join branches b on b.id = o.branch_id
           left join drivers d on d.id = o.driver_id
          where o.offence_at >= $3 and o.offence_at < $4
            and ($1::uuid[] is null or o.branch_id = any($1::uuid[]))
            and ($2::uuid is null or o.branch_id = $2)
         union all
         select c.submitted_on::timestamptz, 'claim', coalesce(c.claim_no, i.number), 'claim',
                ${VEHICLE}, ${DRIVER}, b.name, c.status,
                coalesce(c.settled_minor, c.approved_minor, c.claimed_minor), s.name
           from insurance_claims c
           join incidents i on i.id = c.incident_id
           join suppliers s on s.id = c.insurer_id
           join vehicles v on v.id = i.vehicle_id
           join branches b on b.id = i.branch_id
           left join drivers d on d.id = i.driver_id
          where c.submitted_on between $5 and $6
            and ($1::uuid[] is null or i.branch_id = any($1::uuid[]))
            and ($2::uuid is null or i.branch_id = $2)
       ) events
       order by at, kind`,
      [...scope(filter), period.fromAt, period.untilAt, period.from, period.to],
    );
    return rows.map((r) => ({
      date: (r.at as Date).toISOString().slice(0, 10),
      kind: r.kind as IncidentRegisterRow["kind"],
      reference: s(r.reference),
      type: r.type as string,
      vehicle: r.vehicle as string,
      driverName: s(r.driver_name),
      branchName: r.branch_name as string,
      status: r.status as string,
      amountMinor: r.amount === null ? null : n(r.amount),
      detail: s(r.detail),
    }));
  }

  async remittancesByDriver(
    filter: BranchFilter,
    from: string,
    to: string,
  ): Promise<DriverRemittanceRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select r.driver_id, d.code, ${DRIVER} as name,
              count(distinct r.vehicle_id) as vehicles, count(*) as periods,
              count(*) filter (where r.mode = 'fixed_target'
                and r.expected_minor > r.received_minor + r.waived_minor) as short_periods,
              coalesce(sum(r.expected_minor) filter (where r.mode = 'fixed_target'), 0) as expected,
              coalesce(sum(r.received_minor) filter (where r.mode = 'fixed_target'), 0) as received,
              coalesce(sum(r.waived_minor), 0) as waived,
              coalesce(sum(greatest(r.expected_minor - r.received_minor - r.waived_minor, 0))
                filter (where r.mode = 'fixed_target'), 0) as outstanding,
              coalesce(sum(r.received_minor) filter (where r.mode = 'variable'), 0) as variable
         from remittances r
         join drivers d on d.id = r.driver_id
        where r.period_end between $3 and $4
          and ($1::uuid[] is null or r.branch_id = any($1::uuid[]))
          and ($2::uuid is null or r.branch_id = $2)
        group by r.driver_id, d.id
        order by outstanding desc, d.code`,
      [...scope(filter), from, to],
    );
    return rows.map((r) => ({
      driverId: r.driver_id as string,
      code: r.code as string,
      name: r.name as string,
      vehicles: n(r.vehicles),
      periods: n(r.periods),
      shortPeriods: n(r.short_periods),
      expectedMinor: n(r.expected),
      receivedMinor: n(r.received),
      waivedMinor: n(r.waived),
      outstandingMinor: n(r.outstanding),
      variableReceivedMinor: n(r.variable),
    }));
  }

  async driverPerformance(filter: BranchFilter, period: Period): Promise<DriverPerformanceRow[]> {
    const { rows } = await this.tx.query<Row>(
      `with days as (
         select driver_id, count(*) as working_days, sum(distance) as distance
           from daily_vehicle_stats
          where driver_id is not null and stat_date between $5 and $6
            and status in ('assigned', 'on_workpay')
          group by driver_id),
       money as (
         select driver_id, sum(expected_minor) filter (where mode = 'fixed_target') as expected,
                sum(received_minor) as received, sum(waived_minor) as waived
           from remittances where period_end between $5 and $6
          group by driver_id),
       accidents as (
         select driver_id, count(*) as incidents from incidents
          where driver_id is not null and occurred_at >= $3 and occurred_at < $4
          group by driver_id),
       fines as (
         select driver_id, count(*) as offences, sum(fine_minor) as fines from traffic_offences
          where driver_id is not null and offence_at >= $3 and offence_at < $4
          group by driver_id)
       select d.id, d.code, ${DRIVER} as name, d.status,
              coalesce(days.working_days, 0) as working_days, coalesce(days.distance, 0) as distance,
              coalesce(money.expected, 0) as expected, coalesce(money.received, 0) as received,
              coalesce(money.waived, 0) as waived, coalesce(accidents.incidents, 0) as incidents,
              coalesce(fines.offences, 0) as offences, coalesce(fines.fines, 0) as fines
         from drivers d
         left join days on days.driver_id = d.id
         left join money on money.driver_id = d.id
         left join accidents on accidents.driver_id = d.id
         left join fines on fines.driver_id = d.id
        where d.deleted_at is null
          and (days.driver_id is not null or money.driver_id is not null
               or accidents.driver_id is not null or fines.driver_id is not null)
          and ($1::uuid[] is null or d.branch_id = any($1::uuid[]))
          and ($2::uuid is null or d.branch_id = $2)
        order by d.code`,
      [...scope(filter), period.fromAt, period.untilAt, period.from, period.to],
    );
    return rows.map((r) => ({
      driverId: r.id as string,
      code: r.code as string,
      name: r.name as string,
      status: r.status as string,
      workingDays: n(r.working_days),
      distance: n(r.distance),
      expectedMinor: n(r.expected),
      receivedMinor: n(r.received),
      waivedMinor: n(r.waived),
      incidents: n(r.incidents),
      offences: n(r.offences),
      finesMinor: n(r.fines),
    }));
  }

  async rentalBookings(filter: BranchFilter, from: Date, until: Date): Promise<RentalBookingRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select k.number, k.status, b.name as branch_name, c.name as customer_name,
              c.type as customer_type, vc.name as class_name, ${VEHICLE} as vehicle,
              k.pickup_at, k.return_at, k.currency,
              coalesce((select sum(net_minor) from rental_booking_charges ch
                         where ch.booking_id = k.id), 0) as charges
         from rental_bookings k
         join branches b on b.id = k.branch_id
         join customers c on c.id = k.customer_id
         left join vehicle_classes vc on vc.id = k.class_id
         left join vehicle_blocks vb on vb.id = k.block_id
         left join vehicles v on v.id = vb.vehicle_id
        where k.pickup_at >= $3 and k.pickup_at < $4
          and ($1::uuid[] is null or k.branch_id = any($1::uuid[]))
          and ($2::uuid is null or k.branch_id = $2)
        order by k.pickup_at, k.number`,
      [...scope(filter), from, until],
    );
    return rows.map((r) => ({
      number: r.number as string,
      status: r.status as string,
      branchName: r.branch_name as string,
      customerName: r.customer_name as string,
      customerType: r.customer_type as string,
      className: s(r.class_name),
      vehicle: s(r.vehicle),
      pickupAt: r.pickup_at as Date,
      returnAt: r.return_at as Date,
      chargesMinor: n(r.charges),
      currency: (r.currency as string).trim(),
    }));
  }

  async expenseApprovals(
    filter: BranchFilter,
    from: string,
    to: string,
  ): Promise<ExpenseApprovalRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select e.number, e.expense_date::text as expense_date, e.status, c.name as category,
              e.description, b.name as branch_name, e.payee_name, e.amount_base_minor,
              sub.name as submitted_by, e.submitted_at,
              coalesce(app.name, rej.name) as decided_by,
              coalesce(e.approved_at, e.rejected_at) as decided_at, e.rejection_reason
         from expenses e
         join expense_categories c on c.id = e.category_id
         join branches b on b.id = e.branch_id
         left join users sub on sub.id = e.submitted_by
         left join users app on app.id = e.approved_by
         left join users rej on rej.id = e.rejected_by
        where e.status in ('submitted', 'approved', 'rejected', 'paid')
          and e.expense_date between $3 and $4
          and ($1::uuid[] is null or e.branch_id = any($1::uuid[]))
          and ($2::uuid is null or e.branch_id = $2)
        order by (e.status = 'submitted') desc, e.expense_date, e.number`,
      [...scope(filter), from, to],
    );
    return rows.map((r) => ({
      number: s(r.number),
      expenseDate: r.expense_date as string,
      status: r.status as string,
      category: r.category as string,
      description: r.description as string,
      branchName: r.branch_name as string,
      payeeName: s(r.payee_name),
      amountBaseMinor: n(r.amount_base_minor),
      submittedBy: s(r.submitted_by),
      submittedAt: (r.submitted_at as Date | null) ?? null,
      decidedBy: s(r.decided_by),
      decidedAt: (r.decided_at as Date | null) ?? null,
      rejectionReason: s(r.rejection_reason),
    }));
  }

  async cashDays(filter: BranchFilter, from: string, to: string): Promise<CashDayRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select paid_on::text as day, method, direction, count(*) as payments,
              sum(amount_base_minor) as amount
         from payments
        where status = 'recorded' and method <> 'trade_in' and paid_on between $3 and $4
          and ($1::uuid[] is null or branch_id = any($1::uuid[]))
          and ($2::uuid is null or branch_id = $2)
        group by 1, 2, 3
        order by 1, 2, 3`,
      [...scope(filter), from, to],
    );
    return rows.map((r) => ({
      date: r.day as string,
      method: r.method as string,
      direction: r.direction as "in" | "out",
      payments: n(r.payments),
      amountMinor: n(r.amount),
    }));
  }

  async expectedInflows(filter: BranchFilter, from: string, to: string): Promise<ExpectedInflows> {
    const { rows } = await this.tx.query<{ invoices: string; workpay: string }>(
      `select
         (select coalesce(sum(round((i.total_minor - i.paid_minor) * i.fx_rate)), 0)
            from invoices i
           where i.status in ('issued', 'partially_paid') and i.due_date <= $4
             and ($1::uuid[] is null or i.branch_id = any($1::uuid[]))
             and ($2::uuid is null or i.branch_id = $2)) as invoices,
         (select coalesce(sum(w.amount_minor - w.paid_minor - w.waived_minor), 0)
            from workpay_instalments w
            join workpay_agreements a on a.id = w.agreement_id
           where w.status not in ('paid', 'waived') and w.due_on between $3 and $4
             and a.status in ('active', 'in_arrears', 'restructured')
             and ($1::uuid[] is null or a.branch_id = any($1::uuid[]))
             and ($2::uuid is null or a.branch_id = $2)) as workpay`,
      [...scope(filter), from, to],
    );
    return { invoicesMinor: n(rows[0]!.invoices), workpayMinor: n(rows[0]!.workpay) };
  }

  async openInvoices(filter: BranchFilter, asOf: string): Promise<OpenInvoiceRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select party_type, party_id, party_name, due_date::text as due_date,
              round((total_minor - paid_minor) * fx_rate) as outstanding
         from invoices
        where status in ('issued', 'partially_paid') and issue_date <= $3
          and total_minor > paid_minor
          and ($1::uuid[] is null or branch_id = any($1::uuid[]))
          and ($2::uuid is null or branch_id = $2)
        order by party_name, due_date`,
      [...scope(filter), asOf],
    );
    return rows.map((r) => ({
      partyType: r.party_type as "customer" | "driver",
      partyId: r.party_id as string,
      partyName: r.party_name as string,
      dueDate: r.due_date as string,
      outstandingMinor: n(r.outstanding),
    }));
  }

  async payments(
    filter: BranchFilter,
    query: Readonly<{ from: string; to: string; direction: "in" | "out" | null }>,
  ): Promise<PaymentRegisterRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select p.paid_on::text as paid_on, p.number, p.party_name, p.method, p.reference,
              b.name as branch_name, p.currency, p.amount_minor, p.amount_base_minor, p.status,
              u.name as recorded_by
         from payments p
         join branches b on b.id = p.branch_id
         left join users u on u.id = p.recorded_by
        where p.paid_on between $3 and $4 and ($5::text is null or p.direction = $5)
          and ($1::uuid[] is null or p.branch_id = any($1::uuid[]))
          and ($2::uuid is null or p.branch_id = $2)
        order by p.paid_on, p.number`,
      [...scope(filter), query.from, query.to, query.direction],
    );
    return rows.map((r) => ({
      paidOn: r.paid_on as string,
      number: r.number as string,
      partyName: r.party_name as string,
      method: r.method as string,
      reference: s(r.reference),
      branchName: r.branch_name as string,
      currency: (r.currency as string).trim(),
      amountMinor: n(r.amount_minor),
      amountBaseMinor: n(r.amount_base_minor),
      status: r.status as string,
      recordedBy: s(r.recorded_by),
    }));
  }

  async cashSessions(filter: BranchFilter, from: Date, until: Date): Promise<CashSessionRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select b.name as branch_name, u.name as cashier_name, c.opened_at, c.closed_at,
              c.opening_float_minor, c.cash_in_minor, c.cash_out_minor, c.counted_minor,
              c.variance_minor, c.notes
         from cash_sessions c
         join branches b on b.id = c.branch_id
         join users u on u.id = c.cashier_id
        where c.status = 'closed' and c.closed_at >= $3 and c.closed_at < $4
          and ($1::uuid[] is null or c.branch_id = any($1::uuid[]))
          and ($2::uuid is null or c.branch_id = $2)
        order by c.closed_at`,
      [...scope(filter), from, until],
    );
    return rows.map((r) => ({
      branchName: r.branch_name as string,
      cashierName: r.cashier_name as string,
      openedAt: r.opened_at as Date,
      closedAt: r.closed_at as Date,
      openingMinor: n(r.opening_float_minor),
      cashInMinor: n(r.cash_in_minor),
      cashOutMinor: n(r.cash_out_minor),
      countedMinor: n(r.counted_minor),
      varianceMinor: n(r.variance_minor),
      notes: s(r.notes),
    }));
  }

  async taxAccounts(filter: BranchFilter, from: string, to: string): Promise<TaxAccountRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select a.code, a.name, a.system_key,
              coalesce(sum(l.debit_minor), 0) as debit, coalesce(sum(l.credit_minor), 0) as credit
         from ledger_accounts a
         left join ledger_lines l on l.account_id = a.id
              and ($1::uuid[] is null or l.branch_id = any($1::uuid[]))
              and ($2::uuid is null or l.branch_id = $2)
              and exists (select 1 from journal_entries e
                           where e.id = l.entry_id and e.entry_date between $3 and $4)
        where a.system_key like 'tax_payable:%' or a.system_key in ('input_tax', 'withholding_tax')
        group by a.id
        order by a.code`,
      [...scope(filter), from, to],
    );
    return rows.map((r) => ({
      code: r.code as string,
      name: r.name as string,
      systemKey: r.system_key as string,
      debitMinor: n(r.debit),
      creditMinor: n(r.credit),
    }));
  }

  async dayBook(
    filter: BranchFilter,
    from: string,
    to: string,
    limit: number,
  ): Promise<DayBookRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select e.entry_date::text as entry_date, e.number, e.description, e.source_type,
              a.code, a.name as account_name, b.name as branch_name,
              l.debit_minor, l.credit_minor
         from journal_entries e
         join ledger_lines l on l.entry_id = e.id
         join ledger_accounts a on a.id = l.account_id
         left join branches b on b.id = l.branch_id
        where e.entry_date between $3 and $4
          and ($1::uuid[] is null or l.branch_id is null or l.branch_id = any($1::uuid[]))
          and ($2::uuid is null or l.branch_id = $2)
        order by e.entry_date, e.created_at, e.number, l.debit_minor desc, a.code
        limit $5`,
      [...scope(filter), from, to, limit],
    );
    return rows.map((r) => ({
      date: r.entry_date as string,
      entryNumber: r.number as string,
      description: r.description as string,
      sourceType: r.source_type as string,
      accountCode: r.code as string,
      accountName: r.account_name as string,
      branchName: s(r.branch_name),
      debitMinor: n(r.debit_minor),
      creditMinor: n(r.credit_minor),
    }));
  }
}
