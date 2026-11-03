import { ErasureRuleError, type ErasureSubject } from "../../../domain/console/ColdArchive.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { IClock } from "../../ports/IClock.js";
import type { IErasureLedger, ErasureEntry } from "../../ports/IErasureLedger.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ILogger } from "../../ports/ILogger.js";
import type {
  ErasureTarget,
  IPersonalDataEraser,
  SubjectPreview,
} from "../../ports/IPersonalDataEraser.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { ITenantArchives } from "../../ports/ITenantArchives.js";
import type { ApprovalExecutor, ApprovalWorkflow } from "../platform/ApprovalWorkflow.js";

export const ERASE_ACTION = "tenant.erase_personal_data";

export type ErasureRequest = Readonly<{
  subjectType: ErasureSubject;
  subjectId: string;
  /** The data-protection request it answers. */
  requestId?: string | null;
  reason: string;
  ticket?: string | null;
}>;

/**
 * Erasure by anonymisation (docs/26 §8, docs/27 §3.15, decision 498): staff look up the person,
 * ask, and a Super Admin approves; the approval enters the erasure ledger and the job anonymises
 * the person in the tenant's database. The ledger is applied again to every restored backup or
 * archive of the tenant, so erased data does not come back.
 */
export class PersonalDataErasure {
  constructor(
    private readonly deps: Readonly<{
      ledger: IErasureLedger;
      eraser: IPersonalDataEraser;
      archives: ITenantArchives;
      approvals: ApprovalWorkflow;
      queue: IJobQueue;
      audit: IPlatformAuditTrail;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  /** The person as they are now, for staff to check before asking. */
  async preview(
    tenantId: string,
    subject: Readonly<{ type: ErasureSubject; id: string }>,
  ): Promise<SubjectPreview & Readonly<{ erasure: ErasureEntry | null }>> {
    await this.requireDatabase(tenantId);
    const preview = await this.deps.eraser.preview({ tenantId }, subject);
    return {
      ...preview,
      erasure: await this.deps.ledger.findSubject(tenantId, subject.type, subject.id),
    };
  }

  async request(
    actor: PlatformPrincipal,
    tenantId: string,
    input: ErasureRequest,
  ): Promise<string> {
    const subject = { type: input.subjectType, id: input.subjectId };
    const preview = await this.checkErasable(tenantId, subject);
    return this.deps.approvals.request({
      action: ERASE_ACTION,
      payload: {
        tenantId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        requestId: input.requestId ?? null,
        reason: input.reason.trim(),
      },
      // The reference only: names do not go into the platform's records.
      summary: `Erase the personal data of ${input.subjectType} ${preview.reference ?? input.subjectId} (cannot be undone)`,
      reason: input.reason,
      ticket: input.ticket ?? null,
      targetTenantId: tenantId,
      requestedBy: actor.userId,
    });
  }

  executor(): ApprovalExecutor {
    return {
      action: ERASE_ACTION,
      approverSystemRole: "super_admin",
      execute: async (payload, context) => {
        const tenantId = String(payload.tenantId);
        const subjectType = String(payload.subjectType) as ErasureSubject;
        const subjectId = String(payload.subjectId);
        await this.checkErasable(tenantId, { type: subjectType, id: subjectId });
        const erasureId = await this.deps.ledger.create({
          tenantId,
          subjectType,
          subjectId,
          requestId: typeof payload.requestId === "string" ? payload.requestId : null,
          reason: String(payload.reason),
          approvalId: context.approvalId,
          requestedBy: context.requestedBy,
          approvedBy: context.approvedBy,
        });
        await this.deps.queue.enqueue("tenant.erasure", { erasureId });
        return { erasureId };
      },
    };
  }

  list(filter: Readonly<{ tenantId?: string; requestId?: string; limit: number }>) {
    return this.deps.ledger.list(filter);
  }

  /**
   * Applies the tenant's whole ledger, oldest first, to `target` (the tenant's database brought
   * back from archive, or a backup restored beside it): pending erasures are applied, applied
   * ones applied again.
   */
  async reapply(target: ErasureTarget): Promise<Readonly<{ applied: number; reapplied: number }>> {
    const { deps } = this;
    let applied = 0;
    let reapplied = 0;
    for (const entry of await deps.ledger.forTenant(target.tenantId)) {
      const report = await deps.eraser.erase(target, {
        type: entry.subjectType,
        id: entry.subjectId,
      });
      const now = deps.clock.now();
      if (entry.status === "pending" && target.database === undefined) {
        await deps.ledger.applied(entry.id, report, now);
        applied++;
      } else {
        await deps.ledger.reapplied(entry.id, now);
        reapplied++;
      }
    }
    if (applied + reapplied > 0)
      await deps.audit.record({
        actorType: "system",
        action: "tenant.erasures_reapplied",
        entityType: "tenant",
        entityId: target.tenantId,
        targetTenantId: target.tenantId,
        after: { applied, reapplied, database: target.database?.name ?? null },
      });
    return { applied, reapplied };
  }

  private async checkErasable(
    tenantId: string,
    subject: Readonly<{ type: ErasureSubject; id: string }>,
  ): Promise<SubjectPreview> {
    if ((await this.deps.ledger.findSubject(tenantId, subject.type, subject.id)) !== null)
      throw new ErasureRuleError("This person's data is already erased or waiting to be");
    await this.requireDatabase(tenantId);
    const preview = await this.deps.eraser.preview({ tenantId }, subject);
    if (!preview.found) throw new ErasureRuleError(`No such ${subject.type} in this tenant`);
    if (preview.blockedBy !== null) throw new ErasureRuleError(preview.blockedBy);
    return preview;
  }

  /** The person must be looked up first: an archived tenant is restored before erasing. */
  private async requireDatabase(tenantId: string): Promise<void> {
    const tenant = await this.deps.archives.tenant(tenantId);
    if (tenant === null) throw new ErasureRuleError("Unknown tenant");
    if (!tenant.hasDatabase)
      throw new ErasureRuleError(
        tenant.status === "archived"
          ? "The tenant is in cold archive: restore it to erase someone's data"
          : "The tenant has no database",
      );
  }
}

/**
 * An approved erasure applied to the tenant's database (decision 498). Waits while the tenant is
 * moving; left pending when the tenant was archived in the meantime (applied on its restore).
 */
export class ApplyErasure implements IJobHandler<"tenant.erasure"> {
  readonly job = "tenant.erasure" as const;

  constructor(
    private readonly deps: Readonly<{
      ledger: IErasureLedger;
      eraser: IPersonalDataEraser;
      archives: ITenantArchives;
      audit: IPlatformAuditTrail;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async handle({ erasureId }: JobPayloads["tenant.erasure"]): Promise<void> {
    const { deps } = this;
    const entry = await deps.ledger.find(erasureId);
    if (entry === null) throw new Error(`Erasure ${erasureId} not found`);
    if (entry.status === "applied") return;
    const tenant = await deps.archives.tenant(entry.tenantId);
    if (tenant === null) throw new Error(`Tenant ${entry.tenantId} not found`);
    if (tenant.moving) throw new Error("The tenant is moving to another cluster; trying again");
    if (!tenant.hasDatabase) {
      deps.logger.info("Erasure left pending until the tenant is restored", { erasureId });
      return;
    }
    let report;
    try {
      report = await deps.eraser.erase(
        { tenantId: entry.tenantId },
        { type: entry.subjectType, id: entry.subjectId },
      );
    } catch (error) {
      await deps.ledger.failed(erasureId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    await deps.ledger.applied(erasureId, report, deps.clock.now());
    await deps.audit.record({
      actorType: "system",
      action: "tenant.personal_data_erased",
      entityType: entry.subjectType,
      entityId: entry.subjectId,
      targetTenantId: entry.tenantId,
      after: { erasureId, tables: report.tables, filesRemoved: report.filesRemoved },
      metadata: {
        requestId: entry.requestId,
        requestedBy: entry.requestedBy,
        approvedBy: entry.approvedBy,
      },
    });
    deps.logger.info("Personal data erased", { erasureId, tenantId: entry.tenantId });
  }
}
