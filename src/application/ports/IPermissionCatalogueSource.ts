import type { PermissionScope } from "../authorization/permissionCatalog.js";

export type CataloguePermission = Readonly<{
  key: string;
  module: string;
  description: string;
  scopes: readonly PermissionScope[];
  sensitive: boolean;
}>;

export type CatalogueRoleTemplate = Readonly<{
  systemKey: string;
  name: string;
  description: string;
  grants: readonly Readonly<{ key: string; scope: PermissionScope }>[];
}>;

/** One version of the tenant permission catalogue and system role templates. */
export type CatalogueSnapshot = Readonly<{
  version: number;
  permissions: readonly CataloguePermission[];
  templates: readonly CatalogueRoleTemplate[];
}>;

/** Reads the current catalogue from the platform database (docs/28 §4: "seeded from the db"). */
export interface IPermissionCatalogueSource {
  current(): Promise<CatalogueSnapshot>;
}
