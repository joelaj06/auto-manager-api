import { createHmac, timingSafeEqual } from "node:crypto";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import { optChoice, parseWhatsAppWebhook } from "../../../domain/notifications/WhatsAppWebhook.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  INotificationDeliveries,
  INotificationSettingsStore,
  NotificationSettings,
} from "../../ports/INotifications.js";
import type { ISecretBox } from "../../ports/ISecretBox.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IWhatsAppOptOuts, WhatsAppCredentials } from "../../ports/IWhatsApp.js";
import { fallBackToSms } from "./whatsappFallback.js";

/** Wrong address, verify token or signature (401): nothing tells a caller which. */
export class WhatsAppAuthError extends ApplicationError {
  readonly code = "WHATSAPP_WEBHOOK_REFUSED";
  constructor() {
    super("This webhook call was refused");
  }
}

const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/**
 * What Meta tells us for the business's own account (decision 516), at an address per business:
 * the handshake when the webhook is set up, then signed calls with how messages fared and what
 * people replied. A message that could not reach its number goes by SMS when the rule allows; a
 * reply of STOP keeps the number off WhatsApp until START. Other replies are not kept: this is a
 * channel for notices, not an inbox.
 */
export class WhatsAppWebhook {
  constructor(
    private readonly deps: Readonly<{
      tenants: ITenantDirectory;
      tenantContext: ITenantContext;
      unitOfWork: IUnitOfWork;
      settings: INotificationSettingsStore;
      deliveries: INotificationDeliveries;
      optOuts: IWhatsAppOptOuts;
      secrets: ISecretBox;
      clock: IClock;
    }>,
  ) {}

  /** The GET handshake: the challenge to echo when the verify token is the business's. */
  async verify(tenantSlug: string, mode: unknown, token: unknown, challenge: unknown) {
    if (mode !== "subscribe" || typeof token !== "string" || typeof challenge !== "string")
      throw new WhatsAppAuthError();
    const expected = await this.inTenant(tenantSlug, (settings) =>
      Promise.resolve(this.credentials(settings).verifyToken),
    );
    if (!same(Buffer.from(expected), Buffer.from(token))) throw new WhatsAppAuthError();
    return challenge;
  }

  async receive(tenantSlug: string, raw: Buffer, signature: string | undefined, body: unknown) {
    const { deps } = this;
    await this.inTenant(tenantSlug, async (settings) => {
      const { appSecret } = this.credentials(settings);
      const expected = createHmac("sha256", appSecret).update(raw).digest("hex");
      if (!same(Buffer.from(`sha256=${expected}`), Buffer.from(signature ?? "")))
        throw new WhatsAppAuthError();
      const now = deps.clock.now();
      const content = parseWhatsAppWebhook(body);
      for (const update of content.statuses) {
        const delivery = await deps.deliveries.providerStatus(
          update.messageId,
          update.status,
          update.at,
          update.error,
        );
        if (delivery !== null && update.undeliverable)
          await fallBackToSms(deps.deliveries, settings, delivery, now);
      }
      for (const message of content.inbound) {
        const choice = optChoice(message.text);
        if (choice === "out") await deps.optOuts.optOut(message.from, now);
        else if (choice === "in") await deps.optOuts.optIn(message.from);
      }
    });
  }

  private credentials(settings: NotificationSettings): WhatsAppCredentials {
    if (settings.whatsapp === null) throw new WhatsAppAuthError();
    return JSON.parse(
      this.deps.secrets.open(settings.whatsapp.sealedCredentials),
    ) as WhatsAppCredentials;
  }

  private async inTenant<T>(
    slug: string,
    work: (settings: NotificationSettings) => Promise<T>,
  ): Promise<T> {
    const { deps } = this;
    const tenant = await deps.tenants.findBySlug(slug);
    if (tenant === null || tenant.status === "archived") throw new WhatsAppAuthError();
    return deps.tenantContext.runAs(TenantId.from(tenant.id), () =>
      deps.unitOfWork.run(async () => work(await deps.settings.get())),
    );
  }
}
