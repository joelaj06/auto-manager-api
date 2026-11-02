/**
 * What the sweep finds (decision 493): `no_tenant` — a tenant database no tenant record names;
 * `moved_away` — the database a tenant left on its old cluster; `stray_copy` — a tenant's
 * database on a cluster it is not on, without a move; `missing` — a tenant's database absent from
 * its cluster.
 */
export type DatabaseFindingKind = "no_tenant" | "moved_away" | "stray_copy" | "missing";

export type DatabaseFinding = Readonly<{
  clusterId: string;
  databaseName: string;
  kind: DatabaseFindingKind;
  tenantId: string | null;
  sizeBytes: number | null;
}>;

export type ClusterSweep = Readonly<{
  clusterId: string;
  /** Null when the cluster answered. */
  error: string | null;
  /** Tenant databases on it. */
  databases: number;
  findings: readonly DatabaseFinding[];
}>;

/** Tenant databases on every cluster against the registry. Nothing is ever dropped by a sweep. */
export interface IOrphanDatabases {
  sweep(): Promise<ClusterSweep[]>;
  /**
   * Drops a database a fresh look still finds orphaned on its cluster (not missing, not the
   * database of a tenant on that cluster); false when it is not (any more).
   */
  drop(clusterId: string, databaseName: string): Promise<boolean>;
}
