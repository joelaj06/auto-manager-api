import type { IPartnerRepository } from "../../../domain/repositories/IPartnerRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "../console/consoleAudit.js";
import type { FileView, UploadStarted } from "../files/FileService.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import { PartnerNotFoundError } from "./PartnerAdministration.js";

export const PARTNER_OWNER = "partner";
export const MAX_PARTNER_DOCUMENTS = 50;

/** A reseller's KYC documents and signed agreements (docs/29 §2.1), kept by staff. Audited. */
export class PartnerDocuments {
  constructor(
    private readonly deps: Readonly<{
      partners: IPartnerRepository;
      documents: OwnedDocuments;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
    }>,
  ) {}

  async start(
    partnerId: string,
    input: DocumentUploadInput,
    actor: PlatformPrincipal,
  ): Promise<UploadStarted> {
    await this.assertPartner(partnerId);
    return this.deps.documents.start(partnerId, input, actor.userId);
  }

  async complete(partnerId: string, fileId: string, actor: PlatformPrincipal): Promise<FileView> {
    const file = await this.deps.documents.complete(partnerId, fileId);
    await recordStaffAction(this.deps, actor, {
      action: "partner.document_added",
      entityType: "partner",
      entityId: partnerId,
      after: { fileId, filename: file.filename, sizeBytes: file.sizeBytes },
    });
    return file;
  }

  async list(partnerId: string): Promise<FileView[]> {
    await this.assertPartner(partnerId);
    return this.deps.documents.list(partnerId);
  }

  async remove(
    partnerId: string,
    fileId: string,
    actor: PlatformPrincipal,
    reason: string,
  ): Promise<void> {
    const file = await this.deps.documents.get(partnerId, fileId);
    await this.deps.documents.remove(partnerId, fileId);
    await recordStaffAction(this.deps, actor, {
      action: "partner.document_removed",
      entityType: "partner",
      entityId: partnerId,
      reason,
      before: { fileId, filename: file.filename },
    });
  }

  private async assertPartner(partnerId: string): Promise<void> {
    if ((await this.deps.partners.findById(partnerId)) === null) throw new PartnerNotFoundError();
  }
}
