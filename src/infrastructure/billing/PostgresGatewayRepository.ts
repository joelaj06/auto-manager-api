import {
  PaymentAttempt,
  type AttemptStatus,
  type PaymentAttemptProps,
} from "../../domain/billing/PaymentAttempt.js";
import type {
  IGatewayRepository,
  ReconciliationRecord,
  RefundRecord,
  WebhookRecord,
} from "../../domain/repositories/IGatewayRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AttemptRow = {
  id: string;
  reference: string;
  tenant_id: string;
  invoice_id: string;
  provider: string;
  kind: PaymentAttemptProps["kind"];
  amount_minor: string;
  currency: string;
  status: AttemptStatus;
  payment_method_id: string | null;
  save_method: boolean;
  momo_phone: string | null;
  momo_network: PaymentAttemptProps["momoNetwork"];
  checkout_url: string | null;
  channel: string | null;
  provider_transaction_id: string | null;
  fees_minor: string | null;
  failure_reason: string | null;
  initiated_by_type: PaymentAttemptProps["initiatedByType"];
  initiated_by: string | null;
  created_at: Date;
  completed_at: Date | null;
};

const toAttempt = (r: AttemptRow) =>
  PaymentAttempt.restore({
    id: r.id,
    reference: r.reference,
    tenantId: r.tenant_id,
    invoiceId: r.invoice_id,
    provider: r.provider,
    kind: r.kind,
    amountMinor: Number(r.amount_minor),
    currency: r.currency,
    status: r.status,
    paymentMethodId: r.payment_method_id,
    saveMethod: r.save_method,
    momoPhone: r.momo_phone,
    momoNetwork: r.momo_network,
    checkoutUrl: r.checkout_url,
    channel: r.channel,
    providerTransactionId: r.provider_transaction_id,
    feesMinor: r.fees_minor === null ? null : Number(r.fees_minor),
    failureReason: r.failure_reason,
    initiatedByType: r.initiated_by_type,
    initiatedBy: r.initiated_by,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  });

type WebhookRow = {
  id: string;
  provider: string;
  event_key: string | null;
  event_type: string | null;
  signature_valid: boolean;
  payload: unknown;
  received_at: Date;
  attempts: number;
  processed_at: Date | null;
  outcome: WebhookRecord["outcome"];
  error: string | null;
};

const toWebhook = (r: WebhookRow): WebhookRecord => ({
  id: r.id,
  provider: r.provider,
  eventKey: r.event_key,
  eventType: r.event_type,
  signatureValid: r.signature_valid,
  payload: r.payload,
  receivedAt: r.received_at,
  attempts: r.attempts,
  processedAt: r.processed_at,
  outcome: r.outcome,
  error: r.error,
});

type RefundRow = {
  id: string;
  payment_id: string;
  invoice_id: string;
  tenant_id: string;
  amount_minor: string;
  currency: string;
  reason: string;
  status: RefundRecord["status"];
  provider: string | null;
  provider_refund_id: string | null;
  requested_by: string;
  created_at: Date;
  processed_at: Date | null;
};

const toRefund = (r: RefundRow): RefundRecord => ({
  id: r.id,
  paymentId: r.payment_id,
  invoiceId: r.invoice_id,
  tenantId: r.tenant_id,
  amountMinor: Number(r.amount_minor),
  currency: r.currency,
  reason: r.reason,
  status: r.status,
  provider: r.provider,
  providerRefundId: r.provider_refund_id,
  requestedBy: r.requested_by,
  createdAt: r.created_at,
  processedAt: r.processed_at,
});

type ReconciliationRow = {
  id: string;
  provider: string;
  day: string;
  status: ReconciliationRecord["status"];
  our_count: number;
  our_minor: string;
  provider_count: number;
  provider_minor: string;
  fees_minor: string;
  missing_here: Record<string, unknown>[];
  missing_there: Record<string, unknown>[];
  amount_mismatches: Record<string, unknown>[];
  error: string | null;
  ran_at: Date;
};

const toReconciliation = (r: ReconciliationRow): ReconciliationRecord => ({
  id: r.id,
  provider: r.provider,
  day: r.day,
  status: r.status,
  ourCount: r.our_count,
  ourMinor: Number(r.our_minor),
  providerCount: r.provider_count,
  providerMinor: Number(r.provider_minor),
  feesMinor: Number(r.fees_minor),
  missingHere: r.missing_here,
  missingThere: r.missing_there,
  amountMismatches: r.amount_mismatches,
  error: r.error,
  ranAt: r.ran_at,
});

