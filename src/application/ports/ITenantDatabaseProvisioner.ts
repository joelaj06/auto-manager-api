import type { TenantId } from "../../domain/value-objects/TenantId.js";

export type ProvisionedTenantDatabase = Readonly<{ databaseName: string; created: boolean }>;

/**
 * Creates a tenant's database (idempotent). There is intentionally no delete operation:
 * tenants are never deleted.
 */
export interface ITenantDatabaseProvisioner {
  provision(tenantId: TenantId): Promise<ProvisionedTenantDatabase>;
}
