import type { DocumentSigner } from "../../domain/documents/DocumentSigner.js";
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
  /** Fully signed documents still waiting for their signed PDF. */
  unsealed(limit: number): Promise<string[]>;
  /** Documents being signed whose deadline has passed. */
  overdueForSigning(now: Date, limit: number): Promise<string[]>;
}

export type DocumentEventType =
  | "issued"
  | "rendered"
  | "downloaded"
  | "voided"
  | "verified"
  | "signature_requested"
  | "link_created"
  | "viewed"
  | "otp_sent"
  | "otp_verified"
  | "signed"
  | "declined"
  | "paper_attached"
  | "reminded"
  | "fully_signed"
  | "signed_pdf_rendered"
  | "expired";

export type DocumentEvent = Readonly<{
  id: string;
  documentId: string;
  /** The signer the event is about, if any. */
  signerId: string | null;
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
  /** Asks for the signed copy of a fully signed document after commit. */
  requestSeal(documentId: string): void;
}

/** People signing documents (tenant unit of work). */
export interface IDocumentSigners {
  findById(id: string): Promise<DocumentSigner | null>;
  lockById(id: string): Promise<DocumentSigner | null>;
  save(signer: DocumentSigner): Promise<void>;
  listFor(documentId: string): Promise<DocumentSigner[]>;
  /** Pending signers of these parties on documents still being signed, newest first. */
  pendingFor(
    parties: readonly Readonly<{ type: "user" | "driver"; id: string }>[],
  ): Promise<DocumentSigner[]>;
  /** Pending signers last told before `before` (or never) and told fewer than `max` times. */
  remindable(before: Date, max: number, limit: number): Promise<DocumentSigner[]>;
}

/** Single-use signing links (only the token's hash is stored). */
export interface IDocumentSigningLinks {
  create(
    link: Readonly<{
      signerId: string;
      tokenHash: string;
      createdBy: string | null;
      expiresAt: Date;
    }>,
  ): Promise<void>;
  /** The link, if not used, revoked or expired; locked for the request. */
  lockValid(
    tokenHash: string,
    now: Date,
  ): Promise<Readonly<{ id: string; signerId: string; expiresAt: Date }> | null>;
  markUsed(id: string, now: Date): Promise<void>;
  /** Revokes the signer's open links (a new one replaces them). */
  revokeOpen(signerId: string, now: Date): Promise<void>;
}

export type DocumentSettings = Readonly<{
  /** Signers confirm a one-time code (SMS, or email) before signing. */
  requireOtp: boolean;
  /** Days to collect all signatures. */
  signingDays: number;
  /** Days between reminders to signers who have not signed. */
  reminderEveryDays: number;
  maxReminders: number;
  /** Hours a guest signing link works. */
  linkHours: number;
  /** Signers may type their name instead of drawing (lower assurance). */
  allowTypedSignature: boolean;
}>;

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = Object.freeze({
  requireOtp: true,
  signingDays: 30,
  reminderEveryDays: 3,
  maxReminders: 3,
  linkHours: 72,
  allowTypedSignature: false,
});

export interface IDocumentSettingsStore {
  get(): Promise<DocumentSettings>;
  set(settings: DocumentSettings): Promise<void>;
}

export type SignerContact = Readonly<{ name: string; phone: string | null; email: string | null }>;

/** Names and contacts of the people who can be asked to sign (tenant unit of work). */
export interface ISignerParties {
  user(id: string): Promise<SignerContact | null>;
  driver(id: string): Promise<SignerContact | null>;
}
