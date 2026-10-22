import type { BranchFilter } from "../../application/ports/IReporting.js";
import type {
  AgeingBucket,
  AgreementPaymentRow,
  ArrearsNoticeRow,
  InstalmentNoticeRow,
  IWorkPayReporting,
  PortfolioRow,
} from "../../application/ports/IWorkPayReporting.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const n = (value: string | number | null) => (value === null ? 0 : Number(value));
const scope = (filter: BranchFilter) => [
  filter.branchIds === "all" ? null : filter.branchIds,
  filter.branchId,
];
const RUNNING = ["active", "in_arrears", "defaulted"];
const OPEN_ROW = "(i.amount_minor - i.paid_minor - i.waived_minor - i.rescheduled_minor)";

type NoticeRow = {
  instalment_id: string;
  agreement_id: string;
  number: string;
  instalment_number: number;
  due_on: string;
  outstanding: string;
  driver_id: string;
  driver_name: string;
  phone: string;
  branch_id: string;
  plate_number: string | null;
};

const NOTICE = `select i.id as instalment_id, a.id as agreement_id, a.number,
       i.number as instalment_number, i.due_on::text as due_on, ${OPEN_ROW} as outstanding,
       d.id as driver_id, d.first_name || ' ' || d.last_name as driver_name, d.phone,
       a.branch_id, v.plate_number
  from workpay_instalments i
  join workpay_agreements a on a.id = i.agreement_id
  join drivers d on d.id = a.driver_id
  join vehicles v on v.id = a.vehicle_id
 where a.status = any($1::text[]) and ${OPEN_ROW} > 0`;

const toNotice = (r: NoticeRow): InstalmentNoticeRow => ({
  instalmentId: r.instalment_id,
  agreementId: r.agreement_id,
  number: r.number,
  instalmentNumber: r.instalment_number,
  dueOn: r.due_on,
  outstandingMinor: n(r.outstanding),
  driverId: r.driver_id,
  driverName: r.driver_name,
  phone: r.phone,
  branchId: r.branch_id,
  plateNumber: r.plate_number,
});

export class PostgresWorkPayReporting implements IWorkPayReporting {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async portfolio(filter: BranchFilter, today: string): Promise<PortfolioRow[]> {
    const { rows } = await this.tx.query<{
      agreement_id: string;
      number: string;
      status: string;
      branch_id: string;
      driver_id: string;
      driver_name: string;
      phone: string;
      vehicle_id: string;
      plate_number: string | null;
      vehicle_code: string;
      instalments: string;
      paid: string;
      waived: string;
      outstanding: string;
      overdue: string;
      penalties: string;
      charges: string;
      arrears_since: string | null;
      next_due_on: string | null;
    }>(
      `select a.id as agreement_id, a.number, a.status, a.branch_id, d.id as driver_id,
              d.first_name || ' ' || d.last_name as driver_name, d.phone, v.id as vehicle_id,
              v.plate_number, v.code as vehicle_code, a.arrears_since::text as arrears_since,
              coalesce(i.instalments, 0) as instalments, coalesce(i.paid, 0) as paid,
              coalesce(i.waived, 0) as waived, coalesce(i.outstanding, 0) as outstanding,
              coalesce(i.overdue, 0) as overdue, i.next_due_on,
              coalesce((select sum(p.amount_minor - p.paid_minor - p.waived_minor)
                          from workpay_penalties p where p.agreement_id = a.id), 0) as penalties,
              coalesce((select sum(c.amount_minor - c.paid_minor - c.waived_minor)
                          from workpay_charges c where c.agreement_id = a.id), 0) as charges
         from workpay_agreements a
         join drivers d on d.id = a.driver_id
         join vehicles v on v.id = a.vehicle_id
         left join lateral (
           select sum(i.amount_minor - i.rescheduled_minor) as instalments,
                  sum(i.paid_minor) as paid, sum(i.waived_minor) as waived,
                  sum(${OPEN_ROW}) as outstanding,
                  sum(${OPEN_ROW}) filter (where i.due_on + a.grace_days < $4::date) as overdue,
                  (min(i.due_on) filter (where ${OPEN_ROW} > 0))::text as next_due_on
             from workpay_instalments i where i.agreement_id = a.id
         ) i on true
        where a.status = any($3::text[])
          and ($1::uuid[] is null or a.branch_id = any($1::uuid[]))
          and ($2::uuid is null or a.branch_id = $2)
        order by a.id`,
      [...scope(filter), [...RUNNING, "completed"], today],
    );
    return rows.map((r) => ({
      agreementId: r.agreement_id,
      number: r.number,
      status: r.status,
      branchId: r.branch_id,
      driverId: r.driver_id,
      driverName: r.driver_name,
      phone: r.phone,
      vehicleId: r.vehicle_id,
      plateNumber: r.plate_number,
      vehicleCode: r.vehicle_code,
      instalmentsMinor: n(r.instalments),
      paidMinor: n(r.paid),
      waivedMinor: n(r.waived),
      outstandingMinor: n(r.outstanding),
      overdueMinor: n(r.overdue),
      penaltiesOutstandingMinor: n(r.penalties),
      chargesOutstandingMinor: n(r.charges),
      arrearsSince: r.arrears_since,
      nextDueOn: r.next_due_on,
    }));
  }

