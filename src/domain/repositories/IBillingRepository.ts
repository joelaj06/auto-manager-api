import type { BillingSettings } from "../billing/BillingSettings.js";
import type { Invoice, InvoiceStatus } from "../billing/Invoice.js";
import type { Proration } from "../billing/Proration.js";
import type { Plan, Subscription } from "../billing/Subscription.js";

export type PaymentMethod = "bank_transfer" | "momo" | "cash" | "cheque" | "card" | "other";

export type PaymentRecord = Readonly<{
  id: string;
  invoiceId: string;
  tenantId: string;
  method: PaymentMethod;
  reference: string;
  amountMinor: number;
  currency: string;
  receivedAt: Date;
  notes: string | null;
  /** The staff member who recorded it; null for a gateway payment. */
  recordedBy: string | null;
  /** AF-RCT-2026-000001. */
  receiptNumber: string | null;
  /** Gateway payments: the provider, the attempt and the provider's fees. */
  provider?: string | null;
  gatewayTransactionId?: string | null;
  feesMinor?: number | null;
  createdAt: Date;
}>;

/** The tenant as the buyer on our invoices. */
export type BillingProfile = Readonly<{
  tenantId: string;
  legalName: string;
  tin: string | null;
  address: string | null;
  updatedAt: Date;
}>;

export type BillingContact = Readonly<{
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  receivesNotices: boolean;
}>;

/** A charge waiting for the next invoice (a branch added during a paid period). */
export type BillingAdjustment = Proration &
  Readonly<{
    id: string;
    subscriptionId: string;
    tenantId: string;
    kind: "proration";
    description: string;
    invoiceId: string | null;
    createdAt: Date;
  }>;

/** A saved card or MoMo number (created by the payment gateway). */
export type SavedPaymentMethod = Readonly<{
  id: string;
  tenantId: string;
  provider: string;
  type: "card" | "momo";
  label: string;
  sealedAuthorization: string | null;
  isDefault: boolean;
  expiresOn: string | null;
  createdAt: Date;
}>;

export type SubscriptionEvent = Readonly<{
  type: string;
  details: Readonly<Record<string, unknown>>;
  actorType: "platform_staff" | "user" | "system";
  actorId: string | null;
  createdAt: Date;
}>;

export type InvoiceFilter = Readonly<{
  tenantId?: string;
  status?: InvoiceStatus;
  limit: number;
  /** Keyset cursor: invoices issued before this invoice id (ids are time-ordered). */
  before?: string;
}>;

export type BillingSummary = Readonly<{
  currency: string;
  subscriptionsByStatus: Readonly<Record<string, number>>;
  /** Paying standard subscriptions: billed branches × price (enterprise excluded). */
  mrrMinor: number;
  branchesBilled: number;
  openInvoices: number;
  overdueInvoices: number;
  outstandingMinor: number;
}>;

/** Plans, subscriptions, invoices and payments (platform database, platform unit of work). */
export interface IBillingRepository {
  plans(): Promise<Plan[]>;
  planByCode(code: string): Promise<Plan | null>;
  planById(id: string): Promise<Plan | null>;
  setPlanPrice(code: string, branchPriceMinor: number): Promise<void>;

  subscriptionOf(tenantId: string, lock?: boolean): Promise<Subscription | null>;
  /** Inserts or updates; keeps `tenants.trial_ends_at` in step while trialing. */
  saveSubscription(subscription: Subscription): Promise<void>;
  appendEvent(subscriptionId: string, event: Omit<SubscriptionEvent, "createdAt">): Promise<void>;
  events(subscriptionId: string, limit: number): Promise<SubscriptionEvent[]>;

  /** The next invoice code for `year`, e.g. AF-INV-2026-000042. */
  nextInvoiceCode(year: number): Promise<string>;
  invoice(id: string, lock?: boolean): Promise<Invoice | null>;
  saveInvoice(invoice: Invoice): Promise<void>;
  invoices(filter: InvoiceFilter): Promise<Invoice[]>;

  insertPayment(payment: Omit<PaymentRecord, "createdAt">): Promise<void>;
  payments(filter: Readonly<{ tenantId?: string; invoiceId?: string }>): Promise<PaymentRecord[]>;
  paymentReferenceUsed(method: PaymentMethod, reference: string): Promise<boolean>;

  summary(now: Date): Promise<BillingSummary>;

  settings(): Promise<BillingSettings>;
  saveSettings(settings: BillingSettings, staffId: string): Promise<void>;

  /** Billing details and primary contact from the tenant's application, when it has none. */
  seedBillingDetails(tenantId: string): Promise<void>;
  /** The tenant's name in the registry (an invoice without a billing profile). */
  tenantName(tenantId: string): Promise<string>;
  profile(tenantId: string): Promise<BillingProfile | null>;
  saveProfile(profile: Omit<BillingProfile, "updatedAt">, userId: string | null): Promise<void>;
  contacts(tenantId: string): Promise<BillingContact[]>;
  /** Replaces the tenant's contacts (ids kept where given). */
  replaceContacts(tenantId: string, contacts: readonly BillingContact[]): Promise<void>;

  addAdjustment(adjustment: Omit<BillingAdjustment, "invoiceId" | "createdAt">): Promise<void>;
  /** Charges not on an invoice yet (locked when asked). */
  pendingAdjustments(subscriptionId: string, lock?: boolean): Promise<BillingAdjustment[]>;
  adjustments(
    filter: Readonly<{ tenantId?: string; invoiceId?: string }>,
  ): Promise<BillingAdjustment[]>;
  markInvoiced(adjustmentIds: readonly string[], invoiceId: string): Promise<void>;
  /** A voided invoice gives its adjustments back to the next one. */
  releaseAdjustments(invoiceId: string): Promise<void>;

  /** The next receipt number for `year`, e.g. AF-RCT-2026-000042. */
  nextReceiptCode(year: number): Promise<string>;
  payment(id: string): Promise<PaymentRecord | null>;

  paymentMethods(tenantId: string): Promise<SavedPaymentMethod[]>;
  savePaymentMethod(method: SavedPaymentMethod): Promise<void>;
  /** The tenant's default method becomes `id` (only one default). */
  setDefaultPaymentMethod(tenantId: string, id: string): Promise<void>;
  removePaymentMethod(tenantId: string, id: string, now: Date): Promise<boolean>;
}
