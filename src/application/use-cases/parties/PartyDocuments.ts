import {
  InvalidPartyError,
  optionalDate,
  optionalText,
} from "../../../domain/parties/PartyDetails.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { Principal } from "../../authorization/Principal.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import { PartyDocumentNotFoundError } from "../../errors/PartyErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type {
  IPartyDocuments,
  PartyDocument,
  PartyDocumentType,
  PartyType,
} from "../../ports/IPartyRecords.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { FileView, UploadStarted } from "../files/FileService.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { CustomerAdministration } from "./CustomerAdministration.js";
import type { DriverAdministration } from "./DriverAdministration.js";
import type { DriverGuarantors } from "./DriverGuarantors.js";

/** Whose documents: a driver, one of a driver's guarantors, or a customer. */
export type PartyRef =
  | Readonly<{ type: "driver"; driverId: string }>
  | Readonly<{ type: "driver_guarantor"; driverId: string; guarantorId: string }>
  | Readonly<{ type: "customer"; customerId: string }>;

export type PartyDocumentInput = Readonly<{
  type?: PartyDocumentType;
  number?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  notes?: string | null;
}>;

export type PartyDocumentView = PartyDocument & Readonly<{ files: readonly FileView[] }>;

/**
 * Identity and onboarding documents (Ghana Card, licence, passport photo, police report,
 * contract …) of drivers, their guarantors and customers, with scans. Reading them is
 * sensitive (`drivers.documents.view`, `customers.id_documents.view`); adding them is part of
 * editing the person.
 */
export class PartyDocuments {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      documents: IPartyDocuments;
      drivers: DriverAdministration;
      guarantors: DriverGuarantors;
      customers: CustomerAdministration;
      policy: AuthorizationPolicy;
      files: OwnedDocuments;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async list(actor: Principal, party: PartyRef): Promise<PartyDocumentView[]> {
    const documents = await this.deps.unitOfWork.run(async () => {
      const [type, id] = await this.reach(actor, party, "view");
      return this.deps.documents.list(type, id);
    });
    const views: PartyDocumentView[] = [];
    for (const document of documents)
      views.push({ ...document, files: await this.deps.files.list(document.id) });
    return views;
  }

  async add(actor: Principal, party: PartyRef, input: PartyDocumentInput): Promise<PartyDocument> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const [partyType, partyId] = await this.reach(actor, party, "manage");
      const now = deps.clock.now();
      const document = checked({
        id: deps.ids.next(),
        partyType,
        partyId,
        type: input.type ?? "other",
        number: input.number ?? null,
        issuedOn: input.issuedOn ?? null,
        expiresOn: input.expiresOn ?? null,
        notes: input.notes ?? null,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      });
      await deps.documents.save(document);
      await this.audit(actor, party, "added", document);
      return document;
    });
  }

  async update(
    actor: Principal,
    party: PartyRef,
    documentId: string,
    input: PartyDocumentInput,
  ): Promise<PartyDocument> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await this.document(actor, party, documentId, "manage");
      const after = checked({
        ...before,
        ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
        updatedAt: deps.clock.now(),
      });
      await deps.documents.save(after);
      await this.audit(actor, party, "updated", after);
      return after;
    });
  }

  async remove(actor: Principal, party: PartyRef, documentId: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const document = await this.document(actor, party, documentId, "manage");
      for (const file of await deps.files.list(documentId))
        await deps.files.remove(documentId, file.id);
      await deps.documents.remove(documentId);
      await this.audit(actor, party, "removed", document);
    });
  }

  async startFileUpload(
    actor: Principal,
    party: PartyRef,
    documentId: string,
    input: DocumentUploadInput,
  ): Promise<UploadStarted> {
    await this.deps.unitOfWork.run(() => this.document(actor, party, documentId, "manage"));
    return this.deps.files.start(documentId, input, actor.userId);
  }

  async completeFileUpload(
    actor: Principal,
    party: PartyRef,
    documentId: string,
    fileId: string,
  ): Promise<FileView> {
    await this.deps.unitOfWork.run(() => this.document(actor, party, documentId, "manage"));
    return this.deps.files.complete(documentId, fileId);
  }

  async removeFile(
    actor: Principal,
    party: PartyRef,
    documentId: string,
    fileId: string,
  ): Promise<void> {
    await this.deps.unitOfWork.run(() => this.document(actor, party, documentId, "manage"));
    await this.deps.files.remove(documentId, fileId);
  }

  /**
   * The party within the caller's reach. Viewing needs the sensitive documents permission;
   * managing needs the right to edit the person (and to see documents, so nobody adds
   * documents they could not read back).
   */
  private async reach(
    actor: Principal,
    party: PartyRef,
    mode: "view" | "manage",
  ): Promise<[PartyType, string]> {
    const { deps } = this;
    if (party.type === "customer") {
      this.require(actor, "customers.id_documents.view");
      if (mode === "manage") this.require(actor, "customers.update");
      await deps.customers.find(party.customerId);
      return ["customer", party.customerId];
    }
    await deps.drivers.reach(actor, party.driverId, "drivers.documents.view");
    if (mode === "manage") await deps.drivers.reach(actor, party.driverId, "drivers.update");
    if (party.type === "driver") return ["driver", party.driverId];
    await deps.guarantors.reach(actor, party.driverId, party.guarantorId, "drivers.view");
    return ["driver_guarantor", party.guarantorId];
  }

  private require(
    actor: Principal,
    permission: "customers.id_documents.view" | "customers.update",
  ) {
    if (!this.deps.policy.decide(actor, permission).allowed)
      throw new PermissionDeniedError(permission);
  }

  private async document(
    actor: Principal,
    party: PartyRef,
    documentId: string,
    mode: "view" | "manage",
  ): Promise<PartyDocument> {
    const [type, id] = await this.reach(actor, party, mode);
    const document = await this.deps.documents.get(documentId);
    if (document?.partyType !== type || document.partyId !== id)
      throw new PartyDocumentNotFoundError();
    return document;
  }

  private async audit(
    actor: Principal,
    party: PartyRef,
    verb: string,
    document: PartyDocument,
  ): Promise<void> {
    const [entityType, entityId] =
      party.type === "customer" ? ["customer", party.customerId] : ["driver", party.driverId];
    await recordUserAction(this.deps, actor.userId, {
      action: `${entityType}.document_${verb}`,
      entityType,
      entityId,
      // The document number is not copied into the audit trail.
      after: { id: document.id, partyType: document.partyType, type: document.type },
    });
  }
}

function checked(d: PartyDocument): PartyDocument {
  const issuedOn = optionalDate(d.issuedOn, "Issue date");
  const expiresOn = optionalDate(d.expiresOn, "Expiry date");
  if (issuedOn !== null && expiresOn !== null && expiresOn < issuedOn)
    throw new InvalidPartyError("A document cannot expire before it was issued");
  return {
    ...d,
    number: optionalText(d.number, "Document number", 60),
    issuedOn,
    expiresOn,
    notes: optionalText(d.notes, "Notes", 2_000),
  };
}
