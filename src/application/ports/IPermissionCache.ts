/**
 * Forgets cached permission data after a change in this process (other API instances follow
 * within the cache's short TTL — decision 70).
 */
export interface IPermissionCache {
  forgetTenant(tenantId: string): void;
}
