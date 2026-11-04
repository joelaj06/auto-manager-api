/** The licence on a tenant's subscription. */
export interface ITenantLicence {
  /** `enterprise`, `standard`, or null when the tenant has no subscription. */
  licenceType(tenantId: string): Promise<string | null>;
}
