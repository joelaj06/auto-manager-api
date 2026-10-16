import { IdentityRuleError } from "../errors/IdentityErrors.js";
import type { TenantPermissionView, RoleGrant } from "../ports/ITenantRoles.js";
import type { AuthorizationPolicy } from "./AuthorizationPolicy.js";
import type { PermissionKey, PermissionScope } from "./permissionCatalog.js";
import type { Principal } from "./Principal.js";

const RANK: Readonly<Record<PermissionScope, number>> = { own: 1, branch: 2, all: 3 };

/**
 * Privilege-escalation prevention (docs/28 §13): nobody can define or hand out more than they
 * hold. A grant is within the actor's own when the actor holds the same permission with at least
 * the same scope — and, for a role assigned for one branch, can act in that branch.
 */
export class EscalationGuard {
  constructor(private readonly policy: AuthorizationPolicy) {}

  /** Grants must exist in the tenant's catalogue and use one of the permission's scopes. */
  assertValidGrants(
    grants: readonly RoleGrant[],
    catalogue: readonly TenantPermissionView[],
  ): void {
    const byKey = new Map(catalogue.map((p) => [p.key, p]));
    for (const grant of grants) {
      const permission = byKey.get(grant.key);
      if (permission === undefined) {
        throw new IdentityRuleError("UNKNOWN_PERMISSION", `Unknown permission: ${grant.key}`);
      }
      if (!permission.scopes.includes(grant.scope)) {
        throw new IdentityRuleError(
          "INVALID_SCOPE",
          `${grant.key} cannot have scope "${grant.scope}" (allowed: ${permission.scopes.join(", ")})`,
        );
      }
    }
  }

  /**
   * `branchId` null: the grants apply to all of a user's branches (or define a role); otherwise
   * they apply in that branch only.
   */
  assertWithinOwn(actor: Principal, grants: readonly RoleGrant[], branchId: string | null): void {
    for (const grant of grants) {
      const held = actor.grantFor(grant.key as PermissionKey);
      const needed: PermissionScope =
        branchId !== null && grant.scope === "all" ? "branch" : grant.scope;
      const enough =
        held !== undefined &&
        RANK[held.scope] >= RANK[needed] &&
        // A branch-limited actor cannot hand out "all of the user's branches".
        !(
          held.scope === "branch" &&
          branchId === null &&
          needed === "branch" &&
          held.branchIds !== undefined
        ) &&
        (branchId === null ||
          needed === "own" ||
          this.policy.decide(actor, grant.key as PermissionKey, { branchId }).allowed);
      if (!enough) {
        throw new IdentityRuleError(
          "ROLE_EXCEEDS_OWN_PERMISSIONS",
          `You cannot grant ${grant.key} (${needed}${branchId === null ? "" : " in this branch"}) because you do not have it yourself`,
        );
      }
    }
  }
}
