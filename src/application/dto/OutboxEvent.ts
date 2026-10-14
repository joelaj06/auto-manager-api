/** A domain event recorded in the transactional outbox and published after commit. */
export type OutboxEvent = Readonly<{
  /** Dotted event name, e.g. "rental.checked_in". */
  eventType: string;
  aggregateType?: string | null;
  aggregateId?: string | null;
  payload: Readonly<Record<string, unknown>>;
  /** Earliest time the event may be published (defaults to now). */
  availableAt?: Date;
}>;
