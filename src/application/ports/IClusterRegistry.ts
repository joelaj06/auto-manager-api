import type {
  ClusterLoad,
  ClusterStatus,
  FindingKind,
  NewCluster,
} from "../../domain/console/Clusters.js";
import type { CopyReport } from "./ITenantDatabaseMover.js";
import type { ClusterSweep } from "./IOrphanDatabases.js";

export type ClusterRecord = ClusterLoad &
  Readonly<{
    name: string;
    /** Null: the server in the configuration. */
    host: string | null;
    port: number | null;
    notes: string | null;
    /** Tenants that are trialing, active, past due or read-only. */
    liveTenants: number;
    lastCheckedAt: Date | null;
    lastError: string | null;
    createdAt: Date;
  }>;

export type ClusterChanges = Readonly<{
  name?: string;
  status?: ClusterStatus;
  maxTenants?: number;
  notes?: string | null;
}>;

export type TenantPlacement = Readonly<{
  tenantId: string;
  slug: string;
  status: string;
  clusterId: string;
  hasDatabase: boolean;
  moving: boolean;
}>;

export type MoveStatus = "queued" | "blocking" | "copying" | "switching" | "completed" | "failed";

export type ClusterMove = Readonly<{
  id: string;
  tenantId: string;
  slug: string;
  from: string;
  to: string;
  status: MoveStatus;
  reason: string;
  report: Partial<CopyReport> & Readonly<{ offlineSeconds?: number }>;
  error: string | null;
  approvalId: string | null;
  requestedBy: string;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  sourceRetainedUntil: string | null;
}>;

export type MoveChanges = Readonly<{
  status?: MoveStatus;
  report?: ClusterMove["report"];
  error?: string | null;
  startedAt?: Date;
  finishedAt?: Date;
  sourceRetainedUntil?: string;
}>;

export type ClusterFinding = Readonly<{
  clusterId: string;
  databaseName: string;
  kind: FindingKind;
  tenantId: string | null;
  sizeBytes: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  droppedBy: string | null;
  /** For a database a tenant left behind: kept until then. */
  retainedUntil: string | null;
}>;

/** The cluster registry, moves and sweep findings in the platform database. */
export interface IClusterRegistry {
  list(): Promise<ClusterRecord[]>;
  find(id: string): Promise<ClusterRecord | null>;
  create(cluster: NewCluster, createdBy: string): Promise<void>;
  update(id: string, changes: ClusterChanges): Promise<void>;
  /** Every cluster's load, locked until the end of the transaction (placing a tenant). */
  lockLoads(): Promise<ClusterLoad[]>;
  checked(id: string, error: string | null, at: Date): Promise<void>;

  placement(tenantId: string): Promise<TenantPlacement | null>;
  /** Puts a tenant without a database yet on a cluster. */
  place(tenantId: string, clusterId: string): Promise<void>;
  /** The tenant's database is now on `clusterId`. */
  switchTenant(tenantId: string, clusterId: string): Promise<void>;
  /** Marks the tenant offline for a move (a date) or back (null). */
  setMoving(tenantId: string, since: Date | null): Promise<void>;

  createMove(
    move: Readonly<{
      tenantId: string;
      from: string;
      to: string;
      reason: string;
      approvalId: string | null;
      requestedBy: string;
    }>,
  ): Promise<string>;
  findMove(id: string): Promise<ClusterMove | null>;
  openMove(tenantId: string): Promise<ClusterMove | null>;
  moves(
    filter: Readonly<{ tenantId?: string; clusterId?: string; limit: number }>,
  ): Promise<ClusterMove[]>;
  updateMove(id: string, changes: MoveChanges): Promise<void>;

  /**
   * Records a sweep: findings seen are kept (first seen once), those of clusters that answered
   * and are no longer seen are resolved. Returns the findings seen for the first time.
   */
  recordSweep(sweeps: readonly ClusterSweep[], at: Date): Promise<ClusterFinding[]>;
  findings(filter: Readonly<{ open: boolean; clusterId?: string }>): Promise<ClusterFinding[]>;
  finding(clusterId: string, databaseName: string): Promise<ClusterFinding | null>;
  dropped(clusterId: string, databaseName: string, droppedBy: string, at: Date): Promise<void>;
}

/** Forgets where a tenant's database was, in this process (others within seconds). */
export interface IClusterRouting {
  forget(tenantId: string): void;
}

export type ClusterProbe = Readonly<{
  reachable: boolean;
  latencyMs: number | null;
  serverVersion: string | null;
  connections: number | null;
  maxConnections: number | null;
  /** Size of the tenant databases on it. */
  tenantDatabaseBytes: number | null;
  templateVersion: string | null;
  /** What a cluster lacks to take tenants (roles, template, rights); empty when ready. */
  problems: readonly string[];
  error: string | null;
}>;

/** Live look at a cluster's server. */
export interface IClusterProbe {
  probe(server: Readonly<{ id: string } | { host: string; port: number }>): Promise<ClusterProbe>;
}
