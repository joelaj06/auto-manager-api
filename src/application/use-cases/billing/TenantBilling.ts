import { InvoiceRuleError } from "../../../domain/billing/Invoice.js";
import type {
  BillingContact,
  BillingProfile,
  IBillingRepository,
  PaymentRecord,
  SavedPaymentMethod,
} from "../../../domain/repositories/IBillingRepository.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { PdfFile } from "../documents/PrintedDocuments.js";
import type { BillingDocuments } from "./BillingDocuments.js";
import type { InvoiceDraft, InvoiceView, ManualBilling } from "./ManualBilling.js";
import type { SubscriptionAdministration, SubscriptionView } from "./SubscriptionAdministration.js";

export class ReceiptNotFoundError extends ApplicationError {
  readonly code = "RECEIPT_NOT_FOUND";
  constructor() {
    super("Receipt not found");
  }
}

export class PaymentMethodNotFoundError extends ApplicationError {
  readonly code = "PAYMENT_METHOD_NOT_FOUND";
  constructor() {
    super("Payment method not found");
  }
}

/** A payment as the tenant sees it (no internal notes or staff ids). */
export type TenantPaymentView = Pick<
  PaymentRecord,
  | "id"
  | "invoiceId"
  | "method"
  | "reference"
  | "amountMinor"
  | "currency"
  | "receivedAt"
  | "receiptNumber"
>;

/** One line of the billing history, oldest first, with the balance after it. */
export type TransactionView = Readonly<{
  at: Date;
  type: "invoice" | "payment" | "invoice_voided";
  /** The invoice code or receipt number. */
  reference: string;
  description: string;
  invoiceId: string;
  paymentId: string | null;
  /** What it adds to what is owed (invoices) … */
  debitMinor: number;
  /** … or takes off it (payments, voided invoices). */
  creditMinor: number;
  balanceMinor: number;
}>;

export type TransactionHistory = Readonly<{
  currency: string;
  /** Owed now (open invoices). */
  balanceMinor: number;
  transactions: readonly TransactionView[];
}>;

export type ContactInput = Readonly<{
  name: string;
  email?: string | null;
  phone?: string | null;
  isPrimary?: boolean;
  receivesNotices?: boolean;
}>;

/** A payment method as the tenant sees it (never the provider authorization). */
export type PaymentMethodView = Omit<SavedPaymentMethod, "sealedAuthorization" | "tenantId">;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const MAX_CONTACTS = 5;

const forTenant = (p: PaymentRecord): TenantPaymentView => ({
  id: p.id,
  invoiceId: p.invoiceId,
  method: p.method,
  reference: p.reference,
  amountMinor: p.amountMinor,
  currency: p.currency,
  receivedAt: p.receivedAt,
  receiptNumber: p.receiptNumber,
});

const methodView = ({
  sealedAuthorization: _s,
  tenantId: _t,
  ...m
}: SavedPaymentMethod): PaymentMethodView => m;

/**
 * The tenant's Billing tab (docs/25 §6): subscription and entitlements, the next invoice as it
 * stands (branches, prorations, VAT), invoices with PDFs, the full transaction history with a
 * running balance, receipts, billing details and contacts, and saved payment methods. Always the
 * signed-in user's own tenant. Paying online comes with the gateway (P4-2).
 */
