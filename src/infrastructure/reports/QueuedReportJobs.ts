import type { IJobQueue } from "../../application/ports/IJobQueue.js";
import type { IReportJobQueue } from "../../application/ports/IReportJobs.js";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

/** Enqueues a `reports.generate` job once the requesting transaction has committed. */
export class QueuedReportJobs implements IReportJobQueue {
  constructor(
    private readonly transactions: PostgresTransactionContext,
    private readonly tenantContext: ITenantContext,
    private readonly queue: IJobQueue,
  ) {}

  request(jobId: string): void {
    const tenantId = this.tenantContext.currentTenantId().value;
    this.transactions.afterCommit(`reports.generate:${jobId}`, async () => {
      await this.queue.enqueue("reports.generate", { tenantId, jobId });
    });
  }
}
