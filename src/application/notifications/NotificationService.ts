import type { IEmailDeliveries } from "../ports/IEmailDeliveries.js";
import { renderEmail, type EmailTemplateData, type EmailTemplateKey } from "./emailTemplates.js";

export type EmailRequest<K extends EmailTemplateKey> = Readonly<{
  to: string;
  template: K;
  data: EmailTemplateData[K];
  /**
   * Identifies this notification (e.g. `otp:<challengeId>`): repeating a request with the same
   * key never sends a second email.
   */
  idempotencyKey: string;
  tenantId?: string | null;
}>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Entry point for notifications (docs/15 §1). Today: platform email, rendered now and delivered
 * by the `email.send` job with retries. SMS (tenant's own provider), push and in-app channels
 * plug in here later behind the same call.
 */
export class NotificationService {
  constructor(private readonly deliveries: IEmailDeliveries) {}

  async sendEmail<K extends EmailTemplateKey>(request: EmailRequest<K>): Promise<string> {
    const recipient = request.to.trim().toLowerCase();
    if (!EMAIL.test(recipient) || recipient.length > 320) {
      throw new Error("Invalid email recipient");
    }
    const { id } = await this.deliveries.queue({
      idempotencyKey: request.idempotencyKey,
      tenantId: request.tenantId ?? null,
      template: request.template,
      recipient,
      content: renderEmail(request.template, request.data),
    });
    return id;
  }
}
