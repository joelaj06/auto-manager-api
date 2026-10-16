export type TenantStatus =
  | "provisioning"
  | "provisioning_failed"
  | "trialing"
  | "active"
  | "past_due"
  | "read_only"
  | "deactivated"
  | "archived";

export type TenantSummary = Readonly<{ id: string; slug: string; status: TenantStatus }>;

/** Read-only lookup of tenants in the platform registry (cached by the implementation). */
export interface ITenantDirectory {
  findBySlug(slug: string): Promise<TenantSummary | null>;
  findById(id: string): Promise<TenantSummary | null>;
}
