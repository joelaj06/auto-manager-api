import type { TenantApplication } from "../../../domain/entities/TenantApplication.js";
import { FileStateError } from "../../../domain/entities/StoredFile.js";
import type { ITenantApplicationRepository } from "../../../domain/repositories/ITenantApplicationRepository.js";
import { ApplicationNotFoundError } from "../../errors/ApplicationErrors.js";
import type { FileView, UploadStarted } from "../files/FileService.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import { accessTokenMatches } from "./applicantLinks.js";

export const APPLICATION_OWNER = "tenant_application";
export const MAX_APPLICATION_DOCUMENTS = 10;

const OPEN = new Set(["pending_verification", "pending_review", "needs_info"]);

/**
 * KYC documents of a tenant application (docs/27 §3.2): the applicant attaches them through their
 * private link while the application is open; staff read them in the review queue.
 */
export class ApplicationDocuments {
  constructor(
    private readonly deps: Readonly<{
      applications: ITenantApplicationRepository;
      documents: OwnedDocuments;
    }>,
  ) {}

  async start(
    applicationId: string,
    token: string,
    input: DocumentUploadInput,
  ): Promise<UploadStarted> {
    this.assertOpen(await this.authorise(applicationId, token));
    return this.deps.documents.start(applicationId, input, null);
  }

  async complete(applicationId: string, token: string, fileId: string): Promise<FileView> {
    this.assertOpen(await this.authorise(applicationId, token));
    return this.deps.documents.complete(applicationId, fileId);
  }

  async list(applicationId: string, token: string): Promise<FileView[]> {
    await this.authorise(applicationId, token);
    return this.deps.documents.list(applicationId);
  }

  async remove(applicationId: string, token: string, fileId: string): Promise<void> {
    this.assertOpen(await this.authorise(applicationId, token));
    await this.deps.documents.remove(applicationId, fileId);
  }

  /** Staff (review queue): the documents with short-lived download links. */
  async forReview(applicationId: string): Promise<FileView[]> {
    if ((await this.deps.applications.findById(applicationId)) === null)
      throw new ApplicationNotFoundError();
    return this.deps.documents.list(applicationId);
  }

  private async authorise(applicationId: string, token: string): Promise<TenantApplication> {
    const application = await this.deps.applications.findById(applicationId);
    if (application === null || !accessTokenMatches(token, application.accessTokenHash))
      throw new ApplicationNotFoundError();
    return application;
  }

  private assertOpen(application: TenantApplication): void {
    if (!OPEN.has(application.status))
      throw new FileStateError("Documents can only be changed while the application is open");
  }
}
