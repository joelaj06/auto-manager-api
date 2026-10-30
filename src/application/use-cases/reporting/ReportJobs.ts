import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
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
