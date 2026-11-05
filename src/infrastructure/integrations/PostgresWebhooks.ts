import type { Paged, PageWindow } from "../../domain/value-objects/Paged.js";
import { pagedQuery } from "../database/postgres/PagedQuery.js";
import type {
  AttemptOutcome,
  DeliveryToSend,
  EndpointChanges,
  IWebhooks,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
} from "../../application/ports/IWebhooks.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = (v: unknown) => (v === null || v === undefined ? null : (v as Date));
const text = (v: unknown) => (typeof v === "string" ? v : null);

function toEndpoint(r: Row): WebhookEndpointRecord {
  return {
    id: String(r.id),
    url: String(r.url),
    description: text(r.description),
    events: r.events as string[],
    status: r.status as WebhookEndpointRecord["status"],
    disabledReason: text(r.disabled_reason),
    consecutiveFailures: Number(r.consecutive_failures),
    lastSuccessAt: date(r.last_success_at),
    lastFailureAt: date(r.last_failure_at),
    createdAt: r.created_at as Date,
  };
}

function toDelivery(r: Row): WebhookDeliveryRecord {
  return {
    id: String(r.id),
    endpointId: String(r.endpoint_id),
    eventId: String(r.event_id),
    eventType: String(r.event_type),
    status: r.status as WebhookDeliveryRecord["status"],
    attempts: Number(r.attempts),
    nextAttemptAt: date(r.next_attempt_at),
    lastStatus: r.last_status === null ? null : Number(r.last_status),
    lastError: text(r.last_error),
    deliveredAt: date(r.delivered_at),
    createdAt: r.created_at as Date,
  };
}

export class PostgresWebhooks implements IWebhooks {
  constructor(private readonly context: PostgresTransactionContext) {}

  private tx() {
    return this.context.current();
  }

  async createEndpoint(endpoint: Parameters<IWebhooks["createEndpoint"]>[0]): Promise<string> {
    const { rows } = await this.tx().query<{ id: string }>(
      `insert into webhook_endpoints (url, description, events, sealed_secret, created_by)
       values ($1, $2, $3, $4, $5) returning id`,
      [
        endpoint.url,
        endpoint.description,
        endpoint.events,
        endpoint.sealedSecret,
        endpoint.createdBy,
      ],
    );
    return rows[0]!.id;
  }

