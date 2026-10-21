import type { DocumentTemplate } from "../../domain/documents/DocumentTemplate.js";
import type { DocumentType, Language } from "../../domain/documents/DocumentTypes.js";
import type { DocumentStatus, IssuedDocument } from "../../domain/documents/IssuedDocument.js";

/** Business template versions (tenant unit of work). */
export interface IDocumentTemplateRepository {
  findById(id: string): Promise<DocumentTemplate | null>;
  lockById(id: string): Promise<DocumentTemplate | null>;
  save(template: DocumentTemplate): Promise<void>;
  /** Only drafts are ever deleted. */
  delete(id: string): Promise<void>;
  list(filter: Readonly<{ type?: DocumentType; language?: Language }>): Promise<DocumentTemplate[]>;
  active(type: DocumentType, language: Language): Promise<DocumentTemplate | null>;
  /** Serialises version numbering and activation of one type and language. */
  lockType(type: DocumentType, language: Language): Promise<void>;
  nextVersion(type: DocumentType, language: Language): Promise<number>;
}

export type DocumentListFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId?: string;
  type?: DocumentType;
  subject?: Readonly<{ type: string; id: string }>;
  status?: DocumentStatus;
  limit: number;
  afterId?: string;
}>;

/** Issued documents (tenant unit of work). */
export interface IDocumentRepository {
  findById(id: string): Promise<IssuedDocument | null>;
  lockById(id: string): Promise<IssuedDocument | null>;
  findByCode(code: string): Promise<IssuedDocument | null>;
  save(document: IssuedDocument): Promise<void>;
  /** Newest first. */
  list(filter: DocumentListFilter): Promise<IssuedDocument[]>;
  /** Documents still waiting for their PDF (oldest first). */
  unrendered(limit: number): Promise<string[]>;
}

export type DocumentEventType = "issued" | "rendered" | "downloaded" | "voided" | "verified";

export type DocumentEvent = Readonly<{
  id: string;
  documentId: string;
  type: DocumentEventType;
  actorType: "user" | "system" | "public";
  actorId: string | null;
  ip: string | null;
  metadata: Readonly<Record<string, unknown>>;
  at: Date;
}>;

/** The append-only history of each document (docs/24 §5). */
export interface IDocumentEvents {
  add(event: Omit<DocumentEvent, "id" | "at"> & Readonly<{ at: Date }>): Promise<void>;
  list(documentId: string): Promise<DocumentEvent[]>;
}

/** Asks for a document's PDF to be rendered after the issuing transaction commits. */
export interface IDocumentRenderQueue {
  request(documentId: string): void;
}
