import type pg from "pg";

export type BackupKind = "tenant" | "platform";
export type BackupStatus = "running" | "succeeded" | "failed";

export type BackupRecord = Readonly<{
  id: string;
  kind: BackupKind;
  tenantId: string | null;
  databaseName: string;
  status: BackupStatus;
  startedAt: Date;
  finishedAt: Date | null;
  location: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  keyFingerprint: string | null;
  schemaVersion: string | null;
  rowCounts: Readonly<Record<string, number>> | null;
  error: string | null;
  verifiedAt: Date | null;
  verification: Readonly<Record<string, unknown>> | null;
}>;

type Row = {
  id: string;
  kind: BackupKind;
  tenant_id: string | null;
  database_name: string;
  status: BackupStatus;
  started_at: Date;
  finished_at: Date | null;
  location: string | null;
  size_bytes: string | null;
  sha256: string | null;
  key_fingerprint: string | null;
  schema_version: string | null;
  row_counts: Record<string, number> | null;
  error: string | null;
  verified_at: Date | null;
  verification: Record<string, unknown> | null;
};

const COLUMNS = `id, kind, tenant_id, database_name, status, started_at, finished_at, location,
  size_bytes, sha256, key_fingerprint, schema_version, row_counts, error, verified_at, verification`;

const toRecord = (row: Row): BackupRecord => ({
  id: row.id,
  kind: row.kind,
  tenantId: row.tenant_id,
  databaseName: row.database_name,
  status: row.status,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  location: row.location,
  sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
  sha256: row.sha256,
  keyFingerprint: row.key_fingerprint,
  schemaVersion: row.schema_version,
  rowCounts: row.row_counts,
  error: row.error,
  verifiedAt: row.verified_at,
  verification: row.verification,
});

/** The `backups` table of the platform database (docs/26 §4). */
export class PostgresBackupCatalog {
  constructor(private readonly platform: pg.Pool) {}

  async start(kind: BackupKind, tenantId: string | null, databaseName: string): Promise<string> {
    const { rows } = await this.platform.query<{ id: string }>(
      "insert into backups (kind, tenant_id, database_name) values ($1, $2, $3) returning id",
      [kind, tenantId, databaseName],
    );
    return rows[0]!.id;
  }

  async succeed(
    id: string,
    result: Readonly<{
      location: string;
      sizeBytes: number;
      sha256: string;
      keyFingerprint: string;
      schemaVersion: string | null;
      rowCounts: Readonly<Record<string, number>>;
    }>,
  ): Promise<void> {
    await this.platform.query(
      `update backups
          set status = 'succeeded', finished_at = now(), location = $2, size_bytes = $3,
              sha256 = $4, key_fingerprint = $5, schema_version = $6, row_counts = $7
        where id = $1`,
      [
        id,
        result.location,
        result.sizeBytes,
        result.sha256,
        result.keyFingerprint,
        result.schemaVersion,
        JSON.stringify(result.rowCounts),
      ],
    );
  }

  async fail(id: string, error: string): Promise<void> {
    await this.platform.query(
      "update backups set status = 'failed', finished_at = now(), error = $2 where id = $1",
      [id, error.slice(0, 4_000)],
    );
  }

  async recordVerification(
    id: string,
    passed: boolean,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.platform.query(
      `update backups
          set verification = $2, verified_at = case when $3 then now() else verified_at end
        where id = $1`,
      [id, JSON.stringify({ ...details, passed, checkedAt: new Date().toISOString() }), passed],
    );
  }

  async find(id: string): Promise<BackupRecord | null> {
    const { rows } = await this.platform.query<Row>(
      `select ${COLUMNS} from backups where id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async recent(limit: number): Promise<BackupRecord[]> {
    const { rows } = await this.platform.query<Row>(
      `select ${COLUMNS} from backups order by started_at desc limit $1`,
      [limit],
    );
    return rows.map(toRecord);
  }

  /** The latest successful platform backup and `tenants` random latest tenant backups. */
  async sampleForVerification(tenants: number): Promise<BackupRecord[]> {
    const { rows } = await this.platform.query<Row>(
      `(select ${COLUMNS} from backups
         where kind = 'platform' and status = 'succeeded'
         order by started_at desc limit 1)
       union all
       (select ${COLUMNS} from (
          select distinct on (tenant_id) * from backups
           where kind = 'tenant' and status = 'succeeded'
           order by tenant_id, started_at desc) latest
         order by random() limit $1)`,
      [tenants],
    );
    return rows.map(toRecord);
  }

  /** Tenants that should be backed up: every tenant with a database (deactivated included). */
  async tenantsToBackUp(): Promise<string[]> {
    const { rows } = await this.platform.query<{ id: string }>(
      `select id from tenants
        where status not in ('provisioning', 'provisioning_failed')
        order by id`,
    );
    return rows.map((r) => r.id);
  }
}
