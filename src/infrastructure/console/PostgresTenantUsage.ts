import type { ITenantUsage, TenantUsageSnapshot } from "../../application/ports/ITenantUsage.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import type { TenantConnectionPools } from "../database/postgres/TenantConnectionPools.js";

type Row = {
  users_active: string;
  users_invited: string;
  users_disabled: string;
  active_30d: string;
  last_login_at: Date | null;
  branches_active: string;
  branches_inactive: string;
  custom_roles: string;
  last_role_change_at: Date | null;
  database_bytes: string;
};

/** Counts from the tenant's own database, read-only (no business records). */
export class PostgresTenantUsage implements ITenantUsage {
  constructor(private readonly pools: TenantConnectionPools) {}

  snapshot(tenantId: string, now: Date): Promise<TenantUsageSnapshot> {
    return this.pools.withTransaction(
      TenantId.from(tenantId),
      async (tx) => {
        const { rows } = await tx.query<Row>(
          `select
             (select count(*) from users where status = 'active')              as users_active,
             (select count(*) from users where status = 'invited')             as users_invited,
             (select count(*) from users where status = 'disabled')            as users_disabled,
             (select count(*) from users
               where last_login_at >= $1::timestamptz - interval '30 days')    as active_30d,
             (select max(last_login_at) from users)                            as last_login_at,
             (select count(*) from branches where status = 'active')           as branches_active,
             (select count(*) from branches where status <> 'active')          as branches_inactive,
             (select count(*) from roles where not is_system and deleted_at is null) as custom_roles,
             (select max(updated_at) from roles)                               as last_role_change_at,
             pg_database_size(current_database())                              as database_bytes`,
          [now],
        );
        const r = rows[0]!;
        return {
          users: {
            active: Number(r.users_active),
            invited: Number(r.users_invited),
            disabled: Number(r.users_disabled),
          },
          activeLast30Days: Number(r.active_30d),
          lastLoginAt: r.last_login_at,
          branches: { active: Number(r.branches_active), inactive: Number(r.branches_inactive) },
          customRoles: Number(r.custom_roles),
          lastRoleChangeAt: r.last_role_change_at,
          databaseBytes: Number(r.database_bytes),
        };
      },
      { readOnly: true },
    );
  }
}
