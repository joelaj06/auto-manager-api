import type {
  ILegalRepository,
  LegalDocument,
  LegalKind,
} from "../../../domain/repositories/ILegalRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "./consoleAudit.js";

export class LegalDocumentNotFoundError extends ApplicationError {
  readonly code = "LEGAL_DOCUMENT_NOT_FOUND";
  constructor() {
    super("Legal document not found");
  }
}

export class LegalRuleError extends ApplicationError {
  readonly code = "LEGAL_RULE";
  constructor(message: string) {
    super(message);
  }
}

/** What a tenant must have accepted, and whether it has (the apps prompt the owner). */
export type TenantLegalStatus = Readonly<{
  documents: readonly Readonly<{
    id: string;
    kind: LegalKind;
    version: string;
    title: string;
    summary: string | null;
    effectiveAt: Date | null;
    requiresAcceptance: boolean;
    acceptedAt: Date | null;
  }>[];
  /** Something new the owner still has to accept. */
  actionRequired: boolean;
}>;

/** What every page shows: the sign-up form, the app's legal page. */
const PUBLIC_KINDS: readonly LegalKind[] = ["terms", "privacy"];

/**
 * Terms of service, privacy policy and the data processing agreement (docs/27 §3.11, §3.15):
 * versions drafted and published by staff with an effective date; the version in force is the
 * newest effective one. Applicants accept the current terms and privacy policy at sign-up (the
 * tenant inherits that acceptance); a later version that requires acceptance is accepted by the
 * tenant's owner in the app. Every acceptance is kept (who, when, where from); staff see who
 * accepted which version and who has not.
 */
