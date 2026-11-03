import {
  ArchiveRuleError,
  checkArchive,
  RESTORE_WAITING_ALERT_DAYS,
  type ArchiveStatus,
  ARCHIVE_VERIFY_EVERY_DAYS,
} from "../../../domain/console/ColdArchive.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { IClock } from "../../ports/IClock.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ITenantArchives, TenantArchive } from "../../ports/ITenantArchives.js";
import type { ApprovalExecutor, ApprovalWorkflow } from "../platform/ApprovalWorkflow.js";

export const ARCHIVE_ACTION = "tenant.archive_cold";
export const RESTORE_ARCHIVE_ACTION = "tenant.restore_cold_archive";

const DAY_MS = 86_400_000;

/**
 * Cold archive in the console (docs/27 §3.3, docs/26 §8, decisions 495–497): moving a tenant
 * deactivated for a year to cold archive and bringing it back, each approved by a second staff
 * member. Archiving is done by the server (`tenant.archive`); restoring needs the backup private
 * key, so once approved it is carried out by an operator (`yarn archive restore`).
 */
export class ColdArchives {
  constructor(
    private readonly deps: Readonly<{
      archives: ITenantArchives;
      approvals: ApprovalWorkflow;
      queue: IJobQueue;
      clock: IClock;
    }>,
  ) {}

  list(filter: Readonly<{ status?: ArchiveStatus; tenantId?: string; limit: number }>) {
    return this.deps.archives.list(filter);
  }

  async archive(id: string): Promise<TenantArchive> {
    const archive = await this.deps.archives.find(id);
    if (archive === null) throw new ArchiveRuleError("Unknown archive");
    return archive;
  }

  /** Asks to archive a tenant deactivated for at least a year; another staff member approves. */
  async requestArchive(
    actor: PlatformPrincipal,
    tenantId: string,
    input: Readonly<{ reason: string; ticket?: string | null }>,
  ): Promise<string> {
    const tenant = await this.checkArchivable(tenantId);
    return this.deps.approvals.request({
      action: ARCHIVE_ACTION,
      payload: { tenantId, reason: input.reason.trim() },
      summary: `Move ${tenant.slug} to cold archive (its live database is dropped once the archive is checked)`,
      reason: input.reason,
      ticket: input.ticket ?? null,
      targetTenantId: tenantId,
      requestedBy: actor.userId,
    });
  }

  archiveExecutor(): ApprovalExecutor {
    return {
      action: ARCHIVE_ACTION,
      approverSystemRole: null,
      execute: async (payload, context) => {
        const tenantId = String(payload.tenantId);
        await this.checkArchivable(tenantId);
        const archiveId = await this.deps.archives.create({
          tenantId,
          reason: String(payload.reason),
          approvalId: context.approvalId,
          requestedBy: context.requestedBy,
        });
        await this.deps.queue.enqueue("tenant.archive", { archiveId });
        return { archiveId };
      },
    };
  }

  /**
   * Asks to bring an archived tenant back; once another staff member approves, an operator
   * restores it with the backup private key (`yarn archive restore`).
   */
  async requestRestore(
    actor: PlatformPrincipal,
    tenantId: string,
    input: Readonly<{ reason: string; ticket?: string | null }>,
  ): Promise<string> {
    const archive = await this.checkRestorable(tenantId);
    return this.deps.approvals.request({
      action: RESTORE_ARCHIVE_ACTION,
      payload: { tenantId, archiveId: archive.id, reason: input.reason.trim() },
      summary: `Restore ${archive.slug} from cold archive (deactivated afterwards, until restored)`,
      reason: input.reason,
      ticket: input.ticket ?? null,
      targetTenantId: tenantId,
      requestedBy: actor.userId,
    });
  }

  restoreExecutor(): ApprovalExecutor {
    return {
      action: RESTORE_ARCHIVE_ACTION,
      approverSystemRole: null,
      execute: async (payload, context) => {
        const archive = await this.checkRestorable(String(payload.tenantId));
        await this.deps.archives.update(archive.id, {
          restoreReason: String(payload.reason),
          restoreApprovalId: context.approvalId,
          restoreRequestedBy: context.requestedBy,
          restoreApprovedAt: this.deps.clock.now(),
        });
        return { archiveId: archive.id, next: "yarn archive restore" };
      },
    };
  }

  /** What needs an operator: yearly restore tests due, approved restores not carried out. */
  async attention(): Promise<
    Readonly<{ verificationDue: TenantArchive[]; restoresWaiting: TenantArchive[] }>
  > {
    const now = this.deps.clock.now().getTime();
    return {
      verificationDue: await this.deps.archives.verifiedBefore(
        new Date(now - ARCHIVE_VERIFY_EVERY_DAYS * DAY_MS),
        100,
      ),
      restoresWaiting: await this.deps.archives.restoresWaiting(
        new Date(now - RESTORE_WAITING_ALERT_DAYS * DAY_MS),
      ),
    };
  }

  private async checkArchivable(tenantId: string) {
    const { archives, clock } = this.deps;
    const tenant = await archives.tenant(tenantId);
    if (tenant === null) throw new ArchiveRuleError("Unknown tenant");
    checkArchive(tenant, (await archives.current(tenantId)) !== null, clock.now());
    return tenant;
  }

  private async checkRestorable(tenantId: string): Promise<TenantArchive> {
    const archive = await this.deps.archives.current(tenantId);
    if (archive?.status !== "archived") throw new ArchiveRuleError("The tenant is not archived");
    if (archive.restoreApprovedAt !== null)
      throw new ArchiveRuleError("A restore is already approved and waiting for an operator");
    return archive;
  }
}
