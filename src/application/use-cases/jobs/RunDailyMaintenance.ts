import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { ITenantRetention, RetentionPolicy } from "../../ports/ITenantRetention.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { FileService } from "../files/FileService.js";

export const DEFAULT_RETENTION: RetentionPolicy = Object.freeze({
  sessionsAfterDays: 30,
  otpChallengesAfterDays: 7,
  processedMessagesAfterDays: 30,
  publishedEventsAfterDays: 7,
});

/**
 * Daily work in one tenant database: retention clean-up, abandoned uploads, then the modules'
 * daily tasks. Naturally idempotent (tasks keep their own progress).
 */
export class RunDailyMaintenance implements IJobHandler<"tenant.daily_maintenance"> {
  readonly job = "tenant.daily_maintenance" as const;

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      retention: ITenantRetention;
      clock: IClock;
      logger: ILogger;
      /** Tenant files: abandoned uploads are removed too. */
      files?: FileService;
      policy?: RetentionPolicy;
      /** Modules' daily work (recurring expenses …); one failing task does not stop the others. */
      tasks?: readonly ITenantDailyTask[];
    }>,
  ) {}

  async handle({ tenantId, localDate }: JobPayloads["tenant.daily_maintenance"]): Promise<void> {
    const { deps } = this;
    const removed = await deps.unitOfWork.run(() =>
      deps.retention.purge(deps.policy ?? DEFAULT_RETENTION, deps.clock.now()),
    );
    const abandonedFiles = (await deps.files?.sweepAbandoned()) ?? 0;
    const failed: string[] = [];
    for (const task of deps.tasks ?? []) {
      try {
        await task.run(localDate);
      } catch (error) {
        failed.push(task.name);
        deps.logger.error("Tenant daily task failed", {
          tenantId,
          task: task.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failed.length > 0) throw new Error(`Daily tasks failed: ${failed.join(", ")}`);
    deps.logger.info("Tenant daily maintenance done", {
      tenantId,
      localDate,
      removed,
      abandonedFiles,
    });
  }
}
