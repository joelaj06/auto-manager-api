import { billingTax, sellerParty } from "../../../domain/billing/BillingSettings.js";
import {
  Invoice,
  InvoiceRuleError,
  invoiceLine,
  invoiceSubtotal,
  type InvoiceLine,
  type InvoiceParty,
  type InvoiceProps,
  type InvoiceTaxLine,
} from "../../../domain/billing/Invoice.js";
import type { Subscription } from "../../../domain/billing/Subscription.js";
import type {
  BillingAdjustment,
  IBillingRepository,
  InvoiceFilter,
  PaymentMethod,
  PaymentRecord,
} from "../../../domain/repositories/IBillingRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "../console/consoleAudit.js";
import type { PdfFile } from "../documents/PrintedDocuments.js";
import type { BillingDocuments } from "./BillingDocuments.js";
import type { TenantLifecycleService } from "../tenants/TenantLifecycleService.js";
import {
  SubscriptionNotFoundError,
  type SubscriptionAdministration,
} from "./SubscriptionAdministration.js";

export class InvoiceNotFoundError extends ApplicationError {
  readonly code = "INVOICE_NOT_FOUND";
  constructor() {
    super("Invoice not found");
  }
}

/** Billing data needed before an invoice can be issued (409). */
export class BillingSetupError extends ApplicationError {
  constructor(
    readonly code: "PRICE_NOT_SET" | "LINES_REQUIRED" | "DUPLICATE_PAYMENT" | "PERIOD_INVOICED",
    message: string,
  ) {
    super(message);
  }
}

export type InvoiceView = InvoiceProps &
  Readonly<{ outstandingMinor: number; payments?: readonly PaymentRecord[] }>;

/** What the next invoice would be: lines (branches, pending prorations), tax and parties. */
export type InvoiceDraft = Readonly<{
  period: Readonly<{ start: string; end: string }>;
  lines: readonly InvoiceLine[];
  subtotalMinor: number;
  taxLines: readonly InvoiceTaxLine[];
  taxMinor: number;
  totalMinor: number;
  currency: string;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  dueInDays: number;
  /** The prorations it charges. */
  adjustments: readonly BillingAdjustment[];
}>;

export type ManualLineInput = Readonly<{
  kind: InvoiceLine["kind"];
  description: string;
  quantity: number;
  unitMinor: number;
  countsAsLicence?: boolean;
}>;

export type RecordPaymentInput = Readonly<{
  method: PaymentMethod;
  reference: string;
  amountMinor: number;
  receivedAt: Date;
  notes?: string | null;
}>;

const DAY_MS = 86_400_000;
const LICENCE_KINDS = new Set(["branch_rate", "size_adjustment"]);

/**
 * Manual billing (docs/25 §11, phase 1): staff issue the invoice for a subscription's next
 * period and record the payments they receive (bank transfer, MoMo, cash, cheque). A fully paid
 * invoice activates the subscription for its period, fixes the licence type and lifts a trial
 * or billing deactivation. Standard invoices are computed (billed branches × price, plus the
 * prorations of branches added during the paid period); enterprise invoices are entered line by
 * line. VAT is added on the subtotal when Autoforce is registered; seller and buyer are printed
 * as they are at issue. Clients never send amounts. Every payment gets a receipt number.
 */
export class ManualBilling {
  constructor(
    private readonly deps: Readonly<{
      billing: IBillingRepository;
      subscriptions: SubscriptionAdministration;
      lifecycle: TenantLifecycleService;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      documents: BillingDocuments;
    }>,
  ) {}

  async issue(
    tenantId: string,
    input: Readonly<{ dueInDays?: number; lines?: readonly ManualLineInput[] }>,
    actor: PlatformPrincipal,
  ): Promise<InvoiceView> {
    const { deps } = this;
    const invoice = await deps.unitOfWork.run(async () => {
      const subscription = await deps.billing.subscriptionOf(tenantId, true);
      if (subscription === null) throw new SubscriptionNotFoundError();
      const now = deps.clock.now();
      const draft = await this.compose(subscription, input.lines, now, true);
      // Before taking an invoice number: numbers must have no gaps.
      const open = await deps.billing.invoices({ tenantId, status: "open", limit: 50 });
      if (open.some((i) => i.snapshot().periodStart === draft.period.start))
        throw new BillingSetupError("PERIOD_INVOICED", "This period already has an open invoice");
      const issued = Invoice.issue({
        id: deps.ids.next(),
        code: await deps.billing.nextInvoiceCode(now.getUTCFullYear()),
        tenantId,
        subscriptionId: subscription.id,
        period: draft.period,
        lines: draft.lines,
        taxLines: draft.taxLines,
        seller: draft.seller,
        buyer: draft.buyer,
        currency: draft.currency,
        now,
        dueAt: new Date(now.getTime() + (input.dueInDays ?? draft.dueInDays) * DAY_MS),
        createdBy: actor.userId,
      });
      await deps.billing.saveInvoice(issued);
      await deps.billing.markInvoiced(
        draft.adjustments.map((a) => a.id),
        issued.id,
      );
      await deps.billing.appendEvent(subscription.id, {
        type: "invoice_issued",
        details: {
          invoiceId: issued.id,
          code: issued.snapshot().code,
          totalMinor: issued.snapshot().totalMinor,
        },
        actorType: "platform_staff",
        actorId: actor.userId,
      });
      await recordStaffAction(deps, actor, {
        action: "billing.invoice_issued",
        entityType: "billing_invoice",
        entityId: issued.id,
        targetTenantId: tenantId,
        after: {
          code: issued.snapshot().code,
          period: draft.period,
          totalMinor: issued.snapshot().totalMinor,
        },
      });
      return issued;
    });
    return this.view(invoice);
  }

