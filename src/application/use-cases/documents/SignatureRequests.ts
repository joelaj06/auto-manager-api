import { createHash, randomBytes } from "node:crypto";
import type { DocumentSigner } from "../../../domain/documents/DocumentSigner.js";
import { DOCUMENT_TYPE_CATALOG } from "../../../domain/documents/DocumentTypes.js";
import type { IssuedDocumentProps } from "../../../domain/documents/IssuedDocument.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  IDocumentSettingsStore,
  IDocumentSigningLinks,
} from "../../ports/IDocumentRecords.js";
import type { IDriverAppLinks } from "../../ports/IDriverAppLinks.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { Notifier } from "../notifications/Notifier.js";

export type SigningLink = Readonly<{ url: string; expiresAt: Date }>;

const SMS = {
  driver:
    "{{businessName}}: {{signerName}}, please sign {{documentName}} {{number}} in your driver app.",
  guest: "{{businessName}}: {{signerName}}, please sign {{documentName}} {{number}}: {{link}}",
} as const;

/**
 * Asks signers to sign (docs/24 §4), when a document is issued and as a reminder: users of the
 * business in their inbox (and by push or email), drivers in the driver app and by SMS, guests
 * by SMS or email with a single-use link (the link is hidden in the delivery log). Uses the
 * `signature_requests` rule's channels.
 */
export class SignatureRequests {
  constructor(
    private readonly deps: Readonly<{
      links: IDocumentSigningLinks;
      driverLinks: IDriverAppLinks;
      notifier: Notifier;
      notificationSettings: INotificationSettingsStore;
      documentSettings: IDocumentSettingsStore;
      organisation: IOrganisationSettings;
      clock: IClock;
      settings: Readonly<{ webAppUrl: string }>;
    }>,
  ) {}

  /** Call inside the unit of work that issued (or reminds about) the document. */
  async request(
    document: IssuedDocumentProps,
    signers: readonly DocumentSigner[],
    slug: string,
    createdBy: string | null,
  ): Promise<void> {
    const { deps } = this;
    const settings = await deps.notificationSettings.get();
    const organisation = await deps.organisation.get();
    const documentName = DOCUMENT_TYPE_CATALOG[document.type].name;
    for (const signer of signers) {
      const s = signer.snapshot();
      if (s.status !== "pending") continue;
      const dedupeKey = `signature:${s.id}:${s.reminders}`;
      const values = {
        signerName: s.name,
        documentName,
        number: document.number,
        businessName: organisation.name,
        link: "",
      };
      const notice = {
        rule: "signature_requests" as const,
        dedupeKey,
        title: `Please sign ${document.number}`,
        body: `${documentName} ${document.number} is waiting for your signature.`,
        severity: "info" as const,
        data: { documentId: document.id, signerId: s.id },
      };
      if (s.partyType === "user") {
        await deps.notifier.users(settings, { ...notice, userIds: [s.partyId!] });
        continue;
      }
      if (s.partyType === "driver") {
        const userId = await deps.driverLinks.userOf(s.partyId!);
        if (userId !== null) await deps.notifier.users(settings, { ...notice, userIds: [userId] });
        if (s.phone !== null)
          await deps.notifier.sms(settings, organisation.timezone, {
            rule: "signature_requests",
            driverId: s.partyId!,
            phone: s.phone,
            dedupeKey,
            standardText: SMS.driver,
            values: { ...values, link: "your driver app" },
          });
        continue;
      }
      const link = await this.link(signer, slug, createdBy);
      if (s.phone !== null)
        await deps.notifier.sms(settings, organisation.timezone, {
          rule: "signature_requests",
          recipientType: "signer",
          driverId: s.id,
          phone: s.phone,
          dedupeKey,
          standardText: SMS.guest,
          values: { ...values, link: link.url },
          sensitive: true,
          immediate: true,
        });
      if (s.email !== null)
        await deps.notifier.guestEmail(settings, {
          rule: "signature_requests",
          recipientId: s.id,
          name: s.name,
          email: s.email,
          dedupeKey,
          title: notice.title,
          body: `${organisation.name} asks you to sign ${documentName} ${document.number}. Open this link to read and sign it (it works once and expires on ${link.expiresAt.toISOString().slice(0, 10)}): ${link.url}`,
          sensitive: true,
        });
    }
  }

  /** A new single-use link for a signer (earlier open links stop working). */
  async link(signer: DocumentSigner, slug: string, createdBy: string | null): Promise<SigningLink> {
    const { deps } = this;
    const now = deps.clock.now();
    const { linkHours } = await deps.documentSettings.get();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + linkHours * 3_600_000);
    await deps.links.revokeOpen(signer.id, now);
    await deps.links.create({
      signerId: signer.id,
      tokenHash: SignatureRequests.hash(token),
      createdBy,
      expiresAt,
    });
    return {
      url: `${deps.settings.webAppUrl.replace(/\/$/, "")}/${slug}/sign#token=${token}`,
      expiresAt,
    };
  }

  static hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
