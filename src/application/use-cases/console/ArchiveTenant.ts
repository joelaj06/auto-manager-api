import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { IClock } from "../../ports/IClock.js";
import type { IClusterRouting } from "../../ports/IClusterRegistry.js";
import type { IColdArchiveVault } from "../../ports/IColdArchiveVault.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { ITenantArchives } from "../../ports/ITenantArchives.js";
import type { ITenantDatabaseMover } from "../../ports/ITenantDatabaseMover.js";
import type { IAlerts } from "./PlatformAlerts.js";

/** The tenant status changes of archiving (the lifecycle service). */
export type ArchiveTransitions = Readonly<{
  archive(tenantId: string, reason: string): Promise<void>;
  unarchive(tenantId: string, reason: string): Promise<void>;
}>;

/**
 * An approved cold archive (decision 495):
 *
 *   queued → archiving → archived   (or failed: the database reopened, nothing lost)
 *
 * The tenant's database is closed to the app, dumped encrypted and checked as it is written
 * (restored into a scratch database and compared), the files its records point at listed; the
 * tenant then becomes archived, has no database any more, and the live database is dropped.
 * A worker lost mid-way is retried: before the tenant is archived everything is done again;
 * after, only the drop is finished.
 */
export class ArchiveTenant implements IJobHandler<"tenant.archive"> {
  readonly job = "tenant.archive" as const;

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IPlatformUnitOfWork;
      archives: ITenantArchives;
      mover: ITenantDatabaseMover;
      vault: IColdArchiveVault;
      lifecycle: ArchiveTransitions;
      routing: IClusterRouting;
      audit: IPlatformAuditTrail;
      alerts: IAlerts;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async handle({ archiveId }: JobPayloads["tenant.archive"]): Promise<void> {
    const { deps } = this;
    const archive = await deps.archives.find(archiveId);
    // Created in the approval's transaction: not visible yet, try again.
    if (archive === null) throw new Error(`Archive ${archiveId} not found`);
    const tenant = await deps.archives.tenant(archive.tenantId);
    if (tenant === null) throw new Error(`Tenant ${archive.tenantId} not found`);
    const clusterId = archive.clusterId ?? tenant.clusterId;

    if (archive.status === "archived") {
      await this.dropLive(archive.tenantId, clusterId);
      return;
    }
    if (archive.status !== "queued" && archive.status !== "archiving") return;
    // A worker lost after the tenant was marked archived: its database is still there, closed.
    const resumed = archive.status === "archiving" && tenant.status === "archived";
    if ((tenant.status !== "deactivated" && !resumed) || !tenant.hasDatabase || tenant.moving) {
      await this.fail(
        archiveId,
        archive.tenantId,
        clusterId,
        "The tenant is no longer archivable",
        false,
      );
      return;
    }

    let sealed;
    try {
      await deps.archives.update(archiveId, {
        status: "archiving",
        clusterId,
        startedAt: deps.clock.now(),
      });
      await deps.mover.close(archive.tenantId, clusterId);
      sealed = await deps.vault.seal(archive.tenantId, clusterId);
    } catch (error) {
      await this.fail(archiveId, archive.tenantId, clusterId, error, true);
      return;
    }

    if (!resumed) await deps.lifecycle.archive(archive.tenantId, archive.reason);
    const now = deps.clock.now();
    await deps.unitOfWork.run(async () => {
      await deps.archives.setDatabase(archive.tenantId, null);
      await deps.archives.update(archiveId, {
        status: "archived",
        backupId: sealed.backupId,
        files: sealed.files,
        report: {
          tables: sealed.tables,
          rows: sealed.rows,
          sizeBytes: sealed.sizeBytes,
          schemaVersion: sealed.schemaVersion,
          checks: sealed.checks,
        },
        archivedAt: now,
        error: null,
      });
      await deps.audit.record({
        actorType: "system",
        action: "tenant.cold_archived",
        entityType: "tenant",
        entityId: archive.tenantId,
        targetTenantId: archive.tenantId,
        after: {
          archiveId,
          backupId: sealed.backupId,
          sizeBytes: sealed.sizeBytes,
          rows: sealed.rows,
          files: sealed.files.count,
        },
        metadata: { requestedBy: archive.requestedBy, approvalId: archive.approvalId },
      });
    });
    await this.dropLive(archive.tenantId, clusterId);
    deps.logger.info("Tenant moved to cold archive", {
      tenantId: archive.tenantId,
      archiveId,
      sizeBytes: sealed.sizeBytes,
    });
  }

  private async dropLive(tenantId: string, clusterId: string): Promise<void> {
    await this.deps.vault.dropDatabase(tenantId, clusterId);
    this.deps.routing.forget(tenantId);
  }

  private async fail(
    archiveId: string,
    tenantId: string,
    clusterId: string,
    error: unknown,
    reopen: boolean,
  ): Promise<void> {
    const { deps } = this;
    const reason = error instanceof Error ? error.message : String(error);
    deps.logger.error("Cold archive failed", { archiveId, tenantId, error: reason });
    if (reopen)
      await deps.mover.open(tenantId, clusterId).catch((e: unknown) =>
        deps.logger.error("Could not reopen the database after a failed archive", {
          archiveId,
          error: e,
        }),
      );
    await deps.archives.update(archiveId, { status: "failed", error: reason.slice(0, 2_000) });
    await deps.audit.record({
      actorType: "system",
      action: "tenant.cold_archive_failed",
      entityType: "tenant",
      entityId: tenantId,
      targetTenantId: tenantId,
      after: { archiveId, error: reason.slice(0, 500) },
    });
    await deps.alerts.raise({
      key: `archive.failed:${archiveId}`,
      severity: "warning",
      source: "backups",
      title: "Moving a tenant to cold archive failed; its database is untouched",
      detail: { archiveId, error: reason.slice(0, 500) },
      tenantId,
    });
  }
}
