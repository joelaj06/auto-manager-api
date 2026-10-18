import { Invoice, type InvoiceLine, type InvoiceStatus } from "../../domain/billing/Invoice.js";
import {
  Subscription,
  type LicenceType,
  type Plan,
  type SubscriptionStatus,
} from "../../domain/billing/Subscription.js";
import type {
  BillingSummary,
  IBillingRepository,
  InvoiceFilter,
  PaymentMethod,
  PaymentRecord,
  SubscriptionEvent,
} from "../../domain/repositories/IBillingRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

type PlanRow = {
  id: string;
  code: string;
  name: string;
  currency: string;
  pricing: Plan["pricing"];
  branch_price_minor: string | null;
  trial_days: number;
  trial_branch_limit: number;
  features: string[];
};

type SubscriptionRow = {
  id: string;
  tenant_id: string;
  plan_id: string;
  licence_type: LicenceType;
  status: SubscriptionStatus;
  branch_count: number;
  trial_ends_at: Date | null;
  current_period_start: string | null;
  current_period_end: string | null;
  licence_locked_at: Date | null;
  version: number;
};

type InvoiceRow = {
  id: string;
  code: string;
  tenant_id: string;
  subscription_id: string;
  period_start: string;
  period_end: string;
  lines: InvoiceLine[];
  subtotal_minor: string;
  tax_minor: string;
  total_minor: string;
  paid_minor: string;
  currency: string;
  status: InvoiceStatus;
  issued_at: Date;
  due_at: Date;
  paid_at: Date | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_by: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_COLUMNS = `id, code, name, currency, pricing, branch_price_minor, trial_days,
  trial_branch_limit, features`;
const SUBSCRIPTION_COLUMNS = `id, tenant_id, plan_id, licence_type, status, branch_count,
  trial_ends_at, current_period_start::text, current_period_end::text, licence_locked_at, version`;
const INVOICE_COLUMNS = `id, code, tenant_id, subscription_id, period_start::text,
  period_end::text, lines, subtotal_minor, tax_minor, total_minor, paid_minor, currency, status,
  issued_at, due_at, paid_at, voided_at, void_reason, created_by`;

const toPlan = (r: PlanRow): Plan => ({
  id: r.id,
  code: r.code,
  name: r.name,
  currency: r.currency,
  pricing: r.pricing,
  branchPriceMinor: r.branch_price_minor === null ? null : Number(r.branch_price_minor),
  trialDays: r.trial_days,
  trialBranchLimit: r.trial_branch_limit,
  features: r.features,
});

const toSubscription = (r: SubscriptionRow) =>
  Subscription.restore({
    id: r.id,
    tenantId: r.tenant_id,
    planId: r.plan_id,
    licenceType: r.licence_type,
    status: r.status,
    branchCount: r.branch_count,
    trialEndsAt: r.trial_ends_at,
    currentPeriodStart: r.current_period_start,
    currentPeriodEnd: r.current_period_end,
    licenceLockedAt: r.licence_locked_at,
    version: r.version,
  });

const toInvoice = (r: InvoiceRow) =>
  Invoice.restore({
    id: r.id,
    code: r.code,
    tenantId: r.tenant_id,
    subscriptionId: r.subscription_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    lines: r.lines,
    subtotalMinor: Number(r.subtotal_minor),
    taxMinor: Number(r.tax_minor),
    totalMinor: Number(r.total_minor),
    paidMinor: Number(r.paid_minor),
    currency: r.currency,
    status: r.status,
    issuedAt: r.issued_at,
    dueAt: r.due_at,
    paidAt: r.paid_at,
    voidedAt: r.voided_at,
    voidReason: r.void_reason,
    createdBy: r.created_by,
  });

export class PostgresBillingRepository implements IBillingRepository {
  constructor(private readonly db: PlatformDb) {}

  async plans(): Promise<Plan[]> {
    const { rows } = await this.db.query<PlanRow>(
      `select ${PLAN_COLUMNS} from plans where is_active order by code`,
    );
    return rows.map(toPlan);
  }

  async planByCode(code: string): Promise<Plan | null> {
    const { rows } = await this.db.query<PlanRow>(
      `select ${PLAN_COLUMNS} from plans where code = $1`,
      [code],
    );
    return rows[0] === undefined ? null : toPlan(rows[0]);
  }

  async planById(id: string): Promise<Plan | null> {
    const { rows } = await this.db.query<PlanRow>(
      `select ${PLAN_COLUMNS} from plans where id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : toPlan(rows[0]);
  }

  async setPlanPrice(code: string, branchPriceMinor: number): Promise<void> {
    await this.db.query(
      "update plans set branch_price_minor = $2, updated_at = now() where code = $1",
      [code, branchPriceMinor],
    );
  }

  async subscriptionOf(tenantId: string, lock = false): Promise<Subscription | null> {
    if (!UUID.test(tenantId)) return null;
    const { rows } = await this.db.query<SubscriptionRow>(
      `select ${SUBSCRIPTION_COLUMNS} from subscriptions where tenant_id = $1${lock ? " for update" : ""}`,
      [tenantId],
    );
    return rows[0] === undefined ? null : toSubscription(rows[0]);
  }

  async saveSubscription(subscription: Subscription): Promise<void> {
    const s = subscription.snapshot();
    await this.db.query(
      `insert into subscriptions
         (id, tenant_id, plan_id, licence_type, status, branch_count, trial_ends_at,
          current_period_start, current_period_end, licence_locked_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (id) do update set
         plan_id = excluded.plan_id, licence_type = excluded.licence_type,
         status = excluded.status, branch_count = excluded.branch_count,
         trial_ends_at = excluded.trial_ends_at,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         licence_locked_at = excluded.licence_locked_at,
         updated_at = now(), version = subscriptions.version + 1`,
      [
        s.id,
        s.tenantId,
        s.planId,
        s.licenceType,
        s.status,
        s.branchCount,
        s.trialEndsAt,
        s.currentPeriodStart,
        s.currentPeriodEnd,
        s.licenceLockedAt,
      ],
    );
    if (s.status === "trialing")
      await this.db.query("update tenants set trial_ends_at = $2 where id = $1", [
        s.tenantId,
        s.trialEndsAt,
      ]);
  }

  async appendEvent(
    subscriptionId: string,
    event: Omit<SubscriptionEvent, "createdAt">,
  ): Promise<void> {
    await this.db.query(
      `insert into subscription_events (subscription_id, type, details, actor_type, actor_id)
       values ($1, $2, $3, $4, $5)`,
      [subscriptionId, event.type, JSON.stringify(event.details), event.actorType, event.actorId],
    );
  }

  async events(subscriptionId: string, limit: number): Promise<SubscriptionEvent[]> {
    const { rows } = await this.db.query<{
      type: string;
      details: Record<string, unknown>;
      actor_type: SubscriptionEvent["actorType"];
      actor_id: string | null;
      created_at: Date;
    }>(
      `select type, details, actor_type, actor_id, created_at from subscription_events
        where subscription_id = $1 order by id desc limit $2`,
      [subscriptionId, limit],
    );
    return rows.map((r) => ({
      type: r.type,
      details: r.details,
      actorType: r.actor_type,
      actorId: r.actor_id,
      createdAt: r.created_at,
    }));
  }

  async nextInvoiceCode(year: number): Promise<string> {
    const { rows } = await this.db.query<{ value: string }>(
      `insert into counters (key, value) values ($1, 1)
       on conflict (key) do update set value = counters.value + 1, updated_at = now()
       returning value`,
      [`billing_invoice:${year}`],
    );
    return `AF-INV-${year}-${rows[0]!.value.padStart(6, "0")}`;
  }

  async invoice(id: string, lock = false): Promise<Invoice | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<InvoiceRow>(
      `select ${INVOICE_COLUMNS} from billing_invoices where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toInvoice(rows[0]);
  }

  async saveInvoice(invoice: Invoice): Promise<void> {
    const i = invoice.snapshot();
    await this.db.query(
      `insert into billing_invoices
         (id, code, tenant_id, subscription_id, period_start, period_end, lines, subtotal_minor,
          tax_minor, total_minor, paid_minor, currency, status, issued_at, due_at, paid_at,
          voided_at, void_reason, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       on conflict (id) do update set
         paid_minor = excluded.paid_minor, status = excluded.status, paid_at = excluded.paid_at,
         voided_at = excluded.voided_at, void_reason = excluded.void_reason,
         version = billing_invoices.version + 1`,
      [
        i.id,
        i.code,
        i.tenantId,
        i.subscriptionId,
        i.periodStart,
        i.periodEnd,
        JSON.stringify(i.lines),
        i.subtotalMinor,
        i.taxMinor,
        i.totalMinor,
        i.paidMinor,
        i.currency,
        i.status,
        i.issuedAt,
        i.dueAt,
        i.paidAt,
        i.voidedAt,
        i.voidReason,
        i.createdBy,
      ],
    );
  }

  async invoices(filter: InvoiceFilter): Promise<Invoice[]> {
    const { rows } = await this.db.query<InvoiceRow>(
      `select ${INVOICE_COLUMNS} from billing_invoices
        where ($1::uuid is null or tenant_id = $1)
          and ($2::text is null or status = $2)
          and ($3::uuid is null or id < $3)
        order by id desc
        limit $4`,
      [filter.tenantId ?? null, filter.status ?? null, filter.before ?? null, filter.limit],
    );
    return rows.map(toInvoice);
  }

  async insertPayment(payment: Omit<PaymentRecord, "createdAt">): Promise<void> {
    await this.db.query(
      `insert into billing_payments
         (id, invoice_id, tenant_id, method, reference, amount_minor, currency, received_at,
          notes, recorded_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        payment.id,
        payment.invoiceId,
        payment.tenantId,
        payment.method,
        payment.reference,
        payment.amountMinor,
        payment.currency,
        payment.receivedAt,
        payment.notes,
        payment.recordedBy,
      ],
    );
  }

  async payments(
    filter: Readonly<{ tenantId?: string; invoiceId?: string }>,
  ): Promise<PaymentRecord[]> {
    const { rows } = await this.db.query<{
      id: string;
      invoice_id: string;
      tenant_id: string;
      method: PaymentMethod;
      reference: string;
      amount_minor: string;
      currency: string;
      received_at: Date;
      notes: string | null;
      recorded_by: string;
      created_at: Date;
    }>(
      `select id, invoice_id, tenant_id, method, reference, amount_minor, currency, received_at,
              notes, recorded_by, created_at
         from billing_payments
        where ($1::uuid is null or tenant_id = $1) and ($2::uuid is null or invoice_id = $2)
        order by received_at desc, id desc
        limit 500`,
      [filter.tenantId ?? null, filter.invoiceId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      invoiceId: r.invoice_id,
      tenantId: r.tenant_id,
      method: r.method,
      reference: r.reference,
      amountMinor: Number(r.amount_minor),
      currency: r.currency,
      receivedAt: r.received_at,
      notes: r.notes,
      recordedBy: r.recorded_by,
      createdAt: r.created_at,
    }));
  }

  async paymentReferenceUsed(method: PaymentMethod, reference: string): Promise<boolean> {
    const { rows } = await this.db.query<{ used: boolean }>(
      "select exists (select 1 from billing_payments where method = $1 and reference = $2) as used",
      [method, reference],
    );
    return rows[0]?.used === true;
  }

  async summary(now: Date): Promise<BillingSummary> {
    const [byStatus, paying, invoices] = await Promise.all([
      this.db.query<{ status: string; n: string }>(
        "select status, count(*) as n from subscriptions group by status",
      ),
      this.db.query<{ mrr: string | null; branches: string | null; currency: string | null }>(
        `select sum(s.branch_count * p.branch_price_minor) as mrr, sum(s.branch_count) as branches,
                min(p.currency) as currency
           from subscriptions s join plans p on p.id = s.plan_id
          where s.status in ('active', 'past_due')`,
      ),
      this.db.query<{ open: string; overdue: string; outstanding: string | null }>(
        `select count(*) as open,
                count(*) filter (where due_at < $1) as overdue,
                sum(total_minor - paid_minor) as outstanding
           from billing_invoices where status = 'open'`,
        [now],
      ),
    ]);
    const p = paying.rows[0];
    const i = invoices.rows[0];
    return {
      currency: p?.currency ?? "GHS",
      subscriptionsByStatus: Object.fromEntries(byStatus.rows.map((r) => [r.status, Number(r.n)])),
      mrrMinor: Number(p?.mrr ?? 0),
      branchesBilled: Number(p?.branches ?? 0),
      openInvoices: Number(i?.open ?? 0),
      overdueInvoices: Number(i?.overdue ?? 0),
      outstandingMinor: Number(i?.outstanding ?? 0),
    };
  }
}
