import type { PermissionKey, PermissionScope } from "./permissionCatalog.js";

export type PermissionGrant = Readonly<{
  scope: PermissionScope;
  /** Numeric limits from the role, e.g. { "max_percent": 10 } for a discount permission. */
  limits?: Readonly<Record<string, number>>;
  /**
   * For `branch` grants that come only from branch-specific role assignments: the branches they
   * cover. Absent: all of the user's (active) branches.
   */
  branchIds?: readonly string[];
}>;

/** A user's effective permissions (union over their role assignments) and branches. */
export type PermissionGrants = Readonly<{
  permissions: ReadonlyMap<string, PermissionGrant>;
  /** Active branches the user is assigned to (used by branch-scoped grants). */
  branchIds: readonly string[];
  /** The user belongs to branches, but every one of them is deactivated (docs/27 §3.5). */
  allBranchesInactive?: boolean;
}>;

/** Platform staff acting in the tenant through support access (docs/27 §3.8). */
export type SupportActor = Readonly<{
  sessionId: string;
  staffId: string;
  staffName: string;
  mode: "read" | "write";
}>;

/**
 * The authenticated tenant user behind the current request — or, with `support`, platform staff
 * acting with that user's permissions through a support session.
 */
export class Principal {
  constructor(
    readonly userId: string,
    readonly tenantId: string,
    readonly sessionId: string,
    private readonly grants: PermissionGrants,
    readonly support: SupportActor | null = null,
  ) {}

  get branchIds(): readonly string[] {
    return this.grants.branchIds;
  }

  /** Every granted permission with its scope (for "what may I do" screens). */
  grantedPermissions(): ReadonlyArray<readonly [string, PermissionGrant]> {
    return [...this.grants.permissions.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  grantFor(permission: PermissionKey): PermissionGrant | undefined {
    return this.grants.permissions.get(permission);
  }
}