  /** The next invoice as it would be issued now (standard tenants; nothing is saved). */
  async preview(tenantId: string): Promise<InvoiceDraft> {
    const subscription = await this.deps.billing.subscriptionOf(tenantId);
    if (subscription === null) throw new SubscriptionNotFoundError();
    return this.compose(subscription, undefined, this.deps.clock.now(), false);
  }

  async recordPayment(
    invoiceId: string,
    input: RecordPaymentInput,
    actor: PlatformPrincipal,
  ): Promise<InvoiceView> {
    const { deps } = this;
    if (input.receivedAt > deps.clock.now())
      throw new InvoiceRuleError("A payment cannot be received in the future");
    const result = await deps.unitOfWork.run(async () => {
      const invoice = await deps.billing.invoice(invoiceId, true);
      if (invoice === null) throw new InvoiceNotFoundError();
      if (await deps.billing.paymentReferenceUsed(input.method, input.reference.trim()))
        throw new BillingSetupError(
          "DUPLICATE_PAYMENT",
          "A payment with this method and reference was already recorded",
        );
      const i = invoice.snapshot();
      const now = deps.clock.now();
      const settled = invoice.recordPayment(input.amountMinor, i.currency, now);
      await deps.billing.saveInvoice(invoice);
      await deps.billing.insertPayment({
        id: deps.ids.next(),
        invoiceId,
        tenantId: i.tenantId,
        method: input.method,
        reference: input.reference.trim(),
        amountMinor: input.amountMinor,
        currency: i.currency,
        receivedAt: input.receivedAt,
        notes: input.notes?.trim() || null,
        recordedBy: actor.userId,
        receiptNumber: await deps.billing.nextReceiptCode(now.getUTCFullYear()),
      });
      if (settled) {
        const subscription = await deps.billing.subscriptionOf(i.tenantId, true);
        if (subscription === null) throw new SubscriptionNotFoundError();
        const branchLine = i.lines.find((l) => l.kind === "branch_rate");
        subscription.applyPaidPeriod(
          { start: i.periodStart, end: i.periodEnd },
          now,
          branchLine?.quantity ?? subscription.branchCount,
        );
        await deps.billing.saveSubscription(subscription);
        await deps.billing.appendEvent(subscription.id, {
          type: "invoice_paid",
          details: { invoiceId, code: i.code, period: { start: i.periodStart, end: i.periodEnd } },
          actorType: "platform_staff",
          actorId: actor.userId,
        });
      }
      await recordStaffAction(deps, actor, {
        action: "billing.payment_recorded",
        entityType: "billing_invoice",
        entityId: invoiceId,
        targetTenantId: i.tenantId,
        after: {
          method: input.method,
          reference: input.reference.trim(),
          amountMinor: input.amountMinor,
          settled,
        },
      });
      return { invoice, settled };
    });
    if (result.settled)
      await deps.lifecycle.applyLicencePayment(result.invoice.snapshot().tenantId, actor);
    return this.view(result.invoice, true);
  }

  async void(invoiceId: string, reason: string, actor: PlatformPrincipal): Promise<InvoiceView> {
    const { deps } = this;
    const invoice = await deps.unitOfWork.run(async () => {
      const locked = await deps.billing.invoice(invoiceId, true);
      if (locked === null) throw new InvoiceNotFoundError();
      locked.void(reason, deps.clock.now());
      await deps.billing.saveInvoice(locked);
      // Its prorations go on the next invoice instead.
      await deps.billing.releaseAdjustments(invoiceId);
      await recordStaffAction(deps, actor, {
        action: "billing.invoice_voided",
        entityType: "billing_invoice",
        entityId: invoiceId,
        targetTenantId: locked.snapshot().tenantId,
        reason,
      });
      return locked;
    });
    return this.view(invoice);
  }