export class LegalDocuments {
  constructor(
    private readonly deps: Readonly<{
      legal: ILegalRepository;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  // --- console ---

  async draft(
    input: Readonly<{
      kind: LegalKind;
      version: string;
      title: string;
      body: string;
      summary?: string | null;
      requiresAcceptance?: boolean;
    }>,
    actor: PlatformPrincipal,
  ): Promise<LegalDocument> {
    const { deps } = this;
    if (await deps.legal.versionTaken(input.kind, input.version))
      throw new LegalRuleError(`Version ${input.version} of the ${input.kind} already exists`);
    const document: LegalDocument = {
      id: deps.ids.next(),
      kind: input.kind,
      version: input.version,
      title: input.title.trim(),
      body: input.body,
      summary: input.summary?.trim() || null,
      requiresAcceptance: input.requiresAcceptance ?? true,
      status: "draft",
      effectiveAt: null,
      publishedAt: null,
      createdBy: actor.userId,
      createdAt: deps.clock.now(),
    };
    await deps.unitOfWork.run(async () => {
      await deps.legal.save(document);
      await this.audit(actor, "legal.drafted", document);
    });
    return document;
  }

  async update(
    id: string,
    changes: Readonly<{
      title?: string;
      body?: string;
      summary?: string | null;
      requiresAcceptance?: boolean;
    }>,
    actor: PlatformPrincipal,
  ): Promise<LegalDocument> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const d = await this.find(id, true);
      if (d.status !== "draft")
        throw new LegalRuleError("A published version is never changed; draft a new one");
      const updated: LegalDocument = {
        ...d,
        ...(changes.title === undefined ? {} : { title: changes.title.trim() }),
        ...(changes.body === undefined ? {} : { body: changes.body }),
        ...(changes.summary === undefined ? {} : { summary: changes.summary?.trim() || null }),
        ...(changes.requiresAcceptance === undefined
          ? {}
          : { requiresAcceptance: changes.requiresAcceptance }),
      };
      await deps.legal.save(updated);
      await this.audit(actor, "legal.updated", updated);
      return updated;
    });
  }

  /** Published: in force from `effectiveAt` (now, or a date ahead for notice). */
  async publish(
    id: string,
    effectiveAt: Date | null,
    actor: PlatformPrincipal,
  ): Promise<LegalDocument> {
    const { deps } = this;
    const now = deps.clock.now();
    return deps.unitOfWork.run(async () => {
      const d = await this.find(id, true);
      if (d.status !== "draft") throw new LegalRuleError("This version is already published");
      const published: LegalDocument = {
        ...d,
        status: "published",
        publishedAt: now,
        effectiveAt: effectiveAt ?? now,
      };
      await deps.legal.save(published);
      await this.audit(actor, "legal.published", published);
      return published;
    });
  }

  list(kind?: LegalKind): Promise<LegalDocument[]> {
    return this.deps.legal.list(kind);
  }

  async get(id: string) {
    const d = await this.find(id);
    return {
      ...d,
      acceptances: d.status === "published" ? await this.deps.legal.acceptanceSummary(id) : null,
    };
  }

  // --- public ---

  async current(kind: LegalKind): Promise<LegalDocument> {
    const d = await this.deps.legal.current(kind, this.deps.clock.now());
    if (d === null) throw new LegalDocumentNotFoundError();
    return d;
  }

  /** At sign-up: the applicant accepted the terms and privacy policy in force (inside the unit of work). */
  async recordSignup(
    applicationId: string,
    context: Readonly<{ ip: string | null; userAgent: string | null }>,
  ): Promise<void> {
    const now = this.deps.clock.now();
    for (const kind of PUBLIC_KINDS) {
      const d = await this.deps.legal.current(kind, now);
      if (d === null) continue;
      await this.deps.legal.accept({
        documentId: d.id,
        tenantId: null,
        applicationId,
        tenantUserId: null,
        context: "signup",
        acceptedAt: now,
        ip: context.ip,
        userAgent: context.userAgent,
      });
    }
  }

  // --- the tenant ---

  async tenantStatus(tenantId: string): Promise<TenantLegalStatus> {
    const now = this.deps.clock.now();
    const documents = [];
    for (const kind of [...PUBLIC_KINDS, "dpa"] as const) {
      const d = await this.deps.legal.current(kind, now);
      if (d === null) continue;
      documents.push({
        id: d.id,
        kind: d.kind,
        version: d.version,
        title: d.title,
        summary: d.summary,
        effectiveAt: d.effectiveAt,
        requiresAcceptance: d.requiresAcceptance,
        acceptedAt: await this.deps.legal.acceptedAt(d.id, tenantId),
      });
    }
    return {
      documents,
      actionRequired: documents.some((d) => d.requiresAcceptance && d.acceptedAt === null),
    };
  }

  /** The owner accepts the versions in force for the business. */
  async accept(
    tenantId: string,
    userId: string,
    documentIds: readonly string[],
    context: Readonly<{ ip: string | null; userAgent: string | null }>,
  ): Promise<TenantLegalStatus> {
    const { deps } = this;
    const now = deps.clock.now();
    const current = await this.tenantStatus(tenantId);
    for (const id of documentIds)
      if (!current.documents.some((d) => d.id === id))
        throw new LegalRuleError("Only the versions in force can be accepted");
    await deps.unitOfWork.run(async () => {
      for (const documentId of documentIds)
        await deps.legal.accept({
          documentId,
          tenantId,
          applicationId: null,
          tenantUserId: userId,
          context: "app",
          acceptedAt: now,
          ip: context.ip,
          userAgent: context.userAgent,
        });
    });
    return this.tenantStatus(tenantId);
  }

  private async find(id: string, lock = false): Promise<LegalDocument> {
    const d = await this.deps.legal.find(id, lock);
    if (d === null) throw new LegalDocumentNotFoundError();
    return d;
  }

  private audit(actor: PlatformPrincipal, action: string, d: LegalDocument): Promise<void> {
    return recordStaffAction(this.deps, actor, {
      action,
      entityType: "legal_document",
      entityId: d.id,
      after: { kind: d.kind, version: d.version, status: d.status, effectiveAt: d.effectiveAt },
    });
  }
}
