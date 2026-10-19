import type {
  IVehicleQueries,
  StatusHistoryEntry,
  TimelineEntry,
  VehicleListFilter,
} from "../../application/ports/IVehicleRecords.js";
import type { IVehicleRepository } from "../../domain/repositories/IVehicleRepository.js";
import { Vehicle, type StatusChange, type VehicleProps } from "../../domain/vehicles/Vehicle.js";
import { PlateNumber } from "../../domain/vehicles/VehicleIdentifiers.js";
import { OFF_FLEET_STATUSES, type VehicleStatus } from "../../domain/vehicles/VehicleStatus.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFF_FLEET = [...OFF_FLEET_STATUSES];

type VehicleRow = {
  id: string;
  code: string;
  plate_number: string | null;
  plate_key: string | null;
  vin: string | null;
  engine_number: string | null;
  chassis_number: string | null;
  make_id: string | null;
  make: string;
  model_id: string | null;
  model: string;
  trim: string | null;
  year: number | null;
  colour: string | null;
  body_type: VehicleProps["bodyType"];
  fuel_type: VehicleProps["fuelType"];
  transmission: VehicleProps["transmission"];
  engine_cc: number | null;
  seats: number | null;
  doors: number | null;
  drive: VehicleProps["drive"];
  mileage_unit: VehicleProps["mileageUnit"];
  current_odometer: number | null;
  odometer_read_at: Date | null;
  status: VehicleStatus;
  status_changed_at: Date;
  usage: VehicleProps["usage"];
  ownership_type: VehicleProps["ownershipType"];
  ownership_note: string | null;
  branch_id: string;
  acquisition_date: string | null;
  acquisition_cost_minor: string | null;
  residual_value_minor: string | null;
  depreciation_method: VehicleProps["depreciationMethod"];
  useful_life_months: number | null;
  primary_photo_file_id: string | null;
  tags: string[];
  specs: Record<string, string | number>;
  custom_fields: VehicleProps["customFields"];
  notes: string | null;
  group_ids: string[];
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_reason: string | null;
};

const COLUMNS = `v.id, v.code, v.plate_number, v.plate_key, v.vin, v.engine_number, v.chassis_number,
  v.make_id, v.make, v.model_id, v.model, v.trim, v.year, v.colour, v.body_type, v.fuel_type,
  v.transmission, v.engine_cc, v.seats, v.doors, v.drive, v.mileage_unit, v.current_odometer,
  v.odometer_read_at, v.status, v.status_changed_at, v.usage, v.ownership_type, v.ownership_note,
  v.branch_id, v.acquisition_date::text as acquisition_date, v.acquisition_cost_minor,
  v.residual_value_minor, v.depreciation_method, v.useful_life_months, v.primary_photo_file_id,
  v.tags, v.specs, v.custom_fields, v.notes, v.created_by, v.created_at, v.updated_at,
  v.deleted_at, v.deleted_reason,
  coalesce((select array_agg(m.group_id order by m.group_id) from vehicle_group_members m
             where m.vehicle_id = v.id), '{}') as group_ids`;

const minor = (value: string | null) => (value === null ? null : Number(value));

export const toVehicleProps = (r: VehicleRow): VehicleProps => ({
  id: r.id,
  code: r.code,
  plateNumber: r.plate_number,
  plateKey: r.plate_key,
  vin: r.vin,
  engineNumber: r.engine_number,
  chassisNumber: r.chassis_number,
  makeId: r.make_id,
  make: r.make,
  modelId: r.model_id,
  model: r.model,
  trim: r.trim,
  year: r.year,
  colour: r.colour,
  bodyType: r.body_type,
  fuelType: r.fuel_type,
  transmission: r.transmission,
  engineCc: r.engine_cc,
  seats: r.seats,
  doors: r.doors,
  drive: r.drive,
  mileageUnit: r.mileage_unit,
  currentOdometer: r.current_odometer,
  odometerReadAt: r.odometer_read_at,
  status: r.status,
  statusChangedAt: r.status_changed_at,
  usage: r.usage,
  ownershipType: r.ownership_type,
  ownershipNote: r.ownership_note,
  branchId: r.branch_id,
  acquisitionDate: r.acquisition_date,
  acquisitionCostMinor: minor(r.acquisition_cost_minor),
  residualValueMinor: minor(r.residual_value_minor),
  depreciationMethod: r.depreciation_method,
  usefulLifeMonths: r.useful_life_months,
  primaryPhotoFileId: r.primary_photo_file_id,
  tags: r.tags,
  specs: r.specs,
  customFields: r.custom_fields,
  notes: r.notes,
  groupIds: r.group_ids,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  deletedReason: r.deleted_reason,
});

