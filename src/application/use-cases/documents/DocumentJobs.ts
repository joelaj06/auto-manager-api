import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { Documents } from "./Documents.js";

/** Renders and stores the PDF of one issued document (enqueued after it is issued). */
export class RenderDocument implements IJobHandler<"documents.render"> {
  readonly job = "documents.render" as const;

  constructor(private readonly documents: Documents) {}

  handle({ documentId }: JobPayloads["documents.render"]): Promise<void> {
    return this.documents.render(documentId);
  }
}

/** Daily safety net: renders documents whose render job was lost. */
export class PendingDocumentRenders implements ITenantDailyTask {
  readonly name = "documents";

  constructor(private readonly documents: Documents) {}

  async run(): Promise<void> {
    await this.documents.renderPending();
  }
}
