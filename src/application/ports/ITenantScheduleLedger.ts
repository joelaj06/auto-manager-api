import type { TenantDailyJob } from "../jobs/jobCatalog.js";

/** Remembers which tenant daily jobs were enqueued for which local date. */
export interface ITenantScheduleLedger {
  /**
   * Records (tenant, job, local date) and enqueues the job, atomically. Returns false — and
   * enqueues nothing — when that run was already recorded.
   */
  enqueueOnce(tenantId: string, job: TenantDailyJob["job"], localDate: string): Promise<boolean>;
}
