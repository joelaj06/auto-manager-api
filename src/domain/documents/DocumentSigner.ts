import { DocumentRuleError } from "./IssuedDocument.js";

export type SignerPartyType = "user" | "driver" | "guest";
export type SignerStatus = "pending" | "signed" | "declined";
export type SignatureMethod = "drawn" | "typed" | "paper";

export type DocumentSignerProps = Readonly<{
  id: string;
  documentId: string;
  position: number;
  role: string;
  label: string;
  partyType: SignerPartyType;
  partyId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  required: boolean;
  status: SignerStatus;
  method: SignatureMethod | null;
  signatureFileId: string | null;
  typedName: string | null;
  paperFileId: string | null;
  verifiedBy: string | null;
  consentText: string | null;
  documentSha256: string | null;
  otpSentAt: Date | null;
  otpVerifiedAt: Date | null;
  otpChannel: "sms" | "email" | null;
  signedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
  declinedAt: Date | null;
  declineReason: string | null;
  lastRemindedAt: Date | null;
  reminders: number;
  createdAt: Date;
}>;

/** What a signer agrees to, kept word for word with their signature. */
export const CONSENT_TEXT =
  "I have read this document and agree to sign it electronically. My electronic signature has the same effect as my handwritten signature.";

/** Seconds a signer waits before asking for another code. */
export const OTP_RESEND_SECONDS = 60;

/**
 * One person's place on a document (docs/24 §4–5): a user of the business, a driver or a guest,
 * who signs by drawing (or typing) after confirming a one-time code, declines with a reason, or
 * signs on paper (staff attach the scan). The evidence — method, time, IP, device, the code and
 * the hash of the PDF they saw — never changes afterwards.
 */
export class DocumentSigner {
  private constructor(private props: DocumentSignerProps) {}

  static add(
    params: Pick<
      DocumentSignerProps,
      | "id"
      | "documentId"
      | "position"
      | "role"
      | "label"
      | "partyType"
      | "partyId"
      | "name"
      | "phone"
      | "email"
      | "required"
    > &
      Readonly<{ now: Date }>,
  ): DocumentSigner {
    const { now, ...rest } = params;
    if (rest.partyType === "guest" && rest.phone === null && rest.email === null)
      throw new DocumentRuleError(`${rest.label}: give a phone number or an email to reach them`);
    return new DocumentSigner({
      ...rest,
      status: "pending",
      method: null,
      signatureFileId: null,
      typedName: null,
      paperFileId: null,
      verifiedBy: null,
      consentText: null,
      documentSha256: null,
      otpSentAt: null,
      otpVerifiedAt: null,
      otpChannel: null,
      signedAt: null,
      ip: null,
      userAgent: null,
      declinedAt: null,
      declineReason: null,
      lastRemindedAt: null,
      reminders: 0,
      createdAt: now,
    });
  }

  static restore(props: DocumentSignerProps): DocumentSigner {
    return new DocumentSigner(props);
  }

  get id(): string {
    return this.props.id;
  }

  get isPending(): boolean {
    return this.props.status === "pending";
  }

  private assertPending(): void {
    if (this.props.status === "signed")
      throw new DocumentRuleError("This signature is already given");
    if (this.props.status === "declined")
      throw new DocumentRuleError("This signer declined to sign");
  }

  /** Records that a code went out; refuses another within a minute. */
  otpSent(channel: "sms" | "email", now: Date): void {
    this.assertPending();
    const last = this.props.otpSentAt;
    if (last !== null && now.getTime() - last.getTime() < OTP_RESEND_SECONDS * 1_000)
      throw new DocumentRuleError("A code was just sent; wait a minute before asking again");
    this.props = { ...this.props, otpSentAt: now, otpChannel: channel };
  }

  sign(
    params: Readonly<{
      method: "drawn" | "typed";
      signatureFileId: string | null;
      typedName: string | null;
      documentSha256: string;
      otpVerifiedAt: Date | null;
      ip: string | null;
      userAgent: string | null;
      now: Date;
    }>,
  ): void {
    this.assertPending();
    if (params.method === "typed" && (params.typedName?.trim().length ?? 0) < 2)
      throw new DocumentRuleError("Type your full name to sign");
    this.props = {
      ...this.props,
      status: "signed",
      method: params.method,
      signatureFileId: params.signatureFileId,
      typedName: params.method === "typed" ? params.typedName!.trim() : null,
      consentText: CONSENT_TEXT,
      documentSha256: params.documentSha256,
      otpVerifiedAt: params.otpVerifiedAt,
      signedAt: params.now,
      ip: params.ip,
      userAgent: params.userAgent?.slice(0, 300) ?? null,
    };
  }

  signedOnPaper(fileId: string, verifiedBy: string, documentSha256: string, now: Date): void {
    this.assertPending();
    this.props = {
      ...this.props,
      status: "signed",
      method: "paper",
      paperFileId: fileId,
      verifiedBy,
      documentSha256,
      signedAt: now,
    };
  }

  decline(reason: string, ip: string | null, now: Date): void {
    this.assertPending();
    const why = reason.trim();
    if (why.length < 3) throw new DocumentRuleError("Say why you do not sign");
    this.props = { ...this.props, status: "declined", declineReason: why, declinedAt: now, ip };
  }

  reminded(now: Date): void {
    this.props = { ...this.props, lastRemindedAt: now, reminders: this.props.reminders + 1 };
  }

  snapshot(): DocumentSignerProps {
    return this.props;
  }
}
