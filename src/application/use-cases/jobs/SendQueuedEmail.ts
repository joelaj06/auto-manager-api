import type { IJobHandler, JobContext } from "../../jobs/IJobHandler.js";
import { JOB_CATALOG, type JobPayloads } from "../../jobs/jobCatalog.js";
import type { IClock } from "../../ports/IClock.js";
import type { IEmailDeliveries } from "../../ports/IEmailDeliveries.js";
import type { IEmailSender } from "../../ports/IEmailSender.js";
import type { ILogger } from "../../ports/ILogger.js";

/**
 * Sends a queued email. Already sent (or permanently failed) deliveries are skipped, so a
 * redelivered job does not send twice. If the provider accepted the message but we crash before
 * recording it, it is sent again — email is at-least-once.
 */
export class SendQueuedEmail implements IJobHandler<"email.send"> {
  readonly job = "email.send" as const;

  constructor(
    private readonly deps: Readonly<{
      deliveries: IEmailDeliveries;
      sender: IEmailSender;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async handle({ deliveryId }: JobPayloads["email.send"], context: JobContext): Promise<void> {
    const { deps } = this;
    const delivery = await deps.deliveries.find(deliveryId);
    if (delivery === null) {
      deps.logger.warn("Email delivery not found; skipping", { deliveryId });
      return;
    }
    if (delivery.status !== "queued" || delivery.content === null) return;

    try {
      const providerMessageId = await deps.sender.send({
        to: delivery.recipient,
        ...delivery.content,
        deliveryId,
      });
      await deps.deliveries.markSent(deliveryId, providerMessageId, deps.clock.now());
    } catch (error) {
      const final = context.attempt > JOB_CATALOG["email.send"].retryLimit;
      await deps.deliveries.markAttemptFailed(
        deliveryId,
        (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        final,
      );
      throw error;
    }
  }
}
