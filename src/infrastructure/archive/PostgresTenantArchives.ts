import type { Paged } from "../../domain/value-objects/Paged.js";
import { pagedQuery } from "../database/postgres/PagedQuery.js";
import type { ArchiveStatus } from "../../domain/console/ColdArchive.js";
import type {
  ArchivableTenant,
  ArchiveChanges,
  ArchiveFiles,
  ITenantArchives,
  TenantArchive,
} from "../../application/ports/ITenantArchives.js";
import type { Queryable } from "../database/postgres/Queryable.js";

type Row = Record<string, unknown>;
const date = (v: unknown) => (v === null || v === undefined ? null : (v as Date));
const text = (v: unknown) => (typeof v === "string" ? v : null);
const json = (v: unknown) =>
  v === null || v === undefined ? null : (v as Readonly<Record<string, unknown>>);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN = `('queued', 'archiving', 'archived', 'restoring')`;

const ARCHIVES = `
  select a.*, t.slug::text as slug, b.size_bytes, b.key_fingerprint, b.schema_version
    from tenant_archives a
    join tenants t on t.id = a.tenant_id
    left join backups b on b.id = a.backup_id`;

function toArchive(r: Row): TenantArchive {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    slug: String(r.slug),
    status: r.status as ArchiveStatus,
    reason: String(r.reason),
    approvalId: text(r.approval_id),
    requestedBy: String(r.requested_by),
    requestedAt: r.requested_at as Date,
    clusterId: text(r.cluster_id),
    backupId: text(r.backup_id),
    sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
    keyFingerprint: text(r.key_fingerprint),
    schemaVersion: text(r.schema_version),
    files: r.files as ArchiveFiles,
    report: r.report as Readonly<Record<string, unknown>>,
    error: text(r.error),
    startedAt: date(r.started_at),
    archivedAt: date(r.archived_at),
    lastVerifiedAt: date(r.last_verified_at),
    lastVerification: json(r.last_verification),
    rekeyedAt: date(r.rekeyed_at),
    restoreReason: text(r.restore_reason),
    restoreApprovalId: text(r.restore_approval_id),
    restoreRequestedBy: text(r.restore_requested_by),
    restoreApprovedAt: date(r.restore_approved_at),
    restoreStartedAt: date(r.restore_started_at),
    restoredAt: date(r.restored_at),
    restoredByOperator: text(r.restored_by_operator),
    restoreReport: json(r.restore_report),
  };
}

/** Changes as column = value pairs; `undefined` leaves a column alone. */
const COLUMNS: Readonly<Record<keyof ArchiveChanges, [string, boolean]>> = {
  status: ["status", false],
  clusterId: ["cluster_id", false],
  backupId: ["backup_id", false],
  files: ["files", true],
  report: ["report", true],
  error: ["error", false],
  startedAt: ["started_at", false],
  archivedAt: ["archived_at", false],
  lastVerifiedAt: ["last_verified_at", false],
  lastVerification: ["last_verification", true],
  rekeyedAt: ["rekeyed_at", false],
  restoreReason: ["restore_reason", false],
  restoreApprovalId: ["restore_approval_id", false],
  restoreRequestedBy: ["restore_requested_by", false],
  restoreApprovedAt: ["restore_approved_at", false],
  restoreStartedAt: ["restore_started_at", false],
  restoredAt: ["restored_at", false],
  restoredByOperator: ["restored_by_operator", false],
  restoreReport: ["restore_report", true],
};

export class PostgresTenantArchives implements ITenantArchives {
  constructor(private readonly db: Queryable) {}

  async tenant(tenantId: string): Promise<ArchivableTenant | null> {
    if (!UUID.test(tenantId)) return null;
    const { rows } = await this.db.query<Row>(
      `select id, slug::text as slug, status, status_changed_at, cluster_id,
              database_name is not null as has_database, moving_since is not null as moving
         from tenants where id = $1`,
      [tenantId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      tenantId: String(r.id),
      slug: String(r.slug),
      status: String(r.status),
      statusChangedAt: date(r.status_changed_at),
      clusterId: String(r.cluster_id),
      hasDatabase: r.has_database === true,
      moving: r.moving === true,
    };
  }

  async create(archive: Parameters<ITenantArchives["create"]>[0]): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into tenant_archives (tenant_id, reason, approval_id, requested_by)
       values ($1, $2, $3, $4) returning id`,
      [archive.tenantId, archive.reason, archive.approvalId, archive.requestedBy],
    );
    return rows[0]!.id;
  }

  async find(id: string): Promise<TenantArchive | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(`${ARCHIVES} where a.id = $1`, [id]);
    return rows[0] === undefined ? null : toArchive(rows[0]);
  }

  async current(tenantId: string): Promise<TenantArchive | null> {
    if (!UUID.test(tenantId)) return null;
    const { rows } = await this.db.query<Row>(
      `${ARCHIVES} where a.tenant_id = $1 and a.status in ${OPEN}`,
      [tenantId],
    );
    return rows[0] === undefined ? null : toArchive(rows[0]);
  }

  async list(
    filter: Readonly<{ status?: ArchiveStatus; tenantId?: string; limit: number; offset?: number }>,
  ): Promise<Paged<TenantArchive>> {
    const { rows, total } = await pagedQuery<Row>(
      this.db,
      {
        sql: `${ARCHIVES}
        where ($1::text is null or a.status = $1) and ($2::uuid is null or a.tenant_id = $2)`,
        orderBy: "a.requested_at desc, a.id desc",
        params: [filter.status ?? null, filter.tenantId ?? null],
      },
      filter,
    );
    return { rows: rows.map(toArchive), total };
  }

  async update(id: string, changes: ArchiveChanges): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, value] of Object.entries(changes) as [keyof ArchiveChanges, unknown][]) {
      if (value === undefined) continue;
      const [column, isJson] = COLUMNS[key];
      values.push(isJson && value !== null ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}${isJson ? "::jsonb" : ""}`);
    }
    if (sets.length === 0) return;
    await this.db.query(
      `update tenant_archives set ${sets.join(", ")}, updated_at = now() where id = $1`,
      values,
    );
  }

  async verifiedBefore(before: Date, limit: number): Promise<TenantArchive[]> {
    const { rows } = await this.db.query<Row>(
      `${ARCHIVES}
        where a.status = 'archived' and coalesce(a.last_verified_at, a.archived_at) <= $1
        order by coalesce(a.last_verified_at, a.archived_at), a.id
        limit $2`,
      [before, limit],
    );
    return rows.map(toArchive);
  }

  async restoresWaiting(before: Date): Promise<TenantArchive[]> {
    const { rows } = await this.db.query<Row>(
      `${ARCHIVES}
        where a.status = 'archived' and a.restore_approved_at <= $1
        order by a.restore_approved_at`,
      [before],
    );
    return rows.map(toArchive);
  }

  async setDatabase(tenantId: string, databaseName: string | null): Promise<void> {
    await this.db.query("update tenants set database_name = $2, updated_at = now() where id = $1", [
      tenantId,
      databaseName,
    ]);
  }

  async encryptedForOtherKeys(currentFingerprint: string, limit: number): Promise<TenantArchive[]> {
    const { rows } = await this.db.query<Row>(
      `${ARCHIVES}
        where a.status = 'archived' and b.key_fingerprint is distinct from $1
        order by a.archived_at, a.id
        limit $2`,
      [currentFingerprint, limit],
    );
    return rows.map(toArchive);
  }
}