  async endpoint(id: string): Promise<WebhookEndpointRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx().query<Row>("select * from webhook_endpoints where id = $1", [
      id,
    ]);
    return rows[0] === undefined ? null : toEndpoint(rows[0]);
  }

  async endpoints(): Promise<WebhookEndpointRecord[]> {
    const { rows } = await this.tx().query<Row>(
      "select * from webhook_endpoints order by created_at desc",
    );
    return rows.map(toEndpoint);
  }

  async countEndpoints(): Promise<number> {
    const { rows } = await this.tx().query<{ n: string }>(
      "select count(*) as n from webhook_endpoints",
    );
    return Number(rows[0]!.n);
  }

  async updateEndpoint(id: string, changes: EndpointChanges, now: Date): Promise<void> {
    await this.tx().query(
      `update webhook_endpoints
          set url = coalesce($2, url),
              description = case when $3 then $4 else description end,
              events = coalesce($5, events),
              status = coalesce($6, status),
              disabled_reason = case when $7 then $8 else disabled_reason end,
              consecutive_failures = case when $6 = 'active' then 0 else consecutive_failures end,
              updated_at = $9
        where id = $1`,
      [
        id,
        changes.url ?? null,
        changes.description !== undefined,
        changes.description ?? null,
        changes.events ?? null,
        changes.status ?? null,
        changes.disabledReason !== undefined,
        changes.disabledReason ?? null,
        now,
      ],
    );
  }

  async setSecret(id: string, sealedSecret: string, now: Date): Promise<void> {
    await this.tx().query(
      "update webhook_endpoints set sealed_secret = $2, updated_at = $3 where id = $1",
      [id, sealedSecret, now],
    );
  }

  async removeEndpoint(id: string): Promise<void> {
    await this.tx().query("delete from webhook_endpoints where id = $1", [id]);
  }

  async hasSubscriber(eventType: string): Promise<boolean> {
    const { rows } = await this.tx().query<{ yes: boolean }>(
      `select exists (select 1 from webhook_endpoints
                       where status = 'active' and events @> array[$1]::text[]) as yes`,
      [eventType],
    );
    return rows[0]!.yes;
  }

  async subscribers(eventType: string): Promise<string[]> {
    const { rows } = await this.tx().query<{ id: string }>(
      `select id from webhook_endpoints where status = 'active' and events @> array[$1]::text[]`,
      [eventType],
    );
    return rows.map((r) => r.id);
  }

  async createDelivery(delivery: Parameters<IWebhooks["createDelivery"]>[0]) {
    const { rows } = await this.tx().query<{ id: string }>(
      `insert into webhook_deliveries (endpoint_id, event_id, event_type, body, next_attempt_at)
       values ($1, $2, $3, $4, $5)
       on conflict (endpoint_id, event_id) do nothing returning id`,
      [delivery.endpointId, delivery.eventId, delivery.eventType, delivery.body, delivery.at],
    );
    return rows[0]?.id ?? null;
  }

  async delivery(id: string): Promise<DeliveryToSend | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx().query<Row>(
      `select d.*, e.url, e.sealed_secret, e.status as endpoint_status
         from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
        where d.id = $1`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      ...toDelivery(r),
      body: String(r.body),
      url: String(r.url),
      sealedSecret: String(r.sealed_secret),
      endpointStatus: String(r.endpoint_status),
    };
  }

  async deliveries(endpointId: string, window: PageWindow): Promise<Paged<WebhookDeliveryRecord>> {
    const { rows, total } = await pagedQuery<Row>(
      this.tx(),
      {
        sql: `select * from webhook_deliveries where endpoint_id = $1`,
        orderBy: "created_at desc, id desc",
        params: [endpointId],
      },
      window,
    );
    return { rows: rows.map(toDelivery), total };
  }

  async recordAttempt(outcome: AttemptOutcome): Promise<WebhookEndpointRecord | null> {
    const db = this.tx();
    await db.query(
      `update webhook_deliveries
          set attempts = attempts + 1, status = $2, next_attempt_at = $3, last_status = $4,
              last_error = $5, delivered_at = $6
        where id = $1`,
      [
        outcome.deliveryId,
        outcome.delivered ? "delivered" : outcome.nextAttemptAt === null ? "failed" : "pending",
        outcome.nextAttemptAt,
        outcome.httpStatus,
        outcome.error === null ? null : outcome.error.slice(0, 500),
        outcome.delivered ? outcome.at : null,
      ],
    );
    const { rows } = await db.query<Row>(
      `update webhook_endpoints
          set consecutive_failures = case when $2 then 0 else consecutive_failures + 1 end,
              last_success_at = case when $2 then $3 else last_success_at end,
              last_failure_at = case when $2 then last_failure_at else $3 end
        where id = $1 returning *`,
      [outcome.endpointId, outcome.delivered, outcome.at],
    );
    return rows[0] === undefined ? null : toEndpoint(rows[0]);
  }

  async replay(id: string, at: Date): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const { rowCount } = await this.tx().query(
      `update webhook_deliveries
          set status = 'pending', attempts = 0, next_attempt_at = $2, delivered_at = null
        where id = $1 and status <> 'pending'`,
      [id, at],
    );
    return rowCount === 1;
  }

  async overdue(before: Date, limit: number): Promise<string[]> {
    const { rows } = await this.tx().query<{ id: string }>(
      `select id from webhook_deliveries
        where status = 'pending' and next_attempt_at < $1
        order by next_attempt_at limit $2`,
      [before, limit],
    );
    return rows.map((r) => r.id);
  }

  async purgeDeliveries(before: Date, limit: number): Promise<number> {
    const { rowCount } = await this.tx().query(
      `delete from webhook_deliveries where id in (
         select id from webhook_deliveries
          where created_at < $1 and status <> 'pending' limit $2)`,
      [before, limit],
    );
    return rowCount ?? 0;
  }
}
