import type { IOutboxStore, PendingOutboxEvent } from "../../../application/ports/IOutboxStore.js";
import type { PostgresTransactionContext } from "../postgres/PostgresTransactionContext.js";

type OutboxRow = {
  id: string;
  event_type: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
};

export class PostgresOutboxStore implements IOutboxStore {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async claimDue(limit: number): Promise<PendingOutboxEvent[]> {
    const { rows } = await this.transactions.current().query<OutboxRow>(
      `select id, event_type, aggregate_type, aggregate_id, payload, occurred_at, attempts
         from outbox
        where published_at is null and available_at <= now()
        order by available_at, id
        limit $1
        for update skip locked`,
      [limit],
    );
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      occurredAt: row.occurred_at,
      attempts: row.attempts,
    }));
  }

  async markPublished(id: string): Promise<void> {
    await this.transactions
      .current()
      .query("update outbox set published_at = now(), last_error = null where id = $1", [id]);
  }

  async markFailed(id: string, error: string, retryAt: Date): Promise<void> {
    await this.transactions.current().query(
      `update outbox
          set attempts = attempts + 1, last_error = $2, available_at = $3
        where id = $1`,
      [id, error, retryAt],
    );
  }
}