export class TenantBilling {
  constructor(
    private readonly deps: Readonly<{
      subscriptions: SubscriptionAdministration;
      billing: ManualBilling;
      records: IBillingRepository;
      documents: BillingDocuments;
      unitOfWork: IPlatformUnitOfWork;
      tenantContext: ITenantContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  subscription(): Promise<SubscriptionView> {
    return this.deps.subscriptions.view(this.tenantId());
  }

  /** The next invoice if it were issued today (standard tenants). */
  upcoming(): Promise<InvoiceDraft> {
    return this.deps.billing.preview(this.tenantId());
  }

  async invoices(filter: Readonly<{ limit: number; before?: string }>): Promise<InvoiceView[]> {
    const invoices = await this.deps.billing.invoices({ ...filter, tenantId: this.tenantId() });
    return invoices
      .filter((i) => i.status !== "void")
      .map(({ createdBy: _c, ...i }) => i as InvoiceView);
  }

  async invoice(invoiceId: string): Promise<InvoiceView> {
    const {
      createdBy: _c,
      payments,
      ...invoice
    } = await this.deps.billing.invoice(invoiceId, this.tenantId());
    return { ...invoice, payments: (payments ?? []).map(forTenant) } as unknown as InvoiceView;
  }

  async invoicePdf(invoiceId: string): Promise<PdfFile> {
    const invoice = await this.deps.billing.invoice(invoiceId, this.tenantId());
    return this.deps.documents.invoice(invoice, await this.deps.records.settings());
  }

  /** Every invoice, voided invoice and payment, oldest first, with the running balance. */
  async transactions(): Promise<TransactionHistory> {
    const tenantId = this.tenantId();
    const { records } = this.deps;
    const invoices = await records.invoices({ tenantId, limit: 500 });
    const payments = await records.payments({ tenantId });
    const entries: Omit<TransactionView, "balanceMinor">[] = [];
    for (const invoice of invoices) {
      const i = invoice.snapshot();
      entries.push({
        at: i.issuedAt,
        type: "invoice",
        reference: i.code,
        description: `Invoice for ${i.periodStart} to ${i.periodEnd}`,
        invoiceId: i.id,
        paymentId: null,
        debitMinor: i.totalMinor,
        creditMinor: 0,
      });
      if (i.status === "void" && i.voidedAt !== null)
        entries.push({
          at: i.voidedAt,
          type: "invoice_voided",
          reference: i.code,
          description: `Invoice ${i.code} cancelled${i.voidReason === null ? "" : `: ${i.voidReason}`}`,
          invoiceId: i.id,
          paymentId: null,
          debitMinor: 0,
          creditMinor: i.totalMinor,
        });
    }
    const codes = new Map(invoices.map((i) => [i.id, i.snapshot().code]));
    for (const p of payments)
      entries.push({
        at: p.receivedAt,
        type: "payment",
        reference: p.receiptNumber ?? p.reference,
        description: `Payment for ${codes.get(p.invoiceId) ?? "an invoice"} (${p.method.replaceAll("_", " ")}, ${p.reference})`,
        invoiceId: p.invoiceId,
        paymentId: p.id,
        debitMinor: 0,
        creditMinor: p.amountMinor,
      });
    entries.sort((a, b) => a.at.getTime() - b.at.getTime() || a.type.localeCompare(b.type));
    let balance = 0;
    const transactions = entries.map((e) => {
      balance += e.debitMinor - e.creditMinor;
      return { ...e, balanceMinor: balance };
    });
    const currency = invoices[0]?.snapshot().currency ?? payments[0]?.currency ?? "GHS";
    return { currency, balanceMinor: balance, transactions };
  }

  async receipts(): Promise<TenantPaymentView[]> {
    return (await this.deps.records.payments({ tenantId: this.tenantId() })).map(forTenant);
  }

  async receipt(paymentId: string): Promise<TenantPaymentView> {
    return forTenant(await this.payment(paymentId));
  }

  async receiptPdf(paymentId: string): Promise<PdfFile> {
    const payment = await this.payment(paymentId);
    const invoice = await this.deps.billing.invoice(payment.invoiceId, this.tenantId());
    return this.deps.documents.receipt(payment, invoice, await this.deps.records.settings());
  }

  // --- billing details ---

  async profile(): Promise<
    Readonly<{ profile: BillingProfile | null; contacts: readonly BillingContact[] }>
  > {
    const tenantId = this.tenantId();
    return {
      profile: await this.deps.records.profile(tenantId),
      contacts: await this.deps.records.contacts(tenantId),
    };
  }

  /** Who the business is on our invoices (from the next invoice on). */
  async updateProfile(
    input: Readonly<{ legalName: string; tin?: string | null; address?: string | null }>,
    userId: string,
  ): Promise<BillingProfile> {
    const legalName = input.legalName.trim();
    if (legalName.length < 2 || legalName.length > 160)
      throw new InvoiceRuleError("The legal name is 2 to 160 characters");
    const tin = input.tin?.trim() || null;
    const address = input.address?.trim() || null;
    if (tin !== null && tin.length > 40)
      throw new InvoiceRuleError("The TIN is at most 40 characters");
    if (address !== null && address.length > 500)
      throw new InvoiceRuleError("The address is at most 500 characters");
    const tenantId = this.tenantId();
    await this.deps.unitOfWork.run(() =>
      this.deps.records.saveProfile({ tenantId, legalName, tin, address }, userId),
    );
    return (await this.deps.records.profile(tenantId))!;
  }

  /** Who receives invoices, receipts and notices: 1 to 5 contacts, exactly one primary. */
  async replaceContacts(contacts: readonly ContactInput[]): Promise<BillingContact[]> {
    if (contacts.length === 0 || contacts.length > MAX_CONTACTS)
      throw new InvoiceRuleError(`Give 1 to ${MAX_CONTACTS} billing contacts`);
    const checked: BillingContact[] = contacts.map((c) => {
      const name = c.name.trim();
      const email = c.email?.trim().toLowerCase() || null;
      const phone = c.phone?.trim() || null;
      if (name.length < 2 || name.length > 120)
        throw new InvoiceRuleError("A contact's name is 2 to 120 characters");
      if (email === null && phone === null)
        throw new InvoiceRuleError(`${name}: give an email or a phone number`);
      if (email !== null && !EMAIL.test(email))
        throw new InvoiceRuleError(`${name}: the email address is not valid`);
      if (phone !== null && !PHONE.test(phone))
        throw new InvoiceRuleError(`${name}: give the phone as +233…`);
      return {
        id: this.deps.ids.next(),
        name,
        email,
        phone,
        isPrimary: c.isPrimary ?? false,
        receivesNotices: c.receivesNotices ?? true,
      };
    });
    const primaries = checked.filter((c) => c.isPrimary).length;
    if (primaries !== 1) throw new InvoiceRuleError("Choose exactly one primary billing contact");
    const tenantId = this.tenantId();
    await this.deps.unitOfWork.run(() => this.deps.records.replaceContacts(tenantId, checked));
    return this.deps.records.contacts(tenantId);
  }

  // --- payment methods (saved by the gateway) ---

  async paymentMethods(): Promise<PaymentMethodView[]> {
    return (await this.deps.records.paymentMethods(this.tenantId())).map(methodView);
  }

  async setDefaultPaymentMethod(id: string): Promise<PaymentMethodView[]> {
    const tenantId = this.tenantId();
    await this.deps.unitOfWork.run(async () => {
      const methods = await this.deps.records.paymentMethods(tenantId);
      if (!methods.some((m) => m.id === id)) throw new PaymentMethodNotFoundError();
      await this.deps.records.setDefaultPaymentMethod(tenantId, id);
    });
    return this.paymentMethods();
  }

  /** Forgets a saved method; its provider authorization is erased. */
  async removePaymentMethod(id: string): Promise<void> {
    const tenantId = this.tenantId();
    const removed = await this.deps.unitOfWork.run(() =>
      this.deps.records.removePaymentMethod(tenantId, id, this.deps.clock.now()),
    );
    if (!removed) throw new PaymentMethodNotFoundError();
  }

  private async payment(paymentId: string): Promise<PaymentRecord> {
    const payment = await this.deps.records.payment(paymentId);
    if (payment === null || payment.tenantId !== this.tenantId()) throw new ReceiptNotFoundError();
    return payment;
  }

  private tenantId(): string {
    return this.deps.tenantContext.currentTenantId().value;
  }
}
