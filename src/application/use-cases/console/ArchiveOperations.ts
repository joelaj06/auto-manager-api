import { ArchiveRuleError } from "../../../domain/console/ColdArchive.js";
import type { IClock } from "../../ports/IClock.js";
import type { IClusterRouting } from "../../ports/IClusterRegistry.js";
import type { IArchiveKeyVault, VaultReport } from "../../ports/IColdArchiveVault.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { ITenantArchives, TenantArchive } from "../../ports/ITenantArchives.js";
import type { ArchiveTransitions } from "./ArchiveTenant.js";
import type { IAlerts } from "./PlatformAlerts.js";

export type ArchiveVerification = Readonly<{
  archiveId: string;
  slug: string;
  report: VaultReport | null;
  error: string | null;
}>;

/**
 * What an operator holding the backup private key does with archives (`yarn archive`, docs/31):
 * the yearly restore test (decision 497), the approved restore of a tenant (decision 496) and
 * encrypting archives again for a new key. Each is audited as the system, with the operator's
 * name.
 */
export class ArchiveOperations {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IPlatformUnitOfWork;
      archives: ITenantArchives;
      vault: IArchiveKeyVault;
      /** Where the tenant's database goes back (the least full cluster). */
      placement: Readonly<{ place(tenantId: string): Promise<string> }>;
      erasures: Readonly<{
        reapply(
          target: Readonly<{ tenantId: string }>,
        ): Promise<Readonly<{ applied: number; reapplied: number }>>;
      }>;
      lifecycle: ArchiveTransitions;
      routing: IClusterRouting;
      audit: IPlatformAuditTrail;
      alerts: IAlerts;
      clock: IClock;
      logger: ILogger;
      /** The tenant database name (for the platform record once restored). */
      databaseNameOf: (tenantId: string) => string;
    }>,
  ) {}

  /**
   * Restores archives into a scratch database, migrates them to this release and checks them:
   * the given archives, or those due (not tested for a year).
   */
  async verify(
    operator: string,
    which: Readonly<{ archiveIds?: readonly string[]; due?: number }>,
  ): Promise<ArchiveVerification[]> {
    const { deps } = this;
    const archives =
      which.archiveIds !== undefined
        ? await Promise.all(which.archiveIds.map((id) => this.require(id)))
        : await deps.archives.verifiedBefore(
            new Date(deps.clock.now().getTime() - 365 * 86_400_000),
            which.due ?? 10,
          );
    const results: ArchiveVerification[] = [];
    for (const archive of archives) {
      if (archive.status !== "archived" || archive.backupId === null) {
        results.push({
          archiveId: archive.id,
          slug: archive.slug,
          report: null,
          error: "Not archived",
        });
        continue;
      }
      try {
        const report = await deps.vault.verify(archive.backupId);
        const now = deps.clock.now();
        await deps.archives.update(archive.id, {
          ...(report.passed ? { lastVerifiedAt: now } : {}),
          lastVerification: { ...report, operator, at: now.toISOString() },
        });
        await this.audit("tenant.cold_archive_verified", archive, operator, {
          passed: report.passed,
          migratedTo: report.migratedTo,
        });
        if (!report.passed) await this.alertFailed(archive, report);
        results.push({ archiveId: archive.id, slug: archive.slug, report, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ archiveId: archive.id, slug: archive.slug, report: null, error: message });
      }
    }
    return results;
  }

  /**
   * Brings an archived tenant back once a restore was approved (decision 496): its database is
   * restored on the least full cluster, migrated to this release, checked and opened; the
   * erasure ledger is applied to it; the tenant is deactivated again, for staff to restore. A
   * failed restore leaves no database and the archive as it was.
   */
  async restore(
    tenantId: string,
    operator: string,
  ): Promise<Readonly<{ archive: TenantArchive; report: VaultReport; clusterId: string }>> {
    const { deps } = this;
    const archive = await deps.archives.current(tenantId);
    if (archive?.status !== "archived" || archive.backupId === null)
      throw new ArchiveRuleError("The tenant is not in cold archive");
    if (archive.restoreApprovedAt === null)
      throw new ArchiveRuleError(
        "No approved restore: ask for it in the console and have it approved first",
      );
    await deps.archives.update(archive.id, {
      status: "restoring",
      restoreStartedAt: deps.clock.now(),
    });
    let clusterId: string | null = null;
    let report: VaultReport;
    try {
      clusterId = await deps.placement.place(tenantId);
      report = await deps.vault.unseal(tenantId, archive.backupId, clusterId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.archives.update(archive.id, {
        status: "archived",
        restoreStartedAt: null,
        restoreReport: { error: message, operator, at: deps.clock.now().toISOString() },
      });
      await this.audit("tenant.cold_archive_restore_failed", archive, operator, {
        error: message.slice(0, 500),
      });
      throw error;
    }

    await deps.archives.setDatabase(tenantId, deps.databaseNameOf(tenantId));
    deps.routing.forget(tenantId);
    // Erasures made before or during the archive must not come back (decision 498).
    const erasures = await deps.erasures.reapply({ tenantId });
    await deps.lifecycle.unarchive(tenantId, archive.restoreReason ?? "Restored from cold archive");
    const now = deps.clock.now();
    await deps.unitOfWork.run(async () => {
      await deps.archives.update(archive.id, {
        status: "restored",
        restoredAt: now,
        restoredByOperator: operator,
        restoreReport: { ...report, clusterId, erasures },
      });
      await this.audit("tenant.cold_archive_restored", archive, operator, {
        clusterId,
        migratedTo: report.migratedTo,
        erasures,
      });
    });
    deps.logger.info("Tenant restored from cold archive", { tenantId, clusterId });
    return { archive: (await deps.archives.find(archive.id))!, report, clusterId };
  }

  /** Encrypts archives again for the current public key (keys are rotated). */
  async rekey(
    operator: string,
    which: Readonly<{ archiveIds?: readonly string[]; limit?: number }>,
  ): Promise<
    Readonly<{ archiveId: string; slug: string; backupId: string | null; error: string | null }>[]
  > {
    const { deps } = this;
    const current = deps.vault.currentKeyFingerprint();
    const archives =
      which.archiveIds !== undefined
        ? await Promise.all(which.archiveIds.map((id) => this.require(id)))
        : await deps.archives.encryptedForOtherKeys(current, which.limit ?? 50);
    const results = [];
    for (const archive of archives) {
      if (archive.status !== "archived" || archive.backupId === null) continue;
      if (archive.keyFingerprint === current && which.archiveIds === undefined) continue;
      try {
        const rekeyed = await deps.vault.rekey(archive.backupId);
        await deps.archives.update(archive.id, {
          backupId: rekeyed.backupId,
          rekeyedAt: deps.clock.now(),
        });
        await this.audit("tenant.cold_archive_rekeyed", archive, operator, {
          from: archive.backupId,
          to: rekeyed.backupId,
          keyFingerprint: rekeyed.keyFingerprint,
        });
        results.push({
          archiveId: archive.id,
          slug: archive.slug,
          backupId: rekeyed.backupId,
          error: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ archiveId: archive.id, slug: archive.slug, backupId: null, error: message });
      }
    }
    return results;
  }

  private async require(id: string): Promise<TenantArchive> {
    const archive = await this.deps.archives.find(id);
    if (archive === null) throw new ArchiveRuleError(`Unknown archive ${id}`);
    return archive;
  }

  private audit(
    action: string,
    archive: TenantArchive,
    operator: string,
    after: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    return this.deps.audit.record({
      actorType: "system",
      action,
      entityType: "tenant",
      entityId: archive.tenantId,
      targetTenantId: archive.tenantId,
      after: { archiveId: archive.id, ...after },
      metadata: { operator },
    });
  }

  private async alertFailed(archive: TenantArchive, report: VaultReport): Promise<void> {
    await this.deps.alerts.raise({
      key: `archive.verification_failed:${archive.id}`,
      severity: "critical",
      source: "backups",
      title: `The restore test of ${archive.slug}'s cold archive failed`,
      detail: {
        archiveId: archive.id,
        failed: report.checks.filter((c) => !c.passed).map((c) => c.name),
      },
      tenantId: archive.tenantId,
      runbook: "docs/31 cold archive",
    });
  }
}
