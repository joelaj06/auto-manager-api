export type TenantStatus =
  | "provisioning"
  | "provisioning_failed"
  | "trialing"
  | "active"
  | "past_due"
  | "read_only"
  | "deactivated"
  | "archived";

export type TenantSummary = Readonly<{
  id: string;
  slug: string;
  status: TenantStatus;
  /**
   * Deactivated by billing (non-payment, trial expiry): users with billing access may still sign
   * in and pay; nothing else works (docs/25 §5.4).
   */
  billingOnly?: boolean;
}>;

/** Read-only lookup of tenants in the platform registry (cached by the implementation). */
export interface ITenantDirectory {
  findBySlug(slug: string): Promise<TenantSummary | null>;
  findById(id: string): Promise<TenantSummary | null>;
  /** Forgets cached entries after a status change in this process (others expire within seconds). */
  invalidate(): void;
}
