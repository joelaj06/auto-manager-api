import type { TenantStatus } from "./ITenantDirectory.js";

export type TenantPublicProfile = Readonly<{
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  deactivationReason: string | null;
  statusMessage: string | null;
}>;

/** What the public tenant-config may reveal about a tenant (platform database). */
export interface ITenantPublicProfiles {
  findBySlug(slug: string): Promise<TenantPublicProfile | null>;
}

/** The tenant's organisation settings needed publicly (tenant unit of work). */
export interface IOrganisationReader {
  get(): Promise<Readonly<{ name: string; baseCurrency: string; timezone: string }> | null>;
}
