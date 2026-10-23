import { IdentityRuleError } from "../../errors/IdentityErrors.js";
import {
  BranchDeactivationBlockedError,
  BranchNotFoundError,
  BranchReassignmentError,
  BranchRemovalBlockedError,
} from "../../errors/TenantErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { BranchInventory, BranchMove, IBranchContents } from "../../ports/IBranchContents.js";
import type { BranchView, IBranchDeactivationCheck, IBranches } from "../../ports/IBranches.js";
import type { IClock } from "../../ports/IClock.js";
import type { IPermissionCache } from "../../ports/IPermissionCache.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchEntitlements, BranchPriceImpact } from "../billing/BranchEntitlements.js";

export type BranchActor = Readonly<{ type: "user" | "platform_staff"; id: string }>;

export type NewBranch = Readonly<{
  code: string;
  name: string;
  address?: string | null;
  phone?: string | null;
}>;

/** The deactivation wizard's view of a branch: what is live in it and what blocks it. */
export type DeactivationCheck = Readonly<{
  branch: BranchView;
  inventory: BranchInventory;
  blockers: readonly string[];
}>;

/**
 * Branches as the billing unit (docs/27 §3.5), for tenant owners and — on their behalf —
 * platform staff, in the tenant's context:
 * - create and reactivate within the subscription, or beyond it once the extra charge is
 *   confirmed (the price impact is shown first);
 * - deactivate: nobody can reach a deactivated branch — assignments to it stop granting anything
 *   and its members are re-evaluated on their next request. Records are kept. Only when nothing
 *   live is left in it: the default branch and the last active branch are refused, and every
 *   module adds its own check; the wizard moves everything live to another branch first;
 * - remove: only a branch with no records at all (created by mistake).
 * The billed branch count follows (docs/25 §7).
 */
