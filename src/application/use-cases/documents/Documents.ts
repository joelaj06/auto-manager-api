import { createHash, randomBytes } from "node:crypto";
import { DocumentMarkup } from "../../../domain/documents/DocumentMarkup.js";
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
  IDocumentTemplateRepository,
} from "../../ports/IDocumentRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IPdfRenderer } from "../../ports/IPdfRenderer.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { BusinessLogo } from "../../services/BusinessLogo.js";
import { PageCursor } from "../../services/PageCursor.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { FileService, FileView } from "../files/FileService.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import { toPdfBlocks } from "./documentPdf.js";

export type IssueRequest = Readonly<{
  type: DocumentType;
  subject: Readonly<{ type: string; id: string }>;
  branchId: string | null;
  /** The type's fields except `issuer` and `document`, which are added here. */
  data: Readonly<Record<string, unknown>>;
  language?: Language;
  /** A correction: the document it replaces (voided). */
  replacesId?: string | null;
}>;

export type DocumentView = Omit<IssuedDocumentProps, "templateBody" | "data"> &
  Readonly<{
    name: string;
    /** As printed: 4F7K-2M9Q-XR3T. */
    code: string;
    verifyUrl: string;
    data?: Readonly<Record<string, unknown>>;
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
      status: "issued" | "void";
      voidedAt: Date | null;
      pdfSha256: string | null;
      /** Whether a hash the checker computed matches the issued PDF (null: none given). */
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
      renderer: IPdfRenderer;
      logo: BusinessLogo;
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
      DocumentMarkup.parse(Template.compile(body).render(data)).layout();

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
        now,
      });
      await deps.documents.save(document);
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
      deps.renderQueue.request(document.id);
      return this.view(document, false);
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
      const content = await this.pdf(d);
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
      return { ...(await this.view(document, true)), events: await deps.events.list(id) };
    });
  }

  /** A short-lived link to the PDF (rendered now if the background job has not run yet). */
  async download(actor: Principal, id: string): Promise<FileView & Readonly<{ sha256: string }>> {
    const { deps } = this;
    await deps.unitOfWork.run(() => this.reach(actor, id, "documents.view"));
    await this.render(id);
    return deps.unitOfWork.run(async () => {
      const d = (await deps.documents.findById(id))!.snapshot();
      await this.event(id, "downloaded", actor.userId, {});
      return { ...(await deps.files.get(d.pdfFileId!)), sha256: d.pdfSha256! };
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
      await deps.events.add({
        documentId: d.id,
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
        pdfSha256: d.pdfSha256,
        hashMatches: hash === null || d.pdfSha256 === null ? null : hash === d.pdfSha256,
      };
    });
  }

  private async pdf(d: IssuedDocumentProps): Promise<Buffer> {
    const { deps } = this;
    const html = Template.compile(d.templateBody).render(d.data);
    const issuer = (d.data.issuer ?? {}) as {
      name?: string;
      tin?: string | null;
      phone?: string | null;
      email?: string | null;
      address?: string | null;
    };
    const organisation = await deps.organisation.get();
    const url = this.verifyUrl(await this.slug(), d.verificationCode);
    const code = groupCode(d.verificationCode);
    return deps.renderer.render({
      title: "",
      reference: d.number,
      issuer: {
        name: issuer.name ?? organisation.name,
        lines: [
          ...(issuer.tin ? [`TIN ${issuer.tin}`] : []),
          ...(issuer.phone ? [issuer.phone] : []),
          ...(issuer.email ? [issuer.email] : []),
          ...(issuer.address ? [issuer.address] : []),
        ],
        logo: await deps.logo.bytes(organisation.logoStorageKey),
      },
      blocks: [
        ...toPdfBlocks(DocumentMarkup.parse(html).layout()),
        { type: "verification", url, code },
      ],
      footer: `${d.number} · verification code ${code}`,
      createdAt: d.issuedAt,
    });
  }

  private async event(
    documentId: string,
    type: DocumentEvent["type"],
    userId: string | null,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.deps.events.add({
      documentId,
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

  private verifyUrl(slug: string, code: string): string {
    return `${this.deps.settings.webAppUrl.replace(/\/$/, "")}/${slug}/verify/${groupCode(code)}`;
  }

  private async slug(): Promise<string> {
    const tenantId = this.deps.tenantContext.currentTenantId().value;
    return (await this.deps.directory.findById(tenantId))?.slug ?? tenantId;
  }
}
