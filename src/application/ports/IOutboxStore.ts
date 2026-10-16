/** An outbox row waiting to be published. */
export type PendingOutboxEvent = Readonly<{
  id: string;
  eventType: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
}>;

/**
 * The publishing side of the current tenant's outbox (the writing side is IOutbox). Call inside
 * a unit of work: claimed rows stay locked until it ends, so parallel drains never publish the
 * same event.
 */
export interface IOutboxStore {
  /** Oldest due, unpublished events, locked; rows locked by another drain are skipped. */
  claimDue(limit: number): Promise<PendingOutboxEvent[]>;
  markPublished(id: string): Promise<void>;
  /** Records the failure and postpones the event until `retryAt`. */
  markFailed(id: string, error: string, retryAt: Date): Promise<void>;
}
