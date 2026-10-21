import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { DocumentSigning } from "./DocumentSigning.js";
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

/** Renders the signed copy of a fully signed document. */
export class SealDocument implements IJobHandler<"documents.seal"> {
  readonly job = "documents.seal" as const;

  constructor(private readonly signing: DocumentSigning) {}

  handle({ documentId }: JobPayloads["documents.seal"]): Promise<void> {
    return this.signing.seal(documentId);
  }
}

/** Daily: expires documents past their signing deadline, reminds signers, seals lost ones. */
export class SigningMaintenance implements ITenantDailyTask {
  readonly name = "signatures";

  constructor(private readonly signing: DocumentSigning) {}

  async run(): Promise<void> {
    await this.signing.maintain();
  }
}
