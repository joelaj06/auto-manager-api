import type { IDocumentSignedListener } from "../../ports/IDocumentSignedListener.js";
import { createHash } from "node:crypto";
import type { DocumentSigner } from "../../../domain/documents/DocumentSigner.js";
import { DOCUMENT_TYPE_CATALOG } from "../../../domain/documents/DocumentTypes.js";
import {
  DocumentRuleError,
  type IssuedDocument,
} from "../../../domain/documents/IssuedDocument.js";
import type { Principal } from "../../authorization/Principal.js";
import { DocumentNotFoundError } from "../../errors/DocumentErrors.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IClock } from "../../ports/IClock.js";
import type { IQrCodeRenderer } from "../../ports/IConnectLinkSigner.js";
import type {
  IDocumentEvents,
  IDocumentRenderQueue,
  IDocumentRepository,
  IDocumentSettingsStore,
  IDocumentSigners,
  IDocumentSigningLinks,
} from "../../ports/IDocumentRecords.js";
import type { IDriverAppLinks } from "../../ports/IDriverAppLinks.js";
import type {
  INotificationDeliveries,
  INotificationSettingsStore,
} from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { IssueOtpChallenge } from "../auth/IssueOtpChallenge.js";
import type { VerifyOtpChallenge } from "../auth/VerifyOtpChallenge.js";
import type { FileService, FileView, UploadStarted } from "../files/FileService.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import { maskPhone, type DocumentPdfComposer } from "./DocumentPdfComposer.js";
import { signerView, type Documents, type SignerView } from "./Documents.js";
import { SignatureRequests, type SigningLink } from "./SignatureRequests.js";

/** Who is acting on a signature: a signed-in person, or a guest holding a signing link. */
export type SignerAccess =
  Readonly<{ kind: "account"; actor: Principal }> | Readonly<{ kind: "link"; token: string }>;

export type SignatureInput = Readonly<{
  /** The code sent to the signer (when the business requires one). */
  code?: string;
  /** A drawn signature as PNG (base64 or a data URL), or a typed full name. */
  signature: Readonly<{ type: "drawn"; png: string }> | Readonly<{ type: "typed"; name: string }>;
  /** The signer agrees to sign electronically (the consent text is recorded). */
  consent: boolean;
  /** The signer's browser or app (recorded as evidence). */
  userAgent: string | null;
}>;

export type SigningTask = Readonly<{
  signer: SignerView;
  document: Readonly<{
    id: string;
    number: string;
    type: string;
    name: string;
    status: string;
    issuedAt: Date;
    signingExpiresAt: Date | null;
  }>;
  /** The PDF to read before signing (short-lived link) and its SHA-256. */
  pdf: (FileView & Readonly<{ sha256: string }>) | null;
  requireCode: boolean;
  allowTyped: boolean;
}>;

const MIN_PNG = 200;
const MAX_PNG = 512 * 1024;

/** The bytes of a drawn signature, checked: a PNG of a sensible size. */
export function signaturePng(input: string): Buffer {
  const base64 = input.replace(/^data:image\/png;base64,/, "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(base64))
    throw new DocumentRuleError("The signature is not a PNG image");
  const bytes = Buffer.from(base64, "base64");
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!png) throw new DocumentRuleError("The signature is not a PNG image");
  if (bytes.length < MIN_PNG || bytes.length > MAX_PNG)
    throw new DocumentRuleError("The signature image is empty or too large");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 100 || height < 30 || width > 4000 || height > 2000)
    throw new DocumentRuleError("Draw the signature in the signing box");
  return bytes;
}

/**
 * Signing documents (docs/24 §4–6): each signer reads the issued PDF, confirms a one-time code
 * (SMS through the business's provider, or email) and draws — or, when allowed, types — their
 * signature, or declines with a reason. Users and drivers sign signed in; guests through a
 * single-use link. Staff can record a paper signature by its scan, hand out a new link (QR) and
 * remind. When every required signature is in, the signed copy with its signature record page
 * is rendered once, hashed and kept unchanged.
 */
