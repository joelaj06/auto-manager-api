import type { OutboxEvent } from "../../../application/dto/OutboxEvent.js";
import type { IOutbox } from "../../../application/ports/IOutbox.js";
import type { PostgresTransactionContext } from "../postgres/PostgresTransactionContext.js";

const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Writes to the tenant's outbox table; the outbox worker (P0-8) publishes after commit. */
export class PostgresOutbox implements IOutbox {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async enqueue(event: OutboxEvent): Promise<string> {
    if (!EVENT_TYPE.test(event.eventType)) {
      throw new Error(`Invalid outbox event type: ${event.eventType}`);
    }
    const { rows } = await this.transactions.current().query<{ id: string }>(
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
}
