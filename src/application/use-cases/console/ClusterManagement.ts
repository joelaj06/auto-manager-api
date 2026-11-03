import {
  CAPACITY_WARNING_PERCENT,
  checkMaxTenants,
  checkMove,
  checkNewCluster,
  checkStatusChange,
  ClusterRuleError,
  droppable,
  fillPercent,
  hasRoom,
  pickCluster,
  type ClusterStatus,
} from "../../../domain/console/Clusters.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  ClusterFinding,
  ClusterMove,
  ClusterProbe,
  ClusterRecord,
  IClusterProbe,
  IClusterRegistry,
  IClusterRouting,
} from "../../ports/IClusterRegistry.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IOrphanDatabases } from "../../ports/IOrphanDatabases.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ApprovalExecutor, ApprovalWorkflow } from "../platform/ApprovalWorkflow.js";
import { recordStaffAction } from "./consoleAudit.js";
import type { IAlerts } from "./PlatformAlerts.js";

export const MOVE_CLUSTER_ACTION = "tenant.move_cluster";
export const DROP_DATABASE_ACTION = "cluster.drop_database";

export type ClusterView = ClusterRecord &
  Readonly<{ fillPercent: number; acceptsTenants: boolean; probe: ClusterProbe }>;

export type ClusterOverview = Readonly<{
  clusters: readonly ClusterView[];
  totals: Readonly<{ tenants: number; capacity: number; fillPercent: number }>;
  openFindings: Readonly<Record<ClusterFinding["kind"], number>>;
}>;

export type NewClusterInput = Readonly<{
  id: string;
  name: string;
  host: string;
  port: number;
  maxTenants?: number;
  notes?: string | null;
}>;

export type FindingView = ClusterFinding & Readonly<{ droppable: boolean }>;

/**
 * Cluster management in the console (docs/27 §3.14, docs/22 §2.2, decisions 491–493): the
 * clusters with their capacity and a live look at each, adding one once its server is ready
 * for tenants, draining and retiring, where new tenants go, moving a tenant to another cluster
 * (four-eyes), and what the orphan sweep finds, with dropping an orphan database (four-eyes,
 * Super Admin) once it has waited long enough.
 */
export class ClusterManagement {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IPlatformUnitOfWork;
      registry: IClusterRegistry;
      probes: IClusterProbe;
      orphans: IOrphanDatabases;
      routing: IClusterRouting;
      approvals: ApprovalWorkflow;
      queue: IJobQueue;
      alerts: IAlerts;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async overview(): Promise<ClusterOverview> {
    const { deps } = this;
    const clusters = await deps.registry.list();
    const probes = await Promise.all(
      clusters.map((c) => (c.status === "retired" ? Promise.resolve(null) : deps.probes.probe(c))),
    );
    const views = clusters.map((c, i) => ({
      ...c,
      fillPercent: fillPercent(c),
      acceptsTenants: hasRoom(c),
      probe: probes[i] ?? RETIRED,
    }));
    const live = clusters.filter((c) => c.status !== "retired");
    const tenants = live.reduce((a, c) => a + c.tenants, 0);
    const capacity = live
      .filter((c) => c.status === "active")
      .reduce((a, c) => a + c.maxTenants, 0);
    const openFindings = { no_tenant: 0, moved_away: 0, stray_copy: 0, missing: 0 };
    for (const f of await deps.registry.findings({ open: true })) openFindings[f.kind] += 1;
    return {
      clusters: views,
      totals: {
        tenants,
        capacity,
        fillPercent: capacity === 0 ? 0 : Math.round((tenants / capacity) * 1000) / 10,
      },
      openFindings,
    };
  }

  async cluster(id: string): Promise<ClusterView> {
    const cluster = await this.require(id);
    return {
      ...cluster,
      fillPercent: fillPercent(cluster),
      acceptsTenants: hasRoom(cluster),
      probe: cluster.status === "retired" ? RETIRED : await this.deps.probes.probe(cluster),
    };
  }

