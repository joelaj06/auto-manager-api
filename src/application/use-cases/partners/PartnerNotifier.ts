import type { IPartnerRepository } from "../../../domain/repositories/IPartnerRepository.js";
import type { NotificationService } from "../../notifications/NotificationService.js";

/** Commission and payout news to a reseller's contact (docs/29 §6), once per key. */
export class PartnerNotifier {
  constructor(
    private readonly deps: Readonly<{
      partners: IPartnerRepository;
      email: NotificationService;
      consoleUrl: string;
      attributions: (
        tenantId: string,
      ) => Promise<Readonly<{ partnerId: string; partnerStatus: string }> | null>;
    }>,
  ) {}

  /** The tenant's reseller, if it has one (not terminated). */
  async tellTenantReseller(
    tenantId: string,
    message: Readonly<{ subject: string; body: string; key: string }>,
  ): Promise<void> {
    const attribution = await this.deps.attributions(tenantId);
    if (attribution === null || attribution.partnerStatus === "terminated") return;
    await this.tell(attribution.partnerId, message);
  }

  async tell(
    partnerId: string,
    message: Readonly<{ subject: string; body: string; key: string }>,
  ): Promise<void> {
    const partner = await this.deps.partners.findById(partnerId);
    if (partner === null) return;
    const { profile } = partner.snapshot();
    await this.deps.email.sendEmail({
      to: profile.email,
      template: "partner.notice",
      data: {
        name: profile.contactName,
        subject: message.subject,
        paragraphs: [message.body],
        consoleUrl: this.deps.consoleUrl,
      },
      idempotencyKey: `partner:${partnerId}:${message.key}`,
    });
  }
}
