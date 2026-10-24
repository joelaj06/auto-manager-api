import type {
  BranchReconciliation as Reconciliation,
  IBranchReconciliationRepository,
  OverLimitTenant,
  ReconciliationOutcome,
} from "../../../domain/repositories/IBranchReconciliationRepository.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { IBranches } from "../../ports/IBranches.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantRoster } from "../../ports/ITenantRoster.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordStaffAction } from "../console/consoleAudit.js";
import type { IAlerts } from "../console/PlatformAlerts.js";
import type { BranchEntitlements } from "./BranchEntitlements.js";

const PAGE = 200;

/**
 * The nightly billing-vs-actual reconcile (docs/22 §2.7, docs/27 §3.5): the tenant database is
 * the source of truth for active branches; each usable tenant's billed count is compared with
 * it. A trial follows its branches and nobody is billed for more branches than are active;
 * more active branches than paid for marks the tenant over its limit (new branches are already
 * refused) for staff to settle. Staff can reconcile one tenant at once (the one-click fix).
 */
export class BranchReconciliation implements IJobHandler<"billing.branch_reconcile"> {
  readonly job = "billing.branch_reconcile" as const;

  constructor(
    private readonly deps: Readonly<{
      roster: ITenantRoster;
      tenantContext: ITenantContext;
      tenantUnitOfWork: IUnitOfWork;
      branches: IBranches;
      entitlements: BranchEntitlements;
      reconciliations: IBranchReconciliationRepository;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      logger: ILogger;
      alerts: IAlerts;
    }>,
  ) {}

  async handle(): Promise<void> {
    const tally: Record<ReconciliationOutcome, number> = {
      matched: 0,
      fixed: 0,
      over_limit: 0,
      failed: 0,
    };
    let after: string | null = null;
    for (;;) {
      const tenants = await this.deps.roster.listUsable(after, PAGE);
      for (const tenant of tenants) tally[(await this.reconcile(tenant.id, "job", null)).outcome]++;
      if (tenants.length < PAGE) break;
      after = tenants.at(-1)!.id;
    }
    this.deps.logger.info("Branch counts reconciled", tally);
    if (tally.failed > 0 || tally.over_limit > 0)
      await this.deps.alerts.raise({
        key: `billing.branch_reconcile:${new Date().toISOString().slice(0, 10)}`,
        severity: tally.failed > 0 ? "warning" : "info",
        source: "billing",
        title: `Branch reconcile: ${tally.over_limit} over the limit, ${tally.failed} failed`,
        detail: tally,
      });
  }

  /** The console's one-click fix for one tenant. */
  async runFor(tenantId: string, actor: PlatformPrincipal): Promise<Reconciliation> {
    const result = await this.reconcile(tenantId, "staff", actor);
    await this.deps.unitOfWork.run(() =>
      recordStaffAction(this.deps, actor, {
        action: "billing.branches_reconciled",
        entityType: "subscription",
        entityId: tenantId,
        targetTenantId: tenantId,
        after: {
          outcome: result.outcome,
          billed: result.billedAfter,
          active: result.activeBranches,
        },
      }),
    );
    return result;
  }

  list(
    filter: Readonly<{ tenantId?: string; outcome?: ReconciliationOutcome; limit: number }>,
  ): Promise<Reconciliation[]> {
    return this.deps.reconciliations.list(filter);
  }

  overLimit(): Promise<OverLimitTenant[]> {
    return this.deps.reconciliations.overLimit();
  }

  private async reconcile(
    tenantId: string,
    source: "job" | "staff",
    actor: PlatformPrincipal | null,
  ): Promise<Reconciliation> {
    const { deps } = this;
    try {
      const active = await deps.tenantContext.runAs(TenantId.from(tenantId), () =>
        deps.tenantUnitOfWork.run(() => deps.branches.activeCount()),
      );
      return await deps.entitlements.reconcile(
        tenantId,
        active,
        source,
        actor === null ? null : { type: "platform_staff", id: actor.userId },
      );
    } catch (error) {
      deps.logger.warn("Could not reconcile a tenant's branches", { tenantId, error });
      return deps.reconciliations.record({
        tenantId,
        activeBranches: null,
        billedBefore: null,
        billedAfter: null,
        branchesMax: null,
        subscriptionStatus: null,
        outcome: "failed",
        source,
        error: error instanceof Error ? error.message : "Failed",
      });
    }
  }
}