const WEBHOOK = `select id, provider, event_key, event_type, signature_valid, payload, received_at,
       attempts, processed_at, outcome, error from webhook_events`;

export class PostgresGatewayRepository implements IGatewayRepository {
  constructor(private readonly db: PlatformDb) {}

  async saveAttempt(attempt: PaymentAttempt): Promise<void> {
    const a = attempt.snapshot();
    await this.db.query(
      `insert into gateway_transactions (id, reference, tenant_id, invoice_id, provider, kind,
         amount_minor, currency, status, payment_method_id, save_method, momo_phone, momo_network,
         checkout_url, channel, provider_transaction_id, fees_minor, failure_reason,
         initiated_by_type, initiated_by, created_at, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22)
       on conflict (id) do update set status = excluded.status,
         checkout_url = excluded.checkout_url, channel = excluded.channel,
         provider_transaction_id = excluded.provider_transaction_id,
         fees_minor = excluded.fees_minor, failure_reason = excluded.failure_reason,
         completed_at = excluded.completed_at`,
      [
        a.id,
        a.reference,
        a.tenantId,
        a.invoiceId,
        a.provider,
        a.kind,
        a.amountMinor,
        a.currency,
        a.status,
        a.paymentMethodId,
        a.saveMethod,
        a.momoPhone,
        a.momoNetwork,
        a.checkoutUrl,
        a.channel,
        a.providerTransactionId,
        a.feesMinor,
        a.failureReason,
        a.initiatedByType,
        a.initiatedBy,
        a.createdAt,
        a.completedAt,
      ],
    );
  }

  async attempt(reference: string, lock = false): Promise<PaymentAttempt | null> {
    const { rows } = await this.db.query<AttemptRow>(
      `select * from gateway_transactions where reference = $1${lock ? " for update" : ""}`,
      [reference],
    );
    return rows[0] === undefined ? null : toAttempt(rows[0]);
  }

  async attempts(
    filter: Readonly<{
      status?: AttemptStatus;
      tenantId?: string;
      invoiceId?: string;
      limit: number;
    }>,
  ): Promise<PaymentAttempt[]> {
    const { rows } = await this.db.query<AttemptRow>(
      `select * from gateway_transactions
        where ($1::text is null or status = $1) and ($2::uuid is null or tenant_id = $2)
          and ($3::uuid is null or invoice_id = $3)
        order by created_at desc, id desc limit $4`,
      [filter.status ?? null, filter.tenantId ?? null, filter.invoiceId ?? null, filter.limit],
    );
    return rows.map(toAttempt);
  }

  async succeededBetween(provider: string, from: Date, to: Date): Promise<PaymentAttempt[]> {
    const { rows } = await this.db.query<AttemptRow>(
      `select * from gateway_transactions
        where provider = $1 and status in ('succeeded', 'review')
          and completed_at >= $2 and completed_at < $3
        order by completed_at`,
      [provider, from, to],
    );
    return rows.map(toAttempt);
  }

  async receiveWebhook(
    e: Omit<WebhookRecord, "id" | "receivedAt" | "attempts" | "processedAt" | "outcome" | "error">,
  ) {
    const { rows } = await this.db.query<WebhookRow>(
      `insert into webhook_events (provider, event_key, event_type, signature_valid, payload)
       values ($1, $2, $3, $4, $5)
       on conflict (provider, event_key) where event_key is not null do nothing
       returning *`,
      [e.provider, e.eventKey, e.eventType, e.signatureValid, JSON.stringify(e.payload)],
    );
    if (rows[0] !== undefined) return { record: toWebhook(rows[0]), duplicate: false };
    const existing = await this.db.query<WebhookRow>(
      `${WEBHOOK} where provider = $1 and event_key = $2`,
      [e.provider, e.eventKey],
    );
    return { record: toWebhook(existing.rows[0]!), duplicate: true };
  }

