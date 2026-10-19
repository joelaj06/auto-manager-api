import { AssignmentConflictError } from "../../application/errors/AssignmentErrors.js";
import {
  DEFAULT_ASSIGNMENT_SETTINGS,
  type AssignmentListFilter,
  type AssignmentRecord,
  type AssignmentSettings,
  type IAssignmentQueries,
  type IAssignmentSettingsStore,
} from "../../application/ports/IAssignmentRecords.js";
import {
  VehicleAssignment,
  type HandoverChecklist,
  type VehicleAssignmentProps,
} from "../../domain/assignments/VehicleAssignment.js";
import type { IAssignmentRepository } from "../../domain/repositories/IAssignmentRepository.js";
import { PgErrorCodes, pgErrorCode } from "../database/postgres/pgErrors.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AssignmentRow = {
  id: string;
  vehicle_id: string;
  driver_id: string;
  branch_id: string;
  type: VehicleAssignmentProps["type"];
  remittance_mode: VehicleAssignmentProps["terms"]["mode"];
  target_minor: string | null;
  target_frequency: VehicleAssignmentProps["terms"]["frequency"];
  days_off: number[];
  started_at: Date;
  start_odometer: number;
  start_checklist: HandoverChecklist;
  started_by: string | null;
  ended_at: Date | null;
  end_odometer: number | null;
  end_checklist: HandoverChecklist | null;
  end_reason: string | null;
  ended_by: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};

type RecordRow = AssignmentRow & {
  vehicle_code: string;
  plate_number: string | null;
  make: string;
  model: string;
  driver_code: string;
  driver_name: string;
  driver_phone: string;
};

const COLUMNS = `a.id, a.vehicle_id, a.driver_id, a.branch_id, a.type, a.remittance_mode,
  a.target_minor, a.target_frequency, a.days_off, a.started_at, a.start_odometer,
  a.start_checklist, a.started_by, a.ended_at, a.end_odometer, a.end_checklist, a.end_reason,
  a.ended_by, a.notes, a.created_at, a.updated_at`;

const RECORD_SELECT = `select ${COLUMNS}, v.code as vehicle_code, v.plate_number, v.make, v.model,
    d.code as driver_code, d.first_name || ' ' || d.last_name as driver_name,
    d.phone as driver_phone
   from vehicle_assignments a
   join vehicles v on v.id = a.vehicle_id
   join drivers d on d.id = a.driver_id`;

