import type {
  DriverRef,
  FuelAnomalyRow,
  IIncidents,
  IncidentCosts,
  IncidentFilter,
  OffenceFilter,
} from "../../application/ports/IIncidents.js";
import {
  Incident,
  InsuranceClaim,
  TrafficOffence,
  type ClaimProps,
  type ClaimStatus,
  type IncidentProps,
  type OffenceProps,
} from "../../domain/incidents/Incident.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INCIDENT_COLUMNS = `id, number, vehicle_id, branch_id, driver_id, type, severity, status,
  occurred_at, location, description, injuries, police_report_no, police_station, third_parties,
  issue_id, damage_id, vehicle_status, status_before, closed_at, closed_by, outcome, created_by,
  created_at, updated_at`;
const CLAIM_COLUMNS = `id, incident_id, insurer_id, policy_no, claim_no, status,
  claimed_minor::text as claimed_minor, excess_minor::text as excess_minor,
  approved_minor::text as approved_minor, settled_minor::text as settled_minor,
  settled_on::text as settled_on, settlement_method, settlement_reference,
  submitted_on::text as submitted_on, decided_at, reason, notes, created_by, created_at, updated_at`;
const OFFENCE_COLUMNS = `id, vehicle_id, branch_id, driver_id, type, offence_at, location, authority,
  notice_ref, fine_minor::text as fine_minor, due_on::text as due_on, driver_pays, status,
  paid_on::text as paid_on, paid_by, expense_id, notes, created_by, created_at, updated_at`;
const ANOMALY_COLUMNS = `id, fuel_log_id, vehicle_id, branch_id, driver_id, kind,
  km_per_litre::text as km_per_litre, baseline::text as baseline, litres::text as litres, distance,
  status, reviewed_by, reviewed_at, note, created_at`;

type Row = Record<string, unknown>;

/** Builds `where` clauses with numbered parameters. */
class Where {
  readonly parts: string[] = [];
  readonly params: unknown[] = [];
  add(sql: string, value: unknown): this {
    this.params.push(value);
    this.parts.push(sql.replace("?", `$${this.params.length}`));
    return this;
  }
  branches(column: string, ids: "all" | readonly string[]): this {
    return ids === "all" ? this : this.add(`${column} = any(?::uuid[])`, ids);
  }
  sql(): string {
    return this.parts.length === 0 ? "" : `where ${this.parts.join(" and ")}`;
  }
  limit(n: number): string {
    this.params.push(n);
    return `limit $${this.params.length}`;
  }
}

export class PostgresIncidents implements IIncidents {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  // --- incidents ---

  async insert(incident: Incident): Promise<void> {
    const p = incident.snapshot();
    await this.tx.query(
      `insert into incidents (${INCIDENT_COLUMNS})
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17,
               $18, $19, $20, $21, $22, $23, $24, $25)`,
      incidentParams(p),
    );
  }

  async update(incident: Incident): Promise<void> {
    const p = incident.snapshot();
    await this.tx.query(
      `update incidents set driver_id = $2, type = $3, severity = $4, status = $5,
              occurred_at = $6, location = $7, description = $8, injuries = $9,
              police_report_no = $10, police_station = $11, third_parties = $12::jsonb,
              vehicle_status = $13, status_before = $14, closed_at = $15, closed_by = $16,
              outcome = $17, updated_at = $18
        where id = $1`,
      [
        p.id,
        p.driverId,
        p.type,
        p.severity,
        p.status,
        p.occurredAt,
        p.location,
        p.description,
        p.injuries,
        p.policeReportNo,
        p.policeStation,
        JSON.stringify(p.thirdParties),
        p.vehicleStatus,
        p.statusBefore,
        p.closedAt,
        p.closedBy,
        p.outcome,
        p.updatedAt,
      ],
    );
  }

  async get(id: string): Promise<Incident | null> {
    return (await this.loadIncidents("where id = $1", [id]))[0] ?? null;
  }

  async lock(id: string): Promise<Incident | null> {
    return (await this.loadIncidents("where id = $1 for update", [id]))[0] ?? null;
  }

  list(filter: IncidentFilter): Promise<Incident[]> {
    const w = new Where().branches("branch_id", filter.branchIds);
    if (filter.vehicleId !== undefined) w.add("vehicle_id = ?", filter.vehicleId);
    if (filter.driverId !== undefined) w.add("driver_id = ?", filter.driverId);
    if (filter.type !== undefined) w.add("type = ?", filter.type);
    if (filter.status !== undefined) w.add("status = ?", filter.status);
    if (filter.beforeId !== undefined) w.add("id < ?", filter.beforeId);
    const where = w.sql();
    return this.loadIncidents(`${where} order by id desc ${w.limit(filter.limit)}`, w.params);
  }

  async costs(incidentId: string): Promise<IncidentCosts> {
    const orders = await this.tx.query<Row>(
      `select o.id, o.number, o.status,
              coalesce((select sum(l.amount_minor) from work_order_lines l
                         where l.work_order_id = o.id), 0)::text as total,
              coalesce(sum(a.amount_minor) filter (where a.payer = 'company'), 0)::text as company,
              coalesce(sum(a.amount_minor) filter (where a.payer = 'driver'), 0)::text as driver,
              coalesce(sum(a.amount_minor) filter (where a.payer = 'customer'), 0)::text as customer,
              coalesce(sum(a.amount_minor) filter (where a.payer = 'insurer'), 0)::text as insurer
         from work_orders o
         left join work_order_allocations a on a.work_order_id = o.id
        where o.incident_id = $1
        group by o.id order by o.created_at`,
      [incidentId],
    );
    const expenses = await this.tx.query<Row>(
      `select id, number, status, amount_minor::text as amount, charge_to_driver
         from expenses where incident_id = $1 order by created_at`,
      [incidentId],
    );
    return {
      workOrders: orders.rows.map((r) => ({
        id: r.id as string,
        number: r.number as string,
        status: r.status as string,
        totalMinor: Number(r.total),
        companyMinor: Number(r.company),
        driverMinor: Number(r.driver),
        customerMinor: Number(r.customer),
        insurerMinor: Number(r.insurer),
      })),
      expenses: expenses.rows.map((r) => ({
        id: r.id as string,
        number: r.number as string | null,
        status: r.status as string,
        amountMinor: Number(r.amount),
        chargeToDriver: r.charge_to_driver as boolean,
      })),
    };
  }

  async linkExpense(incidentId: string, expenseId: string, vehicleId: string): Promise<boolean> {
    if (!UUID.test(expenseId)) return false;
    const { rowCount } = await this.tx.query(
      `update expenses e set incident_id = $1
        where e.id = $2 and e.status <> 'void'
          and (not exists (select 1 from expense_lines l where l.expense_id = e.id
                            and l.vehicle_id is not null)
               or exists (select 1 from expense_lines l where l.expense_id = e.id
                           and l.vehicle_id = $3))`,
      [incidentId, expenseId, vehicleId],
    );
    return (rowCount ?? 0) > 0;
  }

  async linkWorkOrder(
    incidentId: string,
    workOrderId: string,
    vehicleId: string,
  ): Promise<boolean> {
    if (!UUID.test(workOrderId)) return false;
    const { rowCount } = await this.tx.query(
      "update work_orders set incident_id = $1 where id = $2 and vehicle_id = $3",
      [incidentId, workOrderId, vehicleId],
    );
    return (rowCount ?? 0) > 0;
  }

  // --- claims ---

  async insertClaim(claim: InsuranceClaim): Promise<void> {
    await this.tx.query(
      `insert into insurance_claims (id, incident_id, insurer_id, policy_no, claim_no, status,
         claimed_minor, excess_minor, approved_minor, settled_minor, settled_on, settlement_method,
         settlement_reference, submitted_on, decided_at, reason, notes, created_by, created_at,
         updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20)`,
      claimParams(claim.snapshot()),
    );
  }

  async updateClaim(claim: InsuranceClaim): Promise<void> {
    const p = claim.snapshot();
    await this.tx.query(
      `update insurance_claims set policy_no = $2, claim_no = $3, status = $4,
              approved_minor = $5, settled_minor = $6, settled_on = $7, settlement_method = $8,
              settlement_reference = $9, decided_at = $10, reason = $11, notes = $12,
              updated_at = $13
        where id = $1`,
      [
        p.id,
        p.policyNo,
        p.claimNo,
        p.status,
        p.approvedMinor,
        p.settledMinor,
        p.settledOn,
        p.settlementMethod,
        p.settlementReference,
        p.decidedAt,
        p.reason,
        p.notes,
        p.updatedAt,
      ],
    );
  }

  async lockClaim(id: string): Promise<InsuranceClaim | null> {
    if (!UUID.test(id)) return null;
    return (await this.loadClaims("where id = $1 for update", [id]))[0] ?? null;
  }

  claimsOf(incidentId: string): Promise<InsuranceClaim[]> {
    return this.loadClaims("where incident_id = $1 order by created_at", [incidentId]);
  }

  claims(
    filter: Readonly<{
      branchIds: "all" | readonly string[];
      statuses?: readonly ClaimStatus[];
      insurerId?: string;
      limit: number;
    }>,
  ): Promise<InsuranceClaim[]> {
    const w = new Where();
    if (filter.branchIds !== "all")
      w.add(
        "incident_id in (select id from incidents where branch_id = any(?::uuid[]))",
        filter.branchIds,
      );
    if (filter.statuses !== undefined) w.add("status = any(?::text[])", filter.statuses);
    if (filter.insurerId !== undefined) w.add("insurer_id = ?", filter.insurerId);
    const where = w.sql();
    return this.loadClaims(`${where} order by id desc ${w.limit(filter.limit)}`, w.params);
  }

  // --- offences ---

  async insertOffence(offence: TrafficOffence): Promise<void> {
    await this.tx.query(
      `insert into traffic_offences (id, vehicle_id, branch_id, driver_id, type, offence_at,
         location, authority, notice_ref, fine_minor, due_on, driver_pays, status, paid_on,
         paid_by, expense_id, notes, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20)`,
      offenceParams(offence.snapshot()),
    );
  }

  async updateOffence(offence: TrafficOffence): Promise<void> {
    const p = offence.snapshot();
    await this.tx.query(
      `update traffic_offences set driver_id = $2, type = $3, offence_at = $4, location = $5,
              authority = $6, notice_ref = $7, fine_minor = $8, due_on = $9, driver_pays = $10,
              status = $11, paid_on = $12, paid_by = $13, expense_id = $14, notes = $15,
              updated_at = $16
        where id = $1`,
      [
        p.id,
        p.driverId,
        p.type,
        p.offenceAt,
        p.location,
        p.authority,
        p.noticeRef,
        p.fineMinor,
        p.dueOn,
        p.driverPays,
        p.status,
        p.paidOn,
        p.paidBy,
        p.expenseId,
        p.notes,
        p.updatedAt,
      ],
    );
  }

  async getOffence(id: string): Promise<TrafficOffence | null> {
    if (!UUID.test(id)) return null;
    return (await this.loadOffences("where id = $1", [id]))[0] ?? null;
  }

  async lockOffence(id: string): Promise<TrafficOffence | null> {
    if (!UUID.test(id)) return null;
    return (await this.loadOffences("where id = $1 for update", [id]))[0] ?? null;
  }

  offences(filter: OffenceFilter): Promise<TrafficOffence[]> {
    const w = new Where().branches("branch_id", filter.branchIds);
    if (filter.vehicleId !== undefined) w.add("vehicle_id = ?", filter.vehicleId);
    if (filter.driverId !== undefined) w.add("driver_id = ?", filter.driverId);
    if (filter.statuses !== undefined) w.add("status = any(?::text[])", filter.statuses);
    if (filter.beforeId !== undefined) w.add("id < ?", filter.beforeId);
    const where = w.sql();
    return this.loadOffences(`${where} order by id desc ${w.limit(filter.limit)}`, w.params);
  }

  async noticeTaken(
    authority: string,
    noticeRef: string,
    exceptId: string | null,
  ): Promise<boolean> {
    const { rows } = await this.tx.query(
      `select 1 from traffic_offences
        where lower(authority) = lower($1) and lower(notice_ref) = lower($2)
          and id is distinct from $3`,
      [authority, noticeRef, exceptId],
    );
    return rows.length > 0;
  }

  // --- fuel anomalies ---

  async addAnomaly(a: FuelAnomalyRow): Promise<void> {
    await this.tx.query(
      `insert into fuel_anomalies (id, fuel_log_id, vehicle_id, branch_id, driver_id, kind,
         km_per_litre, baseline, litres, distance, status, reviewed_by, reviewed_at, note,
         created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       on conflict (fuel_log_id) do nothing`,
      [
        a.id,
        a.fuelLogId,
        a.vehicleId,
        a.branchId,
        a.driverId,
        a.kind,
        a.kmPerLitre,
        a.baseline,
        a.litres,
        a.distance,
        a.status,
        a.reviewedBy,
        a.reviewedAt,
        a.note,
        a.createdAt,
      ],
    );
  }

  async lockAnomaly(id: string): Promise<FuelAnomalyRow | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<Row>(
      `select ${ANOMALY_COLUMNS} from fuel_anomalies where id = $1 for update`,
      [id],
    );
    return rows[0] === undefined ? null : anomaly(rows[0]);
  }

  async updateAnomaly(a: FuelAnomalyRow): Promise<void> {
    await this.tx.query(
      `update fuel_anomalies set status = $2, reviewed_by = $3, reviewed_at = $4, note = $5
        where id = $1`,
      [a.id, a.status, a.reviewedBy, a.reviewedAt, a.note],
    );
  }

  async anomalies(
    filter: Readonly<{
      branchIds: "all" | readonly string[];
      vehicleId?: string;
      status?: FuelAnomalyRow["status"];
      limit: number;
    }>,
  ): Promise<FuelAnomalyRow[]> {
    const w = new Where().branches("branch_id", filter.branchIds);
    if (filter.vehicleId !== undefined) w.add("vehicle_id = ?", filter.vehicleId);
    if (filter.status !== undefined) w.add("status = ?", filter.status);
    const where = w.sql();
    const { rows } = await this.tx.query<Row>(
      `select ${ANOMALY_COLUMNS} from fuel_anomalies ${where} order by id desc ${w.limit(filter.limit)}`,
      w.params,
    );
    return rows.map(anomaly);
  }

  // --- people ---

  async driverAt(vehicleId: string, at: Date): Promise<DriverRef | null> {
    const { rows } = await this.tx.query<{ id: string; name: string; phone: string }>(
      `select d.id, d.first_name || ' ' || d.last_name as name, d.phone
         from vehicle_assignments a join drivers d on d.id = a.driver_id
        where a.vehicle_id = $1 and a.started_at <= $2
          and (a.ended_at is null or a.ended_at > $2)
        order by a.started_at desc limit 1`,
      [vehicleId, at],
    );
    const row = rows[0];
    return row === undefined ? null : { driverId: row.id, name: row.name, phone: row.phone };
  }

  async driver(id: string): Promise<DriverRef | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<{ id: string; name: string; phone: string }>(
      `select id, first_name || ' ' || last_name as name, phone from drivers
        where id = $1 and deleted_at is null`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : { driverId: row.id, name: row.name, phone: row.phone };
  }

  async supplierExists(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const { rows } = await this.tx.query(
      "select 1 from suppliers where id = $1 and active and deleted_at is null",
      [id],
    );
    return rows.length > 0;
  }

  // --- helpers ---

  private async loadIncidents(tail: string, params: unknown[]): Promise<Incident[]> {
    const { rows } = await this.tx.query<Row>(
      `select ${INCIDENT_COLUMNS} from incidents ${tail}`,
      params,
    );
    return rows.map((r) =>
      Incident.restore({
        id: r.id as string,
        number: r.number as string,
        vehicleId: r.vehicle_id as string,
        branchId: r.branch_id as string,
        driverId: r.driver_id as string | null,
        type: r.type as IncidentProps["type"],
        severity: r.severity as IncidentProps["severity"],
        status: r.status as IncidentProps["status"],
        occurredAt: r.occurred_at as Date,
        location: r.location as string | null,
        description: r.description as string,
        injuries: r.injuries as boolean,
        policeReportNo: r.police_report_no as string | null,
        policeStation: r.police_station as string | null,
        thirdParties: r.third_parties as IncidentProps["thirdParties"],
        issueId: r.issue_id as string | null,
        damageId: r.damage_id as string | null,
        vehicleStatus: r.vehicle_status as string | null,
        statusBefore: r.status_before as string | null,
        closedAt: r.closed_at as Date | null,
        closedBy: r.closed_by as string | null,
        outcome: r.outcome as string | null,
        createdBy: r.created_by as string | null,
        createdAt: r.created_at as Date,
        updatedAt: r.updated_at as Date,
      }),
    );
  }

  private async loadClaims(tail: string, params: unknown[]): Promise<InsuranceClaim[]> {
    const { rows } = await this.tx.query<Row>(
      `select ${CLAIM_COLUMNS} from insurance_claims ${tail}`,
      params,
    );
    const num = (v: unknown) => (v === null ? null : Number(v));
    return rows.map((r) =>
      InsuranceClaim.restore({
        id: r.id as string,
        incidentId: r.incident_id as string,
        insurerId: r.insurer_id as string,
        policyNo: r.policy_no as string | null,
        claimNo: r.claim_no as string | null,
        status: r.status as ClaimProps["status"],
        claimedMinor: Number(r.claimed_minor),
        excessMinor: Number(r.excess_minor),
        approvedMinor: num(r.approved_minor),
        settledMinor: num(r.settled_minor),
        settledOn: r.settled_on as string | null,
        settlementMethod: r.settlement_method as ClaimProps["settlementMethod"],
        settlementReference: r.settlement_reference as string | null,
        submittedOn: r.submitted_on as string,
        decidedAt: r.decided_at as Date | null,
        reason: r.reason as string | null,
        notes: r.notes as string | null,
        createdBy: r.created_by as string | null,
        createdAt: r.created_at as Date,
        updatedAt: r.updated_at as Date,
      }),
    );
  }

  private async loadOffences(tail: string, params: unknown[]): Promise<TrafficOffence[]> {
    const { rows } = await this.tx.query<Row>(
      `select ${OFFENCE_COLUMNS} from traffic_offences ${tail}`,
      params,
    );
    return rows.map((r) =>
      TrafficOffence.restore({
        id: r.id as string,
        vehicleId: r.vehicle_id as string,
        branchId: r.branch_id as string,
        driverId: r.driver_id as string | null,
        type: r.type as OffenceProps["type"],
        offenceAt: r.offence_at as Date,
        location: r.location as string | null,
        authority: r.authority as string,
        noticeRef: r.notice_ref as string | null,
        fineMinor: Number(r.fine_minor),
        dueOn: r.due_on as string | null,
        driverPays: r.driver_pays as boolean,
        status: r.status as OffenceProps["status"],
        paidOn: r.paid_on as string | null,
        paidBy: r.paid_by as OffenceProps["paidBy"],
        expenseId: r.expense_id as string | null,
        notes: r.notes as string | null,
        createdBy: r.created_by as string | null,
        createdAt: r.created_at as Date,
        updatedAt: r.updated_at as Date,
      }),
    );
  }
}

function incidentParams(p: IncidentProps): unknown[] {
  return [
    p.id,
    p.number,
    p.vehicleId,
    p.branchId,
    p.driverId,
    p.type,
    p.severity,
    p.status,
    p.occurredAt,
    p.location,
    p.description,
    p.injuries,
    p.policeReportNo,
    p.policeStation,
    JSON.stringify(p.thirdParties),
    p.issueId,
    p.damageId,
    p.vehicleStatus,
    p.statusBefore,
    p.closedAt,
    p.closedBy,
    p.outcome,
    p.createdBy,
    p.createdAt,
    p.updatedAt,
  ];
}

function claimParams(p: ClaimProps): unknown[] {
  return [
    p.id,
    p.incidentId,
    p.insurerId,
    p.policyNo,
    p.claimNo,
    p.status,
    p.claimedMinor,
    p.excessMinor,
    p.approvedMinor,
    p.settledMinor,
    p.settledOn,
    p.settlementMethod,
    p.settlementReference,
    p.submittedOn,
    p.decidedAt,
    p.reason,
    p.notes,
    p.createdBy,
    p.createdAt,
    p.updatedAt,
  ];
}

function offenceParams(p: OffenceProps): unknown[] {
  return [
    p.id,
    p.vehicleId,
    p.branchId,
    p.driverId,
    p.type,
    p.offenceAt,
    p.location,
    p.authority,
    p.noticeRef,
    p.fineMinor,
    p.dueOn,
    p.driverPays,
    p.status,
    p.paidOn,
    p.paidBy,
    p.expenseId,
    p.notes,
    p.createdBy,
    p.createdAt,
    p.updatedAt,
  ];
}

function anomaly(r: Row): FuelAnomalyRow {
  const num = (v: unknown) => (v === null ? null : Number(v));
  return {
    id: r.id as string,
    fuelLogId: r.fuel_log_id as string,
    vehicleId: r.vehicle_id as string,
    branchId: r.branch_id as string,
    driverId: r.driver_id as string | null,
    kind: r.kind as FuelAnomalyRow["kind"],
    kmPerLitre: num(r.km_per_litre),
    baseline: num(r.baseline),
    litres: Number(r.litres),
    distance: r.distance as number,
    status: r.status as FuelAnomalyRow["status"],
    reviewedBy: r.reviewed_by as string | null,
    reviewedAt: r.reviewed_at as Date | null,
    note: r.note as string | null,
    createdAt: r.created_at as Date,
  };
}
