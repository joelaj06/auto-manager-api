import {
  DEFAULT_REMITTANCE_SETTINGS,
  type FleetCounts,
  type IOperationsQueries,
  type IRemittanceRecords,
  type IRemittanceSettingsStore,
  type RemittanceListFilter,
  type RemittancePayment,
  type RemittanceSettings,
  type RemittanceSubmission,
  type ShortfallDriver,
  type TargetAssignment,
} from "../../application/ports/IRemittanceRecords.js";
import { Remittance, type RemittanceProps } from "../../domain/remittances/Remittance.js";
import type { IRemittanceRepository } from "../../domain/repositories/IRemittanceRepository.js";
import { OFF_FLEET_STATUSES } from "../../domain/vehicles/VehicleStatus.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (value: string | null) => (value === null ? null : Number(value));

type RemittanceRow = {
  id: string;
  number: string | null;
  assignment_id: string;
  driver_id: string;
  vehicle_id: string;
  branch_id: string;
  mode: RemittanceProps["mode"];
  period_start: string;
  period_end: string;
  expected_minor: string | null;
  received_minor: string;
  waived_minor: string;
  accrued_minor: string;
  status: RemittanceProps["status"];
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = `r.id, r.number, r.assignment_id, r.driver_id, r.vehicle_id, r.branch_id, r.mode,
  r.period_start::text as period_start, r.period_end::text as period_end, r.expected_minor,
  r.received_minor, r.waived_minor, r.accrued_minor, r.status, r.created_at, r.updated_at`;

const toProps = (r: RemittanceRow): RemittanceProps => ({
  id: r.id,
  number: r.number,
  assignmentId: r.assignment_id,
  driverId: r.driver_id,
  vehicleId: r.vehicle_id,
  branchId: r.branch_id,
  mode: r.mode,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  expectedMinor: num(r.expected_minor),
  receivedMinor: Number(r.received_minor),
  waivedMinor: Number(r.waived_minor),
  accruedMinor: Number(r.accrued_minor),
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

type SubmissionRow = {
  id: string;
  remittance_id: string;
  declared_minor: string;
  method: RemittanceSubmission["method"];
  momo_network: RemittanceSubmission["momoNetwork"];
  reference: string | null;
  earnings: Record<string, number> | null;
  notes: string | null;
  status: RemittanceSubmission["status"];
  submitted_by: string | null;
  submitted_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  reject_reason: string | null;
  payment_id: string | null;
};
const toSubmission = (r: SubmissionRow): RemittanceSubmission => ({
  id: r.id,
  remittanceId: r.remittance_id,
  declaredMinor: Number(r.declared_minor),
  method: r.method,
  momoNetwork: r.momo_network,
  reference: r.reference,
  earnings: r.earnings,
  notes: r.notes,
  status: r.status,
  submittedBy: r.submitted_by,
  submittedAt: r.submitted_at,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  rejectReason: r.reject_reason,
  paymentId: r.payment_id,
});

type PaymentRow = {
  id: string;
  remittance_id: string;
  payment_id: string;
  amount_minor: string;
  settled_minor: string;
  released_at: Date | null;
  created_at: Date;
};
const toPayment = (r: PaymentRow): RemittancePayment => ({
  id: r.id,
  remittanceId: r.remittance_id,
  paymentId: r.payment_id,
  amountMinor: Number(r.amount_minor),
  settledMinor: Number(r.settled_minor),
  releasedAt: r.released_at,
  createdAt: r.created_at,
});

/** Remittances, submissions and their payments in the tenant database (tenant unit of work). */
export class PostgresRemittances implements IRemittanceRepository, IRemittanceRecords {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  findById(id: string): Promise<Remittance | null> {
    return this.one(id, "");
  }

  lockById(id: string): Promise<Remittance | null> {
    return this.one(id, "for update");
  }

  private async one(id: string, lock: string): Promise<Remittance | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<RemittanceRow>(
      `select ${COLUMNS} from remittances r where r.id = $1 ${lock}`,
      [id],
    );
    return rows[0] === undefined ? null : Remittance.restore(toProps(rows[0]));
  }

  async save(remittance: Remittance): Promise<void> {
    const p = remittance.snapshot();
    await this.tx.query(
      `insert into remittances (id, number, assignment_id, driver_id, vehicle_id, branch_id, mode,
         period_start, period_end, expected_minor, received_minor, waived_minor, accrued_minor,
         status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       on conflict (id) do update set number = excluded.number,
         received_minor = excluded.received_minor, waived_minor = excluded.waived_minor,
         accrued_minor = excluded.accrued_minor, status = excluded.status,
         updated_at = excluded.updated_at`,
      [
        p.id,
        p.number,
        p.assignmentId,
        p.driverId,
        p.vehicleId,
        p.branchId,
        p.mode,
        p.periodStart,
        p.periodEnd,
        p.expectedMinor,
        p.receivedMinor,
        p.waivedMinor,
        p.accruedMinor,
        p.status,
        p.createdAt,
        p.updatedAt,
      ],
    );
  }

  async list(filter: RemittanceListFilter): Promise<RemittanceProps[]> {
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ["b.status = 'active'"];
    if (filter.branchIds !== "all")
      where.push(`r.branch_id = any(${param(filter.branchIds)}::uuid[])`);
    if (filter.branchId !== undefined) where.push(`r.branch_id = ${param(filter.branchId)}`);
    if (filter.driverId !== undefined) where.push(`r.driver_id = ${param(filter.driverId)}`);
    if (filter.vehicleId !== undefined) where.push(`r.vehicle_id = ${param(filter.vehicleId)}`);
    if (filter.statuses !== undefined)
      where.push(`r.status = any(${param(filter.statuses)}::text[])`);
    if (filter.from !== undefined) where.push(`r.period_end >= ${param(filter.from)}`);
    if (filter.to !== undefined) where.push(`r.period_start <= ${param(filter.to)}`);
    if (filter.after !== undefined)
      where.push(
        `(r.period_start, r.id) < (${param(filter.after.periodStart)}::date, ${param(filter.after.id)}::uuid)`,
      );
    const { rows } = await this.tx.query<RemittanceRow>(
      `select ${COLUMNS} from remittances r join branches b on b.id = r.branch_id
        where ${where.join(" and ")}
        order by r.period_start desc, r.id desc limit ${param(filter.limit)}`,
      params,
    );
    return rows.map(toProps);
  }

  async submissions(remittanceId: string): Promise<RemittanceSubmission[]> {
    const { rows } = await this.tx.query<SubmissionRow>(
      "select * from remittance_submissions where remittance_id = $1 order by submitted_at desc",
      [remittanceId],
    );
    return rows.map(toSubmission);
  }

  async lockOpenSubmission(remittanceId: string): Promise<RemittanceSubmission | null> {
    const { rows } = await this.tx.query<SubmissionRow>(
      "select * from remittance_submissions where remittance_id = $1 and status = 'submitted' for update",
      [remittanceId],
    );
    return rows[0] === undefined ? null : toSubmission(rows[0]);
  }

  async saveSubmission(s: RemittanceSubmission): Promise<void> {
    await this.tx.query(
      `insert into remittance_submissions (id, remittance_id, declared_minor, method, momo_network,
         reference, earnings, notes, status, submitted_by, submitted_at, decided_by, decided_at,
         reject_reason, payment_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       on conflict (id) do update set status = excluded.status, decided_by = excluded.decided_by,
         decided_at = excluded.decided_at, reject_reason = excluded.reject_reason,
         payment_id = excluded.payment_id`,
      [
        s.id,
        s.remittanceId,
        s.declaredMinor,
        s.method,
        s.momoNetwork,
        s.reference,
        s.earnings === null ? null : JSON.stringify(s.earnings),
        s.notes,
        s.status,
        s.submittedBy,
        s.submittedAt,
        s.decidedBy,
        s.decidedAt,
        s.rejectReason,
        s.paymentId,
      ],
    );
  }

  async payments(remittanceId: string): Promise<RemittancePayment[]> {
    const { rows } = await this.tx.query<PaymentRow>(
      "select * from remittance_payments where remittance_id = $1 order by created_at",
      [remittanceId],
    );
    return rows.map(toPayment);
  }

  async paymentFor(paymentId: string): Promise<RemittancePayment | null> {
    const { rows } = await this.tx.query<PaymentRow>(
      "select * from remittance_payments where payment_id = $1 for update",
      [paymentId],
    );
    return rows[0] === undefined ? null : toPayment(rows[0]);
  }

  async savePayment(p: RemittancePayment): Promise<void> {
    await this.tx.query(
      `insert into remittance_payments (id, remittance_id, payment_id, amount_minor, settled_minor,
         released_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set released_at = excluded.released_at`,
      [p.id, p.remittanceId, p.paymentId, p.amountMinor, p.settledMinor, p.releasedAt, p.createdAt],
    );
  }

  async targetAssignments(): Promise<TargetAssignment[]> {
    const { rows } = await this.tx.query<{
      id: string;
      driver_id: string;
      vehicle_id: string;
      branch_id: string;
      started_at: Date;
      ended_at: Date | null;
      target_minor: string;
      target_frequency: TargetAssignment["frequency"];
      days_off: number[];
      last_period_start: string | null;
    }>(
      `select a.id, a.driver_id, a.vehicle_id, a.branch_id, a.started_at, a.ended_at,
              a.target_minor, a.target_frequency, a.days_off,
              (select max(r.period_start)::text from remittances r where r.assignment_id = a.id)
                as last_period_start
         from vehicle_assignments a
        where a.remittance_mode = 'fixed_target'
          and (a.ended_at is null or a.ended_at > now() - interval '60 days')
        order by a.started_at`,
    );
    return rows.map((r) => ({
      id: r.id,
      driverId: r.driver_id,
      vehicleId: r.vehicle_id,
      branchId: r.branch_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      targetMinor: Number(r.target_minor),
      frequency: r.target_frequency,
      daysOff: r.days_off,
      lastPeriodStart: r.last_period_start,
    }));
  }

  async lockUnsettled(): Promise<string[]> {
    const { rows } = await this.tx.query<{ id: string }>(
      `select id from remittances where status in ('pending', 'submitted', 'partially_paid', 'overdue')
        order by period_start for update`,
    );
    return rows.map((r) => r.id);
  }

  async outstanding(driverId: string): Promise<RemittanceProps[]> {
    const { rows } = await this.tx.query<RemittanceRow>(
      `select ${COLUMNS} from remittances r
        where r.driver_id = $1 and r.mode = 'fixed_target' and r.accrued_minor > 0
          and r.expected_minor > r.received_minor + r.waived_minor
        order by r.period_start`,
      [driverId],
    );
    return rows.map(toProps);
  }
}

/** The figures of the operations board. */
export class PostgresOperationsQueries implements IOperationsQueries {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async fleetCounts(
    branchIds: "all" | readonly string[],
    branchId: string | null,
  ): Promise<FleetCounts> {
    const { rows } = await this.tx.query<{ status: string; n: string }>(
      `select v.status, count(*) as n from vehicles v join branches b on b.id = v.branch_id
        where v.deleted_at is null and b.status = 'active' and v.status <> all($1::text[])
          and ($2::uuid[] is null or v.branch_id = any($2::uuid[]))
          and ($3::uuid is null or v.branch_id = $3)
        group by v.status`,
      [[...OFF_FLEET_STATUSES], branchIds === "all" ? null : branchIds, branchId],
    );
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  async remittancesDue(
    date: string,
    branchIds: "all" | readonly string[],
    branchId: string | null,
  ) {
    const { rows } = await this.tx.query<{
      status: string;
      n: string;
      expected: string;
      received: string;
    }>(
      `select r.status, count(*) as n, coalesce(sum(r.expected_minor), 0) as expected,
              coalesce(sum(r.received_minor), 0) as received
         from remittances r
        where r.mode = 'fixed_target' and r.period_end = $1
          and ($2::uuid[] is null or r.branch_id = any($2::uuid[]))
          and ($3::uuid is null or r.branch_id = $3)
        group by r.status`,
      [date, branchIds === "all" ? null : branchIds, branchId],
    );
    return {
      count: rows.reduce((sum, r) => sum + Number(r.n), 0),
      expectedMinor: rows.reduce((sum, r) => sum + Number(r.expected), 0),
      receivedMinor: rows.reduce((sum, r) => sum + Number(r.received), 0),
      byStatus: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])),
    };
  }

  async shortfallDrivers(
    since: string,
    minPeriods: number,
    branchIds: "all" | readonly string[],
    branchId: string | null,
  ): Promise<ShortfallDriver[]> {
    const { rows } = await this.tx.query<{
      driver_id: string;
      name: string;
      code: string;
      periods: string;
      outstanding: string;
    }>(
      `select r.driver_id, d.first_name || ' ' || d.last_name as name, d.code,
              count(*) as periods,
              sum(r.expected_minor - r.received_minor - r.waived_minor) as outstanding
         from remittances r join drivers d on d.id = r.driver_id
        where r.mode = 'fixed_target' and r.status in ('overdue', 'partially_paid')
          and r.period_end >= $1
          and ($3::uuid[] is null or r.branch_id = any($3::uuid[]))
          and ($4::uuid is null or r.branch_id = $4)
        group by r.driver_id, d.first_name, d.last_name, d.code
       having count(*) >= $2
        order by sum(r.expected_minor - r.received_minor - r.waived_minor) desc`,
      [since, minPeriods, branchIds === "all" ? null : branchIds, branchId],
    );
    return rows.map((r) => ({
      driverId: r.driver_id,
      name: r.name,
      code: r.code,
      periods: Number(r.periods),
      outstandingMinor: Number(r.outstanding),
    }));
  }
}

/** Remittance settings in `organisation.settings->'remittances'`, over the defaults. */
export class PostgresRemittanceSettingsStore implements IRemittanceSettingsStore {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async get(): Promise<RemittanceSettings> {
    const { rows } = await this.transactions
      .current()
      .query<{ remittances: Partial<RemittanceSettings> | null }>(
        "select settings->'remittances' as remittances from organisation",
      );
    return { ...DEFAULT_REMITTANCE_SETTINGS, ...(rows[0]?.remittances ?? {}) };
  }

  async set(settings: RemittanceSettings): Promise<void> {
    await this.transactions
      .current()
      .query(
        "update organisation set settings = jsonb_set(settings, '{remittances}', $1::jsonb), updated_at = now()",
        [JSON.stringify(settings)],
      );
  }
}
