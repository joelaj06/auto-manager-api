import type {
  BusinessType,
  CostRates,
  OnboardingFacts,
} from "../../domain/console/TenantAnalytics.js";

/** Applications created in a period and how far they went (docs/27 §3.16). */
export type FunnelCounts = Readonly<{
  signups: number;
  verified: number;
  approved: number;
  provisioned: number;
  firstVehicle: number;
  firstTransaction: number;
  paying: number;
}>;

export type TenantSummary = Readonly<{
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  businessType: BusinessType | null;
  provisionedAt: Date | null;
}>;

/** A live tenant's activity up to a day: 14 days for activity, 30 for modules and support. */
export type TenantActivity = TenantSummary &
  Readonly<{
    loginDays: number;
    averageActiveUsers: number;
    users: number;
    recordsCreated: number;
    vehicles: number;
    vehiclesBefore: number | null;
    /** Records per audited entity type over 30 days. */
    entities: Readonly<Record<string, number>>;
    billing: "trialing" | "paid_up" | "overdue";
    supportSessions: number;
    jobs: number;
    failedJobs: number;
    apiCalls: number;
    apiErrors: number;
    /** Recurring licence fee a month, minor units of the plan currency. */
    mrrMinor: number;
    partnerId: string | null;
  }>;

export type CohortRow = Readonly<{
  tenantId: string;
  /** YYYY-MM the tenant was provisioned in. */
  cohort: string;
  /** Months (YYYY-MM) with at least one user signed in. */
  activeMonths: readonly string[];
  /** YYYY-MM of the first paid invoice. */
  payingFrom: string | null;
  mrrMinor: number;
}>;

/** A live tenant's size and its last 30 days of calls and jobs. */
export type CostRow = TenantSummary &
  Readonly<{
    databaseBytes: number;
    storageBytes: number;
    apiCalls: number;
    jobs: number;
    mrrMinor: number;
  }>;

export type PartnerRow = Readonly<{
  partnerId: string;
  name: string;
  status: string;
  tenantIds: readonly string[];
  newTenants: number;
  churned: number;
  earnedMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  currency: string;
}>;

export type ChurnRow = Readonly<{ reason: string; count: number }>;

/** Read models of the platform analytics (platform database). */
export interface IPlatformAnalytics {
  funnel(from: Date, until: Date): Promise<FunnelCounts>;
  /** Live tenants (trialing, active, past due, read-only), their activity up to `day`. */
  activity(day: string, now: Date): Promise<TenantActivity[]>;
  cohorts(fromMonth: string): Promise<CohortRow[]>;
  costs(day: string): Promise<CostRow[]>;
  partners(from: Date, until: Date): Promise<PartnerRow[]>;
  churn(from: Date, until: Date): Promise<Readonly<{ deactivated: ChurnRow[]; restored: number }>>;
  tenant(tenantId: string): Promise<TenantSummary | null>;
  onboarding(tenantId: string): Promise<OnboardingFacts>;
  rates(): Promise<CostRates>;
  saveRates(rates: CostRates, by: string): Promise<void>;
}
