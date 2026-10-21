import { DomainError } from "../errors/DomainError.js";
import type { DocumentType, Language } from "./DocumentTypes.js";

export class DocumentRuleError extends DomainError {
  readonly code = "DOCUMENT_RULE";
  constructor(message: string) {
    super(message);
  }
}

export type DocumentStatus = "issued" | "void";

export type IssuedDocumentProps = Readonly<{
  id: string;
  number: string;
  type: DocumentType;
  language: Language;
  templateId: string | null;
  /** "3" for the business's version 3, "system-1" for the system template. */
  templateVersion: string;
  templateBody: string;
  subjectType: string;
  subjectId: string;
  branchId: string | null;
  data: Readonly<Record<string, unknown>>;
  verificationCode: string;
  status: DocumentStatus;
  pdfFileId: string | null;
  pdfSha256: string | null;
  renderedAt: Date | null;
  issuedBy: string | null;
  issuedAt: Date;
  voidedBy: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  replacesId: string | null;
}>;

/** Crockford base32 without I, L, O, U: what people can read back from paper. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 12 characters (60 bits) from random bytes: unguessable, short enough to type. */
export function verificationCode(random: Uint8Array): string {
  if (random.length < 8) throw new Error("A verification code needs 8 random bytes");
  let bits = 0n;
  for (const byte of random.subarray(0, 8)) bits = (bits << 8n) | BigInt(byte);
  let code = "";
  for (let i = 0; i < 12; i += 1) {
    code += ALPHABET[Number(bits & 31n)];
    bits >>= 5n;
  }
  return code;
}

/** As people type it: grouped, lower case, O for 0, I or L for 1 — or null when not a code. */
export function normaliseVerificationCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "").replaceAll("O", "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(code) ? code : null;
}

/** "4F7K-2M9Q-XR3T" for printing. */
export const groupCode = (code: string) => code.replace(/(.{4})(?=.)/g, "$1-");

/**
 * A document issued from a template (docs/24 §5–6): its data is snapshotted and the template
 * copied when it is issued, so it renders the same forever; the PDF is attached once and never
 * replaced. A wrong document is voided — a correction is a new document that names it.
 */
export class IssuedDocument {
  private constructor(private props: IssuedDocumentProps) {}

  static issue(
    params: Omit<
      IssuedDocumentProps,
      | "status"
      | "pdfFileId"
      | "pdfSha256"
      | "renderedAt"
      | "voidedBy"
      | "voidedAt"
      | "voidReason"
      | "issuedAt"
    > &
      Readonly<{ now: Date }>,
  ): IssuedDocument {
    const { now, ...rest } = params;
    return new IssuedDocument({
      ...rest,
      status: "issued",
      pdfFileId: null,
      pdfSha256: null,
      renderedAt: null,
      issuedAt: now,
      voidedBy: null,
      voidedAt: null,
      voidReason: null,
    });
  }

  static restore(props: IssuedDocumentProps): IssuedDocument {
    return new IssuedDocument(props);
  }

  get id(): string {
    return this.props.id;
  }

  get isRendered(): boolean {
    return this.props.pdfFileId !== null;
  }

  rendered(fileId: string, sha256: string, now: Date): void {
    if (this.props.pdfFileId !== null)
      throw new DocumentRuleError("This document already has its PDF");
    this.props = { ...this.props, pdfFileId: fileId, pdfSha256: sha256, renderedAt: now };
  }

  void(userId: string, reason: string, now: Date): void {
    if (this.props.status === "void") throw new DocumentRuleError("This document is already void");
    const why = reason.trim();
    if (why.length < 3) throw new DocumentRuleError("Say why the document is void");
    this.props = {
      ...this.props,
      status: "void",
      voidedBy: userId,
      voidedAt: now,
      voidReason: why,
    };
  }

  snapshot(): IssuedDocumentProps {
    return this.props;
  }
}