export class BranchLifecycle {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      branches: IBranches;
      contents: IBranchContents;
      checks: readonly IBranchDeactivationCheck[];
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      tenantContext: ITenantContext;
      permissionCache: IPermissionCache;
      clock: IClock;
      entitlements: BranchEntitlements;
    }>,
  ) {}

  list(): Promise<BranchView[]> {
    return this.deps.unitOfWork.run(() => this.deps.branches.list());
  }

  /** What one more active branch would cost (create or reactivate). */
  async priceImpact(): Promise<BranchPriceImpact> {
    const { deps } = this;
    const active = await deps.unitOfWork.run(() => deps.branches.activeCount());
    return deps.entitlements.priceImpact(this.tenantId(), active);
  }

  async create(
    input: NewBranch,
    actor: BranchActor,
    confirmBranchPurchase = false,
  ): Promise<string> {
    const { deps } = this;
    const code = input.code.trim().toUpperCase();
    return deps.unitOfWork.run(async () => {
      if (await deps.branches.codeTaken(code))
        throw new IdentityRuleError("BRANCH_CODE_TAKEN", "Another branch already uses this code");
      await deps.entitlements.beforeActivating(this.tenantId(), await deps.branches.activeCount(), {
        confirmPurchase: confirmBranchPurchase,
        actor,
      });
      const id = await deps.branches.create({
        code,
        name: input.name.trim(),
        address: input.address ?? null,
        phone: input.phone ?? null,
      });
      await this.record("branch.created", id, actor, { code, name: input.name.trim() });
      return id;
    });
  }

  /** Name, address and phone (staff; tenants edit through their organisation settings). */
  async update(
    branchId: string,
    changes: Readonly<{ name?: string; address?: string | null; phone?: string | null }>,
    reason: string,
    actor: BranchActor,
  ): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const branch = await this.load(branchId);
      await deps.branches.update(branchId, changes);
      await this.record("branch.updated", branchId, actor, { before: branch, changes, reason });
    });
  }

  async makeDefault(branchId: string, reason: string, actor: BranchActor): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const branch = await this.load(branchId);
      if (branch.status !== "active")
        throw new BranchReassignmentError("Only an active branch can be the default");
      await deps.branches.makeDefault(branchId);
      await this.record("branch.made_default", branchId, actor, { reason });
    });
  }

  /** The wizard's first step: what is still live in the branch and what blocks deactivation. */
  async deactivationCheck(branchId: string): Promise<DeactivationCheck> {
    return this.deps.unitOfWork.run(async () => {
      const branch = await this.load(branchId);
      return {
        branch,
        inventory: await this.deps.contents.inventory(branchId),
        blockers: await this.blockers(branch),
      };
    });
  }

  /**
   * The wizard's second step: every live record of the branch moves to another active branch
   * (with its members and branch roles, unless `users` is false). History stays where it
   * happened. Open cash sessions must be closed first.
   */
  async reassign(
    branchId: string,
    input: Readonly<{ targetBranchId: string; users?: boolean; reason: string }>,
    actor: BranchActor,
  ): Promise<BranchMove> {
    const { deps } = this;
    const moved = await deps.unitOfWork.run(async () => {
      if (input.targetBranchId === branchId)
        throw new BranchReassignmentError("Choose another branch to move the records to");
      const branch = await this.load(branchId);
      const target = await deps.branches.lockById(input.targetBranchId);
      if (target === null || target.status !== "active")
        throw new BranchReassignmentError("The records can only move to an active branch");
      const { openCashSessions } = await deps.contents.inventory(branchId);
      if (openCashSessions > 0)
        throw new BranchReassignmentError(
          `Close the branch's ${openCashSessions} open cash session${openCashSessions === 1 ? "" : "s"} first`,
        );
      const result = await deps.contents.moveLive(branchId, target.id, {
        users: input.users ?? true,
      });
      await deps.branches.invalidateMembers(branchId);
      await deps.branches.invalidateMembers(target.id);
      await this.record("branch.records_reassigned", branch.id, actor, {
        to: { id: target.id, code: target.code },
        moved: result,
        reason: input.reason,
      });
      return result;
    });
    deps.permissionCache.forgetTenant(this.tenantId());
    return moved;
  }

  async deactivate(branchId: string, reason: string, actor: BranchActor): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const branch = await this.load(branchId);
      if (branch.status === "inactive") return;
      const blockers = await this.blockers(branch);
      if (blockers.length > 0) throw new BranchDeactivationBlockedError(blockers);
      await deps.branches.setStatus(branchId, "inactive", reason, deps.clock.now());
      const affected = await deps.branches.invalidateMembers(branchId);
      await this.audit("branch.deactivated", branch, actor, reason, { affectedUsers: affected });
    });
    await this.afterDeactivating(actor);
  }

  /** Back to active: within the subscription, or beyond it once the charge is confirmed. */
  async reactivate(
    branchId: string,
    reason: string,
    actor: BranchActor,
    confirmBranchPurchase = false,
  ): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const branch = await this.load(branchId);
      if (branch.status === "active") return;
      await deps.entitlements.beforeActivating(this.tenantId(), await deps.branches.activeCount(), {
        confirmPurchase: confirmBranchPurchase,
        actor,
      });
      await deps.branches.setStatus(branchId, "active", null, deps.clock.now());
      const affected = await deps.branches.invalidateMembers(branchId);
      await this.audit("branch.reactivated", branch, actor, reason, { affectedUsers: affected });
    });
    deps.permissionCache.forgetTenant(this.tenantId());
  }

  /** Only a branch with no records at all (created by mistake); anything else is deactivated. */
  async remove(branchId: string, reason: string, actor: BranchActor): Promise<void> {
    const { deps } = this;
    const wasActive = await deps.unitOfWork.run(async () => {
      const branch = await this.load(branchId);
      const blockers: string[] = [];
      if (branch.isDefault) blockers.push("it is the default branch");
      if (branch.status === "active" && (await deps.branches.activeCount()) <= 1)
        blockers.push("it is the only active branch");
      const tables = await deps.contents.tablesWithRecords(branchId);
      if (tables.length > 0)
        blockers.push(`it has records (${tables.map((t) => t.replaceAll("_", " ")).join(", ")})`);
      if (blockers.length > 0) throw new BranchRemovalBlockedError(blockers);
      await deps.branches.invalidateMembers(branchId);
      await deps.contents.remove(branchId);
      await this.record("branch.removed", branchId, actor, {
        code: branch.code,
        name: branch.name,
        reason,
      });
      return branch.status === "active";
    });
    if (wasActive) await this.afterDeactivating(actor);
    else deps.permissionCache.forgetTenant(this.tenantId());
  }

  private async blockers(branch: BranchView): Promise<string[]> {
    const { deps } = this;
    const blockers: string[] = [];
    if (branch.status === "inactive") return blockers;
    if (branch.isDefault)
      blockers.push("it is the default branch — make another branch the default first");
    if ((await deps.branches.activeCount()) <= 1) blockers.push("it is the only active branch");
    for (const check of deps.checks) {
      const problem = await check.check(branch.id);
      if (problem !== null) blockers.push(problem);
    }
    return blockers;
  }

  /** The permission cache forgets the tenant; billing counts only the active branches. */
  private async afterDeactivating(actor: BranchActor): Promise<void> {
    const { deps } = this;
    const tenantId = this.tenantId();
    deps.permissionCache.forgetTenant(tenantId);
    const active = await deps.unitOfWork.run(() => deps.branches.activeCount());
    await deps.entitlements.afterDeactivating(tenantId, active, actor);
  }

  private async load(branchId: string): Promise<BranchView> {
    const branch = await this.deps.branches.lockById(branchId);
    if (branch === null) throw new BranchNotFoundError();
    return branch;
  }

  private tenantId(): string {
    return this.deps.tenantContext.currentTenantId().value;
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

  private async record(
    action: string,
    branchId: string,
    actor: BranchActor,
    details: Record<string, unknown>,
  ): Promise<void> {
    const request = this.deps.requestContext.current();
    await this.deps.auditTrail.record({
      actorType: actor.type === "user" ? "user" : "platform_staff",
      actorId: actor.id,
      action,
      entityType: "branch",
      entityId: branchId,
      after: details,
      requestId: request?.requestId ?? null,
      ip: request?.ip ?? null,
    });
  }
}
