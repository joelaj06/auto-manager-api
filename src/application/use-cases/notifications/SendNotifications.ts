import { SmsProviderError } from "../../errors/NotificationErrors.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import { renderEmail } from "../../notifications/emailTemplates.js";
import type { IClock } from "../../ports/IClock.js";
import type { IEmailDeliveries } from "../../ports/IEmailDeliveries.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ILogger } from "../../ports/ILogger.js";
import type {
  Delivery,
  INotificationDeliveries,
  INotificationSettingsStore,
  IPushDevices,
  IPushSender,
  ISmsGateway,
  NotificationSettings,
} from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { ISecretBox } from "../../ports/ISecretBox.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

/** Messages per run; a full run asks for another. */
const BATCH = 50;
/** Attempts before a message fails for good; waits grow 1, 4, 16, 64 minutes. */
const MAX_ATTEMPTS = 5;

/**
 * Sends a tenant's due messages (SMS through its provider, push, email), each in its own short
 * transaction so a failure never resends the others. Provider refusals that retrying cannot fix
 * (credentials, sender ID, balance) fail at once; others are retried with back-off. Messages
 * waiting for the end of quiet hours get a run scheduled for then.
 */
export class SendNotifications implements IJobHandler<"notifications.send"> {
  readonly job = "notifications.send" as const;

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      deliveries: INotificationDeliveries;
      settings: INotificationSettingsStore;
      organisation: IOrganisationSettings;
      secrets: ISecretBox;
      gateways: readonly ISmsGateway[];
      push: IPushSender;
      devices: IPushDevices;
      emails: IEmailDeliveries;
      queue: IJobQueue;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async handle({ tenantId }: JobPayloads["notifications.send"]): Promise<void> {
    const { deps } = this;
    let handled = 0;
    while (handled < BATCH) {
      const done = await deps.unitOfWork.run(async () => {
        const now = deps.clock.now();
        const [delivery] = await deps.deliveries.claimDue(now, 1);
        if (delivery === undefined) return false;
        await this.deliver(tenantId, delivery, await deps.settings.get());
        return true;
      });
      if (!done) break;
      handled += 1;
    }

    if (handled === BATCH) {
      await deps.queue.enqueue("notifications.send", { tenantId }, { singletonKey: tenantId });
      return;
    }
    const next = await deps.unitOfWork.run(() => deps.deliveries.nextDue(deps.clock.now()));
    if (next !== null)
      // A separate key, so a run waiting for later never blocks the next immediate one.
      await deps.queue.enqueue(
        "notifications.send",
        { tenantId },
        { singletonKey: `${tenantId}@${next.toISOString()}`, startAfter: next },
      );
  }

  private async deliver(
    tenantId: string,
    delivery: Delivery,
    settings: NotificationSettings,
  ): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now();
    try {
      if (delivery.channel === "sms") {
        if (settings.sms === null) {
          await deps.deliveries.skipped(delivery.id, "No SMS provider is set up");
          return;
        }
        const gateway = deps.gateways.find((g) => g.provider === settings.sms!.provider);
        if (gateway === undefined) throw new SmsProviderError("Unknown SMS provider", true);
        const credentials = JSON.parse(deps.secrets.open(settings.sms.sealedCredentials)) as Record<
          string,
          string
        >;
        const result = await gateway.send(
          { senderId: settings.sms.senderId, credentials },
          delivery.address,
          delivery.body,
        );
        await deps.deliveries.sent(delivery.id, gateway.provider, result.messageId, now);
      } else if (delivery.channel === "push") {
        const tokens = await deps.devices.tokensOf(delivery.recipientId);
        if (tokens.length === 0) {
          await deps.deliveries.skipped(delivery.id, "No app signed in for this person");
          return;
        }
        const { invalid } = await deps.push.send(tokens, {
          title: delivery.title ?? "",
          body: delivery.body,
          data: delivery.data,
        });
        await deps.devices.forget(invalid);
        await deps.deliveries.sent(delivery.id, "push", null, now);
      } else {
        const { name } = await deps.organisation.get();
        const queued = await deps.emails.queue({
          idempotencyKey: `tenant-notification:${tenantId}:${delivery.id}`,
          tenantId,
          template: "tenant.notification",
          recipient: delivery.address,
          content: renderEmail("tenant.notification", {
            recipientName: delivery.data.recipientName ?? "",
            businessName: name,
            title: delivery.title ?? "",
            body: delivery.body,
          }),
        });
        await deps.deliveries.sent(delivery.id, "email", queued.id, now);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = error instanceof SmsProviderError && error.permanent;
      const attempt = delivery.attempts + 1;
      const retryAt =
        permanent || attempt >= MAX_ATTEMPTS
          ? null
          : new Date(now.getTime() + 4 ** (attempt - 1) * 60_000);
      await deps.deliveries.failed(delivery.id, message, retryAt);
      deps.logger.warn("Notification not delivered", {
        tenantId,
        deliveryId: delivery.id,
        channel: delivery.channel,
        attempt,
        willRetry: retryAt !== null,
        error: message,
      });
    }
  }
}
