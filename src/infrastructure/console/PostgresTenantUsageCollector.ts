import type { ITenantUsageCollector } from "../../application/ports/ITenantUsageCollector.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import type { TenantConnectionPools } from "../database/postgres/TenantConnectionPools.js";

type Row = {
  active_users: number;
  records_created: number;
  vehicles: number;
  branches: number;
  users: number;
  storage_bytes: string;
  database_bytes: string;
};

/** A day's counts from the tenant database, read-only. Records created: its audit entries. */
export class PostgresTenantUsageCollector implements ITenantUsageCollector {
  constructor(private readonly pools: TenantConnectionPools) {}

  collect(tenantId: string, day: string) {
    return this.pools.withTransaction(
      TenantId.from(tenantId),
      async (tx) => {
        const { rows } = await tx.query<Row>(
          `select
             (select count(*)::int from users
               where last_login_at >= $1::date and last_login_at < $1::date + 1)    as active_users,
             (select count(*)::int from audit_logs
               where occurred_at >= $1::date and occurred_at < $1::date + 1)        as records_created,
             (select count(*)::int from vehicles where deleted_at is null)          as vehicles,
             (select count(*)::int from branches where status = 'active')           as branches,
             (select count(*)::int from users where status <> 'disabled')           as users,
             (select coalesce(sum(size_bytes), 0) from files where status = 'ready') as storage_bytes,
             pg_database_size(current_database())                                   as database_bytes`,
          [day],
        );
        const r = rows[0]!;
        return {
          activeUsers: r.active_users,
          recordsCreated: r.records_created,
          vehicles: r.vehicles,
          branches: r.branches,
          users: r.users,
          storageBytes: Number(r.storage_bytes),
          databaseBytes: Number(r.database_bytes),
        };
      },
      { readOnly: true },
    );
  }
}
