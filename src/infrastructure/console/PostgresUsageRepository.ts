import type { IUsageRepository, UsageDay } from "../../domain/repositories/IUsageRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

type Row = {
  tenant_id: string;
  day: string;
  active_users: number;
  api_calls: string;
  records_created: number;
  vehicles: number;
  branches: number;
  users: number;
  storage_bytes: string;
  database_bytes: string;
};

export class PostgresUsageRepository implements IUsageRepository {
  constructor(private readonly db: PlatformDb) {}

  async addCalls(
    counts: readonly Readonly<{ tenantId: string; day: string; calls: number }>[],
  ): Promise<void> {
    if (counts.length === 0) return;
    await this.db.query(
      `insert into api_usage (tenant_id, day, calls)
       select * from unnest($1::uuid[], $2::date[], $3::bigint[])
       on conflict (tenant_id, day) do update set calls = api_usage.calls + excluded.calls`,
      [counts.map((c) => c.tenantId), counts.map((c) => c.day), counts.map((c) => c.calls)],
    );
  }

  async callsOn(tenantId: string, day: string): Promise<number> {
    const { rows } = await this.db.query<{ calls: string }>(
      "select calls from api_usage where tenant_id = $1 and day = $2",
      [tenantId, day],
    );
    return Number(rows[0]?.calls ?? 0);
  }

  async saveDay(d: UsageDay): Promise<void> {
    await this.db.query(
      `insert into usage_daily (tenant_id, day, active_users, api_calls, records_created, vehicles,
         branches, users, storage_bytes, database_bytes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (tenant_id, day) do update set active_users = excluded.active_users,
         api_calls = excluded.api_calls, records_created = excluded.records_created,
         vehicles = excluded.vehicles, branches = excluded.branches, users = excluded.users,
         storage_bytes = excluded.storage_bytes, database_bytes = excluded.database_bytes,
         collected_at = now()`,
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
      ],
    );
  }

  async days(tenantId: string, from: string, to: string): Promise<UsageDay[]> {
    const { rows } = await this.db.query<Row>(
      `select tenant_id, day::text, active_users, api_calls, records_created, vehicles, branches,
              users, storage_bytes, database_bytes
         from usage_daily where tenant_id = $1 and day between $2 and $3 order by day`,
      [tenantId, from, to],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      day: r.day,
      activeUsers: r.active_users,
      apiCalls: Number(r.api_calls),
      recordsCreated: r.records_created,
      vehicles: r.vehicles,
      branches: r.branches,
      users: r.users,
      storageBytes: Number(r.storage_bytes),
      databaseBytes: Number(r.database_bytes),
    }));
  }
}
