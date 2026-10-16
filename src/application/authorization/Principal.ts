import type { PermissionKey, PermissionScope } from "./permissionCatalog.js";

export type PermissionGrant = Readonly<{
  scope: PermissionScope;
  /** Numeric limits from the role, e.g. { "max_percent": 10 } for a discount permission. */
  limits?: Readonly<Record<string, number>>;
}>;

/** A user's effective permissions (union over their role assignments) and branches. */
export type PermissionGrants = Readonly<{
  permissions: ReadonlyMap<string, PermissionGrant>;
  /** Branches the user is assigned to (used by branch-scoped grants). */
  branchIds: readonly string[];
}>;

/** The authenticated tenant user behind the current request. */
export class Principal {
  constructor(
    readonly userId: string,
    readonly tenantId: string,
    readonly sessionId: string,
    private readonly grants: PermissionGrants,
  ) {}

  get branchIds(): readonly string[] {
    return this.grants.branchIds;
  }

  grantFor(permission: PermissionKey): PermissionGrant | undefined {
    return this.grants.permissions.get(permission);
  }
}
