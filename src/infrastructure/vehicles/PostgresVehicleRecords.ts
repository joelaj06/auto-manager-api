import {
  DEFAULT_VEHICLE_SETTINGS,
  type IOdometerReadings,
  type IVehicleDocuments,
  type IVehicleGroups,
  type IVehicleSettingsStore,
  type VehicleDocument,
  type VehicleGroup,
  type VehicleSettings,
} from "../../application/ports/IVehicleRecords.js";
import type { OdometerReadingProps } from "../../domain/vehicles/OdometerReading.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DocumentRow = {
  id: string;
  vehicle_id: string;
  type: VehicleDocument["type"];
  title: string | null;
  number: string | null;
  provider: string | null;
  issued_on: string | null;
  expires_on: string | null;
  cost_minor: string | null;
  reminder_days: number[];
  notes: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};
const DOCUMENT_COLUMNS = `id, vehicle_id, type, title, number, provider, issued_on::text as issued_on,
  expires_on::text as expires_on, cost_minor, reminder_days, notes, created_by, created_at, updated_at`;
const toDocument = (r: DocumentRow): VehicleDocument => ({
  id: r.id,
  vehicleId: r.vehicle_id,
  type: r.type,
  title: r.title,
  number: r.number,
  provider: r.provider,
  issuedOn: r.issued_on,
  expiresOn: r.expires_on,
  costMinor: r.cost_minor === null ? null : Number(r.cost_minor),
  reminderDays: r.reminder_days,
  notes: r.notes,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Vehicle documents in the tenant database. */
export class PostgresVehicleDocuments implements IVehicleDocuments {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async list(vehicleId: string): Promise<VehicleDocument[]> {
    const { rows } = await this.tx.query<DocumentRow>(
      `select ${DOCUMENT_COLUMNS} from vehicle_documents where vehicle_id = $1
        order by type, expires_on desc nulls first, created_at desc`,
      [vehicleId],
    );
    return rows.map(toDocument);
  }

  async forVehicles(vehicleIds: readonly string[]): Promise<VehicleDocument[]> {
    if (vehicleIds.length === 0) return [];
    const { rows } = await this.tx.query<DocumentRow>(
      `select ${DOCUMENT_COLUMNS} from vehicle_documents where vehicle_id = any($1::uuid[])`,
      [vehicleIds],
    );
    return rows.map(toDocument);
  }

  async get(id: string): Promise<VehicleDocument | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<DocumentRow>(
      `select ${DOCUMENT_COLUMNS} from vehicle_documents where id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : toDocument(rows[0]);
  }

  async save(d: VehicleDocument): Promise<void> {
    await this.tx.query(
      `insert into vehicle_documents (id, vehicle_id, type, title, number, provider, issued_on,
         expires_on, cost_minor, reminder_days, notes, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (id) do update set title = excluded.title, number = excluded.number,
         provider = excluded.provider, issued_on = excluded.issued_on,
         expires_on = excluded.expires_on, cost_minor = excluded.cost_minor,
         reminder_days = excluded.reminder_days, notes = excluded.notes,
         updated_at = excluded.updated_at`,
      [
        d.id,
        d.vehicleId,
        d.type,
        d.title,
        d.number,
        d.provider,
        d.issuedOn,
        d.expiresOn,
        d.costMinor,
        d.reminderDays,
        d.notes,
        d.createdBy,
        d.createdAt,
        d.updatedAt,
      ],
    );
  }

  async remove(id: string): Promise<void> {
    await this.tx.query("delete from vehicle_documents where id = $1", [id]);
  }
}

type ReadingRow = {
  id: string;
  vehicle_id: string;
  value: number;
  read_at: Date;
  source: OdometerReadingProps["source"];
  ref_id: string | null;
  replacement: boolean;
  note: string | null;
  recorded_by: string | null;
  created_at: Date;
};
const READING_COLUMNS =
  "id, vehicle_id, value, read_at, source, ref_id, replacement, note, recorded_by, created_at";
const toReading = (r: ReadingRow): OdometerReadingProps => ({
  id: r.id,
  vehicleId: r.vehicle_id,
  value: r.value,
  readAt: r.read_at,
  source: r.source,
  refId: r.ref_id,
  replacement: r.replacement,
  note: r.note,
  recordedBy: r.recorded_by,
  createdAt: r.created_at,
});

/** Odometer readings in the tenant database. */
export class PostgresOdometerReadings implements IOdometerReadings {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async neighbours(vehicleId: string, at: Date) {
    const before = await this.tx.query<ReadingRow>(
      `select ${READING_COLUMNS} from odometer_readings where vehicle_id = $1 and read_at <= $2
        order by read_at desc, created_at desc limit 1`,
      [vehicleId, at],
    );
    const after = await this.tx.query<ReadingRow>(
      `select ${READING_COLUMNS} from odometer_readings where vehicle_id = $1 and read_at > $2
        order by read_at, created_at limit 1`,
      [vehicleId, at],
    );
    return {
      before: before.rows[0] === undefined ? null : toReading(before.rows[0]),
      after: after.rows[0] === undefined ? null : toReading(after.rows[0]),
    };
  }

  async add(r: OdometerReadingProps): Promise<void> {
    await this.tx.query(
      `insert into odometer_readings (${READING_COLUMNS})
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        r.id,
        r.vehicleId,
        r.value,
        r.readAt,
        r.source,
        r.refId,
        r.replacement,
        r.note,
        r.recordedBy,
        r.createdAt,
      ],
    );
  }

  async list(vehicleId: string, limit: number): Promise<OdometerReadingProps[]> {
    const { rows } = await this.tx.query<ReadingRow>(
      `select ${READING_COLUMNS} from odometer_readings where vehicle_id = $1
        order by read_at desc, created_at desc limit $2`,
      [vehicleId, limit],
    );
    return rows.map(toReading);
  }
}

type GroupRow = {
  id: string;
  name: string;
  description: string | null;
  vehicle_count: string;
  created_at: Date;
};
/** Members still on the register (removed vehicles do not count). */
const GROUP_SELECT = `select g.id, g.name::text as name, g.description, g.created_at,
    (select count(*) from vehicle_group_members m join vehicles v on v.id = m.vehicle_id
      where m.group_id = g.id and v.deleted_at is null) as vehicle_count
   from vehicle_groups g`;
const toGroup = (r: GroupRow): VehicleGroup => ({
  id: r.id,
  name: r.name,
  description: r.description,
  vehicleCount: Number(r.vehicle_count),
  createdAt: r.created_at,
});

/** Vehicle groups in the tenant database. */
export class PostgresVehicleGroups implements IVehicleGroups {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async list(): Promise<VehicleGroup[]> {
    const { rows } = await this.tx.query<GroupRow>(`${GROUP_SELECT} order by g.name`);
    return rows.map(toGroup);
  }

  async get(id: string): Promise<VehicleGroup | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<GroupRow>(`${GROUP_SELECT} where g.id = $1`, [id]);
    return rows[0] === undefined ? null : toGroup(rows[0]);
  }

  async nameTaken(name: string, exceptId: string | null): Promise<boolean> {
    const { rows } = await this.tx.query(
      "select 1 from vehicle_groups where name = $1 and ($2::uuid is null or id <> $2)",
      [name, exceptId],
    );
    return rows.length > 0;
  }

  async save(group: Readonly<{ id: string; name: string; description: string | null }>) {
    await this.tx.query(
      `insert into vehicle_groups (id, name, description) values ($1, $2, $3)
       on conflict (id) do update set name = excluded.name, description = excluded.description,
         updated_at = now()`,
      [group.id, group.name, group.description],
    );
  }

  async remove(id: string): Promise<void> {
    await this.tx.query("delete from vehicle_groups where id = $1", [id]);
  }

  async existing(ids: readonly string[]): Promise<string[]> {
    if (ids.some((id) => !UUID.test(id))) return [];
    const { rows } = await this.tx.query<{ id: string }>(
      "select id from vehicle_groups where id = any($1::uuid[])",
      [ids],
    );
    return rows.map((r) => r.id);
  }
}

/** Vehicle settings in `organisation.settings->'vehicles'`, over the defaults. */
export class PostgresVehicleSettingsStore implements IVehicleSettingsStore {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async get(): Promise<VehicleSettings> {
    const { rows } = await this.transactions
      .current()
      .query<{ vehicles: Partial<VehicleSettings> | null }>(
        "select settings->'vehicles' as vehicles from organisation",
      );
    const stored = rows[0]?.vehicles ?? {};
    return {
      ...DEFAULT_VEHICLE_SETTINGS,
      ...stored,
      compliance: { ...DEFAULT_VEHICLE_SETTINGS.compliance, ...stored.compliance },
    };
  }

  async set(settings: VehicleSettings): Promise<void> {
    await this.transactions
      .current()
      .query(
        "update organisation set settings = jsonb_set(settings, '{vehicles}', $1::jsonb), updated_at = now()",
        [JSON.stringify(settings)],
      );
  }
}
