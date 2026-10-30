import type { OnboardingFacts } from "../../domain/console/TenantAnalytics.js";
import type { UsageDay } from "../../domain/repositories/IUsageRepository.js";

/** A day's activity and size, read from the tenant's own database (no business records). */
export interface ITenantUsageCollector {
  collect(
    tenantId: string,
    day: string,
  ): Promise<Omit<UsageDay, "tenantId" | "day" | "apiCalls" | "apiErrors" | "jobs" | "failedJobs">>;
  /** When each onboarding step was first done. */
  onboarding(tenantId: string): Promise<OnboardingFacts>;
}
