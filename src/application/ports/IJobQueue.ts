import type { JobName, JobPayloads } from "../jobs/jobCatalog.js";

export type EnqueueOptions = Readonly<{
  /** With a `stately` queue: at most one queued and one running job per key. */
  singletonKey?: string;
  startAfter?: Date;
}>;

/** Background job queue (lives in the platform database). */
export interface IJobQueue {
  /** Returns the job id, or null when a singleton key suppressed the job. */
  enqueue<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    options?: EnqueueOptions,
  ): Promise<string | null>;
}
