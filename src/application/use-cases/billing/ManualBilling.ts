import {
  Invoice,
  InvoiceRuleError,
  invoiceLine,
  type InvoiceLine,
  type InvoiceProps,
} from "../../../domain/billing/Invoice.js";
import type {
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
export const DEFAULT_DUE_DAYS = 7;
const LICENCE_KINDS = new Set(["branch_rate", "size_adjustment"]);

/**
 * Manual billing (docs/25 §11, phase 1): staff issue the invoice for a subscription's next
 * period and record the payments they receive (bank transfer, MoMo, cash, cheque). A fully paid
 * invoice activates the subscription for its period, fixes the licence type and lifts a trial
 * or billing deactivation. Standard invoices are computed (billed branches × price);
 * enterprise invoices are entered line by line. Clients never send amounts.
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
      const plan = await deps.subscriptions.plan(subscription.licenceType);
      const now = deps.clock.now();
      const period = subscription.nextPeriod(now.toISOString().slice(0, 10));
      const lines = this.linesFor(subscription.branchCount, plan, input.lines, period);
      // Before taking an invoice number: numbers must have no gaps.
      const open = await deps.billing.invoices({ tenantId, status: "open", limit: 50 });
      if (open.some((i) => i.snapshot().periodStart === period.start))
        throw new BillingSetupError("PERIOD_INVOICED", "This period already has an open invoice");
      const issued = Invoice.issue({
        id: deps.ids.next(),
        code: await deps.billing.nextInvoiceCode(now.getUTCFullYear()),
        tenantId,
        subscriptionId: subscription.id,
        period,
        lines,
        currency: plan.currency,
        now,
        dueAt: new Date(now.getTime() + (input.dueInDays ?? DEFAULT_DUE_DAYS) * DAY_MS),
        createdBy: actor.userId,
      });
      await deps.billing.saveInvoice(issued);
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
        after: { code: issued.snapshot().code, period, totalMinor: issued.snapshot().totalMinor },
      });
      return issued;
    });
    return this.view(invoice);
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
      });
      if (settled) {
        const subscription = await deps.billing.subscriptionOf(i.tenantId, true);
        if (subscription === null) throw new SubscriptionNotFoundError();
        subscription.applyPaidPeriod({ start: i.periodStart, end: i.periodEnd }, now);
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

  payments(tenantId: string): Promise<PaymentRecord[]> {
    return this.deps.billing.payments({ tenantId });
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
