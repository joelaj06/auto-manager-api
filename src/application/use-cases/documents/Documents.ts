import { createHash, randomBytes } from "node:crypto";
import { DocumentMarkup } from "../../../domain/documents/DocumentMarkup.js";
import {
  DocumentSigner,
  type DocumentSignerProps,
} from "../../../domain/documents/DocumentSigner.js";
import {
  DOCUMENT_TYPE_CATALOG,
  type DocumentType,
  type Language,
} from "../../../domain/documents/DocumentTypes.js";
import {
  groupCode,
  IssuedDocument,
  normaliseVerificationCode,
  verificationCode,
  DocumentRuleError,
  type DocumentStatus,
  type IssuedDocumentProps,
} from "../../../domain/documents/IssuedDocument.js";
import { Template } from "../../../domain/documents/TemplateEngine.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type { Page } from "../../dto/Page.js";
import { DocumentNotFoundError } from "../../errors/DocumentErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  DocumentEvent,
  IDocumentEvents,
  IDocumentRenderQueue,
  IDocumentRepository,
  IDocumentSettingsStore,
  IDocumentSigners,
  IDocumentTemplateRepository,
  ISignerParties,
} from "../../ports/IDocumentRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { PageCursor } from "../../services/PageCursor.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { FileService, FileView } from "../files/FileService.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { DocumentPdfComposer } from "./DocumentPdfComposer.js";
import type { SignatureRequests } from "./SignatureRequests.js";

export type IssueRequest = Readonly<{
  type: DocumentType;
  subject: Readonly<{ type: string; id: string }>;
  branchId: string | null;
  /** The type's fields except `issuer` and `document`, which are added here. */
  data: Readonly<Record<string, unknown>>;
  language?: Language;
  /** A correction: the document it replaces (voided). */
  replacesId?: string | null;
  /**
   * Who signs it in the system, by their place in the template's signature block. Without
   * signers the document is printed and signed by hand.
   */
  signers?: readonly SignerRequest[];
}>;

export type SignerRequest = Readonly<{
  role: string;
  party:
    | Readonly<{ type: "user" | "driver"; id: string }>
    | Readonly<{ type: "guest"; name: string; phone?: string | null; email?: string | null }>;
  /** Default: required, except a witness. */
  required?: boolean;
}>;

/** A signer as staff see them (never the evidence's raw IP, device or codes). */
export type SignerView = Pick<
  DocumentSignerProps,
  | "id"
  | "position"
  | "role"
  | "label"
  | "partyType"
  | "partyId"
  | "name"
  | "required"
  | "status"
  | "method"
  | "signedAt"
  | "declinedAt"
  | "declineReason"
  | "reminders"
> &
  Readonly<{ codeConfirmed: boolean }>;

export const signerView = (s: DocumentSignerProps): SignerView => ({
  id: s.id,
  position: s.position,
  role: s.role,
  label: s.label,
  partyType: s.partyType,
  partyId: s.partyId,
  name: s.name,
  required: s.required,
  status: s.status,
  method: s.method,
  signedAt: s.signedAt,
  declinedAt: s.declinedAt,
  declineReason: s.declineReason,
  reminders: s.reminders,
  codeConfirmed: s.otpVerifiedAt !== null,
});

export type DocumentView = Omit<IssuedDocumentProps, "templateBody" | "data"> &
  Readonly<{
    name: string;
    /** As printed: 4F7K-2M9Q-XR3T. */
    code: string;
    verifyUrl: string;
    data?: Readonly<Record<string, unknown>>;
    signers?: readonly SignerView[];
    events?: readonly DocumentEvent[];
  }>;

export type VerificationResult =
  | Readonly<{ found: false }>
  | Readonly<{
      found: true;
      type: string;
      name: string;
      number: string;
      issuedOn: string;
      issuer: string;
      parties: readonly string[];
      status: DocumentStatus;
      voidedAt: Date | null;
      signatures: readonly Readonly<{
        name: string;
        label: string;
        status: "pending" | "signed" | "declined";
        signedAt: Date | null;
      }>[];
      fullySignedAt: Date | null;
      /** The document as issued (what was signed) and the signed copy. */
      pdfSha256: string | null;
      signedPdfSha256: string | null;
      /** Whether a copy's hash matches the issued or the signed PDF (null: none given). */
      hashMatches: boolean | null;
    }>;

