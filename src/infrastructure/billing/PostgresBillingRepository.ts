import type { BillingSettings } from "../../domain/billing/BillingSettings.js";
import {
  Invoice,
  type InvoiceLine,
  type InvoiceParty,
  type InvoiceStatus,
  type InvoiceTaxLine,
} from "../../domain/billing/Invoice.js";
import type { TaxComponent } from "../../domain/tax/TaxCode.js";
import {
  Subscription,
  type LicenceType,
  type Plan,
  type SubscriptionStatus,
} from "../../domain/billing/Subscription.js";
import type {
  BillingAdjustment,
  BillingContact,
  BillingProfile,
  BillingSummary,
  IBillingRepository,
  SavedPaymentMethod,
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
  period_branch_count: number | null;
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
  tax_lines: InvoiceTaxLine[];
  seller: InvoiceParty | null;
  buyer: InvoiceParty | null;
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

type PaymentRow = {
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
  receipt_number: string | null;
  created_at: Date;
};

const PAYMENT_COLUMNS = `id, invoice_id, tenant_id, method, reference, amount_minor, currency,
  received_at, notes, recorded_by, receipt_number, created_at`;

const toPayment = (r: PaymentRow): PaymentRecord => ({
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
  receiptNumber: r.receipt_number,
  createdAt: r.created_at,
});

type AdjustmentRow = {
  id: string;
  subscription_id: string;
  tenant_id: string;
  kind: "proration";
  description: string;
  branches: number;
  unit_minor: string;
  days: number;
  period_days: number;
  amount_minor: string;
  starts_on: string;
  period_end: string;
  invoice_id: string | null;
  created_at: Date;
};

const ADJUSTMENT = `select id, subscription_id, tenant_id, kind, description, branches, unit_minor, days,
       period_days, amount_minor, starts_on::text, period_end::text, invoice_id, created_at
  from billing_adjustments`;

const toAdjustment = (r: AdjustmentRow): BillingAdjustment => ({
  id: r.id,
  subscriptionId: r.subscription_id,
  tenantId: r.tenant_id,
  kind: r.kind,
  description: r.description,
  branches: r.branches,
  unitMinor: Number(r.unit_minor),
  days: r.days,
  periodDays: r.period_days,
  amountMinor: Number(r.amount_minor),
  startsOn: r.starts_on,
  periodEnd: r.period_end,
  invoiceId: r.invoice_id,
  createdAt: r.created_at,
});

type MethodRow = {
  id: string;
  tenant_id: string;
  provider: string;
  type: "card" | "momo";
  label: string;
  sealed_authorization: string | null;
  is_default: boolean;
  expires_on: string | null;
  created_at: Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_COLUMNS = `id, code, name, currency, pricing, branch_price_minor, trial_days,
  trial_branch_limit, features`;
const SUBSCRIPTION_COLUMNS = `id, tenant_id, plan_id, licence_type, status, branch_count,
  trial_ends_at, current_period_start::text, current_period_end::text, period_branch_count,
  licence_locked_at, version`;
const INVOICE_COLUMNS = `id, code, tenant_id, subscription_id, period_start::text,
  period_end::text, lines, subtotal_minor, tax_lines, seller, buyer, tax_minor, total_minor,
  paid_minor, currency, status,
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
    periodBranchCount: r.period_branch_count,
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
    taxLines: r.tax_lines,
    taxMinor: Number(r.tax_minor),
    totalMinor: Number(r.total_minor),
    paidMinor: Number(r.paid_minor),
    seller: r.seller,
    buyer: r.buyer,
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
          current_period_start, current_period_end, licence_locked_at, period_branch_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (id) do update set
         plan_id = excluded.plan_id, licence_type = excluded.licence_type,
         status = excluded.status, branch_count = excluded.branch_count,
         trial_ends_at = excluded.trial_ends_at,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         licence_locked_at = excluded.licence_locked_at,
         period_branch_count = excluded.period_branch_count,
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
        s.periodBranchCount,
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
          voided_at, void_reason, created_by, tax_lines, seller, buyer)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22)
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
        JSON.stringify(i.taxLines),
        i.seller === null ? null : JSON.stringify(i.seller),
        i.buyer === null ? null : JSON.stringify(i.buyer),
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
          notes, recorded_by, receipt_number)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
        payment.receiptNumber,
      ],
    );
  }

  async payments(
    filter: Readonly<{ tenantId?: string; invoiceId?: string }>,
  ): Promise<PaymentRecord[]> {
    const { rows } = await this.db.query<PaymentRow>(
      `select ${PAYMENT_COLUMNS} from billing_payments
        where ($1::uuid is null or tenant_id = $1) and ($2::uuid is null or invoice_id = $2)
        order by received_at desc, id desc
        limit 500`,
      [filter.tenantId ?? null, filter.invoiceId ?? null],
    );
    return rows.map(toPayment);
  }

  async payment(id: string): Promise<PaymentRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<PaymentRow>(
      `select ${PAYMENT_COLUMNS} from billing_payments where id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : toPayment(rows[0]);
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

  async settings(): Promise<BillingSettings> {
    const { rows } = await this.db.query<{
      seller_name: string;
      seller_address: string | null;
      seller_tin: string | null;
      seller_email: string | null;
      seller_phone: string | null;
      vat_registered: boolean;
      vat_number: string | null;
      tax_components: TaxComponent[];
      payment_instructions: string | null;
      invoice_due_days: number;
    }>("select * from billing_settings where id");
    const r = rows[0]!;
    return {
      sellerName: r.seller_name,
      sellerAddress: r.seller_address,
      sellerTin: r.seller_tin,
      sellerEmail: r.seller_email,
      sellerPhone: r.seller_phone,
      vatRegistered: r.vat_registered,
      vatNumber: r.vat_number,
      taxComponents: r.tax_components,
      paymentInstructions: r.payment_instructions,
      invoiceDueDays: r.invoice_due_days,
    };
  }

  async saveSettings(s: BillingSettings, staffId: string): Promise<void> {
    await this.db.query(
      `update billing_settings set seller_name = $1, seller_address = $2, seller_tin = $3,
         seller_email = $4, seller_phone = $5, vat_registered = $6, vat_number = $7,
         tax_components = $8, payment_instructions = $9, invoice_due_days = $10,
         updated_at = now(), updated_by = $11
       where id`,
      [
        s.sellerName,
        s.sellerAddress,
        s.sellerTin,
        s.sellerEmail,
        s.sellerPhone,
        s.vatRegistered,
        s.vatNumber,
        JSON.stringify(s.taxComponents),
        s.paymentInstructions,
        s.invoiceDueDays,
        staffId,
      ],
    );
  }

  async seedBillingDetails(tenantId: string): Promise<void> {
    await this.db.query(
      `insert into billing_profiles (tenant_id, legal_name, tin)
       select t.id, a.business_name, a.tin
         from tenants t join tenant_applications a on a.id = t.application_id
        where t.id = $1
       on conflict do nothing`,
      [tenantId],
    );
    await this.db.query(
      `insert into billing_contacts (tenant_id, name, email, phone, is_primary)
       select t.id, a.contact_name, a.contact_email, a.contact_phone, true
         from tenants t join tenant_applications a on a.id = t.application_id
        where t.id = $1 and not exists (select 1 from billing_contacts c where c.tenant_id = t.id)`,
      [tenantId],
    );
  }

  async tenantName(tenantId: string): Promise<string> {
    const { rows } = await this.db.query<{ name: string }>(
      "select name from tenants where id = $1",
      [tenantId],
    );
    return rows[0]?.name ?? "";
  }

  async profile(tenantId: string): Promise<BillingProfile | null> {
    if (!UUID.test(tenantId)) return null;
    const { rows } = await this.db.query<{
      tenant_id: string;
      legal_name: string;
      tin: string | null;
      address: string | null;
      updated_at: Date;
    }>(
      "select tenant_id, legal_name, tin, address, updated_at from billing_profiles where tenant_id = $1",
      [tenantId],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : {
          tenantId: r.tenant_id,
          legalName: r.legal_name,
          tin: r.tin,
          address: r.address,
          updatedAt: r.updated_at,
        };
  }

  async saveProfile(p: Omit<BillingProfile, "updatedAt">, userId: string | null): Promise<void> {
    await this.db.query(
      `insert into billing_profiles (tenant_id, legal_name, tin, address, updated_by)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant_id) do update set legal_name = excluded.legal_name,
         tin = excluded.tin, address = excluded.address, updated_by = excluded.updated_by,
         updated_at = now()`,
      [p.tenantId, p.legalName, p.tin, p.address, userId],
    );
  }

  async contacts(tenantId: string): Promise<BillingContact[]> {
    if (!UUID.test(tenantId)) return [];
    const { rows } = await this.db.query<{
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      is_primary: boolean;
      receives_notices: boolean;
    }>(
      `select id, name, email, phone, is_primary, receives_notices from billing_contacts
        where tenant_id = $1 order by is_primary desc, created_at, id`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      isPrimary: r.is_primary,
      receivesNotices: r.receives_notices,
    }));
  }

  async replaceContacts(tenantId: string, contacts: readonly BillingContact[]): Promise<void> {
    await this.db.query("delete from billing_contacts where tenant_id = $1", [tenantId]);
    for (const c of contacts)
      await this.db.query(
        `insert into billing_contacts (id, tenant_id, name, email, phone, is_primary, receives_notices)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [c.id, tenantId, c.name, c.email, c.phone, c.isPrimary, c.receivesNotices],
      );
  }

  async addAdjustment(a: Omit<BillingAdjustment, "invoiceId" | "createdAt">): Promise<void> {
    await this.db.query(
      `insert into billing_adjustments (id, subscription_id, tenant_id, kind, description, branches,
         unit_minor, days, period_days, amount_minor, starts_on, period_end)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        a.id,
        a.subscriptionId,
        a.tenantId,
        a.kind,
        a.description,
        a.branches,
        a.unitMinor,
        a.days,
        a.periodDays,
        a.amountMinor,
        a.startsOn,
        a.periodEnd,
      ],
    );
  }

  async pendingAdjustments(subscriptionId: string, lock = false): Promise<BillingAdjustment[]> {
    const { rows } = await this.db.query<AdjustmentRow>(
      `${ADJUSTMENT} where subscription_id = $1 and invoice_id is null
        order by created_at, id${lock ? " for update" : ""}`,
      [subscriptionId],
    );
    return rows.map(toAdjustment);
  }

  async adjustments(
    filter: Readonly<{ tenantId?: string; invoiceId?: string }>,
  ): Promise<BillingAdjustment[]> {
    const { rows } = await this.db.query<AdjustmentRow>(
      `${ADJUSTMENT} where ($1::uuid is null or tenant_id = $1)
          and ($2::uuid is null or invoice_id = $2)
        order by created_at desc, id desc limit 500`,
      [filter.tenantId ?? null, filter.invoiceId ?? null],
    );
    return rows.map(toAdjustment);
  }

  async markInvoiced(adjustmentIds: readonly string[], invoiceId: string): Promise<void> {
    if (adjustmentIds.length === 0) return;
    await this.db.query(
      "update billing_adjustments set invoice_id = $2 where id = any($1::uuid[]) and invoice_id is null",
      [adjustmentIds, invoiceId],
    );
  }

  async releaseAdjustments(invoiceId: string): Promise<void> {
    await this.db.query("update billing_adjustments set invoice_id = null where invoice_id = $1", [
      invoiceId,
    ]);
  }

  async nextReceiptCode(year: number): Promise<string> {
    const { rows } = await this.db.query<{ value: string }>(
      `insert into counters (key, value) values ($1, 1)
       on conflict (key) do update set value = counters.value + 1, updated_at = now()
       returning value`,
      [`billing_receipt:${year}`],
    );
    return `AF-RCT-${year}-${rows[0]!.value.padStart(6, "0")}`;
  }

  async paymentMethods(tenantId: string): Promise<SavedPaymentMethod[]> {
    if (!UUID.test(tenantId)) return [];
    const { rows } = await this.db.query<MethodRow>(
      `select id, tenant_id, provider, type, label, sealed_authorization, is_default,
              expires_on::text, created_at
         from payment_methods where tenant_id = $1 and removed_at is null
        order by is_default desc, created_at desc`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      provider: r.provider,
      type: r.type,
      label: r.label,
      sealedAuthorization: r.sealed_authorization,
      isDefault: r.is_default,
      expiresOn: r.expires_on,
      createdAt: r.created_at,
    }));
  }

  async savePaymentMethod(m: SavedPaymentMethod): Promise<void> {
    if (m.isDefault)
      await this.db.query(
        "update payment_methods set is_default = false where tenant_id = $1 and is_default",
        [m.tenantId],
      );
    await this.db.query(
      `insert into payment_methods (id, tenant_id, provider, type, label, sealed_authorization,
         is_default, expires_on, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        m.id,
        m.tenantId,
        m.provider,
        m.type,
        m.label,
        m.sealedAuthorization,
        m.isDefault,
        m.expiresOn,
        m.createdAt,
      ],
    );
  }

  async setDefaultPaymentMethod(tenantId: string, id: string): Promise<void> {
    await this.db.query(
      "update payment_methods set is_default = false where tenant_id = $1 and is_default",
      [tenantId],
    );
    await this.db.query(
      `update payment_methods set is_default = true
        where tenant_id = $1 and id = $2 and removed_at is null`,
      [tenantId, id],
    );
  }

  async removePaymentMethod(tenantId: string, id: string, now: Date): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const { rowCount } = await this.db.query(
      `update payment_methods set removed_at = $3, is_default = false, sealed_authorization = null
        where tenant_id = $1 and id = $2 and removed_at is null`,
      [tenantId, id, now],
    );
    return (rowCount ?? 0) > 0;
  }
}
