import type { PermissionScope } from "./permissionCatalog.js";
import type { PermissionGrant } from "./Principal.js";

/** One permission granted through one role assignment. */
export type AssignedGrant = Readonly<{
  key: string;
  scope: PermissionScope;
  limits: Readonly<Record<string, number>> | null;
  /** The branch the role was assigned for; null: all of the user's branches. */
  assignmentBranchId: string | null;
}>;

const RANK: Readonly<Record<PermissionScope, number>> = { own: 1, branch: 2, all: 3 };

/**
 * Combines a user's role grants into one grant per permission (docs/28 §3.3):
 * - a role assigned for a specific branch only works in that branch: an `all` or `branch` grant
 *   becomes `branch` limited to it (`own` stays `own`);
 * - across assignments the widest scope wins; branch-limited grants combine their branches, and an
 *   unlimited `branch` grant (role assigned for all branches) covers all of the user's branches;
 * - numeric limits take the most generous value.
 */
export function mergeGrants(grants: readonly AssignedGrant[]): Map<string, PermissionGrant> {
  type Acc = {
    scope: PermissionScope;
    branches: Set<string> | null;
    limits: Record<string, number>;
  };
  const merged = new Map<string, Acc>();

  for (const grant of grants) {
    const scope: PermissionScope =
      grant.assignmentBranchId !== null && grant.scope === "all" ? "branch" : grant.scope;
    const branches =
      scope === "branch" && grant.assignmentBranchId !== null
        ? new Set([grant.assignmentBranchId])
        : null;
    const current = merged.get(grant.key);

    if (current === undefined || RANK[scope] > RANK[current.scope]) {
      merged.set(grant.key, { scope, branches, limits: { ...(current?.limits ?? {}) } });
    } else if (RANK[scope] === RANK[current.scope] && scope === "branch") {
      current.branches =
        current.branches === null || branches === null
          ? null
          : new Set([...current.branches, ...branches]);
    }
    const target = merged.get(grant.key)!;
    for (const [name, value] of Object.entries(grant.limits ?? {})) {
      target.limits[name] = Math.max(target.limits[name] ?? Number.NEGATIVE_INFINITY, value);
    }
  }

  const result = new Map<string, PermissionGrant>();
  for (const [key, acc] of merged) {
    result.set(key, {
      scope: acc.scope,
      ...(Object.keys(acc.limits).length === 0 ? {} : { limits: acc.limits }),
      ...(acc.scope === "branch" && acc.branches !== null
        ? { branchIds: [...acc.branches].sort() }
        : {}),
    });
  }
  return result;
}
