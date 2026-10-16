import type {
  DatabaseProbe,
  EmailProbe,
  ISystemProbes,
  QueueProbe,
  RuntimeProbe,
} from "../../application/ports/ISystemProbes.js";
import { JOB_QUEUE_SCHEMA } from "../jobs/PgBossJobQueue.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

/** Measurements from the platform database, the pg-boss tables and this process. */
export class PostgresSystemProbes implements ISystemProbes {
  private readonly startedAt = new Date(Date.now() - process.uptime() * 1_000);

  constructor(
    private readonly db: PlatformDb,
    private readonly version: string,
  ) {}

  async database(): Promise<DatabaseProbe> {
    const started = performance.now();
    try {
      await this.db.query("select 1");
      const latencyMs = Math.round(performance.now() - started);
      const { rows } = await this.db.query<{
        connections: string;
        max_connections: string;
        size: string;
        tenant_dbs: string;
      }>(
        `select (select count(*) from pg_stat_activity)               as connections,
                current_setting('max_connections')                     as max_connections,
                pg_database_size(current_database())                   as size,
                (select count(*) from tenants where database_name is not null) as tenant_dbs`,
      );
      const r = rows[0]!;
      return {
        reachable: true,
        latencyMs,
        connections: Number(r.connections),
        maxConnections: Number(r.max_connections),
        platformDatabaseBytes: Number(r.size),
        tenantDatabases: Number(r.tenant_dbs),
        error: null,
      };
    } catch (error) {
      return {
        reachable: false,
        latencyMs: null,
        connections: null,
        maxConnections: null,
        platformDatabaseBytes: null,
        tenantDatabases: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async queues(now: Date): Promise<QueueProbe[]> {
    const { rows } = await this.db.query<{
      name: string;
      ready: string;
      deferred: string;
      active: string;
      failed_24h: string;
      oldest_ready: Date | null;
    }>(
      `select name,
              count(*) filter (where state in ('created', 'retry') and start_after <= $1) as ready,
              count(*) filter (where state in ('created', 'retry') and start_after > $1)  as deferred,
              count(*) filter (where state = 'active')                                   as active,
              count(*) filter (where state = 'failed'
                                 and completed_on >= $1::timestamptz - interval '24 hours') as failed_24h,
              min(start_after) filter (where state in ('created', 'retry')
                                         and start_after <= $1)                           as oldest_ready
         from ${JOB_QUEUE_SCHEMA}.job
        group by name
        order by name`,
      [now],
    );
    return rows.map((r) => ({
      name: r.name,
      ready: Number(r.ready),
      deferred: Number(r.deferred),
      active: Number(r.active),
      failedLast24Hours: Number(r.failed_24h),
      oldestReadyAt: r.oldest_ready,
    }));
  }

  async email(now: Date): Promise<EmailProbe> {
    const { rows } = await this.db.query<{
      pending: string;
      failed_24h: string;
      oldest: Date | null;
    }>(
      `select count(*) filter (where status = 'queued') as pending,
              count(*) filter (where status = 'failed'
                                 and created_at >= $1::timestamptz - interval '24 hours') as failed_24h,
              min(created_at) filter (where status = 'queued') as oldest
         from email_deliveries
        where status = 'queued' or created_at >= $1::timestamptz - interval '24 hours'`,
      [now],
    );
    const r = rows[0]!;
    return {
      pending: Number(r.pending),
      failedLast24Hours: Number(r.failed_24h),
      oldestPendingAt: r.oldest,
    };
  }

  runtime(): RuntimeProbe {
    return {
      version: this.version,
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      memoryRssBytes: process.memoryUsage.rss(),
      startedAt: this.startedAt,
    };
  }
}