/**
 * Issued documents (docs/24 §3, §6). Issuing snapshots the data and the template in use (the
 * business's active version or the system one), numbers the document and gives it a
 * verification code; the PDF is rendered once in the background, stored, hashed (SHA-256) and
 * never replaced. Anyone holding the paper can check it by its code or QR: what it is, who it
 * is between, whether it is still valid, and whether a copy's hash matches.
 */
export class Documents {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      documents: IDocumentRepository;
      events: IDocumentEvents;
      templates: IDocumentTemplateRepository;
      renderQueue: IDocumentRenderQueue;
      organisation: IOrganisationSettings;
      numbering: DocumentNumbering;
      calendar: TenantCalendar;
      files: FileService;
      composer: DocumentPdfComposer;
      signers: IDocumentSigners;
      parties: ISignerParties;
      documentSettings: IDocumentSettingsStore;
      requests: SignatureRequests;
      scope: BranchScope;
      tenantContext: ITenantContext;
      directory: ITenantDirectory;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      settings: Readonly<{ webAppUrl: string }>;
    }>,
  ) {}

  /** For modules: issues a document (inside their unit of work); its PDF follows after commit. */
  async issue(userId: string | null, request: IssueRequest): Promise<DocumentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const def = DOCUMENT_TYPE_CATALOG[request.type];
      const language = request.language ?? "en";
      const now = deps.clock.now();
      const organisation = await deps.organisation.get();
      const template = await deps.templates.active(request.type, language);
      const number = await deps.numbering.next(def.numbering, now);
      const data = {
        ...request.data,
        issuer: {
          name: organisation.legalName ?? organisation.name,
          tin: organisation.tin,
          phone: organisation.contactPhone,
          email: organisation.contactEmail,
          address: null,
        },
        document: { number, issuedOn: await deps.calendar.today() },
      };
      const body = template?.snapshot().body ?? def.system.body;
      // Fail now, not in the background, if the data does not fit the template.
      const layout = DocumentMarkup.parse(Template.compile(body).render(data)).layout();
      const places = layout.flatMap((b) => (b.kind === "signatures" ? b.signers : []));
      const asked = request.signers ?? [];
      for (const signer of asked)
        if (!places.some((p) => p.role === signer.role))
          throw new DocumentRuleError(
            `The template has no "${signer.role}" signature (it has ${places.map((p) => p.role).join(", ") || "none"})`,
          );
      if (new Set(asked.map((a) => a.role)).size !== asked.length)
        throw new DocumentRuleError("Each signature place has one signer");
      const { signingDays } = await deps.documentSettings.get();

      if (request.replacesId !== undefined && request.replacesId !== null) {
        const old = await deps.documents.lockById(request.replacesId);
        const o = old?.snapshot();
        if (old === null || o?.type !== request.type || o.subjectId !== request.subject.id)
          throw new DocumentRuleError(
            "A correction replaces a document of the same kind and subject",
          );
        old.void(userId ?? "", `Replaced by ${number}`, now);
        await deps.documents.save(old);
        await this.event(old.id, "voided", userId, { replacedBy: number });
      }
      const document = IssuedDocument.issue({
        id: deps.ids.next(),
        number,
        type: request.type,
        language,
        templateId: template?.id ?? null,
        templateVersion:
          template === null ? `system-${def.system.version}` : String(template.snapshot().version),
        templateBody: body,
        subjectType: request.subject.type,
        subjectId: request.subject.id,
        branchId: request.branchId,
        data,
        verificationCode: verificationCode(randomBytes(8)),
        issuedBy: userId,
        replacesId: request.replacesId ?? null,
        signingExpiresAt:
          asked.length === 0 ? null : new Date(now.getTime() + signingDays * 86_400_000),
        now,
      });
      await deps.documents.save(document);
      const signers: DocumentSigner[] = [];
      for (const signer of asked) {
        const place = places.findIndex((p) => p.role === signer.role);
        const contact =
          signer.party.type === "guest"
            ? {
                name: signer.party.name.trim(),
                phone: signer.party.phone ?? null,
                email: signer.party.email ?? null,
              }
            : signer.party.type === "user"
              ? await deps.parties.user(signer.party.id)
              : await deps.parties.driver(signer.party.id);
        if (contact === null)
          throw new DocumentRuleError(`The ${places[place]!.label} to sign was not found`);
        const added = DocumentSigner.add({
          id: deps.ids.next(),
          documentId: document.id,
          position: place + 1,
          role: signer.role,
          label: places[place]!.label,
          partyType: signer.party.type,
          partyId: signer.party.type === "guest" ? null : signer.party.id,
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
          required: signer.required ?? signer.role !== "witness",
          now,
        });
        await deps.signers.save(added);
        signers.push(added);
      }
      await this.event(document.id, "issued", userId, {
        template: document.snapshot().templateVersion,
      });
      if (userId !== null)
        await recordUserAction(deps, userId, {
          action: "document.issued",
          entityType: "document",
          entityId: document.id,
          after: { number, type: request.type, subject: request.subject },
        });
      for (const signer of signers)
        await this.event(document.id, "signature_requested", userId, {}, signer.id);
      if (signers.length > 0)
        await deps.requests.request(document.snapshot(), signers, await this.slug(), userId);
      deps.renderQueue.request(document.id);
      return {
        ...(await this.view(document, false)),
        signers: signers.map((x) => signerView(x.snapshot())),
      };
    });
  }

  /**
   * Renders and stores the PDF of a document that has none yet; does nothing otherwise. Safe to
   * run twice at once: the second waits on the lock and finds the PDF.
   */
  async render(documentId: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const document = await deps.documents.lockById(documentId);
      if (document === null || document.isRendered) return;
      const d = document.snapshot();
      const content = await deps.composer.compose(
        d,
        this.verifyUrl(await this.slug(), d.verificationCode),
        null,
      );
      const file = await deps.files.storeGenerated({
        kind: "issued_document",
        filename: `${d.number}.pdf`,
        contentType: "application/pdf",
        content,
        owner: { type: "document", id: d.id },
        createdBy: null,
      });
      const sha256 = createHash("sha256").update(content).digest("hex");
      document.rendered(file.id, sha256, deps.clock.now());
      await deps.documents.save(document);
      await this.event(d.id, "rendered", null, { sha256, bytes: content.length });
    });
  }

  /** Safety net (daily): renders documents whose background job was lost. */
  async renderPending(limit = 50): Promise<number> {
    const ids = await this.deps.unitOfWork.run(() => this.deps.documents.unrendered(limit));
    for (const id of ids) await this.render(id);
    return ids.length;
  }

  async list(
    actor: Principal,
    query: Readonly<{
      type?: DocumentType;
      subject?: Readonly<{ type: string; id: string }>;
      status?: "issued" | "void";
      branchId?: string;
      cursor?: string;
      limit: number;
    }>,
  ): Promise<Page<DocumentView>> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 1).values;
    return deps.unitOfWork.run(async () => {
      const rows = await deps.documents.list({
        branchIds: deps.scope.branchesFor(actor, "documents.list"),
        ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.subject === undefined ? {} : { subject: query.subject }),
        ...(query.status === undefined ? {} : { status: query.status }),
        limit: query.limit + 1,
        ...(after === undefined ? {} : { afterId: String(after[0]) }),
      });
      const page = PageCursor.paginate(rows, query.limit, (r) => [r.id]);
      const slug = await this.slug();
      return { ...page, items: page.items.map((d) => this.viewWith(d, slug, false)) };
    });
  }

  async get(actor: Principal, id: string): Promise<DocumentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const document = await this.reach(actor, id, "documents.view");
      return {
        ...(await this.view(document, true)),
        signers: (await deps.signers.listFor(id)).map((x) => signerView(x.snapshot())),
        events: await deps.events.list(id),
      };
    });
  }

  /** A short-lived link to the PDF (rendered now if the background job has not run yet). */
  async download(
    actor: Principal,
    id: string,
    copy: "issued" | "signed" = "issued",
  ): Promise<FileView & Readonly<{ sha256: string }>> {
    const { deps } = this;
    await deps.unitOfWork.run(() => this.reach(actor, id, "documents.view"));
    await this.render(id);
    return deps.unitOfWork.run(async () => {
      const d = (await deps.documents.findById(id))!.snapshot();
      if (copy === "signed" && d.signedPdfFileId === null)
        throw new DocumentRuleError("There is no signed copy yet");
      await this.event(id, "downloaded", actor.userId, { copy });
      return copy === "signed"
        ? { ...(await deps.files.get(d.signedPdfFileId!)), sha256: d.signedPdfSha256! }
        : { ...(await deps.files.get(d.pdfFileId!)), sha256: d.pdfSha256! };
    });
  }

  async void(actor: Principal, id: string, reason: string): Promise<DocumentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const document = await this.reach(actor, id, "documents.void", true);
      document.void(actor.userId, reason, deps.clock.now());
      await deps.documents.save(document);
      await this.event(id, "voided", actor.userId, { reason });
      await recordUserAction(deps, actor.userId, {
        action: "document.voided",
        entityType: "document",
        entityId: id,
        after: { number: document.snapshot().number, reason },
      });
      return this.view(document, false);
    });
  }

  /** Public check of a document by its code (docs/24 §6): never its content. */
  async verify(code: string, sha256: string | null): Promise<VerificationResult> {
    const { deps } = this;
    const normalised = normaliseVerificationCode(code);
    if (normalised === null) return { found: false };
    return deps.unitOfWork.run(async () => {
      const document = await deps.documents.findByCode(normalised);
      if (document === null) return { found: false };
      const d = document.snapshot();
      const data = d.data as {
        issuer?: { name?: string };
        document?: { issuedOn?: string };
        driver?: { name?: string };
        customer?: { name?: string };
      };
      const hash = sha256?.trim().toLowerCase() ?? null;
      const signers = await deps.signers.listFor(d.id);
      await deps.events.add({
        documentId: d.id,
        signerId: null,
        type: "verified",
        actorType: "public",
        actorId: null,
        ip: deps.requestContext.current()?.ip ?? null,
        metadata: hash === null ? {} : { hashChecked: true },
        at: deps.clock.now(),
      });
      return {
        found: true,
        type: d.type,
        name: DOCUMENT_TYPE_CATALOG[d.type].name,
        number: d.number,
        issuedOn: data.document?.issuedOn ?? d.issuedAt.toISOString().slice(0, 10),
        issuer: data.issuer?.name ?? "",
        parties: [data.driver?.name, data.customer?.name].filter(
          (n): n is string => typeof n === "string" && n !== "",
        ),
        status: d.status,
        voidedAt: d.voidedAt,
        signatures: signers.map((x) => {
          const v = x.snapshot();
          return { name: v.name, label: v.label, status: v.status, signedAt: v.signedAt };
        }),
        fullySignedAt: d.fullySignedAt,
        pdfSha256: d.pdfSha256,
        signedPdfSha256: d.signedPdfSha256,
        hashMatches:
          hash === null || d.pdfSha256 === null
            ? null
            : hash === d.pdfSha256 || hash === d.signedPdfSha256,
      };
    });
  }

  private async event(
    documentId: string,
    type: DocumentEvent["type"],
    userId: string | null,
    metadata: Readonly<Record<string, unknown>>,
    signerId: string | null = null,
  ): Promise<void> {
    await this.deps.events.add({
      documentId,
      signerId,
      type,
      actorType: userId === null ? "system" : "user",
      actorId: userId,
      ip: this.deps.requestContext.current()?.ip ?? null,
      metadata,
      at: this.deps.clock.now(),
    });
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<IssuedDocument> {
    const { deps } = this;
    const document = lock ? await deps.documents.lockById(id) : await deps.documents.findById(id);
    if (document === null) throw new DocumentNotFoundError();
    const branchId = document.snapshot().branchId;
    if (branchId !== null)
      await deps.scope.assertReaches(
        actor,
        permission,
        branchId,
        () => new DocumentNotFoundError(),
      );
    return document;
  }

  private async view(document: IssuedDocument, withData: boolean): Promise<DocumentView> {
    return this.viewWith(document, await this.slug(), withData);
  }

  private viewWith(document: IssuedDocument, slug: string, withData: boolean): DocumentView {
    const { templateBody: _body, data, ...rest } = document.snapshot();
    return {
      ...rest,
      name: DOCUMENT_TYPE_CATALOG[rest.type].name,
      code: groupCode(rest.verificationCode),
      verifyUrl: this.verifyUrl(slug, rest.verificationCode),
      ...(withData ? { data } : {}),
    };
  }

  verifyUrl(slug: string, code: string): string {
    return `${this.deps.settings.webAppUrl.replace(/\/$/, "")}/${slug}/verify/${groupCode(code)}`;
  }

  async slug(): Promise<string> {
    const tenantId = this.deps.tenantContext.currentTenantId().value;
    return (await this.deps.directory.findById(tenantId))?.slug ?? tenantId;
  }
}
