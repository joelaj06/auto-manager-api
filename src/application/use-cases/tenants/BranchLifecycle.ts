import { BranchDeactivationBlockedError, BranchNotFoundError } from "../../errors/TenantErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { BranchView, IBranchDeactivationCheck, IBranches } from "../../ports/IBranches.js";
import type { IClock } from "../../ports/IClock.js";
import type { IPermissionCache } from "../../ports/IPermissionCache.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

export type BranchActor = Readonly<{ type: "user" | "platform_staff"; id: string }>;

/**
 * Branch deactivation and reactivation (docs/27 §3.5), for tenant owners and — on their behalf —
 * platform staff, in the tenant's context. Nobody can reach a deactivated branch: assignments to
 * it stop granting anything and its members are re-evaluated on their next request. Records are
 * kept. A branch can only be deactivated when nothing live is left in it: the default branch and
 * the last active branch are refused, and every module can add its own check.
 */
export class BranchLifecycle {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      branches: IBranches;
      checks: readonly IBranchDeactivationCheck[];
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      tenantContext: ITenantContext;
      permissionCache: IPermissionCache;
      clock: IClock;
    }>,
  ) {}

  list(): Promise<BranchView[]> {
    return this.deps.unitOfWork.run(() => this.deps.branches.list());
  }

  async deactivate(branchId: string, reason: string, actor: BranchActor): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const branch = await this.load(branchId);
      if (branch.status === "inactive") return;
      const blockers: string[] = [];
      if (branch.isDefault)
        blockers.push("it is the default branch — make another branch the default first");
      if ((await deps.branches.activeCount()) <= 1) blockers.push("it is the only active branch");
      for (const check of deps.checks) {
        const problem = await check.check(branchId);
        if (problem !== null) blockers.push(problem);
      }
      if (blockers.length > 0) throw new BranchDeactivationBlockedError(blockers);

      await deps.branches.setStatus(branchId, "inactive", reason, deps.clock.now());
      const affected = await deps.branches.invalidateMembers(branchId);
      await this.audit("branch.deactivated", branch, actor, reason, { affectedUsers: affected });
    });
    deps.permissionCache.forgetTenant(deps.tenantContext.currentTenantId().value);
  }

  async reactivate(branchId: string, reason: string, actor: BranchActor): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const branch = await this.load(branchId);
      if (branch.status === "active") return;
      await deps.branches.setStatus(branchId, "active", null, deps.clock.now());
      const affected = await deps.branches.invalidateMembers(branchId);
      await this.audit("branch.reactivated", branch, actor, reason, { affectedUsers: affected });
    });
    deps.permissionCache.forgetTenant(deps.tenantContext.currentTenantId().value);
  }

  private async load(branchId: string): Promise<BranchView> {
    const branch = await this.deps.branches.lockById(branchId);
    if (branch === null) throw new BranchNotFoundError();
    return branch;
  }

  private async audit(
    action: string,
    branch: BranchView,
    actor: BranchActor,
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const request = this.deps.requestContext.current();
    await this.deps.auditTrail.record({
      actorType: actor.type === "user" ? "user" : "platform_staff",
      actorId: actor.id,
      action,
      entityType: "branch",
      entityId: branch.id,
      before: { status: branch.status },
      after: { status: action === "branch.deactivated" ? "inactive" : "active" },
      metadata: { ...metadata, reason },
      requestId: request?.requestId ?? null,
      ip: request?.ip ?? null,
    });
  }
}
