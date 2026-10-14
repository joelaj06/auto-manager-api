import type { TenantId } from "../../../domain/value-objects/TenantId.js";

const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,15}_$/;

/**
 * Database name for a tenant: prefix + the tenant UUID without dashes, e.g.
 * `t_0199e1c27a3b7f1e9a4c8d2e5f6a7b8c`. Uses the immutable tenant id (never the slug) so
 * renaming a tenant never renames its database. Always a safe identifier (≤ 48 characters).
 */
export class TenantDatabaseNaming {
  constructor(readonly prefix: string) {
    if (!PREFIX_PATTERN.test(prefix)) {
      throw new Error(`Invalid tenant database prefix: ${prefix}`);
    }
  }

  databaseNameFor(tenantId: TenantId): string {
    return `${this.prefix}${tenantId.value.replaceAll("-", "")}`;
  }
}
