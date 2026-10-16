import type {
  BackupListFilter,
  BackupOverview,
  BackupView,
  IDataOperationsQueries,
  SchemaFailure,
  SchemaVersionCount,
} from "../../application/ports/IDataOperationsQueries.js";
import { MigrationRunner } from "../database/migrations/MigrationRunner.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const SAMPLE = 20;

/** Backup catalogue and tenant schema status, read for the console. */
export class PostgresDataOperationsQueries implements IDataOperationsQueries {
  constructor(private readonly db: PlatformDb) {}

  async backups(filter: BackupListFilter): Promise<BackupView[]> {
    const { rows } = await this.db.query<{
      id: string;
      kind: "tenant" | "platform";
      tenant_id: string | null;
      slug: string | null;
      status: "running" | "succeeded" | "failed";
      started_at: Date;
      finished_at: Date | null;
      size_bytes: string | null;
      schema_version: string | null;
      error: string | null;
      verified_at: Date | null;
      verification: Record<string, unknown> | null;
    }>(
      `select b.id, b.kind, b.tenant_id, t.slug::text as slug, b.status, b.started_at,
              b.finished_at, b.size_bytes, b.schema_version, b.error, b.verified_at, b.verification
         from backups b left join tenants t on t.id = b.tenant_id
        where ($1::text is null or b.kind = $1)
          and ($2::uuid is null or b.tenant_id = $2)
          and ($3::text is null or b.status = $3)
          and ($4::uuid is null or b.id < $4)
        order by b.id desc
        limit $5`,
      [
        filter.kind ?? null,
        filter.tenantId ?? null,
        filter.status ?? null,
        filter.before ?? null,
        filter.limit,
      ],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      tenantId: r.tenant_id,
      tenantSlug: r.slug,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      schemaVersion: r.schema_version,
      error: r.error,
      verifiedAt: r.verified_at,
      verification: r.verification,
    }));
  }

  async backupOverview(now: Date, since: Date): Promise<BackupOverview> {
    const [summary, verification, missing] = await Promise.all([
      this.db.query<{ platform_ok: Date | null; platform_failed: Date | null; failed_24h: string }>(
        `select
           (select max(finished_at) from backups
             where kind = 'platform' and status = 'succeeded') as platform_ok,
           (select max(started_at) from backups
             where kind = 'platform' and status = 'failed') as platform_failed,
           (select count(*) from backups
             where status = 'failed' and started_at >= $1::timestamptz - interval '24 hours') as failed_24h`,
        [now],
      ),
      this.db.query<{ id: string; checked_at: string; passed: boolean }>(
        `select id, verification->>'checkedAt' as checked_at,
                (verification->>'passed')::boolean as passed
           from backups
          where verification ? 'checkedAt'
          order by (verification->>'checkedAt')::timestamptz desc
          limit 1`,
      ),
      this.db.query<{ id: string; slug: string; last_ok: Date | null; total: string }>(
        `select t.id, t.slug::text as slug, last.at as last_ok, count(*) over () as total
           from tenants t
           left join lateral (
             select max(finished_at) as at from backups
              where tenant_id = t.id and status = 'succeeded') last on true
          where t.status not in ('provisioning', 'provisioning_failed')
            and t.created_at < $1
            and (last.at is null or last.at < $1)
          order by last.at nulls first, t.slug
          limit $2`,
        [since, SAMPLE],
      ),
    ]);
    const s = summary.rows[0]!;
    const v = verification.rows[0];
    return {
      lastPlatform: { succeededAt: s.platform_ok, failedAt: s.platform_failed },
      lastVerification:
        v === undefined ? null : { at: new Date(v.checked_at), passed: v.passed, backupId: v.id },
      failedLast24Hours: Number(s.failed_24h),
      tenantsWithoutRecentBackup: {
        count: Number(missing.rows[0]?.total ?? 0),
        sample: missing.rows.map((r) => ({
          tenantId: r.id,
          slug: r.slug,
          lastSucceededAt: r.last_ok,
        })),
      },
    };
  }

  async schemaVersions(): Promise<SchemaVersionCount[]> {
    const { rows } = await this.db.query<{
      version: string | null;
      status: "ok" | "failed" | null;
      tenants: string;
    }>(
      `select s.schema_version as version, s.status, count(*) as tenants
         from tenants t left join tenant_schema_status s on s.tenant_id = t.id
        where t.database_name is not null
        group by s.schema_version, s.status
        order by s.schema_version desc nulls last, s.status`,
    );
    return rows.map((r) => ({ version: r.version, status: r.status, tenants: Number(r.tenants) }));
  }

  async schemaFailures(limit: number): Promise<SchemaFailure[]> {
    const { rows } = await this.db.query<{
      tenant_id: string;
      slug: string;
      schema_version: string | null;
      error: string | null;
      updated_at: Date;
    }>(
      `select s.tenant_id, t.slug::text as slug, s.schema_version, s.error, s.updated_at
         from tenant_schema_status s join tenants t on t.id = s.tenant_id
        where s.status = 'failed'
        order by s.updated_at desc
        limit $1`,
      [limit],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      slug: r.slug,
      version: r.schema_version,
      error: r.error,
      updatedAt: r.updated_at,
    }));
  }

  platformSchemaVersion(): Promise<string | null> {
    return MigrationRunner.readSchemaVersion(this.db);
  }
}
