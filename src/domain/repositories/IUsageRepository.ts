import type { OnboardingFacts } from "../console/TenantAnalytics.js";

/** One tenant's day (docs/27 §4 `usage_daily`). */
export type UsageDay = Readonly<{
  tenantId: string;
  day: string;
  activeUsers: number;
  apiCalls: number;
  recordsCreated: number;
  vehicles: number;
  branches: number;
  users: number;
  storageBytes: number;
  databaseBytes: number;
  /** Background jobs run for the tenant, and those that failed. */
  jobs: number;
  failedJobs: number;
  /** API calls answered with a server error. */
  apiErrors: number;
  /** Records created per audited entity type. */
  modules: Readonly<Record<string, number>>;
}>;

export type JobCounts = Readonly<{ jobs: number; failed: number }>;

/** Daily usage and the API call counters it is built from (platform database). */
export interface IUsageRepository {
  addCalls(
    counts: readonly Readonly<{ tenantId: string; day: string; calls: number; errors: number }>[],
  ): Promise<void>;
  callsOn(tenantId: string, day: string): Promise<Readonly<{ calls: number; errors: number }>>;
  /** Background jobs of each tenant created on a day (from the job queue). */
  jobsOn(day: string): Promise<ReadonlyMap<string, JobCounts>>;
  saveDay(day: UsageDay): Promise<void>;
  /** A tenant's onboarding milestones, refreshed nightly. */
  saveOnboarding(tenantId: string, facts: OnboardingFacts): Promise<void>;
  days(tenantId: string, from: string, to: string): Promise<UsageDay[]>;
}
