import type { PlatformPermissionKey } from "../authorization/platformPermissionCatalog.js";

export type PlatformRoleView = Readonly<{
  id: string;
  /** Set for system roles (read-only); null for custom roles. */
  systemKey: string | null;
  name: string;
  description: string;
  permissions: readonly PlatformPermissionKey[];
}>;

export type CustomRoleInput = Readonly<{
  name: string;
  description: string;
  permissions: readonly PlatformPermissionKey[];
}>;

/** Staff roles and assignments. Writes inside a platform unit of work. */
export interface IPlatformRoles {
  list(): Promise<PlatformRoleView[]>;
  findById(id: string): Promise<PlatformRoleView | null>;
  findBySystemKey(systemKey: string): Promise<PlatformRoleView | null>;
  createCustom(input: CustomRoleInput, createdBy: string): Promise<string>;
  updateCustom(id: string, input: CustomRoleInput): Promise<void>;
  rolesOfUser(userId: string): Promise<PlatformRoleView[]>;
  /** Replaces the user's roles. */
  setUserRoles(
    userId: string,
    roleIds: readonly string[],
    assignedBy: string | null,
  ): Promise<void>;
  /** Users holding the role (to invalidate their tokens after a role edit). */
  userIdsWithRole(roleId: string): Promise<string[]>;
  /** Active staff holding a system role, e.g. Super Admins for security alerts. */
  activeUsersWithSystemRole(systemKey: string): Promise<Readonly<{ id: string; email: string }>[]>;
}
