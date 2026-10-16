import type { TenantStatus } from "./ITenantDirectory.js";

export type TenantListFilter = Readonly<{
  status?: readonly TenantStatus[];
  /** Matches name or slug (contains, case-insensitive), or an exact owner email/phone. */
  q?: string;
  tag?: string;
  createdFrom?: Date;
  createdTo?: Date;
  limit: number;
  /** Keyset cursor: tenants created before this tenant id (ids are time-ordered). */
  before?: string;
}>;

export type TenantListItem = Readonly<{
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  createdAt: Date;
  trialEndsAt: Date | null;
  statusChangedAt: Date | null;
  ownerName: string | null;
  ownerEmail: string | null;
  source: "self" | "assisted" | null;
  tags: readonly string[];
}>;

export type TenantOverview = Readonly<{
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  previousStatus: string | null;
  deactivationReason: string | null;
  statusMessage: string | null;
  statusChangedAt: Date | null;
  createdAt: Date;
  provisionedAt: Date | null;
  trialEndsAt: Date | null;
  catalogueVersion: number | null;
  databaseName: string | null;
  application: Readonly<{
    id: string;
    source: "self" | "assisted";
    businessType: string;
    country: string;
    contactName: string;
    contactEmail: string;
    contactPhone: string;
    expectedBranches: number;
    expectedVehicles: number;
    referralCode: string | null;
    partnerId: string | null;
    submittedAt: Date | null;
    reviewedAt: Date | null;
  }> | null;
  provisioning: Readonly<{
    status: "running" | "failed" | "completed";
    step: string;
    attempts: number;
    lastError: string | null;
  }> | null;
  schema: Readonly<{
    version: string | null;
    status: "ok" | "failed";
    error: string | null;
    updatedAt: Date;
  }> | null;
  backups: Readonly<{
    lastSucceededAt: Date | null;
    lastSizeBytes: number | null;
    lastVerifiedAt: Date | null;
    lastFailedAt: Date | null;
  }>;
  tags: readonly string[];
  notes: Readonly<{ count: number; pinned: number }>;
  pendingApprovals: number;
}>;

export type TimelineEntry = Readonly<{
  at: Date;
  source: "application" | "audit";
  type: string;
  actorType: string;
  actorId: string | null;
  summary: string | null;
  details: unknown;
}>;

export type DashboardCounts = Readonly<{
  tenantsByStatus: Readonly<Record<string, number>>;
  deactivatedByReason: Readonly<Record<string, number>>;
  applicationsByStatus: Readonly<Record<string, number>>;
  newApplications: Readonly<{ last7Days: number; last30Days: number }>;
  newTenants: Readonly<{ last7Days: number; last30Days: number }>;
  trialsEndingWithin7Days: number;
  oldestPendingReviewAt: Date | null;
  provisioningFailed: number;
  schemaFailures: number;
  pendingApprovals: number;
}>;

/** Console read models over the platform registry (docs/27 §3.1, §3.4). */
export interface IConsoleTenantQueries {
  list(filter: TenantListFilter): Promise<TenantListItem[]>;
  overview(tenantId: string): Promise<TenantOverview | null>;
  timeline(
    tenantId: string,
    options: Readonly<{ limit: number; before?: Date }>,
  ): Promise<TimelineEntry[]>;
  dashboard(now: Date): Promise<DashboardCounts>;
}
