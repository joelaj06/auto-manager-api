/** Ends every session of the current tenant (tenant unit of work). */
export interface ITenantSessionRevoker {
  revokeAll(reason: "tenant_deactivated", now: Date): Promise<number>;
}
