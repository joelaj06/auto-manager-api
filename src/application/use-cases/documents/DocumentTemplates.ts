import { DocumentMarkup } from "../../../domain/documents/DocumentMarkup.js";
import {
  DocumentTemplate,
  type DocumentTemplateProps,
} from "../../../domain/documents/DocumentTemplate.js";
import {
  DOCUMENT_TYPE_CATALOG,
  DOCUMENT_TYPES,
  LANGUAGES,
  type DocumentType,
  type Language,
} from "../../../domain/documents/DocumentTypes.js";
import { Template, type FieldSchema } from "../../../domain/documents/TemplateEngine.js";
import type { Principal } from "../../authorization/Principal.js";
import { DocumentTemplateNotFoundError } from "../../errors/DocumentErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IDocumentTemplateRepository } from "../../ports/IDocumentRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IPdfRenderer } from "../../ports/IPdfRenderer.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "../reference/userAudit.js";
import { toPdfBlocks } from "./documentPdf.js";

export type DocumentTypeView = Readonly<{
  type: DocumentType;
  name: string;
  languages: readonly Language[];
  /** The fields templates may use, for the editor. */
  fields: FieldSchema;
  system: Readonly<{
    version: number;
    body: string;
    lockedClauses: readonly Readonly<{ id: string; title: string | null }>[];
  }>;
  /** The business's version in use per language (null: the system template). */
  active: Readonly<Partial<Record<Language, number>>>;
}>;

/**
 * Document templates (docs/24 §3): every type starts from the system template; a business may
 * write its own versions — text, layout and optional clauses — but the locked clauses stay
 * exactly as the system has them. A draft is checked on every save and put in use when ready;
 * the version in use and older ones never change.
 */
export class DocumentTemplates {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      templates: IDocumentTemplateRepository;
      renderer: IPdfRenderer;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async catalog(): Promise<DocumentTypeView[]> {
    const versions = await this.deps.unitOfWork.run(() => this.deps.templates.list({}));
    return DOCUMENT_TYPES.map((type) => {
      const def = DOCUMENT_TYPE_CATALOG[type];
      const active: Partial<Record<Language, number>> = {};
      for (const v of versions) {
        const p = v.snapshot();
        if (p.type === type && p.status === "active") active[p.language] = p.version;
      }
      return {
        type,
        name: def.name,
        languages: LANGUAGES,
        fields: def.fields,
        system: {
          version: def.system.version,
          body: def.system.body,
          lockedClauses: [...DocumentMarkup.parse(def.system.body).clauses()]
            .filter(([, c]) => c.locked)
            .map(([id, c]) => ({ id, title: c.title })),
        },
        active,
      };
    });
  }

  list(
    query: Readonly<{ type?: DocumentType; language?: Language }>,
  ): Promise<DocumentTemplateProps[]> {
    return this.deps.unitOfWork.run(async () =>
      (await this.deps.templates.list(query)).map((t) => t.snapshot()),
    );
  }

  async get(id: string): Promise<DocumentTemplateProps> {
    return this.deps.unitOfWork.run(async () => (await this.find(id)).snapshot());
  }

  /** A new draft version (the next number for the type and language). */
  async create(
    actor: Principal,
    input: Readonly<{ type: DocumentType; language?: Language; name: string; body: string }>,
  ): Promise<DocumentTemplateProps> {
    const { deps } = this;
    const language = input.language ?? "en";
    return deps.unitOfWork.run(async () => {
      await deps.templates.lockType(input.type, language);
      const template = DocumentTemplate.draft({
        id: deps.ids.next(),
        type: input.type,
        language,
        name: input.name,
        version: await deps.templates.nextVersion(input.type, language),
        body: input.body,
        createdBy: actor.userId,
        now: deps.clock.now(),
      });
      await deps.templates.save(template);
      await this.audit(actor, "document_template.created", template);
      return template.snapshot();
    });
  }

  async update(
    actor: Principal,
    id: string,
    changes: Readonly<{ name?: string; body?: string }>,
  ): Promise<DocumentTemplateProps> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const template = await this.find(id, true);
      template.edit(changes, deps.clock.now());
      await deps.templates.save(template);
      await this.audit(actor, "document_template.updated", template);
      return template.snapshot();
    });
  }

  async remove(actor: Principal, id: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const template = await this.find(id, true);
      template.assertDraft();
      await deps.templates.delete(id);
      await this.audit(actor, "document_template.deleted", template);
    });
  }

  /** Puts a draft in use; the version used so far is archived. */
  async activate(actor: Principal, id: string): Promise<DocumentTemplateProps> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const found = await this.find(id);
      const { type, language } = found.snapshot();
      await deps.templates.lockType(type, language);
      const template = await this.find(id, true);
      const now = deps.clock.now();
      const current = await deps.templates.active(type, language);
      if (current !== null) {
        current.archive(now);
        await deps.templates.save(current);
      }
      template.activate(actor.userId, now);
      await deps.templates.save(template);
      await this.audit(actor, "document_template.activated", template);
      return template.snapshot();
    });
  }

  /** Back to the system template for a type and language. */
  async useSystem(actor: Principal, type: DocumentType, language: Language): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      await deps.templates.lockType(type, language);
      const current = await deps.templates.active(type, language);
      if (current === null) return;
      current.archive(deps.clock.now());
      await deps.templates.save(current);
      await this.audit(actor, "document_template.archived", current);
    });
  }

  /** A PDF of a template (saved or not) filled with the type's sample data, marked PREVIEW. */
  async preview(type: DocumentType, body: string | null): Promise<Buffer> {
    const def = DOCUMENT_TYPE_CATALOG[type];
    const source = body ?? def.system.body;
    const template = Template.compile(source);
    template.check(def.fields);
    const html = template.render(def.sample);
    const issuer = def.sample.issuer as { name: string; tin: string; phone: string };
    return this.deps.renderer.render({
      title: "",
      reference: (def.sample.document as { number: string }).number,
      issuer: { name: issuer.name, lines: [`TIN ${issuer.tin}`, issuer.phone], logo: null },
      watermark: "PREVIEW",
      blocks: [
        ...toPdfBlocks(DocumentMarkup.parse(html).layout()),
        {
          type: "verification",
          url: "https://example.com/verify/PREV-IEW0-0000",
          code: "PREV-IEW0-0000",
        },
      ],
      footer: "Preview with sample data — not a document",
      createdAt: this.deps.clock.now(),
    });
  }

  private async find(id: string, lock = false): Promise<DocumentTemplate> {
    const template = lock
      ? await this.deps.templates.lockById(id)
      : await this.deps.templates.findById(id);
    if (template === null) throw new DocumentTemplateNotFoundError();
    return template;
  }

  private async audit(actor: Principal, action: string, template: DocumentTemplate) {
    const p = template.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "document_template",
      entityId: p.id,
      after: { type: p.type, language: p.language, version: p.version, status: p.status },
    });
  }
}
