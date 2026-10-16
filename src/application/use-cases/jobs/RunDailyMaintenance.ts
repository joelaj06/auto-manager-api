import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { ITenantRetention, RetentionPolicy } from "../../ports/ITenantRetention.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

export const DEFAULT_RETENTION: RetentionPolicy = Object.freeze({
  sessionsAfterDays: 30,
  otpChallengesAfterDays: 7,
  processedMessagesAfterDays: 30,
  publishedEventsAfterDays: 7,
});

/** Daily retention clean-up in one tenant database. Naturally idempotent. */
export class RunDailyMaintenance implements IJobHandler<"tenant.daily_maintenance"> {
  readonly job = "tenant.daily_maintenance" as const;

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      retention: ITenantRetention;
      clock: IClock;
      logger: ILogger;
      policy?: RetentionPolicy;
    }>,
  ) {}

  async handle({ tenantId, localDate }: JobPayloads["tenant.daily_maintenance"]): Promise<void> {
    const { deps } = this;
    const removed = await deps.unitOfWork.run(() =>
      deps.retention.purge(deps.policy ?? DEFAULT_RETENTION, deps.clock.now()),
    );
    deps.logger.info("Tenant daily maintenance done", { tenantId, localDate, removed });
  }
}
