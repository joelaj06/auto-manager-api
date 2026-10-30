import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ITenantRoster } from "../../ports/ITenantRoster.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { ReportSchedules } from "./ReportSchedules.js";
import type { Reports } from "./Reports.js";

/** Builds one report file (enqueued once the request has committed). */
export class GenerateReport implements IJobHandler<"reports.generate"> {
  readonly job = "reports.generate" as const;

  constructor(private readonly reports: Reports) {}

  handle({ jobId }: JobPayloads["reports.generate"]): Promise<void> {
    return this.reports.generate(jobId);
  }
}

/** Daily: removes report files past their keeping time and fails jobs that were lost. */
export class ReportRetention implements ITenantDailyTask {
  readonly name = "reports";

  constructor(private readonly reports: Reports) {}

  run(): Promise<void> {
    return this.reports.sweep();
  }
}

/** A tenant's scheduled reports that are due, queued as their owners. */
export class RunReportSchedules implements IJobHandler<"tenant.report_schedules"> {
  readonly job = "tenant.report_schedules" as const;

  constructor(private readonly schedules: ReportSchedules) {}

  async handle(): Promise<void> {
    await this.schedules.runDue();
  }
}

/** Every 15 minutes: a scheduled-report run for every usable tenant. */
export class SweepReportSchedules implements IJobHandler<"reports.schedules_sweep"> {
  readonly job = "reports.schedules_sweep" as const;

  constructor(private readonly deps: Readonly<{ roster: ITenantRoster; queue: IJobQueue }>) {}

  async handle(): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const tenants = await this.deps.roster.listUsable(after, 500);
      for (const tenant of tenants)
        await this.deps.queue.enqueue(
          "tenant.report_schedules",
          { tenantId: tenant.id },
          { singletonKey: tenant.id },
        );
      if (tenants.length < 500) return;
      after = tenants.at(-1)?.id ?? null;
    }
  }
}
