import type { EventHandlerRegistry } from "../../events/EventHandlerRegistry.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IProcessedMessages } from "../../ports/IProcessedMessages.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

/**
 * Runs one handler for one event, exactly once as far as the tenant database is concerned: the
 * key `event:<handler>:<eventId>` and the handler's changes commit together. A redelivery finds
 * the key and does nothing; a failure rolls both back and the job is retried.
 */
export class DeliverEvent implements IJobHandler<"event.deliver"> {
  readonly job = "event.deliver" as const;

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      processed: IProcessedMessages;
      handlers: EventHandlerRegistry;
      logger: ILogger;
    }>,
  ) {}

  async handle(payload: JobPayloads["event.deliver"]): Promise<void> {
    const { deps } = this;
    const handler = deps.handlers.byHandlerName(payload.handler);
    if (handler === undefined) {
      // The handler was removed in a later release; nothing left to do for this event.
      deps.logger.warn("Event handler no longer exists; skipping", {
        handler: payload.handler,
        eventType: payload.eventType,
        eventId: payload.eventId,
      });
      return;
    }

    await deps.unitOfWork.run(async () => {
      const fresh = await deps.processed.markProcessed(`event:${handler.name}:${payload.eventId}`);
      if (!fresh) return;
      await handler.handle({
        id: payload.eventId,
        tenantId: payload.tenantId,
        eventType: payload.eventType,
        aggregateType: payload.aggregateType,
        aggregateId: payload.aggregateId,
        payload: payload.payload,
        occurredAt: new Date(payload.occurredAt),
      });
    });
  }
}
