/** An outbox event as handed to its handlers (after commit, possibly more than once). */
export type DeliveredEvent = Readonly<{
  id: string;
  tenantId: string;
  eventType: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}>;

/**
 * Reacts to domain events of other modules (e.g. send a receipt when a payment is recorded).
 * Runs in the event's tenant context inside a unit of work that also records the event as
 * processed for this handler, so database changes happen exactly once. Side effects outside the
 * tenant database (emails, SMS) must be enqueued as jobs, which are themselves idempotent.
 */
export interface IEventHandler {
  /** Stable, unique name (`<module>.<what it does>`); part of the idempotency key. */
  readonly name: string;
  readonly eventTypes: readonly string[];
  handle(event: DeliveredEvent): Promise<void>;
}
