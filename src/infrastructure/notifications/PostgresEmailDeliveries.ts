import type pg from "pg";
import type {
  EmailDelivery,
  IEmailDeliveries,
  NewEmailDelivery,
} from "../../application/ports/IEmailDeliveries.js";
import { PostgresTransactionRunner } from "../database/postgres/PostgresTransactionRunner.js";
import type { PgBossJobQueue } from "../jobs/PgBossJobQueue.js";

type DeliveryRow = {
  id: string;
  status: EmailDelivery["status"];
  recipient: string;
  attempts: number;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** email_deliveries in the platform database; the send job is enqueued in the same transaction. */
export class PostgresEmailDeliveries implements IEmailDeliveries {
  constructor(
    private readonly platform: pg.Pool,
    private readonly jobs: PgBossJobQueue,
    private readonly transactions = new PostgresTransactionRunner(),
  ) {}

  queue(delivery: NewEmailDelivery): Promise<Readonly<{ id: string; created: boolean }>> {
    return this.transactions.run(this.platform, async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `insert into email_deliveries
           (idempotency_key, tenant_id, template, recipient, subject, body_text, body_html)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (idempotency_key) do nothing
         returning id`,
        [
          delivery.idempotencyKey,
          delivery.tenantId,
          delivery.template,
          delivery.recipient,
          delivery.content.subject,
          delivery.content.text,
          delivery.content.html,
        ],
      );
      const id = inserted.rows[0]?.id;
      if (id !== undefined) {
        await this.jobs.enqueueWithin(tx, "email.send", { deliveryId: id });
        return { id, created: true };
      }
      const existing = await tx.query<{ id: string }>(
        "select id from email_deliveries where idempotency_key = $1",
        [delivery.idempotencyKey],
      );
      const existingId = existing.rows[0]?.id;
      if (existingId === undefined) throw new Error("Email delivery vanished during queueing");
      return { id: existingId, created: false };
    });
  }

  async find(id: string): Promise<EmailDelivery | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.platform.query<DeliveryRow>(
      `select id, status, recipient, attempts, subject, body_text, body_html
         from email_deliveries where id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      status: row.status,
      recipient: row.recipient,
      attempts: row.attempts,
      content:
        row.subject === null || row.body_text === null || row.body_html === null
          ? null
          : { subject: row.subject, text: row.body_text, html: row.body_html },
    };
  }

  async markSent(id: string, providerMessageId: string, now: Date): Promise<void> {
    await this.platform.query(
      `update email_deliveries
          set status = 'sent', sent_at = $3, provider_message_id = $2, attempts = attempts + 1,
              last_error = null, body_text = null, body_html = null
        where id = $1`,
      [id, providerMessageId.slice(0, 500), now],
    );
  }

  async markAttemptFailed(id: string, error: string, final: boolean): Promise<void> {
    await this.platform.query(
      `update email_deliveries
          set attempts = attempts + 1, last_error = $2,
              status = case when $3 then 'failed' else status end,
              body_text = case when $3 then null else body_text end,
              body_html = case when $3 then null else body_html end
        where id = $1`,
      [id, error, final],
    );
  }
}
