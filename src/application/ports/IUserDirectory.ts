/**
 * Which tenants a person belongs to (platform database), so the mobile app can offer "choose
 * your business" after sign-in. Identifiers are stored as keyed hashes only.
 */
export interface IUserDirectory {
  upsert(entry: {
    tenantId: string;
    tenantUserId: string;
    email: string | null;
    phone: string | null;
    status: "active" | "disabled";
  }): Promise<void>;
}