  async ageing(filter: BranchFilter, today: string) {
    const { rows } = await this.tx.query<{ bucket: AgeingBucket; amount: string }>(
      `select case when days <= 7 then '1-7' when days <= 30 then '8-30'
                   when days <= 60 then '31-60' when days <= 90 then '61-90'
                   else 'over_90' end as bucket,
              sum(open) as amount
         from (select ($4::date - i.due_on - a.grace_days) as days, ${OPEN_ROW} as open
                 from workpay_instalments i
                 join workpay_agreements a on a.id = i.agreement_id
                where a.status = any($3::text[]) and ${OPEN_ROW} > 0
                  and i.due_on + a.grace_days < $4::date
                  and ($1::uuid[] is null or a.branch_id = any($1::uuid[]))
                  and ($2::uuid is null or a.branch_id = $2)) x
        group by 1`,
      [...scope(filter), RUNNING, today],
    );
    const result: Record<AgeingBucket, number> = {
      "1-7": 0,
      "8-30": 0,
      "31-60": 0,
      "61-90": 0,
      over_90: 0,
    };
    for (const r of rows) result[r.bucket] = n(r.amount);
    return result;
  }

  async dueBetween(filter: BranchFilter, from: string, to: string) {
    const { rows } = await this.tx.query<{ due_on: string; amount: string }>(
      `select i.due_on::text as due_on, sum(${OPEN_ROW}) as amount
         from workpay_instalments i
         join workpay_agreements a on a.id = i.agreement_id
        where a.status = any($3::text[]) and ${OPEN_ROW} > 0
          and i.due_on between $4 and $5
          and ($1::uuid[] is null or a.branch_id = any($1::uuid[]))
          and ($2::uuid is null or a.branch_id = $2)
        group by i.due_on order by i.due_on`,
      [...scope(filter), RUNNING, from, to],
    );
    return rows.map((r) => ({ dueOn: r.due_on, outstandingMinor: n(r.amount) }));
  }

  async collected(filter: BranchFilter, from: string, to: string) {
    const { rows } = await this.tx.query<{ due: string | null; paid: string | null }>(
      `select sum(i.amount_minor - i.rescheduled_minor - i.waived_minor) as due,
              sum(i.paid_minor) as paid
         from workpay_instalments i
         join workpay_agreements a on a.id = i.agreement_id
        where a.status = any($3::text[]) and i.due_on between $4 and $5
          and i.amount_minor > i.rescheduled_minor
          and ($1::uuid[] is null or a.branch_id = any($1::uuid[]))
          and ($2::uuid is null or a.branch_id = $2)`,
      [...scope(filter), [...RUNNING, "completed"], from, to],
    );
    return { dueMinor: n(rows[0]?.due ?? null), paidMinor: n(rows[0]?.paid ?? null) };
  }

  async instalmentsDueOn(dates: readonly string[]): Promise<InstalmentNoticeRow[]> {
    const { rows } = await this.tx.query<NoticeRow>(
      `${NOTICE} and i.due_on = any($2::date[]) order by i.due_on, a.id`,
      [RUNNING, dates],
    );
    return rows.map(toNotice);
  }

  async overdueInstalments(): Promise<InstalmentNoticeRow[]> {
    const { rows } = await this.tx.query<NoticeRow>(
      `${NOTICE} and i.status = 'overdue' order by a.branch_id, a.id, i.number`,
      [RUNNING],
    );
    return rows.map(toNotice);
  }

  async inArrears(): Promise<ArrearsNoticeRow[]> {
    const { rows } = await this.tx.query<{
      agreement_id: string;
      number: string;
      status: string;
      arrears_since: string;
      branch_id: string;
      driver_id: string;
      driver_name: string;
      overdue: string;
      guarantors: { name: string; phone: string }[];
    }>(
      `select a.id as agreement_id, a.number, a.status, a.arrears_since::text as arrears_since,
              a.branch_id, d.id as driver_id, d.first_name || ' ' || d.last_name as driver_name,
              coalesce((select sum(${OPEN_ROW}) from workpay_instalments i
                         where i.agreement_id = a.id and i.status = 'overdue'), 0) as overdue,
              coalesce((select json_agg(json_build_object('name', g.name, 'phone', g.phone)
                                 order by g.position)
                          from workpay_guarantors g where g.agreement_id = a.id), '[]'::json)
                as guarantors
         from workpay_agreements a
         join drivers d on d.id = a.driver_id
        where a.status = any($1::text[]) and a.arrears_since is not null
        order by a.arrears_since, a.id`,
      [RUNNING],
    );
    return rows.map((r) => ({
      agreementId: r.agreement_id,
      number: r.number,
      status: r.status,
      arrearsSince: r.arrears_since,
      branchId: r.branch_id,
      driverId: r.driver_id,
      driverName: r.driver_name,
      overdueMinor: n(r.overdue),
      guarantors: r.guarantors,
    }));
  }

  async payments(agreementId: string): Promise<AgreementPaymentRow[]> {
    const { rows } = await this.tx.query<{
      id: string;
      number: string;
      source_type: string;
      paid_on: string;
      method: string;
      amount_base_minor: string;
      status: string;
    }>(
      `select id, number, source_type, paid_on::text as paid_on, method, amount_base_minor, status
         from payments
        where source_type in ('workpay_deposit', 'workpay_payment') and source_id = $1
        order by paid_on, recorded_at, id`,
      [agreementId],
    );
    return rows.map((r) => ({
      paymentId: r.id,
      number: r.number,
      kind: r.source_type === "workpay_deposit" ? "deposit" : "instalments",
      paidOn: r.paid_on,
      method: r.method,
      amountMinor: n(r.amount_base_minor),
      reversed: r.status === "reversed",
    }));
  }
}