export class DocumentSigning {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      documents: IDocumentRepository;
      issued: Documents;
      signers: IDocumentSigners;
      links: IDocumentSigningLinks;
      events: IDocumentEvents;
      settings: IDocumentSettingsStore;
      requests: SignatureRequests;
      composer: DocumentPdfComposer;
      files: FileService;
      scans: OwnedDocuments;
      driverLinks: IDriverAppLinks;
      issueOtp: IssueOtpChallenge;
      verifyOtp: VerifyOtpChallenge;
      deliveries: INotificationDeliveries;
      notificationSettings: INotificationSettingsStore;
      emails: NotificationService;
      organisation: IOrganisationSettings;
      qr: IQrCodeRenderer;
      scope: BranchScope;
      tenantContext: ITenantContext;
      requestContext: IRequestContext;
      clock: IClock;
      sealQueue: IDocumentRenderQueue;
      /** Modules told when their documents are signed by everyone. */
      signedListeners?: readonly IDocumentSignedListener[];
    }>,
  ) {}

  /** What the caller still has to sign (as a user, or as the driver they are). */
  async mine(actor: Principal): Promise<SigningTask[]> {
    const { deps } = this;
    const parties = await this.partiesOf(actor);
    const signers = await deps.unitOfWork.run(() => deps.signers.pendingFor(parties));
    return Promise.all(signers.map((s) => this.task(s, false)));
  }

  /** One signature to give, with the PDF to read first. */
  async open(access: SignerAccess, signerId: string | null): Promise<SigningTask> {
    const signer = await this.reach(access, signerId);
    await this.deps.issued.render(signer.snapshot().documentId);
    await this.event(signer, "viewed", access, {});
    return this.task(signer, true);
  }

  /** Sends the one-time code to the signer's phone (or email). */
  async sendCode(
    access: SignerAccess,
    signerId: string | null,
  ): Promise<Readonly<{ channel: "sms" | "email"; to: string; expiresAt: Date }>> {
    const { deps } = this;
    const signer = await this.reach(access, signerId);
    const s = signer.snapshot();
    const notifications = await deps.unitOfWork.run(() => deps.notificationSettings.get());
    const channel: "sms" | "email" | null =
      s.phone !== null && notifications.sms !== null ? "sms" : s.email !== null ? "email" : null;
    if (channel === null)
      throw new DocumentRuleError(
        "No way to send this signer a code: the business has no SMS provider and they have no email",
      );
    await deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      (await deps.documents.findById(s.documentId))!.assertSignable(now);
      const locked = (await deps.signers.lockById(s.id))!;
      locked.otpSent(channel, now);
      await deps.signers.save(locked);
    });
    const issued = await deps.issueOtp.execute({
      subject: `signer:${s.id}`,
      purpose: "document_signing",
    });
    const { name } = await deps.unitOfWork.run(() => deps.organisation.get());
    if (channel === "sms")
      await deps.unitOfWork.run(() =>
        deps.deliveries.queue({
          channel: "sms",
          rule: "signing_code",
          recipientType: "signer",
          recipientId: s.id,
          address: s.phone!,
          title: null,
          body: `${issued.code} is your code to sign a document from ${name}. Do not share it.`,
          data: {},
          dedupeKey: `signing_code:${issued.challengeId}`,
          sendAfter: deps.clock.now(),
          sensitive: true,
        }),
      );
    else
      await deps.emails.sendEmail({
        to: s.email!,
        template: "auth.otp_code",
        data: {
          recipientName: s.name,
          code: issued.code,
          purpose: "document_signing",
          expiresInMinutes: Math.round(
            (issued.expiresAt.getTime() - deps.clock.now().getTime()) / 60_000,
          ),
          businessName: name,
        },
        idempotencyKey: `signing-code:${issued.challengeId}`,
        tenantId: deps.tenantContext.currentTenantId().value,
      });
    await this.event(signer, "otp_sent", access, { channel });
    return {
      channel,
      to: channel === "sms" ? maskPhone(s.phone!) : maskEmail(s.email!),
      expiresAt: issued.expiresAt,
    };
  }

  async sign(
    access: SignerAccess,
    signerId: string | null,
    input: SignatureInput,
  ): Promise<SigningTask> {
    const { deps } = this;
    if (!input.consent)
      throw new DocumentRuleError("Confirm that you agree to sign electronically");
    const signer = await this.reach(access, signerId);
    const s = signer.snapshot();
    const settings = await deps.unitOfWork.run(() => deps.settings.get());
    if (input.signature.type === "typed" && !settings.allowTypedSignature)
      throw new DocumentRuleError("Draw your signature to sign");
    const png = input.signature.type === "drawn" ? signaturePng(input.signature.png) : null;
    // The PDF they sign must exist (its hash is recorded with the signature).
    await deps.issued.render(s.documentId);
    let codeConfirmed: Date | null = null;
    if (settings.requireOtp) {
      if (input.code === undefined || input.code.trim() === "")
        throw new DocumentRuleError("Enter the code we sent you");
      // Outside the signing transaction: a wrong guess counts even if signing fails.
      await deps.verifyOtp.execute({
        subject: `signer:${s.id}`,
        purpose: "document_signing",
        code: input.code.trim(),
      });
      codeConfirmed = deps.clock.now();
      await this.event(signer, "otp_verified", access, {});
    }
    const request = deps.requestContext.current();
    const fully = await deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      const locked = (await deps.signers.lockById(s.id))!;
      const document = (await deps.documents.lockById(s.documentId))!;
      document.assertSignable(now);
      let signatureFileId: string | null = null;
      if (png !== null)
        signatureFileId = (
          await deps.files.storeGenerated({
            kind: "signature_image",
            filename: `signature-${s.id}.png`,
            contentType: "image/png",
            content: png,
            owner: { type: "document_signer", id: s.id },
            createdBy: access.kind === "account" ? access.actor.userId : null,
          })
        ).id;
      locked.sign({
        method: input.signature.type,
        signatureFileId,
        typedName: input.signature.type === "typed" ? input.signature.name : null,
        documentSha256: document.snapshot().pdfSha256!,
        otpVerifiedAt: codeConfirmed,
        ip: request?.ip ?? null,
        userAgent: input.userAgent,
        now,
      });
      await deps.signers.save(locked);
      return this.recordSignature(document, locked, access, { method: input.signature.type });
    });
    if (fully) await this.seal(s.documentId).catch(() => undefined);
    return this.task((await deps.unitOfWork.run(() => deps.signers.findById(s.id)))!, false);
  }

  async decline(
    access: SignerAccess,
    signerId: string | null,
    reason: string,
  ): Promise<SigningTask> {
    const { deps } = this;
    const signer = await this.reach(access, signerId);
    const s = signer.snapshot();
    await deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      const locked = (await deps.signers.lockById(s.id))!;
      const document = (await deps.documents.lockById(s.documentId))!;
      document.assertSignable(now);
      locked.decline(reason, deps.requestContext.current()?.ip ?? null, now);
      await deps.signers.save(locked);
      if (locked.snapshot().required) {
        document.declined();
        await deps.documents.save(document);
      }
      if (access.kind === "link") await this.useLink(access.token);
      await this.event(locked, "declined", access, { reason: locked.snapshot().declineReason });
    });
    return this.task((await deps.unitOfWork.run(() => deps.signers.findById(s.id)))!, false);
  }

  // --- staff ---

  /** A new signing link for a guest signer, with its QR (to scan in person or send yourself). */
  async newLink(
    actor: Principal,
    documentId: string,
    signerId: string,
  ): Promise<SigningLink & Readonly<{ qrSvg: string }>> {
    const { deps } = this;
    const link = await deps.unitOfWork.run(async () => {
      const { signer } = await this.staffReach(actor, documentId, signerId, "documents.issue");
      if (signer.snapshot().partyType !== "guest")
        throw new DocumentRuleError("Users and drivers sign signed in, not with a link");
      if (!signer.isPending) throw new DocumentRuleError("This signer is done");
      const created = await deps.requests.link(signer, await deps.issued.slug(), actor.userId);
      await this.event(signer, "link_created", { kind: "account", actor }, {});
      return created;
    });
    return { ...link, qrSvg: await deps.qr.svg(link.url) };
  }

  /** Asks every signer still pending again, now. */
  async remind(actor: Principal, documentId: string): Promise<number> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const document = await this.staffDocument(actor, documentId, "documents.issue", true);
      document.assertSignable(deps.clock.now());
      return this.remindPending(document, actor.userId);
    });
  }

  async startPaperScan(
    actor: Principal,
    documentId: string,
    signerId: string,
    input: DocumentUploadInput,
  ): Promise<UploadStarted> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const { signer, document } = await this.staffReach(
        actor,
        documentId,
        signerId,
        "documents.attach_paper",
      );
      document.assertSignable(deps.clock.now());
      if (!signer.isPending) throw new DocumentRuleError("This signer is done");
    });
    return deps.scans.start(documentId, input, actor.userId);
  }

  /** The scan is up: the signer counts as signed on paper, checked by the caller. */
  async completePaperScan(
    actor: Principal,
    documentId: string,
    signerId: string,
    fileId: string,
  ): Promise<SignerView> {
    const { deps } = this;
    await deps.issued.render(documentId);
    await deps.scans.complete(documentId, fileId);
    const fully = await deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      const { signer, document } = await this.staffReach(
        actor,
        documentId,
        signerId,
        "documents.attach_paper",
        true,
      );
      document.assertSignable(now);
      signer.signedOnPaper(fileId, actor.userId, document.snapshot().pdfSha256!, now);
      await deps.signers.save(signer);
      return this.recordSignature(
        document,
        signer,
        { kind: "account", actor },
        { method: "paper", fileId },
        "paper_attached",
      );
    });
    if (fully) await this.seal(documentId).catch(() => undefined);
    return signerView(
      (await deps.unitOfWork.run(() => deps.signers.findById(signerId)))!.snapshot(),
    );
  }

  // --- background ---

  /**
   * Renders the signed copy of a fully signed document (signatures on their lines and the
   * signature record page), once.
   */
  async seal(documentId: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const document = await deps.documents.lockById(documentId);
      const d = document?.snapshot();
      if (
        document === null ||
        d === undefined ||
        d.fullySignedAt === null ||
        d.signedPdfFileId !== null
      )
        return;
      const signers = await deps.signers.listFor(documentId);
      const withImages = await Promise.all(
        signers.map(async (s) => {
          const p = s.snapshot();
          return {
            ...p,
            image: p.signatureFileId === null ? null : await deps.files.read(p.signatureFileId),
          };
        }),
      );
      const content = await deps.composer.compose(
        d,
        deps.issued.verifyUrl(await deps.issued.slug(), d.verificationCode),
        { signers: withImages, at: d.fullySignedAt },
      );
      const file = await deps.files.storeGenerated({
        kind: "issued_document",
        filename: `${d.number}-signed.pdf`,
        contentType: "application/pdf",
        content,
        owner: { type: "document", id: d.id },
        createdBy: null,
      });
      const sha256 = createHash("sha256").update(content).digest("hex");
      document.signedPdf(file.id, sha256);
      await deps.documents.save(document);
      await deps.events.add({
        documentId: d.id,
        signerId: null,
        type: "signed_pdf_rendered",
        actorType: "system",
        actorId: null,
        ip: null,
        metadata: { sha256, bytes: content.length },
        at: deps.clock.now(),
      });
    });
  }

  /** Daily: expire documents past their deadline, remind slow signers, seal lost ones. */
  async maintain(): Promise<Readonly<{ expired: number; reminded: number; sealed: number }>> {
    const { deps } = this;
    const now = deps.clock.now();
    const expired = await deps.unitOfWork.run(async () => {
      let count = 0;
      for (const id of await deps.documents.overdueForSigning(now, 200)) {
        const document = (await deps.documents.lockById(id))!;
        if (!document.expire(now)) continue;
        await deps.documents.save(document);
        await deps.events.add({
          documentId: id,
          signerId: null,
          type: "expired",
          actorType: "system",
          actorId: null,
          ip: null,
          metadata: {},
          at: now,
        });
        count += 1;
      }
      return count;
    });
    const reminded = await deps.unitOfWork.run(async () => {
      const { reminderEveryDays, maxReminders } = await deps.settings.get();
      const due = await deps.signers.remindable(
        new Date(now.getTime() - reminderEveryDays * 86_400_000),
        maxReminders,
        200,
      );
      let count = 0;
      for (const signer of due) {
        const document = (await deps.documents.findById(signer.snapshot().documentId))!;
        const locked = (await deps.signers.lockById(signer.id))!;
        locked.reminded(now);
        await deps.signers.save(locked);
        await deps.requests.request(document.snapshot(), [locked], await deps.issued.slug(), null);
        await this.event(locked, "reminded", null, { reminder: locked.snapshot().reminders });
        count += 1;
      }
      return count;
    });
    const unsealed = await deps.unitOfWork.run(() => deps.documents.unsealed(50));
    for (const id of unsealed) await this.seal(id);
    return { expired, reminded, sealed: unsealed.length };
  }

  // --- helpers ---

  /** Inside the unit of work: the document moves on; true when it is now fully signed. */
  private async recordSignature(
    document: IssuedDocument,
    signer: DocumentSigner,
    access: SignerAccess,
    metadata: Readonly<Record<string, unknown>>,
    event: "signed" | "paper_attached" = "signed",
  ): Promise<boolean> {
    const { deps } = this;
    const now = deps.clock.now();
    const all = await deps.signers.listFor(document.id);
    const done = all.every((x) => !x.snapshot().required || x.snapshot().status === "signed");
    document.signatureAdded(done, now);
    await deps.documents.save(document);
    if (access.kind === "link") await this.useLink(access.token);
    await this.event(signer, event, access, metadata);
    if (done) {
      await deps.events.add({
        documentId: document.id,
        signerId: null,
        type: "fully_signed",
        actorType: "system",
        actorId: null,
        ip: null,
        metadata: {},
        at: now,
      });
      deps.sealQueue.requestSeal(document.id);
      const d = document.snapshot();
      for (const listener of deps.signedListeners ?? [])
        if (listener.documentType === d.type) await listener.fullySigned(d);
    }
    return done;
  }

  private async remindPending(document: IssuedDocument, userId: string): Promise<number> {
    const { deps } = this;
    const now = deps.clock.now();
    let count = 0;
    for (const signer of await deps.signers.listFor(document.id)) {
      if (!signer.isPending) continue;
      const locked = (await deps.signers.lockById(signer.id))!;
      locked.reminded(now);
      await deps.signers.save(locked);
      await deps.requests.request(document.snapshot(), [locked], await deps.issued.slug(), userId);
      await deps.events.add({
        documentId: document.id,
        signerId: signer.id,
        type: "reminded",
        actorType: "user",
        actorId: userId,
        ip: deps.requestContext.current()?.ip ?? null,
        metadata: {},
        at: now,
      });
      count += 1;
    }
    return count;
  }

  /** The signer the caller may act as: their own (signed in) or the link's (guest). */
  private async reach(access: SignerAccess, signerId: string | null): Promise<DocumentSigner> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (access.kind === "link") {
        const link = await deps.links.lockValid(
          SignatureRequests.hash(access.token),
          deps.clock.now(),
        );
        if (link === null)
          throw new DocumentRuleError("This signing link has expired or was already used");
        return (await deps.signers.findById(link.signerId))!;
      }
      const signer = signerId === null ? null : await deps.signers.findById(signerId);
      const s = signer?.snapshot();
      const parties = await this.partiesOf(access.actor);
      if (
        signer === null ||
        s === undefined ||
        !parties.some((p) => p.type === s.partyType && p.id === s.partyId)
      )
        throw new DocumentNotFoundError();
      return signer;
    });
  }

  private async partiesOf(actor: Principal) {
    const driverId = await this.deps.unitOfWork.run(() =>
      this.deps.driverLinks.driverOf(actor.userId),
    );
    return [
      { type: "user" as const, id: actor.userId },
      ...(driverId === null ? [] : [{ type: "driver" as const, id: driverId }]),
    ];
  }

  private async useLink(token: string): Promise<void> {
    const link = await this.deps.links.lockValid(
      SignatureRequests.hash(token),
      this.deps.clock.now(),
    );
    if (link !== null) await this.deps.links.markUsed(link.id, this.deps.clock.now());
  }

  private async staffDocument(
    actor: Principal,
    documentId: string,
    permission: "documents.issue" | "documents.attach_paper",
    lock = false,
  ): Promise<IssuedDocument> {
    const { deps } = this;
    const document = lock
      ? await deps.documents.lockById(documentId)
      : await deps.documents.findById(documentId);
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

  private async staffReach(
    actor: Principal,
    documentId: string,
    signerId: string,
    permission: "documents.issue" | "documents.attach_paper",
    lock = false,
  ): Promise<Readonly<{ document: IssuedDocument; signer: DocumentSigner }>> {
    const document = await this.staffDocument(actor, documentId, permission, lock);
    const signer = lock
      ? await this.deps.signers.lockById(signerId)
      : await this.deps.signers.findById(signerId);
    if (signer === null || signer.snapshot().documentId !== documentId)
      throw new DocumentNotFoundError();
    return { document, signer };
  }

  private async task(signer: DocumentSigner, withPdf: boolean): Promise<SigningTask> {
    const { deps } = this;
    const s = signer.snapshot();
    return deps.unitOfWork.run(async () => {
      const d = (await deps.documents.findById(s.documentId))!.snapshot();
      const settings = await deps.settings.get();
      return {
        signer: signerView(s),
        document: {
          id: d.id,
          number: d.number,
          type: d.type,
          name: DOCUMENT_TYPE_CATALOG[d.type].name,
          status: d.status,
          issuedAt: d.issuedAt,
          signingExpiresAt: d.signingExpiresAt,
        },
        pdf:
          withPdf && d.pdfFileId !== null
            ? { ...(await deps.files.get(d.pdfFileId)), sha256: d.pdfSha256! }
            : null,
        requireCode: settings.requireOtp,
        allowTyped: settings.allowTypedSignature,
      };
    });
  }

  private async event(
    signer: DocumentSigner,
    type:
      | "viewed"
      | "otp_sent"
      | "otp_verified"
      | "signed"
      | "declined"
      | "paper_attached"
      | "reminded"
      | "link_created",
    access: SignerAccess | null,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const { deps } = this;
    const request = deps.requestContext.current();
    await deps.unitOfWork.run(() =>
      deps.events.add({
        documentId: signer.snapshot().documentId,
        signerId: signer.id,
        type,
        actorType: access === null ? "system" : access.kind === "account" ? "user" : "public",
        actorId: access?.kind === "account" ? access.actor.userId : null,
        ip: request?.ip ?? null,
        metadata,
        at: deps.clock.now(),
      }),
    );
  }
}

const maskEmail = (email: string) => email.replace(/^(.)[^@]*(@.*)$/, "$1***$2");