  /** Registers a cluster whose server is ready (`yarn db:setup` and `yarn db:migrate` on it). */
  async add(actor: PlatformPrincipal, input: NewClusterInput): Promise<ClusterView> {
    const { deps } = this;
    const cluster = checkNewCluster({
      id: input.id,
      name: input.name,
      host: input.host,
      port: input.port,
      maxTenants: input.maxTenants ?? 1_000,
      notes: input.notes ?? null,
    });
    if ((await deps.registry.find(cluster.id)) !== null)
      throw new ClusterRuleError(`A cluster ${cluster.id} already exists`);
    const probe = await deps.probes.probe({ host: cluster.host, port: cluster.port });
    if (probe.problems.length > 0)
      throw new ClusterRuleError(`The server is not ready: ${probe.problems.join("; ")}`);
    await deps.unitOfWork.run(async () => {
      await deps.registry.create(cluster, actor.userId);
      await recordStaffAction(deps, actor, {
        action: "cluster.added",
        entityType: "cluster",
        entityId: cluster.id,
        after: { ...cluster, serverVersion: probe.serverVersion },
      });
    });
    return this.cluster(cluster.id);
  }

  async update(
    actor: PlatformPrincipal,
    id: string,
    changes: Readonly<{
      name?: string;
      status?: ClusterStatus;
      maxTenants?: number;
      notes?: string | null;
    }>,
  ): Promise<ClusterView> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const before = await this.require(id);
      if (changes.maxTenants !== undefined) checkMaxTenants(changes.maxTenants);
      if (changes.name !== undefined && changes.name.trim().length === 0)
        throw new ClusterRuleError("A cluster needs a name");
      if (changes.status !== undefined) checkStatusChange(before, changes.status);
      await deps.registry.update(id, {
        ...changes,
        ...(changes.name === undefined ? {} : { name: changes.name.trim() }),
      });
      await recordStaffAction(deps, actor, {
        action: "cluster.updated",
        entityType: "cluster",
        entityId: id,
        before: {
          name: before.name,
          status: before.status,
          maxTenants: before.maxTenants,
          notes: before.notes,
        },
        after: changes,
      });
    });
    return this.cluster(id);
  }

  /**
   * Puts a new tenant on the least full active cluster with room (decision 491), before its
   * database is created; a tenant that has one stays where it is. With no room anywhere the
   * provisioning step fails (retryable) and a critical alert asks for a cluster.
   */
  async place(tenantId: string): Promise<string> {
    const { deps } = this;
    const placed = await deps.unitOfWork.run(async () => {
      const tenant = await deps.registry.placement(tenantId);
      if (tenant === null) throw new ClusterRuleError("Unknown tenant");
      if (tenant.hasDatabase) return tenant.clusterId;
      const loads = await deps.registry.lockLoads();
      // Its own row already counts towards the cluster it was registered on (an archived
      // tenant's does not: it is coming back from cold archive).
      const counted = tenant.status !== "archived";
      const id = pickCluster(
        loads.map((l) =>
          counted && l.id === tenant.clusterId ? { ...l, tenants: l.tenants - 1 } : l,
        ),
      );
      if (id === null) return null;
      await deps.registry.place(tenantId, id);
      return id;
    });
    deps.routing.forget(tenantId);
    if (placed === null) {
      await deps.alerts.raise({
        key: "cluster.no_capacity",
        severity: "critical",
        source: "clusters",
        title: "No database cluster has room for new tenants",
        detail: { tenantId },
        runbook: "Add a cluster or raise a cluster's limit in Data operations → Clusters",
      });
      throw new ClusterRuleError("No database cluster has room for a new tenant");
    }
    await this.warnIfFull(placed);
    return placed;
  }

  /** Asks to move a tenant to another cluster; another staff member approves it (four-eyes). */
  async requestMove(
    actor: PlatformPrincipal,
    tenantId: string,
    input: Readonly<{ clusterId: string; reason: string; ticket?: string | null }>,
  ): Promise<string> {
    const { deps } = this;
    const tenant = await this.checkMove(tenantId, input.clusterId);
    if (input.reason.trim().length < 3) throw new ClusterRuleError("Give a reason for the move");
    return deps.approvals.request({
      action: MOVE_CLUSTER_ACTION,
      payload: { tenantId, toCluster: input.clusterId, reason: input.reason.trim() },
      summary: `Move ${tenant.slug} from ${tenant.clusterId} to ${input.clusterId} (offline while its data is copied)`,
      reason: input.reason,
      ticket: input.ticket ?? null,
      targetTenantId: tenantId,
      requestedBy: actor.userId,
    });
  }

  /** Runs once a move is approved: records it and queues the copy. */
  moveExecutor(): ApprovalExecutor {
    return {
      action: MOVE_CLUSTER_ACTION,
      approverSystemRole: null,
      execute: async (payload, context) => {
        const tenantId = String(payload.tenantId);
        const to = String(payload.toCluster);
        const tenant = await this.checkMove(tenantId, to);
        const moveId = await this.deps.registry.createMove({
          tenantId,
          from: tenant.clusterId,
          to,
          reason: String(payload.reason),
          approvalId: context.approvalId,
          requestedBy: context.requestedBy,
        });
        await this.deps.queue.enqueue("tenant.cluster_move", { moveId });
        return { moveId, from: tenant.clusterId, to };
      },
    };
  }

  moves(filter: Readonly<{ tenantId?: string; clusterId?: string; limit: number }>) {
    return this.deps.registry.moves(filter);
  }

  async move(id: string): Promise<ClusterMove> {
    const move = await this.deps.registry.findMove(id);
    if (move === null) throw new ClusterRuleError("Unknown cluster move");
    return move;
  }

  async findings(filter: Readonly<{ open: boolean; clusterId?: string }>): Promise<FindingView[]> {
    const now = this.deps.clock.now();
    return (await this.deps.registry.findings(filter)).map((f) => ({
      ...f,
      droppable: f.resolvedAt === null && droppable(f, now),
    }));
  }

  /** Asks to drop an orphan database; a Super Admin approves it (four-eyes). */
  async requestDrop(
    actor: PlatformPrincipal,
    clusterId: string,
    databaseName: string,
    input: Readonly<{ reason: string; ticket?: string | null }>,
  ): Promise<string> {
    const finding = await this.droppableFinding(clusterId, databaseName);
    return this.deps.approvals.request({
      action: DROP_DATABASE_ACTION,
      payload: { clusterId, databaseName },
      summary: `Drop ${finding.kind.replace("_", " ")} database ${databaseName} on ${clusterId} (cannot be undone)`,
      reason: input.reason,
      ticket: input.ticket ?? null,
      targetTenantId: finding.tenantId,
      requestedBy: actor.userId,
    });
  }

  dropExecutor(): ApprovalExecutor {
    return {
      action: DROP_DATABASE_ACTION,
      approverSystemRole: "super_admin",
      execute: async (payload, context) => {
        const clusterId = String(payload.clusterId);
        const databaseName = String(payload.databaseName);
        await this.droppableFinding(clusterId, databaseName);
        // A fresh look on the cluster decides, not the last sweep.
        if (!(await this.deps.orphans.drop(clusterId, databaseName)))
          throw new ClusterRuleError(`${databaseName} on ${clusterId} is no longer an orphan`);
        await this.deps.registry.dropped(
          clusterId,
          databaseName,
          context.approvedBy,
          this.deps.clock.now(),
        );
        return { clusterId, databaseName, dropped: true };
      },
    };
  }

  /**
   * The orphan sweep's results (decision 493), kept per cluster: new findings audited, a missing
   * database or an unreachable cluster raised at once as critical, orphans that waited past their
   * grace period raised as warnings to drop. Nothing is dropped.
   */
  async sweep(): Promise<Readonly<{ clusters: number; findings: number; fresh: number }>> {
    const { deps } = this;
    const sweeps = await deps.orphans.sweep();
    const now = deps.clock.now();
    const fresh = await deps.unitOfWork.run(() => deps.registry.recordSweep(sweeps, now));
    const orphans = fresh.filter((f) => f.kind !== "missing");
    if (orphans.length > 0) {
      deps.logger.warn("Tenant databases without a tenant on their cluster", {
        databases: orphans.map((f) => `${f.clusterId}/${f.databaseName}`),
      });
      await deps.audit.record({
        actorType: "system",
        action: "provisioning.orphan_databases_found",
        entityType: "cluster",
        after: {
          databases: orphans.map((f) => f.databaseName),
          findings: orphans.map((f) => ({
            cluster: f.clusterId,
            name: f.databaseName,
            kind: f.kind,
          })),
        },
      });
    }
    for (const sweep of sweeps)
      if (sweep.error !== null)
        await deps.alerts.raise({
          key: `cluster.unreachable:${sweep.clusterId}`,
          severity: "critical",
          source: "clusters",
          title: `Database cluster ${sweep.clusterId} does not answer`,
          detail: { error: sweep.error.slice(0, 500) },
        });
    const open = await deps.registry.findings({ open: true });
    for (const f of open.filter((x) => x.kind === "missing"))
      await deps.alerts.raise({
        key: `cluster.database_missing:${f.clusterId}:${f.databaseName}`,
        severity: "critical",
        source: "clusters",
        title: `The database of a tenant is missing from ${f.clusterId}`,
        detail: { databaseName: f.databaseName },
        tenantId: f.tenantId,
        runbook: "Restore the tenant's latest backup (docs/26 §6)",
      });
    const due = open.filter((f) => droppable(f, now));
    if (due.length > 0)
      await deps.alerts.raise({
        key: "cluster.orphans_due",
        severity: "warning",
        source: "clusters",
        title: `${due.length} orphan tenant databases can be dropped`,
        detail: { databases: due.map((f) => `${f.clusterId}/${f.databaseName}`).slice(0, 50) },
      });
    return {
      clusters: sweeps.length,
      findings: sweeps.reduce((a, s) => a + s.findings.length, 0),
      fresh: fresh.length,
    };
  }

  private async checkMove(tenantId: string, to: string) {
    const { registry } = this.deps;
    const tenant = await registry.placement(tenantId);
    if (tenant === null) throw new ClusterRuleError("Unknown tenant");
    const target = await registry.find(to);
    checkMove(tenant, target, (await registry.openMove(tenantId)) !== null);
    return tenant;
  }

  private async droppableFinding(clusterId: string, databaseName: string) {
    const finding = await this.deps.registry.finding(clusterId, databaseName);
    if (finding === null || finding.resolvedAt !== null)
      throw new ClusterRuleError("The sweep does not report this database");
    if (!droppable(finding, this.deps.clock.now()))
      throw new ClusterRuleError(
        finding.kind === "missing"
          ? "A missing database cannot be dropped"
          : finding.kind === "moved_away"
            ? `The old database is kept until ${finding.retainedUntil ?? "its move completes"}`
            : "An orphan database is kept 14 days after it is first seen",
      );
    return finding;
  }

  private async warnIfFull(clusterId: string): Promise<void> {
    const cluster = await this.deps.registry.find(clusterId);
    if (cluster !== null && fillPercent(cluster) >= CAPACITY_WARNING_PERCENT)
      await this.deps.alerts.raise({
        key: `cluster.capacity:${clusterId}`,
        severity: "warning",
        source: "clusters",
        title: `Cluster ${clusterId} is ${fillPercent(cluster)} % full`,
        detail: { tenants: cluster.tenants, maxTenants: cluster.maxTenants },
        runbook: "Add a cluster before this one fills up (docs/22 §2.2)",
      });
  }

  private async require(id: string): Promise<ClusterRecord> {
    const cluster = await this.deps.registry.find(id);
    if (cluster === null) throw new ClusterRuleError("Unknown cluster");
    return cluster;
  }
}

const RETIRED: ClusterProbe = {
  reachable: false,
  latencyMs: null,
  serverVersion: null,
  connections: null,
  maxConnections: null,
  tenantDatabaseBytes: null,
  templateVersion: null,
  problems: [],
  error: null,
};
