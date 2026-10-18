import type { Invoice, InvoiceStatus } from "../billing/Invoice.js";
import type { Plan, Subscription } from "../billing/Subscription.js";

export type PaymentMethod = "bank_transfer" | "momo" | "cash" | "cheque" | "other";

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
  recordedBy: string;
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
}
