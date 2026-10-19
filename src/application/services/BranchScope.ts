import type { AuthorizationPolicy } from "../authorization/AuthorizationPolicy.js";
import type { PermissionKey } from "../authorization/permissionCatalog.js";
import type { Principal } from "../authorization/Principal.js";
import { IdentityRuleError } from "../errors/IdentityErrors.js";
import { BranchDeactivatedError } from "../errors/TenantErrors.js";
import type { BranchView, IBranches } from "../ports/IBranches.js";

/**
 * Branch scope of records that belong to a branch (vehicles, drivers …), docs/28 rule 14 and
 * docs/27 §3.5: a record outside the caller's branches does not exist for them; a record of a
 * deactivated branch is refused even with all-branch access. Call inside a unit of work.
 */
export class BranchScope {
  constructor(
    private readonly deps: Readonly<{ branches: IBranches; policy: AuthorizationPolicy }>,
  ) {}

  /** Throws `notFound()` outside the caller's branches, BRANCH_DEACTIVATED for inactive ones. */
  async assertReaches(
    actor: Principal,
    permission: PermissionKey,
    branchId: string,
    notFound: () => Error,
  ): Promise<void> {
    const reachable = this.deps.policy.branchesFor(actor, permission);
    if (reachable !== "all") {
      if (!reachable.includes(branchId)) throw notFound();
      return;
    }
    const branch = (await this.deps.branches.list()).find((b) => b.id === branchId);
    if (branch?.status !== "active") throw new BranchDeactivatedError();
  }

  /** The branch exists, is active and is within the caller's scope for `permission`. */
  async branch(actor: Principal, permission: PermissionKey, branchId: string): Promise<BranchView> {
    const branch = (await this.deps.branches.list()).find((b) => b.id === branchId);
    if (branch === undefined) throw new IdentityRuleError("UNKNOWN_BRANCH", "Unknown branch");
    if (branch.status !== "active") throw new BranchDeactivatedError();
    const reachable = this.deps.policy.branchesFor(actor, permission);
    if (reachable !== "all" && !reachable.includes(branchId))
      throw new IdentityRuleError("BRANCH_OUT_OF_SCOPE", "You can only use branches you manage");
    return branch;
  }

  /** The default branch, or the caller's only branch, for records created without one. */
  async defaultBranch(actor: Principal, permission: PermissionKey, what: string): Promise<string> {
    const reachable = this.deps.policy.branchesFor(actor, permission);
    if (reachable !== "all") {
      if (reachable.length === 1) return reachable[0]!;
      throw new IdentityRuleError("UNKNOWN_BRANCH", `Choose the branch of the ${what}`);
    }
    const branch = (await this.deps.branches.list()).find(
      (b) => b.isDefault && b.status === "active",
    );
    if (branch === undefined)
      throw new IdentityRuleError("UNKNOWN_BRANCH", `Choose the branch of the ${what}`);
    return branch.id;
  }

  can(actor: Principal, permission: PermissionKey, branchId: string): boolean {
    return this.deps.policy.decide(actor, permission, { branchId }).allowed;
  }

  branchesFor(actor: Principal, permission: PermissionKey): "all" | readonly string[] {
    return this.deps.policy.branchesFor(actor, permission);
  }
}
