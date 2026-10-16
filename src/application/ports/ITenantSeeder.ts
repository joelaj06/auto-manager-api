import type { CatalogueSnapshot } from "./IPermissionCatalogueSource.js";

export type SeedInput = Readonly<{
  organisation: Readonly<{
    name: string;
    country: string;
    timezone: string;
    tin: string | null;
    registrationNumber: string | null;
    contactEmail: string;
    contactPhone: string;
  }>;
  owner: Readonly<{ name: string; email: string; phone: string }>;
  defaultBranch: Readonly<{ code: string; name: string }>;
  catalogue: CatalogueSnapshot;
}>;

export type CatalogueSyncResult = Readonly<{
  added: number;
  deprecated: number;
  /** System roles whose permissions changed (holders' tokens were invalidated). */
  changedRoles: readonly string[];
}>;

export type TenantOwner = Readonly<{
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: "invited" | "active" | "disabled";
}>;

/**
 * Writes the initial data of a tenant database and keeps its permissions in line with the
 * catalogue. Call inside the tenant's unit of work. Every operation is idempotent.
 */
export interface ITenantSeeder {
  /** Organisation, default branch, catalogue, expense categories, tax codes and the owner. */
  seed(input: SeedInput): Promise<TenantOwner>;
  /**
   * Upserts permissions, marks removed ones deprecated, updates system roles to the templates.
   * Custom roles are never changed.
   */
  syncCatalogue(catalogue: CatalogueSnapshot): Promise<CatalogueSyncResult>;
  owner(): Promise<TenantOwner | null>;
}
