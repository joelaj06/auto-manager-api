import type {
  DataExport,
  ITenantDataExportRepository,
} from "../../domain/repositories/ITenantDataExportRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string;
  tenant_id: string;
  requested_by_type: DataExport["requestedByType"];
  requested_by: string;
  status: DataExport["status"];
  storage_key: string | null;
  size_bytes: string | null;
  tables: number | null;
  files_included: number | null;
  files_skipped: number | null;
  error: string | null;
  requested_at: Date;
  completed_at: Date | null;
  expires_at: Date | null;
  downloads: number;
  last_downloaded_at: Date | null;
};

const toExport = (r: Row): DataExport => ({
  id: r.id,
  tenantId: r.tenant_id,
  requestedByType: r.requested_by_type,
  requestedBy: r.requested_by,
  status: r.status,
  storageKey: r.storage_key,
  sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  tables: r.tables,
  filesIncluded: r.files_included,
  filesSkipped: r.files_skipped,
  error: r.error,
  requestedAt: r.requested_at,
  completedAt: r.completed_at,
  expiresAt: r.expires_at,
  downloads: r.downloads,
  lastDownloadedAt: r.last_downloaded_at,
});

export class PostgresTenantDataExportRepository implements ITenantDataExportRepository {
  constructor(private readonly db: PlatformDb) {}

  async save(e: DataExport): Promise<void> {
    await this.db.query(
      `insert into tenant_data_exports (id, tenant_id, requested_by_type, requested_by, status,
         storage_key, size_bytes, tables, files_included, files_skipped, error, requested_at,
         completed_at, expires_at, downloads, last_downloaded_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       on conflict (id) do update set status = excluded.status, storage_key = excluded.storage_key,
         size_bytes = excluded.size_bytes, tables = excluded.tables,
         files_included = excluded.files_included, files_skipped = excluded.files_skipped,
         error = excluded.error, completed_at = excluded.completed_at,
         expires_at = excluded.expires_at, downloads = excluded.downloads,
         last_downloaded_at = excluded.last_downloaded_at`,
      [
        e.id,
        e.tenantId,
        e.requestedByType,
        e.requestedBy,
        e.status,
        e.storageKey,
        e.sizeBytes,
        e.tables,
        e.filesIncluded,
        e.filesSkipped,
        e.error?.slice(0, 1000) ?? null,
        e.requestedAt,
        e.completedAt,
        e.expiresAt,
        e.downloads,
        e.lastDownloadedAt,
      ],
    );
  }

  async find(id: string, lock = false): Promise<DataExport | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(
      `select * from tenant_data_exports where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toExport(rows[0]);
  }

  async list(tenantId: string, limit: number): Promise<DataExport[]> {
    const { rows } = await this.db.query<Row>(
      `select * from tenant_data_exports where tenant_id = $1 order by requested_at desc limit $2`,
      [tenantId, limit],
    );
    return rows.map(toExport);
  }

  async inProgress(tenantId: string): Promise<DataExport | null> {
    const { rows } = await this.db.query<Row>(
      `select * from tenant_data_exports where tenant_id = $1 and status in ('queued', 'running')
        order by requested_at desc limit 1`,
      [tenantId],
    );
    return rows[0] === undefined ? null : toExport(rows[0]);
  }

  async expiredBy(now: Date): Promise<DataExport[]> {
    const { rows } = await this.db.query<Row>(
      "select * from tenant_data_exports where status = 'ready' and expires_at <= $1",
      [now],
    );
    return rows.map(toExport);
  }
}
