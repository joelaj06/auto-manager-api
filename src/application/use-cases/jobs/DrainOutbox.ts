import type { EventHandlerRegistry } from "../../events/EventHandlerRegistry.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { IClock } from "../../ports/IClock.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { IOutboxStore } from "../../ports/IOutboxStore.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

const BATCH_SIZE = 100;
const MAX_RETRY_DELAY_MS = 3_600_000;

/**
 * Publishes a tenant's due outbox events: one `event.deliver` job per (event, subscribed
 * handler), then marks the event published. Delivery is at least once — if the process dies
 * after enqueueing but before commit, the event is enqueued again and the handler's idempotency
 * key absorbs the duplicate.
 *
 * Events without subscribers are simply marked published. Failed events back off
 * exponentially (10 s, 20 s, … up to 1 h) and a delayed drain is scheduled for them.
 */
export class DrainOutbox implements IJobHandler<"outbox.drain"> {
  readonly job = "outbox.drain" as const;

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      outbox: IOutboxStore;
      handlers: EventHandlerRegistry;
      queue: IJobQueue;
      clock: IClock;
    }>,
  ) {}

  async handle({ tenantId }: JobPayloads["outbox.drain"]): Promise<void> {
    const { deps } = this;
    const { claimed, earliestRetry } = await deps.unitOfWork.run(async () => {
      const events = await deps.outbox.claimDue(BATCH_SIZE);
      let earliest: Date | null = null;
      for (const event of events) {
        try {
          for (const handler of deps.handlers.handlersFor(event.eventType)) {
            await deps.queue.enqueue("event.deliver", {
              tenantId,
              eventId: event.id,
              eventType: event.eventType,
              handler: handler.name,
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              payload: event.payload,
              occurredAt: event.occurredAt.toISOString(),
            });
          }
          await deps.outbox.markPublished(event.id);
        } catch (error) {
          const retryAt = new Date(
            deps.clock.now().getTime() + Math.min(10_000 * 2 ** event.attempts, MAX_RETRY_DELAY_MS),
          );
          await deps.outbox.markFailed(event.id, describe(error), retryAt);
          if (earliest === null || retryAt < earliest) earliest = retryAt;
        }
      }
      return { claimed: events.length, earliestRetry: earliest };
    });

    if (claimed === BATCH_SIZE) {
      // More may be waiting; the stately queue keeps at most one queued drain per tenant.
      await deps.queue.enqueue("outbox.drain", { tenantId }, { singletonKey: tenantId });
    } else if (earliestRetry !== null) {
      await deps.queue.enqueue(
        "outbox.drain",
        { tenantId },
        { singletonKey: tenantId, startAfter: earliestRetry },
      );
    }
  }
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
