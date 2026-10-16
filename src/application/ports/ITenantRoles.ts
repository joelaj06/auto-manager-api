import type { PermissionScope } from "../authorization/permissionCatalog.js";

export type RoleGrant = Readonly<{
  key: string;
  scope: PermissionScope;
  limits?: Readonly<Record<string, number>> | null;
}>;

export type TenantRoleView = Readonly<{
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  systemKey: string | null;
  basedOnRoleId: string | null;
  grants: readonly RoleGrant[];
  holders: number;
}>;

export type TenantPermissionView = Readonly<{
  key: string;
  module: string;
  description: string;
  scopes: readonly PermissionScope[];
  sensitive: boolean;
}>;

/** Roles and the permission list of the current tenant (tenant unit of work). */
export interface ITenantRoles {
  list(): Promise<TenantRoleView[]>;
  findById(id: string): Promise<TenantRoleView | null>;
  nameTaken(name: string, exceptId?: string): Promise<boolean>;
  create(input: {
    name: string;
    description: string;
    grants: readonly RoleGrant[];
    basedOnRoleId: string | null;
    createdBy: string;
  }): Promise<string>;
  /** Replaces name, description and grants of a custom role; bumps its version. */
  update(
    id: string,
    input: { name: string; description: string; grants: readonly RoleGrant[] },
  ): Promise<void>;
  softDelete(id: string): Promise<void>;
  permissions(): Promise<TenantPermissionView[]>;
}
