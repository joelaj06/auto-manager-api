import type { ITenantUsageCollector } from "../../application/ports/ITenantUsageCollector.js";
import type { OnboardingFacts, OnboardingStep } from "../../domain/console/TenantAnalytics.js";
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

/**
 * A day's counts from the tenant database, read-only. Records created: its audit entries, also
 * counted per entity type for the modules used.
 */
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
        const entities = await tx.query<{ entity_type: string; n: number }>(
          `select entity_type, count(*)::int as n from audit_logs
            where occurred_at >= $1::date and occurred_at < $1::date + 1 and actor_type = 'user'
            group by entity_type`,
          [day],
        );
        return {
          modules: Object.fromEntries(entities.rows.map((e) => [e.entity_type, e.n])),
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

  /** The first day each onboarding step was done (the HQ branch and the owner aside). */
  onboarding(tenantId: string): Promise<OnboardingFacts> {
    return this.pools.withTransaction(
      TenantId.from(tenantId),
      async (tx) => {
        const { rows } = await tx.query<Record<OnboardingStep, string | null>>(
          `select
             (select (created_at::date)::text from branches order by created_at offset 1 limit 1)
                                                                                as branch_added,
             (select min(created_at)::date::text from vehicles)                 as vehicle_added,
             (select min(created_at)::date::text from drivers)                  as driver_added,
             (select (created_at::date)::text from users order by created_at offset 1 limit 1)
                                                                                as user_invited,
             (select min(updated_at)::date::text from remittances
               where status in ('partially_paid', 'paid'))                      as first_remittance,
             (select min(created_at)::date::text from rental_bookings)          as first_rental,
             (select min(recorded_at)::date::text from payments)                as first_transaction,
             (select min(created_at)::date::text from push_devices)             as app_installed`,
        );
        const r = rows[0]!;
        return Object.fromEntries(
          Object.entries(r).filter((e): e is [string, string] => e[1] !== null),
        );
      },
      { readOnly: true },
    );
  }
}