/** The vehicle register in the tenant database (tenant unit of work). */
export class PostgresVehicleRepository implements IVehicleRepository, IVehicleQueries {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async findById(id: string): Promise<Vehicle | null> {
    return this.one(id, "");
  }

  async lockById(id: string): Promise<Vehicle | null> {
    return this.one(id, "for update of v");
  }

  private async one(id: string, lock: string): Promise<Vehicle | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<VehicleRow>(
      `select ${COLUMNS} from vehicles v where v.id = $1 and v.deleted_at is null ${lock}`,
      [id],
    );
    return rows[0] === undefined ? null : Vehicle.restore(toVehicleProps(rows[0]));
  }

  async save(vehicle: Vehicle): Promise<void> {
    const p = vehicle.snapshot();
    await this.tx.query(
      `insert into vehicles (id, code, plate_number, plate_key, vin, engine_number, chassis_number,
         make_id, make, model_id, model, trim, year, colour, body_type, fuel_type, transmission,
         engine_cc, seats, doors, drive, mileage_unit, current_odometer, odometer_read_at, status,
         status_changed_at, usage, ownership_type, ownership_note, branch_id, acquisition_date,
         acquisition_cost_minor, residual_value_minor, depreciation_method, useful_life_months,
         primary_photo_file_id, tags, specs, custom_fields, notes, created_by, created_at,
         updated_at, deleted_at, deleted_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36,
         $37, $38, $39, $40, $41, $42, $43, $44, $45)
       on conflict (id) do update set
         plate_number = excluded.plate_number, plate_key = excluded.plate_key, vin = excluded.vin,
         engine_number = excluded.engine_number, chassis_number = excluded.chassis_number,
         make_id = excluded.make_id, make = excluded.make, model_id = excluded.model_id,
         model = excluded.model, trim = excluded.trim, year = excluded.year,
         colour = excluded.colour, body_type = excluded.body_type, fuel_type = excluded.fuel_type,
         transmission = excluded.transmission, engine_cc = excluded.engine_cc,
         seats = excluded.seats, doors = excluded.doors, drive = excluded.drive,
         mileage_unit = excluded.mileage_unit, current_odometer = excluded.current_odometer,
         odometer_read_at = excluded.odometer_read_at, status = excluded.status,
         status_changed_at = excluded.status_changed_at, usage = excluded.usage,
         ownership_type = excluded.ownership_type, ownership_note = excluded.ownership_note,
         branch_id = excluded.branch_id, acquisition_date = excluded.acquisition_date,
         acquisition_cost_minor = excluded.acquisition_cost_minor,
         residual_value_minor = excluded.residual_value_minor,
         depreciation_method = excluded.depreciation_method,
         useful_life_months = excluded.useful_life_months,
         primary_photo_file_id = excluded.primary_photo_file_id, tags = excluded.tags,
         specs = excluded.specs, custom_fields = excluded.custom_fields, notes = excluded.notes,
         updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
         deleted_reason = excluded.deleted_reason`,
      [
        p.id,
        p.code,
        p.plateNumber,
        p.plateKey,
        p.vin,
        p.engineNumber,
        p.chassisNumber,
        p.makeId,
        p.make,
        p.modelId,
        p.model,
        p.trim,
        p.year,
        p.colour,
        p.bodyType,
        p.fuelType,
        p.transmission,
        p.engineCc,
        p.seats,
        p.doors,
        p.drive,
        p.mileageUnit,
        p.currentOdometer,
        p.odometerReadAt,
        p.status,
        p.statusChangedAt,
        p.usage,
        p.ownershipType,
        p.ownershipNote,
        p.branchId,
        p.acquisitionDate,
        p.acquisitionCostMinor,
        p.residualValueMinor,
        p.depreciationMethod,
        p.usefulLifeMonths,
        p.primaryPhotoFileId,
        p.tags,
        JSON.stringify(p.specs),
        JSON.stringify(p.customFields),
        p.notes,
        p.createdBy,
        p.createdAt,
        p.updatedAt,
        p.deletedAt,
        p.deletedReason,
      ],
    );
    await this.tx.query(
      "delete from vehicle_group_members where vehicle_id = $1 and not (group_id = any($2::uuid[]))",
      [p.id, p.groupIds],
    );
    if (p.groupIds.length > 0)
      await this.tx.query(
        `insert into vehicle_group_members (vehicle_id, group_id)
         select $1, unnest($2::uuid[]) on conflict do nothing`,
        [p.id, p.groupIds],
      );
  }

  async plateTaken(plateKey: string, exceptId: string | null): Promise<boolean> {
    const { rows } = await this.tx.query(
      `select 1 from vehicles where plate_key = $1 and deleted_at is null
          and ($2::uuid is null or id <> $2)`,
      [plateKey, exceptId],
    );
    return rows.length > 0;
  }

  async vinTaken(vin: string, exceptId: string | null): Promise<boolean> {
    const { rows } = await this.tx.query(
      `select 1 from vehicles where vin = $1 and deleted_at is null
          and ($2::uuid is null or id <> $2)`,
      [vin, exceptId],
    );
    return rows.length > 0;
  }

  async recordStatusChange(
    vehicleId: string,
    change: StatusChange,
    changedBy: string | null,
    at: Date,
  ): Promise<void> {
    await this.tx.query(
      `insert into vehicle_status_history
         (vehicle_id, from_status, to_status, reason, ref_type, ref_id, changed_by, changed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        vehicleId,
        change.from,
        change.to,
        change.reason,
        change.ref?.type ?? null,
        change.ref?.id ?? null,
        changedBy,
        at,
      ],
    );
  }

  async list(filter: VehicleListFilter): Promise<VehicleProps[]> {
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ["v.deleted_at is null", "b.status = 'active'"];
    if (filter.branchIds !== "all")
      where.push(`v.branch_id = any(${param(filter.branchIds)}::uuid[])`);
    if (filter.branchId !== undefined) where.push(`v.branch_id = ${param(filter.branchId)}`);
    if (filter.statuses !== undefined)
      where.push(`v.status = any(${param(filter.statuses)}::text[])`);
    else if (filter.includeOffFleet !== true)
      where.push(`v.status <> all(${param(OFF_FLEET)}::text[])`);
    if (filter.usage !== undefined) where.push(`v.usage = ${param(filter.usage)}`);
    if (filter.makeId !== undefined) where.push(`v.make_id = ${param(filter.makeId)}`);
    if (filter.tag !== undefined) where.push(`${param(filter.tag.toLowerCase())} = any(v.tags)`);
    if (filter.groupId !== undefined)
      where.push(
        `exists (select 1 from vehicle_group_members m where m.vehicle_id = v.id and m.group_id = ${param(filter.groupId)})`,
      );
    if (filter.search !== undefined && filter.search.trim() !== "") {
      const text = param(filter.search.trim().toLowerCase());
      const key = PlateNumber.keyOf(filter.search);
      where.push(
        `(${key === "" ? "false" : `strpos(v.plate_key, ${param(key)}) > 0`}
          or lower(v.code) = ${text} or v.vin = upper(${text})
          or strpos(lower(v.make || ' ' || v.model), ${text}) > 0)`,
      );
    }
    if (filter.after !== undefined)
      where.push(
        `(v.created_at, v.id) < (${param(filter.after.createdAt)}::timestamptz, ${param(filter.after.id)}::uuid)`,
      );
    const { rows } = await this.tx.query<VehicleRow>(
      `select ${COLUMNS} from vehicles v join branches b on b.id = v.branch_id
        where ${where.join(" and ")}
        order by v.created_at desc, v.id desc
        limit ${param(filter.limit)}`,
      params,
    );
    return rows.map(toVehicleProps);
  }

  async statusHistory(vehicleId: string, limit: number): Promise<StatusHistoryEntry[]> {
    const { rows } = await this.tx.query<{
      id: string;
      from_status: VehicleStatus | null;
      to_status: VehicleStatus;
      reason: string | null;
      ref_type: string | null;
      ref_id: string | null;
      changed_by: string | null;
      changed_at: Date;
    }>(
      `select id, from_status, to_status, reason, ref_type, ref_id, changed_by, changed_at
         from vehicle_status_history where vehicle_id = $1
        order by changed_at desc, id desc limit $2`,
      [vehicleId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      from: r.from_status,
      to: r.to_status,
      reason: r.reason,
      ref: r.ref_type === null || r.ref_id === null ? null : { type: r.ref_type, id: r.ref_id },
      changedBy: r.changed_by,
      changedAt: r.changed_at,
    }));
  }

  async timeline(vehicleId: string, before: Date | null, limit: number): Promise<TimelineEntry[]> {
    const { rows } = await this.tx.query<{
      id: string;
      at: Date;
      kind: TimelineEntry["kind"];
      actor_id: string | null;
      data: Record<string, unknown>;
    }>(
      `select * from (
         select id, changed_at as at, 'status' as kind, changed_by as actor_id,
                jsonb_build_object('from', from_status, 'to', to_status, 'reason', reason,
                                   'refType', ref_type, 'refId', ref_id) as data
           from vehicle_status_history where vehicle_id = $1
         union all
         select id, created_at, 'document', created_by,
                jsonb_build_object('documentId', id, 'type', type, 'number', number,
                                   'expiresOn', expires_on)
           from vehicle_documents where vehicle_id = $1
         union all
         select id, read_at, 'odometer', recorded_by,
                jsonb_build_object('value', value, 'source', source, 'replacement', replacement,
                                   'note', note)
           from odometer_readings where vehicle_id = $1
       ) t
       where ($2::timestamptz is null or at < $2)
       order by at desc, id desc
       limit $3`,
      [vehicleId, before, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      kind: r.kind,
      actorId: r.actor_id,
      data: r.data,
    }));
  }

  async countInBranch(branchId: string): Promise<number> {
    const { rows } = await this.tx.query<{ count: string }>(
      `select count(*) from vehicles
        where branch_id = $1 and deleted_at is null and status <> all($2::text[])`,
      [branchId, OFF_FLEET],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async distanceBetween(vehicleId: string, from: Date, to: Date): Promise<number | null> {
    const { rows } = await this.tx.query<{
      distance: number | null;
      replaced: boolean;
      inside: string;
    }>(
      `with r as (select value, read_at, replacement from odometer_readings
                   where vehicle_id = $1 and read_at <= $3)
       select (select value from r order by read_at desc limit 1)
              - coalesce((select value from r where read_at <= $2 order by read_at desc limit 1),
                         (select value from r where read_at > $2 order by read_at limit 1))
                as distance,
              exists (select 1 from r where read_at > $2 and replacement) as replaced,
              (select count(*) from r where read_at > $2) as inside`,
      [vehicleId, from, to],
    );
    const row = rows[0];
    if (row === undefined || row.replaced || Number(row.inside) === 0) return null;
    return row.distance;
  }
}
