import { MOVED_SOURCE_RETENTION_DAYS } from "../../../domain/console/Clusters.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { IClock } from "../../ports/IClock.js";
import type { IClusterRegistry, IClusterRouting } from "../../ports/IClusterRegistry.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { ITenantDatabaseMover } from "../../ports/ITenantDatabaseMover.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type { IAlerts } from "./PlatformAlerts.js";
import type { TenantLoginPlacement } from "./TenantDatabaseLogins.js";

const DAY_MS = 86_400_000;

/**
 * An approved move of a tenant's database to another cluster (decision 492):
 *
 *   queued → blocking → copying → switching → completed   (or failed, undone)
 *
 * Blocking marks the tenant moving — its users get 503 TENANT_MOVING and its jobs wait — and,
 * once every process has seen that, closes the old database to the app and ends its sessions.
 * Copying dumps it, restores it on the new cluster and compares the two; the copy is then opened.
 * Switching points the tenant at the new cluster and, once every process routes there, brings
 * the tenant back. The old database is kept, closed, for 14 days.
 *
 * A failure before the switch reopens the old database, drops the copy and brings the tenant
 * back where it was; the move is failed with the reason and an alert. A worker lost mid-way is
 * retried and resumes: blocking and copying are repeated, a switch is finished.
 */
export class MoveTenantToCluster implements IJobHandler<"tenant.cluster_move"> {
  readonly job = "tenant.cluster_move" as const;

  constructor(
    private readonly deps: Readonly<{
      registry: IClusterRegistry;
      mover: ITenantDatabaseMover;
      directory: ITenantDirectory;
      routing: IClusterRouting;
      audit: IPlatformAuditTrail;
      alerts: IAlerts;
      clock: IClock;
      logger: ILogger;
      /** How long until every process sees a change of the tenant (its caches' lifetime). */
      settleMs: number;
      wait: (ms: number) => Promise<void>;
      /** A tenant with its own database login takes it along (decision 532). */
      logins?: Pick<TenantLoginPlacement, "prepareOn" | "removeFrom">;
    }>,
  ) {}

  async handle({ moveId }: JobPayloads["tenant.cluster_move"]): Promise<void> {
    const { deps } = this;
    const move = await deps.registry.findMove(moveId);
    // Created in the approval's transaction: not visible yet, try again.
    if (move === null) throw new Error(`Cluster move ${moveId} not found`);
    if (move.status === "completed" || move.status === "failed") return;
    const placement = await deps.registry.placement(move.tenantId);
    if (placement === null) throw new Error(`Tenant ${move.tenantId} not found`);

    const started = deps.clock.now();
    const switched = placement.clusterId === move.to;
    if (!switched) {
      try {
        await deps.registry.updateMove(moveId, { status: "blocking", startedAt: started });
        await this.offline(move.tenantId, started);
        await deps.mover.close(move.tenantId, move.from);
        await deps.registry.updateMove(moveId, { status: "copying" });
        const report = await deps.mover.copy(move.tenantId, move.from, move.to);
        await deps.logins?.prepareOn(move.tenantId, move.to);
        await deps.mover.open(move.tenantId, move.to);
        await deps.registry.updateMove(moveId, { status: "switching", report });
        await deps.registry.switchTenant(move.tenantId, move.to);
      } catch (error) {
        await this.undo(moveId, move.tenantId, move.from, move.to, error);
        return;
      }
    }

    // Every process routes to the new cluster before the tenant is back.
    this.forget(move.tenantId);
    await deps.wait(deps.settleMs);
    await deps.registry.setMoving(move.tenantId, null);
    this.forget(move.tenantId);
    await deps.logins?.removeFrom(move.tenantId, move.from);
    const finished = deps.clock.now();
    const fresh = await deps.registry.findMove(moveId);
    await deps.registry.updateMove(moveId, {
      status: "completed",
      finishedAt: finished,
      sourceRetainedUntil: new Date(finished.getTime() + MOVED_SOURCE_RETENTION_DAYS * DAY_MS)
        .toISOString()
        .slice(0, 10),
      report: {
        ...(fresh?.report ?? {}),
        offlineSeconds: Math.round(
          (finished.getTime() - (fresh?.startedAt ?? started).getTime()) / 1000,
        ),
      },
    });
    await deps.audit.record({
      actorType: "system",
      action: "tenant.cluster_moved",
      entityType: "tenant",
      entityId: move.tenantId,
      targetTenantId: move.tenantId,
      before: { cluster: move.from },
      after: { cluster: move.to },
      metadata: { moveId, requestedBy: move.requestedBy },
    });
    deps.logger.info("Tenant moved to another cluster", {
      tenantId: move.tenantId,
      from: move.from,
      to: move.to,
    });
  }

  /** The tenant stops working everywhere: marked moving, then the caches' lifetime. */
  private async offline(tenantId: string, since: Date): Promise<void> {
    await this.deps.registry.setMoving(tenantId, since);
    this.forget(tenantId);
    await this.deps.wait(this.deps.settleMs);
  }

  private forget(tenantId: string): void {
    this.deps.directory.invalidate();
    this.deps.routing.forget(tenantId);
  }

  private async undo(
    moveId: string,
    tenantId: string,
    from: string,
    to: string,
    error: unknown,
  ): Promise<void> {
    const { deps } = this;
    const reason = error instanceof Error ? error.message : String(error);
    deps.logger.error("Cluster move failed; undoing it", { moveId, tenantId, error: reason });
    // Best effort each: the tenant must come back on its old cluster whatever else fails.
    await deps.mover.open(tenantId, from).catch((e: unknown) =>
      deps.logger.error("Could not reopen the database after a failed move", {
        moveId,
        error: e,
      }),
    );
    await deps.mover
      .discard(tenantId, to)
      .catch((e: unknown) =>
        deps.logger.warn("Could not drop the copy of a failed move", { moveId, error: e }),
      );
    await deps.registry.setMoving(tenantId, null);
    this.forget(tenantId);
    await deps.registry.updateMove(moveId, {
      status: "failed",
      error: reason.slice(0, 2_000),
      finishedAt: deps.clock.now(),
    });
    await deps.audit.record({
      actorType: "system",
      action: "tenant.cluster_move_failed",
      entityType: "tenant",
      entityId: tenantId,
      targetTenantId: tenantId,
      after: { from, to, error: reason.slice(0, 500) },
      metadata: { moveId },
    });
    await deps.alerts.raise({
      key: `cluster.move_failed:${moveId}`,
      severity: "warning",
      source: "clusters",
      title: `Moving a tenant from ${from} to ${to} failed; it is back on ${from}`,
      detail: { moveId, error: reason.slice(0, 500) },
      tenantId,
    });
  }
}
