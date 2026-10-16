import { PermissionDeniedError } from "../errors/AuthErrors.js";
import type { PermissionKey, PermissionScope } from "./permissionCatalog.js";
import type { Principal } from "./Principal.js";

/** Facts about the record being acted on, used by branch- and own-scoped grants. */
export type ResourceRef = Readonly<{ branchId?: string | null; ownerId?: string | null }>;

export type AuthorizationDecision =
  Readonly<{ allowed: true; scope: PermissionScope }> | Readonly<{ allowed: false }>;

/**
 * Decides whether a principal may perform an action.
 *
 * - Without a resource (e.g. "list vehicles"), any grant allows the action and its scope is
 *   returned so the caller can filter the query (own / branch / all).
 * - With a resource, the grant's scope must cover it: `all` always; `branch` when the record's
 *   branch is one of the user's; `own` when the user owns the record.
 */
export class AuthorizationPolicy {
  decide(
    principal: Principal,
    permission: PermissionKey,
    resource?: ResourceRef,
  ): AuthorizationDecision {
    const grant = principal.grantFor(permission);
    if (grant === undefined) return { allowed: false };
    if (resource === undefined || grant.scope === "all")
      return { allowed: true, scope: grant.scope };

    if (grant.scope === "branch") {
      const branchId = resource.branchId ?? null;
      return branchId !== null && this.grantBranches(principal, grant.branchIds).includes(branchId)
        ? { allowed: true, scope: "branch" }
        : { allowed: false };
    }
    return (resource.ownerId ?? null) === principal.userId
      ? { allowed: true, scope: "own" }
      : { allowed: false };
  }

  /** Like decide(), but throws PermissionDeniedError when not allowed. Returns the scope. */
  require(
    principal: Principal,
    permission: PermissionKey,
    resource?: ResourceRef,
  ): PermissionScope {
    const decision = this.decide(principal, permission, resource);
    if (!decision.allowed) throw new PermissionDeniedError(permission);
    return decision.scope;
  }

  /**
   * For list filtering: "all" when the permission covers every branch, otherwise the branches it
   * covers (empty when not granted or own-only).
   */
  branchesFor(principal: Principal, permission: PermissionKey): "all" | readonly string[] {
    const grant = principal.grantFor(permission);
    if (grant === undefined || grant.scope === "own") return [];
    if (grant.scope === "all") return "all";
    return this.grantBranches(principal, grant.branchIds);
  }

  private grantBranches(
    principal: Principal,
    limited: readonly string[] | undefined,
  ): readonly string[] {
    // A branch-limited grant only covers branches the user still belongs to (and that are active).
    return limited === undefined
      ? principal.branchIds
      : limited.filter((b) => principal.branchIds.includes(b));
  }

  /** A numeric limit attached to the grant (e.g. maximum discount percent), if any. */
  limit(principal: Principal, permission: PermissionKey, name: string): number | undefined {
    return principal.grantFor(permission)?.limits?.[name];
  }
}
