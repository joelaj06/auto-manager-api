import { DocumentMarkup } from "./DocumentMarkup.js";
import { DOCUMENT_TYPE_CATALOG, type DocumentType, type Language } from "./DocumentTypes.js";
import { DocumentTemplateError, Template } from "./TemplateEngine.js";

export type TemplateStatus = "draft" | "active" | "archived";

export type DocumentTemplateProps = Readonly<{
  id: string;
  type: DocumentType;
  language: Language;
  name: string;
  version: number;
  body: string;
  status: TemplateStatus;
  systemVersion: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  activatedBy: string | null;
  activatedAt: Date | null;
  archivedAt: Date | null;
}>;

/**
 * Checks a template body before it is saved (docs/24 §3): the language and markup are valid,
 * every field exists for the document type, every locked clause of the system template is there
 * unchanged, and the sample data renders to valid markup.
 */
export function validateTemplate(type: DocumentType, body: string): void {
  const def = DOCUMENT_TYPE_CATALOG[type];
  const template = Template.compile(body);
  template.check(def.fields);
  const clauses = DocumentMarkup.parse(body).clauses();
  for (const [id, clause] of DocumentMarkup.parse(def.system.body).clauses()) {
    if (!clause.locked) continue;
    const mine = clauses.get(id);
    if (mine === undefined)
      throw new DocumentTemplateError(
        `The locked clause "${clause.title ?? id}" must stay in the template`,
      );
    if (mine.content !== clause.content || !mine.locked || mine.title !== clause.title)
      throw new DocumentTemplateError(
        `The locked clause "${clause.title ?? id}" cannot be changed`,
      );
  }
  DocumentMarkup.parse(template.render(def.sample)).layout();
}

/**
 * A business's version of a document template. Drafts can be edited; activating one makes it
 * the template new documents use (the previous one is archived). An active or archived version
 * never changes: editing means a new version.
 */
export class DocumentTemplate {
  private constructor(private props: DocumentTemplateProps) {}

  static draft(
    params: Readonly<{
      id: string;
      type: DocumentType;
      language: Language;
      name: string;
      version: number;
      body: string;
      createdBy: string | null;
      now: Date;
    }>,
  ): DocumentTemplate {
    const name = params.name.trim();
    if (name.length === 0) throw new DocumentTemplateError("Give the template a name");
    validateTemplate(params.type, params.body);
    return new DocumentTemplate({
      id: params.id,
      type: params.type,
      language: params.language,
      name,
      version: params.version,
      body: params.body,
      status: "draft",
      systemVersion: DOCUMENT_TYPE_CATALOG[params.type].system.version,
      createdBy: params.createdBy,
      createdAt: params.now,
      updatedAt: params.now,
      activatedBy: null,
      activatedAt: null,
      archivedAt: null,
    });
  }

  static restore(props: DocumentTemplateProps): DocumentTemplate {
    return new DocumentTemplate(props);
  }

  get id(): string {
    return this.props.id;
  }

  edit(changes: Readonly<{ name?: string; body?: string }>, now: Date): void {
    if (this.props.status !== "draft")
      throw new DocumentTemplateError("Only a draft can be edited; start a new version");
    const name = changes.name?.trim() ?? this.props.name;
    if (name.length === 0) throw new DocumentTemplateError("Give the template a name");
    const body = changes.body ?? this.props.body;
    validateTemplate(this.props.type, body);
    this.props = {
      ...this.props,
      name,
      body,
      systemVersion: DOCUMENT_TYPE_CATALOG[this.props.type].system.version,
      updatedAt: now,
    };
  }

  activate(userId: string, now: Date): void {
    if (this.props.status !== "draft")
      throw new DocumentTemplateError("Only a draft can be put in use");
    // The system template may have moved on since the draft was checked.
    validateTemplate(this.props.type, this.props.body);
    this.props = {
      ...this.props,
      status: "active",
      activatedBy: userId,
      activatedAt: now,
      updatedAt: now,
    };
  }

  archive(now: Date): void {
    if (this.props.status !== "active") return;
    this.props = { ...this.props, status: "archived", archivedAt: now, updatedAt: now };
  }

  assertDraft(): void {
    if (this.props.status !== "draft")
      throw new DocumentTemplateError("Only a draft can be deleted");
  }

  snapshot(): DocumentTemplateProps {
    return this.props;
  }
}
