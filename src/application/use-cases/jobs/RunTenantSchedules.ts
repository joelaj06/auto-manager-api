import type { IJobHandler } from "../../jobs/IJobHandler.js";
import { TENANT_DAILY_JOBS, type TenantDailyJob } from "../../jobs/jobCatalog.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { ITenantRoster } from "../../ports/ITenantRoster.js";
import type { ITenantScheduleLedger } from "../../ports/ITenantScheduleLedger.js";
import { localDateTime } from "../../services/TenantLocalTime.js";

const PAGE_SIZE = 500;

/**
 * The per-tenant scheduler (docs/15 §3): on every tick, for each usable tenant, enqueues each
 * daily job whose local hour has been reached and that has not run for today's local date.
 * Because the check is "hour reached" rather than "hour equals", a tick missed during a deploy
 * or outage is caught up by the next one; the ledger guarantees one run per local day.
 */
export class RunTenantSchedules implements IJobHandler<"scheduler.tick"> {
  readonly job = "scheduler.tick" as const;

  constructor(
    private readonly deps: Readonly<{
      roster: ITenantRoster;
      ledger: ITenantScheduleLedger;
      clock: IClock;
      logger: ILogger;
      dailyJobs?: readonly TenantDailyJob[];
    }>,
  ) {}

  async handle(): Promise<void> {
    const { deps } = this;
    const dailyJobs = deps.dailyJobs ?? TENANT_DAILY_JOBS;
    const now = deps.clock.now();
    let enqueued = 0;
    let after: string | null = null;

    for (;;) {
      const tenants = await deps.roster.listUsable(after, PAGE_SIZE);
      for (const tenant of tenants) {
        let local;
        try {
          local = localDateTime(now, tenant.timezone);
        } catch {
          deps.logger.warn("Tenant has an invalid timezone; daily jobs skipped", {
            tenantId: tenant.id,
            timezone: tenant.timezone,
          });
          continue;
        }
        for (const daily of dailyJobs) {
          if (local.hour < daily.localHour) continue;
          if (await deps.ledger.enqueueOnce(tenant.id, daily.job, local.date)) enqueued++;
        }
      }
      if (tenants.length < PAGE_SIZE) break;
      after = tenants.at(-1)?.id ?? null;
    }

    if (enqueued > 0) deps.logger.info("Tenant daily jobs enqueued", { count: enqueued });
  }
}
