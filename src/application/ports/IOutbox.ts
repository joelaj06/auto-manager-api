import type { OutboxEvent } from "../dto/OutboxEvent.js";

/**
 * Transactional outbox of the current tenant. Call inside the unit of work of the business
 * change, so the event exists if and only if the change committed.
 */
export interface IOutbox {
  /** Returns the id of the stored event. */
  enqueue(event: OutboxEvent): Promise<string>;
}
