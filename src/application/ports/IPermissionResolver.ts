import type { PermissionGrants } from "../authorization/Principal.js";

/**
 * Effective permissions of a tenant user, from their role assignments. Implementations cache by
 * (tenant, user, permission version); bumping the version (role edit, user disabled) invalidates.
 */
export interface IPermissionResolver {
  /** Null when the user does not exist or is disabled — they must not be authenticated. */
  resolve(
    tenantId: string,
    userId: string,
    permissionVersion: number,
  ): Promise<PermissionGrants | null>;
  /** The user's current permission version, or null when the user does not exist or is disabled. */
  currentVersion(tenantId: string, userId: string): Promise<number | null>;
}