const toProps = (r: AssignmentRow): VehicleAssignmentProps => ({
  id: r.id,
  vehicleId: r.vehicle_id,
  driverId: r.driver_id,
  branchId: r.branch_id,
  type: r.type,
  terms: {
    mode: r.remittance_mode,
    targetMinor: r.target_minor === null ? null : Number(r.target_minor),
    frequency: r.target_frequency,
    daysOff: r.days_off,
  },
  startedAt: r.started_at,
  startOdometer: r.start_odometer,
  startChecklist: r.start_checklist,
  startedBy: r.started_by,
  endedAt: r.ended_at,
  endOdometer: r.end_odometer,
  endChecklist: r.end_checklist,
  endReason: r.end_reason,
  endedBy: r.ended_by,
  notes: r.notes,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRecord = (r: RecordRow): AssignmentRecord => ({
  ...toProps(r),
  vehicle: {
    id: r.vehicle_id,
    code: r.vehicle_code,
    plateNumber: r.plate_number,
    make: r.make,
    model: r.model,
  },
  driver: { id: r.driver_id, code: r.driver_code, name: r.driver_name, phone: r.driver_phone },
});

/** Vehicle assignments in the tenant database (tenant unit of work). */
export class PostgresAssignmentRepository implements IAssignmentRepository, IAssignmentQueries {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async findById(id: string): Promise<VehicleAssignment | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<AssignmentRow>(
      `select ${COLUMNS} from vehicle_assignments a where a.id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : VehicleAssignment.restore(toProps(rows[0]));
  }

  async lockOpenForVehicle(vehicleId: string): Promise<VehicleAssignment | null> {
    const { rows } = await this.tx.query<AssignmentRow>(
      `select ${COLUMNS} from vehicle_assignments a
        where a.vehicle_id = $1 and a.ended_at is null for update`,
      [vehicleId],
    );
    return rows[0] === undefined ? null : VehicleAssignment.restore(toProps(rows[0]));
  }

  async save(assignment: VehicleAssignment): Promise<void> {
    const p = assignment.snapshot();
    try {
      // A savepoint keeps the unit of work usable when the database refuses the row.
      await this.tx.query("savepoint assignment_save");
      await this.tx.query(
        `insert into vehicle_assignments (id, vehicle_id, driver_id, branch_id, type,
           remittance_mode, target_minor, target_frequency, days_off, started_at, start_odometer,
           start_checklist, started_by, ended_at, end_odometer, end_checklist, end_reason,
           ended_by, notes, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
           $19, $20, $21)
         on conflict (id) do update set remittance_mode = excluded.remittance_mode,
           target_minor = excluded.target_minor, target_frequency = excluded.target_frequency,
           days_off = excluded.days_off, ended_at = excluded.ended_at,
           end_odometer = excluded.end_odometer, end_checklist = excluded.end_checklist,
           end_reason = excluded.end_reason, ended_by = excluded.ended_by,
           notes = excluded.notes, updated_at = excluded.updated_at`,
        [
          p.id,
          p.vehicleId,
          p.driverId,
          p.branchId,
          p.type,
          p.terms.mode,
          p.terms.targetMinor,
          p.terms.frequency,
          p.terms.daysOff,
          p.startedAt,
          p.startOdometer,
          JSON.stringify(p.startChecklist),
          p.startedBy,
          p.endedAt,
          p.endOdometer,
          p.endChecklist === null ? null : JSON.stringify(p.endChecklist),
          p.endReason,
          p.endedBy,
          p.notes,
          p.createdAt,
          p.updatedAt,
        ],
      );
      await this.tx.query("release savepoint assignment_save");
    } catch (error) {
      const code = pgErrorCode(error);
      if (code !== PgErrorCodes.uniqueViolation && code !== PgErrorCodes.exclusionViolation)
        throw error;
      await this.tx.query("rollback to savepoint assignment_save");
      const which = String((error as { constraint?: string }).constraint ?? "");
      throw new AssignmentConflictError(
        which.includes("driver")
          ? "The driver already has a vehicle at that time"
          : "The vehicle already has a driver at that time",
      );
    }
  }

  async get(id: string): Promise<AssignmentRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<RecordRow>(`${RECORD_SELECT} where a.id = $1`, [id]);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async openForVehicle(vehicleId: string): Promise<AssignmentRecord | null> {
    const { rows } = await this.tx.query<RecordRow>(
      `${RECORD_SELECT} where a.vehicle_id = $1 and a.ended_at is null`,
      [vehicleId],
    );
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async openForDriver(driverId: string): Promise<AssignmentRecord | null> {
    const { rows } = await this.tx.query<RecordRow>(
      `${RECORD_SELECT} where a.driver_id = $1 and a.ended_at is null`,
      [driverId],
    );
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async at(vehicleId: string, instant: Date): Promise<AssignmentRecord | null> {
    const { rows } = await this.tx.query<RecordRow>(
      `${RECORD_SELECT}
        where a.vehicle_id = $1 and tstzrange(a.started_at, a.ended_at, '[)') @> $2::timestamptz`,
      [vehicleId, instant],
    );
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async list(filter: AssignmentListFilter): Promise<AssignmentRecord[]> {
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ["v.deleted_at is null"];
    if (filter.branchIds !== "all")
      where.push(`v.branch_id = any(${param(filter.branchIds)}::uuid[])`);
    if (filter.branchId !== undefined) where.push(`v.branch_id = ${param(filter.branchId)}`);
    if (filter.vehicleId !== undefined) where.push(`a.vehicle_id = ${param(filter.vehicleId)}`);
    if (filter.driverId !== undefined) where.push(`a.driver_id = ${param(filter.driverId)}`);
    if (filter.open === true) where.push("a.ended_at is null");
    if (filter.open === false) where.push("a.ended_at is not null");
    if (filter.after !== undefined)
      where.push(
        `(a.started_at, a.id) < (${param(filter.after.startedAt)}::timestamptz, ${param(filter.after.id)}::uuid)`,
      );
    const { rows } = await this.tx.query<RecordRow>(
      `${RECORD_SELECT} where ${where.join(" and ")}
        order by a.started_at desc, a.id desc limit ${param(filter.limit)}`,
      params,
    );
    return rows.map(toRecord);
  }
}

/** Assignment settings in `organisation.settings->'assignments'`, over the defaults. */
export class PostgresAssignmentSettingsStore implements IAssignmentSettingsStore {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async get(): Promise<AssignmentSettings> {
    const { rows } = await this.transactions
      .current()
      .query<{ assignments: Partial<AssignmentSettings> | null }>(
        "select settings->'assignments' as assignments from organisation",
      );
    return { ...DEFAULT_ASSIGNMENT_SETTINGS, ...(rows[0]?.assignments ?? {}) };
  }

  async set(settings: AssignmentSettings): Promise<void> {
    await this.transactions
      .current()
      .query(
        "update organisation set settings = jsonb_set(settings, '{assignments}', $1::jsonb), updated_at = now()",
        [JSON.stringify(settings)],
      );
  }
}
