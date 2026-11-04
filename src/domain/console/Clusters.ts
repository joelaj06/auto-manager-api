import { DomainError } from "../errors/DomainError.js";

export class ClusterRuleError extends DomainError {
  readonly code = "CLUSTER_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const CLUSTER_STATUSES = ["active", "draining", "retired"] as const;
/** active: takes new tenants; draining: keeps its tenants, takes no new ones; retired: empty. */
export type ClusterStatus = (typeof CLUSTER_STATUSES)[number];

/** The cluster in the configuration; it cannot be retired. */
export const MAIN_CLUSTER_ID = "main";

/** Tenants per cluster before another is added (docs/22 §2.2). */
export const DEFAULT_MAX_TENANTS = 1_000;
/** A cluster this full raises a capacity alert. */
export const CAPACITY_WARNING_PERCENT = 85;
/** An orphan database may be dropped once it has been seen this long. */
export const ORPHAN_GRACE_DAYS = 14;
/** The database a tenant leaves behind when it moves is kept this long. */
export const MOVED_SOURCE_RETENTION_DAYS = 14;

const ID = /^[a-z][a-z0-9-]{1,30}$/;

export type NewCluster = Readonly<{
  id: string;
  name: string;
  host: string;
  port: number;
  maxTenants: number;
  notes: string | null;
}>;

export function checkNewCluster(input: NewCluster): NewCluster {
  if (!ID.test(input.id))
    throw new ClusterRuleError("A cluster id is 2–31 lowercase letters, digits and dashes");
  if (input.id === MAIN_CLUSTER_ID) throw new ClusterRuleError("The main cluster already exists");
  if (input.name.trim().length === 0) throw new ClusterRuleError("A cluster needs a name");
  if (!/^[A-Za-z0-9.-]{1,255}$/.test(input.host))
    throw new ClusterRuleError("The host is a name or address");
  checkMaxTenants(input.maxTenants);
  return { ...input, name: input.name.trim(), notes: input.notes?.trim() || null };
}

export function checkMaxTenants(maxTenants: number): void {
  if (!Number.isInteger(maxTenants) || maxTenants < 1 || maxTenants > 100_000)
    throw new ClusterRuleError("A cluster holds 1 to 100,000 tenants");
}

/** A cluster's tenants against its limit. */
export type ClusterLoad = Readonly<{
  id: string;
  status: ClusterStatus;
  maxTenants: number;
  tenants: number;
  /** The one tenant this cluster is kept for. */
  dedicatedTo?: string | null;
}>;

export const fillPercent = (load: ClusterLoad): number =>
  Math.round((load.tenants / load.maxTenants) * 1000) / 10;

export const hasRoom = (load: ClusterLoad): boolean =>
  load.status === "active" && load.tenants < load.maxTenants;

/**
 * Where a new tenant's database goes (decision 491): the active cluster with room that is least
 * full, by id on a tie; null when none has room.
 */
export function pickCluster(
  loads: readonly ClusterLoad[],
  tenantId: string | null = null,
): string | null {
  // A cluster kept for this tenant comes first; one kept for anybody else is never used.
  const own = loads.find((l) => tenantId !== null && l.dedicatedTo === tenantId && hasRoom(l));
  if (own !== undefined) return own.id;
  const open = loads.filter((l) => hasRoom(l) && (l.dedicatedTo ?? null) === null);
  if (open.length === 0) return null;
  return [...open].sort(
    (a, b) => a.tenants / a.maxTenants - b.tenants / b.maxTenants || a.id.localeCompare(b.id),
  )[0]!.id;
}

/** A status change; a cluster is retired only once empty, and the main cluster never. */
export function checkStatusChange(load: ClusterLoad, next: ClusterStatus): void {
  if (next !== "retired") return;
  if (load.id === MAIN_CLUSTER_ID) throw new ClusterRuleError("The main cluster cannot be retired");
  if (load.tenants > 0)
    throw new ClusterRuleError(
      `${load.tenants} tenants are still on ${load.id}: move them before retiring it`,
    );
}

/** A tenant's move to `to` (decision 492). */
export function checkMove(
  tenant: Readonly<{
    tenantId?: string;
    clusterId: string;
    hasDatabase: boolean;
    status: string;
    moving: boolean;
  }>,
  to: ClusterLoad | null,
  moveOpen: boolean,
): void {
  if (!tenant.hasDatabase) throw new ClusterRuleError("The tenant has no database yet");
  if (["provisioning", "provisioning_failed", "archived"].includes(tenant.status))
    throw new ClusterRuleError(`A ${tenant.status} tenant cannot be moved`);
  if (tenant.moving || moveOpen) throw new ClusterRuleError("The tenant is already being moved");
  if (to === null) throw new ClusterRuleError("Unknown cluster");
  if (to.id === tenant.clusterId) throw new ClusterRuleError(`The tenant is already on ${to.id}`);
  if ((to.dedicatedTo ?? null) !== null && to.dedicatedTo !== tenant.tenantId)
    throw new ClusterRuleError(`${to.id} is kept for another tenant`);
  if (!hasRoom(to))
    throw new ClusterRuleError(
      to.status === "active"
        ? `${to.id} is full (${to.tenants} of ${to.maxTenants})`
        : `${to.id} is ${to.status} and takes no tenants`,
    );
}

export type FindingKind = "no_tenant" | "moved_away" | "stray_copy" | "missing";

/**
 * Whether staff may ask to drop a database the sweep found (decision 493): a database no tenant
 * uses once seen for the grace period; one a tenant left behind once its retention is over; a
 * missing database is never "dropped".
 */
export function droppable(
  finding: Readonly<{ kind: FindingKind; firstSeenAt: Date; retainedUntil: string | null }>,
  now: Date,
): boolean {
  if (finding.kind === "missing") return false;
  if (finding.kind === "moved_away")
    return finding.retainedUntil !== null && now.toISOString().slice(0, 10) > finding.retainedUntil;
  return now.getTime() - finding.firstSeenAt.getTime() >= ORPHAN_GRACE_DAYS * 86_400_000;
}

/** Keeping a cluster for one tenant (decision 531): nobody else may be on it. */
export function checkDedication(
  cluster: Readonly<{ id: string; status: ClusterStatus }>,
  othersOnIt: number,
): void {
  if (cluster.id === MAIN_CLUSTER_ID)
    throw new ClusterRuleError("The main cluster cannot be kept for one tenant");
  if (cluster.status === "retired") throw new ClusterRuleError(`${cluster.id} is retired`);
  if (othersOnIt > 0)
    throw new ClusterRuleError(
      `${othersOnIt} other tenants are on ${cluster.id}: move them off first`,
    );
}
