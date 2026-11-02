export type CopyCheck = Readonly<{ name: string; passed: boolean; detail?: string }>;

export type CopyReport = Readonly<{
  tables: number;
  rows: number;
  schemaVersion: string | null;
  /** Size of the copy on its new cluster. */
  sizeBytes: number;
  checks: readonly CopyCheck[];
}>;

/** Copies a tenant's database from one cluster to another (decision 492). */
export interface ITenantDatabaseMover {
  /** Closes the tenant's database on a cluster to the app and ends the app's sessions there. */
  close(tenantId: string, clusterId: string): Promise<void>;
  /** Opens it to the app and backups again. */
  open(tenantId: string, clusterId: string): Promise<void>;
  /**
   * Copies the database onto `to` — replacing an unfinished earlier copy there — and compares
   * the copy with the original; throws with the failed checks when they differ. The caller
   * makes sure the tenant is not on `to`.
   */
  copy(tenantId: string, from: string, to: string): Promise<CopyReport>;
  /** Drops an unfinished copy from a cluster the tenant is not on (the caller makes sure). */
  discard(tenantId: string, clusterId: string): Promise<void>;
}