  async invoices(filter: InvoiceFilter): Promise<InvoiceView[]> {
    const invoices = await this.deps.billing.invoices(filter);
    return Promise.all(invoices.map((i) => this.view(i)));
  }

  async invoice(invoiceId: string, tenantId?: string): Promise<InvoiceView> {
    const invoice = await this.deps.billing.invoice(invoiceId);
    if (invoice === null || (tenantId !== undefined && invoice.snapshot().tenantId !== tenantId))
      throw new InvoiceNotFoundError();
    return this.view(invoice, true);
  }

  async invoicePdf(invoiceId: string): Promise<PdfFile> {
    return this.deps.documents.invoice(
      await this.invoice(invoiceId),
      await this.deps.billing.settings(),
    );
  }

  async receiptPdf(paymentId: string): Promise<PdfFile> {
    const payment = await this.deps.billing.payment(paymentId);
    if (payment === null) throw new InvoiceNotFoundError();
    return this.deps.documents.receipt(
      payment,
      await this.invoice(payment.invoiceId),
      await this.deps.billing.settings(),
    );
  }

  payments(tenantId: string): Promise<PaymentRecord[]> {
    return this.deps.billing.payments({ tenantId });
  }

  /** The next invoice of a subscription: period, lines, tax and both parties. */
  private async compose(
    subscription: Subscription,
    manual: readonly ManualLineInput[] | undefined,
    now: Date,
    lock: boolean,
  ): Promise<InvoiceDraft> {
    const { deps } = this;
    const plan = await deps.subscriptions.plan(subscription.licenceType);
    const today = now.toISOString().slice(0, 10);
    const period = subscription.nextPeriod(today);
    const adjustments = await deps.billing.pendingAdjustments(subscription.id, lock);
    const lines = [
      ...this.linesFor(subscription.branchCount, plan, manual, period),
      ...adjustments.map((a) =>
        invoiceLine({
          kind: "proration",
          description: a.description,
          quantity: 1,
          unitMinor: a.amountMinor,
          countsAsLicence: true,
        }),
      ),
    ];
    const settings = await deps.billing.settings();
    const subtotalMinor = invoiceSubtotal(lines);
    const taxLines = billingTax(settings, subtotalMinor, plan.currency, today);
    const taxMinor = taxLines.reduce((sum, t) => sum + t.amountMinor, 0);
    return {
      period,
      lines,
      subtotalMinor,
      taxLines,
      taxMinor,
      totalMinor: subtotalMinor + taxMinor,
      currency: plan.currency,
      seller: sellerParty(settings),
      buyer: await this.buyer(subscription.tenantId),
      dueInDays: settings.invoiceDueDays,
      adjustments,
    };
  }

  /** The tenant as printed on the invoice: its billing profile and primary contact. */
  private async buyer(tenantId: string): Promise<InvoiceParty> {
    const { billing } = this.deps;
    const profile = await billing.profile(tenantId);
    const primary = (await billing.contacts(tenantId)).find((c) => c.isPrimary);
    return {
      name: profile?.legalName ?? (await billing.tenantName(tenantId)),
      address: profile?.address ?? null,
      tin: profile?.tin ?? null,
      email: primary?.email ?? null,
      phone: primary?.phone ?? null,
    };
  }

  private linesFor(
    branchCount: number,
    plan: Awaited<ReturnType<SubscriptionAdministration["plan"]>>,
    manual: readonly ManualLineInput[] | undefined,
    period: Readonly<{ start: string; end: string }>,
  ): InvoiceLine[] {
    if (plan.pricing === "custom") {
      if (manual === undefined || manual.length === 0)
        throw new BillingSetupError(
          "LINES_REQUIRED",
          "Enterprise invoices are entered line by line (from the accepted quote)",
        );
      return manual.map((line) =>
        invoiceLine({
          ...line,
          countsAsLicence: line.countsAsLicence ?? LICENCE_KINDS.has(line.kind),
        }),
      );
    }
    if (manual !== undefined && manual.length > 0)
      throw new InvoiceRuleError("Standard invoices are computed from the billed branches");
    if (plan.branchPriceMinor === null)
      throw new BillingSetupError("PRICE_NOT_SET", "Set the standard price per branch first");
    return [
      invoiceLine({
        kind: "branch_rate",
        description: `${plan.name} licence, ${branchCount} branch${branchCount === 1 ? "" : "es"}, ${period.start} to ${period.end}`,
        quantity: branchCount,
        unitMinor: plan.branchPriceMinor,
        countsAsLicence: true,
      }),
    ];
  }

  private async view(invoice: Invoice, withPayments = false): Promise<InvoiceView> {
    const s = invoice.snapshot();
    return {
      ...s,
      outstandingMinor: invoice.outstandingMinor,
      ...(withPayments ? { payments: await this.deps.billing.payments({ invoiceId: s.id }) } : {}),
    };
  }
}
