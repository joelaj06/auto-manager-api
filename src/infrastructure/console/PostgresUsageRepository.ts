import type { OnboardingFacts } from "../../domain/console/TenantAnalytics.js";
import type {
  IUsageRepository,
  JobCounts,
  UsageDay,
} from "../../domain/repositories/IUsageRepository.js";
import { JOB_QUEUE_SCHEMA } from "../jobs/PgBossJobQueue.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

type Row = {
  tenant_id: string;
  day: string;
  active_users: number;
  api_calls: string;
  api_errors: string;
  records_created: number;
  vehicles: number;
  branches: number;
  users: number;
  storage_bytes: string;
  database_bytes: string;
  jobs: number;
  failed_jobs: number;
  modules: Record<string, number>;
};

export class PostgresUsageRepository implements IUsageRepository {
  constructor(private readonly db: PlatformDb) {}

  async addCalls(
    counts: readonly Readonly<{ tenantId: string; day: string; calls: number; errors: number }>[],
  ): Promise<void> {
    if (counts.length === 0) return;
    await this.db.query(
      `insert into api_usage (tenant_id, day, calls, errors)
       select * from unnest($1::uuid[], $2::date[], $3::bigint[], $4::bigint[])
       on conflict (tenant_id, day) do update
         set calls = api_usage.calls + excluded.calls, errors = api_usage.errors + excluded.errors`,
      [
        counts.map((c) => c.tenantId),
        counts.map((c) => c.day),
        counts.map((c) => c.calls),
        counts.map((c) => c.errors),
      ],
    );
  }

  async callsOn(
    tenantId: string,
    day: string,
  ): Promise<Readonly<{ calls: number; errors: number }>> {
    const { rows } = await this.db.query<{ calls: string; errors: string }>(
      "select calls, errors from api_usage where tenant_id = $1 and day = $2",
      [tenantId, day],
    );
    return { calls: Number(rows[0]?.calls ?? 0), errors: Number(rows[0]?.errors ?? 0) };
  }

  async jobsOn(day: string): Promise<ReadonlyMap<string, JobCounts>> {
    const { rows } = await this.db.query<{ tenant_id: string; jobs: string; failed: string }>(
      `select data ->> 'tenantId' as tenant_id, count(*) as jobs,
              count(*) filter (where state = 'failed') as failed
         from ${JOB_QUEUE_SCHEMA}.job
        where created_on >= $1::date and created_on < $1::date + 1
          and data ->> 'tenantId' is not null
        group by 1`,
      [day],
    );
    return new Map(
      rows.map((r) => [r.tenant_id, { jobs: Number(r.jobs), failed: Number(r.failed) }]),
    );
  }

  async saveDay(d: UsageDay): Promise<void> {
    await this.db.query(
      `insert into usage_daily (tenant_id, day, active_users, api_calls, records_created, vehicles,
         branches, users, storage_bytes, database_bytes, jobs, failed_jobs, api_errors, modules)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (tenant_id, day) do update set active_users = excluded.active_users,
         api_calls = excluded.api_calls, records_created = excluded.records_created,
         vehicles = excluded.vehicles, branches = excluded.branches, users = excluded.users,
         storage_bytes = excluded.storage_bytes, database_bytes = excluded.database_bytes,
         jobs = excluded.jobs, failed_jobs = excluded.failed_jobs,
         api_errors = excluded.api_errors, modules = excluded.modules, collected_at = now()`,
      [
        d.tenantId,
        d.day,
        d.activeUsers,
        d.apiCalls,
        d.recordsCreated,
        d.vehicles,
        d.branches,
        d.users,
        d.storageBytes,
        d.databaseBytes,
        d.jobs,
        d.failedJobs,
        d.apiErrors,
        JSON.stringify(d.modules),
      ],
    );
  }

  async saveOnboarding(tenantId: string, facts: OnboardingFacts): Promise<void> {
    await this.db.query(
      `insert into tenant_onboarding (tenant_id, steps) values ($1, $2)
       on conflict (tenant_id) do update set steps = excluded.steps, updated_at = now()`,
      [tenantId, JSON.stringify(facts)],
    );
  }

  async days(tenantId: string, from: string, to: string): Promise<UsageDay[]> {
    const { rows } = await this.db.query<Row>(
      `select tenant_id, day::text, active_users, api_calls, api_errors, records_created, vehicles,
              branches, users, storage_bytes, database_bytes, jobs, failed_jobs, modules
         from usage_daily where tenant_id = $1 and day between $2 and $3 order by day`,
      [tenantId, from, to],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      day: r.day,
      activeUsers: r.active_users,
      apiCalls: Number(r.api_calls),
      apiErrors: Number(r.api_errors),
      recordsCreated: r.records_created,
      vehicles: r.vehicles,
      branches: r.branches,
      users: r.users,
      storageBytes: Number(r.storage_bytes),
      databaseBytes: Number(r.database_bytes),
      jobs: r.jobs,
      failedJobs: r.failed_jobs,
      modules: r.modules,
    }));
  }
}
