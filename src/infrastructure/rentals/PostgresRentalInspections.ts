import type {
  DamageFilter,
  IRentalInspections,
  IVehicleDamages,
} from "../../application/ports/IRentalInspections.js";
import type { FuelLevel } from "../../domain/assignments/VehicleAssignment.js";
import type { ChargeAmount } from "../../domain/rentals/RentalBooking.js";
import type {
  InspectionItem,
  InspectionStage,
  PhotoView,
  RentalInspection,
} from "../../domain/rentals/RentalInspection.js";
import {
  VehicleDamage,
  type DamageArea,
  type DamageLiability,
  type DamageSeverity,
  type DamageStatus,
} from "../../domain/rentals/VehicleDamage.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InspectionRow = {
  id: string;
  booking_id: string;
  stage: InspectionStage;
  vehicle_id: string;
  odometer: number;
  fuel: FuelLevel;
  checklist: InspectionItem[];
  id_checked: boolean;
  notes: string | null;
  inspected_by: string | null;
  inspected_at: Date;
  photos: { fileId: string; view: PhotoView }[];
};

export class PostgresRentalInspections implements IRentalInspections {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async ofBooking(bookingId: string): Promise<RentalInspection[]> {
    if (!UUID.test(bookingId)) return [];
    const { rows } = await this.tx.query<InspectionRow>(
      `select i.*, coalesce((select jsonb_agg(jsonb_build_object('fileId', p.file_id, 'view', p.view)
                                  order by p.view, p.file_id)
                               from rental_inspection_photos p where p.inspection_id = i.id),
                             '[]'::jsonb) as photos
         from rental_inspections i where i.booking_id = $1
        order by case i.stage when 'check_out' then 0 else 1 end`,
      [bookingId],
    );
    return rows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      stage: r.stage,
      vehicleId: r.vehicle_id,
      odometer: r.odometer,
      fuel: r.fuel,
      checklist: r.checklist,
      idChecked: r.id_checked,
      photos: r.photos,
      notes: r.notes,
      inspectedBy: r.inspected_by,
      inspectedAt: r.inspected_at,
    }));
  }

  async insert(i: RentalInspection): Promise<void> {
    await this.tx.query(
      `insert into rental_inspections (id, booking_id, stage, vehicle_id, odometer, fuel, checklist,
         id_checked, notes, inspected_by, inspected_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        i.id,
        i.bookingId,
        i.stage,
        i.vehicleId,
        i.odometer,
        i.fuel,
        JSON.stringify(i.checklist),
        i.idChecked,
        i.notes,
        i.inspectedBy,
        i.inspectedAt,
      ],
    );
    if (i.photos.length > 0)
      await this.tx.query(
        `insert into rental_inspection_photos (inspection_id, file_id, view)
         select $1, p.file_id, p.view from unnest($2::uuid[], $3::text[]) as p (file_id, view)`,
        [i.id, i.photos.map((p) => p.fileId), i.photos.map((p) => p.view)],
      );
  }

  async usedFiles(fileIds: readonly string[]): Promise<string[]> {
    if (fileIds.length === 0) return [];
    const { rows } = await this.tx.query<{ file_id: string }>(
      `select file_id from rental_inspection_photos where file_id = any($1::uuid[])
       union select file_id from vehicle_damage_photos where file_id = any($1::uuid[])`,
      [fileIds],
    );
    return rows.map((r) => r.file_id);
  }
}

type DamageRow = {
  id: string;
  vehicle_id: string;
  branch_id: string;
  booking_id: string | null;
  inspection_id: string | null;
  stage: InspectionStage | null;
  area: DamageArea;
  severity: DamageSeverity;
  description: string;
  status: DamageStatus;
  liability: DamageLiability;
  currency: string;
  estimate_minor: string | null;
  final_minor: string | null;
  work_order_ref: string | null;
  claim_ref: string | null;
  notes: string | null;
  photo_ids: string[];
  repaired_at: Date | null;
  repaired_by: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

const DAMAGES = `select d.*, i.stage,
    coalesce((select array_agg(p.file_id order by p.file_id) from vehicle_damage_photos p
               where p.damage_id = d.id), '{}') as photo_ids
  from vehicle_damages d left join rental_inspections i on i.id = d.inspection_id`;

const minor = (value: string | null) => (value === null ? null : Number(value));

const toDamage = (r: DamageRow): VehicleDamage =>
  VehicleDamage.restore({
    id: r.id,
    vehicleId: r.vehicle_id,
    branchId: r.branch_id,
    bookingId: r.booking_id,
    inspectionId: r.inspection_id,
    foundAt: r.stage,
    area: r.area,
    severity: r.severity,
    description: r.description,
    status: r.status,
    liability: r.liability,
    currency: r.currency,
    estimateMinor: minor(r.estimate_minor),
    finalMinor: minor(r.final_minor),
    workOrderRef: r.work_order_ref,
    claimRef: r.claim_ref,
    notes: r.notes,
    photoIds: r.photo_ids,
    repairedAt: r.repaired_at,
    repairedBy: r.repaired_by,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

export class PostgresVehicleDamages implements IVehicleDamages {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async get(id: string): Promise<VehicleDamage | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<DamageRow>(`${DAMAGES} where d.id = $1`, [id]);
    return rows[0] === undefined ? null : toDamage(rows[0]);
  }

  async lock(id: string): Promise<VehicleDamage | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<DamageRow>(`${DAMAGES} where d.id = $1 for update of d`, [
      id,
    ]);
    return rows[0] === undefined ? null : toDamage(rows[0]);
  }

  async list(filter: DamageFilter): Promise<VehicleDamage[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.branchIds !== "all") add("d.branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.vehicleId !== undefined) add("d.vehicle_id = ?", filter.vehicleId);
    if (filter.bookingId !== undefined) add("d.booking_id = ?", filter.bookingId);
    if (filter.statuses !== undefined) add("d.status = any(?::text[])", filter.statuses);
    params.push(filter.limit);
    const { rows } = await this.tx.query<DamageRow>(
      `${DAMAGES} ${where.length === 0 ? "" : `where ${where.join(" and ")}`}
        order by d.id desc limit $${params.length}`,
      params,
    );
    return rows.map(toDamage);
  }

  async insert(damage: VehicleDamage): Promise<void> {
    const d = damage.snapshot();
    await this.tx.query(
      `insert into vehicle_damages (id, vehicle_id, branch_id, booking_id, inspection_id, area,
         severity, description, status, liability, currency, estimate_minor, final_minor,
         work_order_ref, claim_ref, notes, repaired_at, repaired_by, created_by, created_at,
         updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20, $20)`,
      [
        d.id,
        d.vehicleId,
        d.branchId,
        d.bookingId,
        d.inspectionId,
        d.area,
        d.severity,
        d.description,
        d.status,
        d.liability,
        d.currency,
        d.estimateMinor,
        d.finalMinor,
        d.workOrderRef,
        d.claimRef,
        d.notes,
        d.repairedAt,
        d.repairedBy,
        d.createdBy,
        d.createdAt,
      ],
    );
    await this.savePhotos(d.id, d.photoIds);
  }

  async update(damage: VehicleDamage): Promise<void> {
    const d = damage.snapshot();
    await this.tx.query(
      `update vehicle_damages set severity = $2, description = $3, status = $4, liability = $5,
         estimate_minor = $6, final_minor = $7, work_order_ref = $8, claim_ref = $9, notes = $10,
         repaired_at = $11, repaired_by = $12, updated_at = $13
       where id = $1`,
      [
        d.id,
        d.severity,
        d.description,
        d.status,
        d.liability,
        d.estimateMinor,
        d.finalMinor,
        d.workOrderRef,
        d.claimRef,
        d.notes,
        d.repairedAt,
        d.repairedBy,
        d.updatedAt,
      ],
    );
    await this.savePhotos(d.id, d.photoIds);
  }

  async charged(damageId: string): Promise<ChargeAmount> {
    const { rows } = await this.tx.query<{ net: string; tax: string; total: string }>(
      `select coalesce(sum(net_minor), 0) as net, coalesce(sum(tax_minor), 0) as tax,
              coalesce(sum(total_minor), 0) as total
         from rental_booking_charges where damage_id = $1`,
      [damageId],
    );
    const r = rows[0]!;
    return { netMinor: Number(r.net), taxMinor: Number(r.tax), totalMinor: Number(r.total) };
  }

  /** Photos are only added. */
  private async savePhotos(damageId: string, fileIds: readonly string[]): Promise<void> {
    if (fileIds.length === 0) return;
    await this.tx.query(
      `insert into vehicle_damage_photos (damage_id, file_id)
       select $1, f from unnest($2::uuid[]) as f on conflict do nothing`,
      [damageId, fileIds],
    );
  }
}
