import type { ApplicationStatus } from "../../domain/entities/TenantApplication.js";

export type SimilarApplication = Readonly<{
  id: string;
  businessName: string;
  status: ApplicationStatus;
  createdAt: Date;
  matchedOn: readonly ("email" | "phone" | "business_name")[];
}>;

/** Read-only checks across applications and tenants (duplicates, risk, slug availability). */
export interface IApplicationLookups {
  /** Taken by a tenant or by an application that is not rejected (optionally ignoring one). */
  slugTaken(slug: string, exceptApplicationId?: string): Promise<boolean>;
  /** An application with this email or phone is still being processed. */
  openApplicationExists(email: string, phone: string): Promise<boolean>;
  /** The latest re-apply block for this email or phone, if still in force. */
  reapplyBlockedUntil(email: string, phone: string, now: Date): Promise<Date | null>;
  applicationsFromIpSince(ip: string, since: Date): Promise<number>;
  /** Other applications with the same email, phone or business name. */
  similar(params: {
    excludeId?: string;
    email: string;
    phone: string;
    businessName: string;
  }): Promise<SimilarApplication[]>;
  /** Existing tenants with (nearly) the same business name. */
  tenantsNamed(businessName: string): Promise<number>;
}
