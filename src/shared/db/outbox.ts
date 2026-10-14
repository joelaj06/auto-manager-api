import type { Queryable } from "./types.js";

export type OutboxEvent = Readonly<{
  /** Dotted event name, e.g. "rental.checked_in". */
  eventType: string;
  aggregateType?: string | null;
  aggregateId?: string | null;
  payload: Readonly<Record<string, unknown>>;
  /** Earliest time the event may be published (defaults to now). */
  availableAt?: Date;
}>;

const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Records a domain event in the transactional outbox. Call it inside the same transaction as the
 * business change, so the event exists if and only if the change committed. Publishing is done
 * by the job runner (P0-8).
 */
export async function enqueueOutboxEvent(db: Queryable, event: OutboxEvent): Promise<string> {
  if (!EVENT_TYPE.test(event.eventType)) {
    throw new Error(`Invalid outbox event type: ${event.eventType}`);
  }
  const { rows } = await db.query<{ id: string }>(
    `insert into outbox (event_type, aggregate_type, aggregate_id, payload, available_at)
     values ($1, $2, $3, $4, coalesce($5, now()))
     returning id`,
    [
      event.eventType,
      event.aggregateType ?? null,
      event.aggregateId ?? null,
      JSON.stringify(event.payload),
      event.availableAt ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("Outbox insert returned no id");
  return id;
}
