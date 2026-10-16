import type { PartnerStatus } from "../../domain/entities/Partner.js";
import type { ApplicationStatus } from "../../domain/entities/TenantApplication.js";
import type { TenantStatus } from "./ITenantDirectory.js";

export type PartnerListItem = Readonly<{
  id: string;
  name: string;
  kind: "individual" | "company";
  contactName: string;
  email: string;
  phone: string;
  region: string | null;
  status: PartnerStatus;
  trusted: boolean;
  referralCode: string;
  users: number;
  tenants: number;
  openApplications: number;
  createdAt: Date;
}>;

export type AttributionSource = "referral_code" | "assisted" | "manual";

/** A tenant attributed to a partner, with every field; the use case removes what may not be shown. */
export type PartnerTenantRow = Readonly<{
  tenantId: string;
  name: string;
  slug: string;
  status: TenantStatus;
  deactivationReason: string | null;
  source: AttributionSource;
  attributedAt: Date;
  signedUpAt: Date | null;
  activatedAt: Date | null;
  trialEndsAt: Date | null;
  owner: Readonly<{ name: string; email: string; phone: string }> | null;
}>;

export type PartnerTenantStatusChange = Readonly<{
  from: string;
  to: string;
  reasonCategory: string | null;
  at: Date;
}>;

export type PartnerApplicationRow = Readonly<{
  id: string;
  status: ApplicationStatus;
  businessName: string;
  desiredSlug: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  source: "self" | "assisted";
  submittedAt: Date | null;
  createdAt: Date;
  emailVerified: boolean;
  phoneVerified: boolean;
  tenantId: string | null;
}>;

export type PartnerApplicationMessage = Readonly<{
  type: string;
  from: "us" | "applicant";
  message: string | null;
  at: Date;
}>;

export type PartnerDashboardCounts = Readonly<{
  tenantsByStatus: Readonly<Record<string, number>>;
  applicationsByStatus: Readonly<Record<string, number>>;
  tenantsAddedLast30Days: number;
}>;

export type PartnerTenantFilter = Readonly<{
  status?: readonly TenantStatus[];
  q?: string;
  limit: number;
  before?: string;
}>;

/**
 * Read models of the reseller programme. Every partner-scoped method takes the partner id and
 * filters on it in SQL: rows of another partner are never returned (docs/29 §7).
 */
export interface IPartnerQueries {
  list(
    filter: Readonly<{
      status?: PartnerStatus;
      q?: string;
      limit: number;
      before?: string;
    }>,
  ): Promise<PartnerListItem[]>;
  tenants(partnerId: string, filter: PartnerTenantFilter): Promise<PartnerTenantRow[]>;
  tenant(partnerId: string, tenantId: string): Promise<PartnerTenantRow | null>;
  statusHistory(partnerId: string, tenantId: string): Promise<PartnerTenantStatusChange[]>;
  applications(
    partnerId: string,
    filter: Readonly<{ status?: ApplicationStatus; limit: number; before?: string }>,
  ): Promise<PartnerApplicationRow[]>;
  application(partnerId: string, applicationId: string): Promise<PartnerApplicationRow | null>;
  /** Messages the applicant can see (not internal staff notes). */
  applicationMessages(applicationId: string): Promise<PartnerApplicationMessage[]>;
  dashboard(partnerId: string, now: Date): Promise<PartnerDashboardCounts>;
}

export type Attribution = Readonly<{
  tenantId: string;
  partnerId: string;
  source: AttributionSource;
  attributedAt: Date;
}>;

/** Which partner a tenant belongs to (one at most). */
export interface IPartnerAttributions {
  find(tenantId: string): Promise<Attribution | null>;
  /** Sets (or replaces) the tenant's partner. */
  attribute(params: {
    tenantId: string;
    partnerId: string;
    source: AttributionSource;
    applicationId: string | null;
    actorId: string | null;
    reason: string | null;
  }): Promise<void>;
  remove(tenantId: string): Promise<void>;
}
