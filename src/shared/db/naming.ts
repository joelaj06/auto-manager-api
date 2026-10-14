const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,15}_$/;

export class InvalidTenantIdError extends Error {
  readonly code = "INVALID_TENANT_ID";

  constructor() {
    super("Tenant id must be a UUID");
    this.name = "InvalidTenantIdError";
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Database name for a tenant: prefix + the tenant UUID without dashes, e.g.
 * `t_0199e1c27a3b7f1e9a4c8d2e5f6a7b8c`. Uses the immutable tenant id (never the slug) so renaming
 * a tenant never renames its database. Always a safe PostgreSQL identifier (≤ 48 characters).
 */
export function tenantDatabaseName(prefix: string, tenantId: string): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error(`Invalid tenant database prefix: ${prefix}`);
  }
  if (!isUuid(tenantId)) {
    throw new InvalidTenantIdError();
  }
  return `${prefix}${tenantId.toLowerCase().replaceAll("-", "")}`;
}
