import { mergeGrants } from "../../application/authorization/mergeGrants.js";
import type { PermissionGrants } from "../../application/authorization/Principal.js";
import type { PermissionScope } from "../../application/authorization/permissionCatalog.js";
import type { IPermissionResolver } from "../../application/ports/IPermissionResolver.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import type { TenantConnectionPools } from "../database/postgres/TenantConnectionPools.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A tenant user's effective permissions from their role assignments (docs/28 §3.3), combined by
 * `mergeGrants` (branch-specific assignments only work in their branch, widest scope wins). Deprecated permissions, deleted
 * roles and assignments to deactivated branches grant nothing; disabled and invited users have no
 * permissions (and no valid version). Only active branches count as the user's branches.
 * Wrapped by CachingPermissionResolver.
 */
export class PostgresTenantPermissionResolver implements IPermissionResolver {
  constructor(private readonly pools: TenantConnectionPools) {}

  async currentVersion(tenantId: string, userId: string): Promise<number | null> {
    if (!UUID.test(userId)) return null;
    return this.pools.withTransaction(
      TenantId.from(tenantId),
      async (tx) => {
        const { rows } = await tx.query<{ permission_version: number }>(
          "select permission_version from users where id = $1 and status = 'active'",
          [userId],
        );
        return rows[0]?.permission_version ?? null;
      },
      { readOnly: true },
    );
  }

  async resolve(
    tenantId: string,
    userId: string,
    permissionVersion: number,
  ): Promise<PermissionGrants | null> {
    if (!UUID.test(userId)) return null;
    return this.pools.withTransaction(
      TenantId.from(tenantId),
      async (tx) => {
        const user = await tx.query<{ ok: boolean }>(
          "select true as ok from users where id = $1 and status = 'active' and permission_version = $2",
          [userId, permissionVersion],
        );
        if (user.rows[0] === undefined) return null;

        const grants = await tx.query<{
          key: string;
          scope: PermissionScope;
          limits: Record<string, number> | null;
          branch_id: string | null;
        }>(
          `select rp.permission_key as key, rp.scope, rp.limits, ur.branch_id
             from user_roles ur
             join roles r on r.id = ur.role_id and r.deleted_at is null
             join role_permissions rp on rp.role_id = r.id
             join permissions p on p.key = rp.permission_key and not p.deprecated
             left join branches b on b.id = ur.branch_id
            where ur.user_id = $1
              -- An assignment to a deactivated branch grants nothing (docs/28 rule 14).
              and (ur.branch_id is null or b.status = 'active')`,
          [userId],
        );
        const permissions = mergeGrants(
          grants.rows.map((g) => ({
            key: g.key,
            scope: g.scope,
            limits: g.limits,
            assignmentBranchId: g.branch_id,
          })),
        );
        const branches = await tx.query<{ branch_id: string; active: boolean }>(
          `select ub.branch_id, b.status = 'active' as active from user_branches ub
             join branches b on b.id = ub.branch_id
            where ub.user_id = $1`,
          [userId],
        );
        const active = branches.rows.filter((b) => b.active).map((b) => b.branch_id);
        return {
          permissions,
          branchIds: active,
          allBranchesInactive: branches.rows.length > 0 && active.length === 0,
        };
      },
      { readOnly: true },
    );
  }
}
