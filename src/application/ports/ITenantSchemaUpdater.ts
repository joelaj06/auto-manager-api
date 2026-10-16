/** Brings one tenant database to the latest schema (normally a no-op after cloning the template). */
export interface ITenantSchemaUpdater {
  migrate(tenantId: string): Promise<string | null>;
}
