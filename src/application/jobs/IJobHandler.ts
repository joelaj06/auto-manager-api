import type { JobName, JobPayloads } from "./jobCatalog.js";

export type JobContext = Readonly<{
  jobId: string;
  /** 1 on the first attempt. */
  attempt: number;
}>;

/**
 * Handles one job type. For tenant-scoped jobs the worker has already entered the tenant's
 * context, so the unit of work reaches that tenant's database. Must be idempotent.
 */
export interface IJobHandler<N extends JobName = JobName> {
  readonly job: N;
  handle(payload: JobPayloads[N], context: JobContext): Promise<void>;
}
