import type { IJobQueue } from "../../application/ports/IJobQueue.js";
import type { IDocumentRenderQueue } from "../../application/ports/IDocumentRecords.js";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

/** Enqueues a `documents.render` job once the issuing transaction has committed. */
export class QueuedDocumentRendering implements IDocumentRenderQueue {
  constructor(
    private readonly transactions: PostgresTransactionContext,
    private readonly tenantContext: ITenantContext,
    private readonly queue: IJobQueue,
  ) {}

  request(documentId: string): void {
    const tenantId = this.tenantContext.currentTenantId().value;
    this.transactions.afterCommit(`documents.render:${documentId}`, async () => {
      await this.queue.enqueue("documents.render", { tenantId, documentId });
    });
  }

  requestSeal(documentId: string): void {
    const tenantId = this.tenantContext.currentTenantId().value;
    this.transactions.afterCommit(`documents.seal:${documentId}`, async () => {
      await this.queue.enqueue("documents.seal", { tenantId, documentId });
    });
  }
}
