export type TenantUsageSnapshot = Readonly<{
  users: Readonly<{ active: number; invited: number; disabled: number }>;
  /** Users who signed in within the last 30 days. */
  activeLast30Days: number;
  lastLoginAt: Date | null;
  branches: Readonly<{ active: number; inactive: number }>;
  customRoles: number;
  lastRoleChangeAt: Date | null;
  databaseBytes: number;
}>;

/**
 * Operational counts read from a tenant's own database (no business records: docs/27 §2
 * "least data"). Read-only.
 */
export interface ITenantUsage {
  snapshot(tenantId: string, now: Date): Promise<TenantUsageSnapshot>;
}
