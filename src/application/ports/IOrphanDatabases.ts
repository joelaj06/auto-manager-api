/** Tenant databases that exist on the cluster without a tenant record (never dropped automatically). */
export interface IOrphanDatabases {
  find(): Promise<string[]>;
}