  async webhook(id: string, lock = false): Promise<WebhookRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<WebhookRow>(
      `${WEBHOOK} where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toWebhook(rows[0]);
  }

  async finishWebhook(
    id: string,
    outcome: NonNullable<WebhookRecord["outcome"]>,
    error: string | null,
    now: Date,
  ): Promise<void> {
    await this.db.query(
      `update webhook_events set outcome = $2, error = $3, processed_at = $4,
         attempts = attempts + 1
       where id = $1`,
      [id, outcome, error?.slice(0, 2000) ?? null, now],
    );
  }

  async webhooks(
    filter: Readonly<{ outcome?: WebhookRecord["outcome"]; before?: string; limit: number }>,
  ): Promise<WebhookRecord[]> {
    const { rows } = await this.db.query<WebhookRow>(
      `${WEBHOOK} where ($1::text is null or outcome = $1) and ($2::uuid is null or id < $2)
        order by id desc limit $3`,
      [filter.outcome ?? null, filter.before ?? null, filter.limit],
    );
    return rows.map(toWebhook);
  }

  async addRefund(r: Omit<RefundRecord, "createdAt" | "processedAt">): Promise<void> {
    await this.db.query(
      `insert into billing_refunds (id, payment_id, invoice_id, tenant_id, amount_minor, currency,
         reason, status, provider, provider_refund_id, requested_by, processed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               case when $8 = 'processed' then now() end)`,
      [
        r.id,
        r.paymentId,
        r.invoiceId,
        r.tenantId,
        r.amountMinor,
        r.currency,
        r.reason,
        r.status,
        r.provider,
        r.providerRefundId,
        r.requestedBy,
      ],
    );
  }

  async refund(id: string, lock = false): Promise<RefundRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<RefundRow>(
      `select * from billing_refunds where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toRefund(rows[0]);
  }

  async pendingRefundFor(reference: string): Promise<RefundRecord | null> {
    const { rows } = await this.db.query<RefundRow>(
      `select r.* from billing_refunds r
         join billing_payments p on p.id = r.payment_id
         join gateway_transactions g on g.id = p.gateway_transaction_id
        where g.reference = $1 and r.status = 'pending'
        order by r.created_at, r.id limit 1 for update of r`,
      [reference],
    );
    return rows[0] === undefined ? null : toRefund(rows[0]);
  }

  async finishRefund(id: string, status: "processed" | "failed", now: Date): Promise<void> {
    await this.db.query(
      `update billing_refunds set status = $2,
         processed_at = case when $2 = 'processed' then $3::timestamptz end
       where id = $1`,
      [id, status, now],
    );
  }

  async refunds(
    filter: Readonly<{ paymentId?: string; tenantId?: string }>,
  ): Promise<RefundRecord[]> {
    const { rows } = await this.db.query<RefundRow>(
      `select * from billing_refunds
        where ($1::uuid is null or payment_id = $1) and ($2::uuid is null or tenant_id = $2)
        order by created_at desc`,
      [filter.paymentId ?? null, filter.tenantId ?? null],
    );
    return rows.map(toRefund);
  }

  async saveReconciliation(
    r: Omit<ReconciliationRecord, "id" | "ranAt">,
  ): Promise<ReconciliationRecord> {
    const { rows } = await this.db.query<ReconciliationRow>(
      `insert into gateway_reconciliations (provider, day, status, our_count, our_minor,
         provider_count, provider_minor, fees_minor, missing_here, missing_there,
         amount_mismatches, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (provider, day) do update set status = excluded.status,
         our_count = excluded.our_count, our_minor = excluded.our_minor,
         provider_count = excluded.provider_count, provider_minor = excluded.provider_minor,
         fees_minor = excluded.fees_minor, missing_here = excluded.missing_here,
         missing_there = excluded.missing_there, amount_mismatches = excluded.amount_mismatches,
         error = excluded.error, ran_at = now()
       returning *, day::text as day`,
      [
        r.provider,
        r.day,
        r.status,
        r.ourCount,
        r.ourMinor,
        r.providerCount,
        r.providerMinor,
        r.feesMinor,
        JSON.stringify(r.missingHere),
        JSON.stringify(r.missingThere),
        JSON.stringify(r.amountMismatches),
        r.error,
      ],
    );
    return toReconciliation(rows[0]!);
  }

  async reconciliations(limit: number): Promise<ReconciliationRecord[]> {
    const { rows } = await this.db.query<ReconciliationRow>(
      `select *, day::text as day from gateway_reconciliations order by day desc limit $1`,
      [limit],
    );
    return rows.map(toReconciliation);
  }
}
