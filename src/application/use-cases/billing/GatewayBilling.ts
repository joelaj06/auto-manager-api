import type { Invoice } from "../../../domain/billing/Invoice.js";
import {
  PaymentAttempt,
  type AttemptKind,
  type MomoNetwork,
} from "../../../domain/billing/PaymentAttempt.js";
import type {
  IBillingRepository,
  PaymentMethod,
  PaymentRecord,
} from "../../../domain/repositories/IBillingRepository.js";
import type {
  IGatewayRepository,
  RefundRecord,
  WebhookRecord,
} from "../../../domain/repositories/IGatewayRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ILogger } from "../../ports/ILogger.js";
import type {
  GatewayTransaction,
  IPaymentGateway,
  MobileMoneyResult,
  WebhookEvent,
} from "../../ports/IPaymentGateway.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ISecretBox } from "../../ports/ISecretBox.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import { recordStaffAction } from "../console/consoleAudit.js";
import type { TenantLifecycleService } from "../tenants/TenantLifecycleService.js";
import { InvoiceNotFoundError, type ManualBilling } from "./ManualBilling.js";
import { PaymentMethodNotFoundError, ReceiptNotFoundError } from "./TenantBilling.js";

export class PaymentNotPossibleError extends ApplicationError {
  constructor(
    readonly code: "INVOICE_NOT_PAYABLE" | "BILLING_EMAIL_REQUIRED" | "REFUND_NOT_POSSIBLE",
    message: string,
  ) {
    super(message);
  }
}

export class PaymentAttemptNotFoundError extends ApplicationError {
  readonly code = "PAYMENT_ATTEMPT_NOT_FOUND";
  constructor() {
    super("Payment not found");
  }
}

export class WebhookNotFoundError extends ApplicationError {
  readonly code = "WEBHOOK_NOT_FOUND";
  constructor() {
    super("Webhook event not found");
  }
}

/** A payment attempt as the payer and staff see it (never authorizations or phone numbers). */
export type AttemptView = Readonly<{
  reference: string;
  invoiceId: string;
  kind: string;
  status: string;
  amountMinor: number;
  currency: string;
  checkoutUrl: string | null;
  channel: string | null;
  failureReason: string | null;
  /** MoMo: approve the prompt, or enter the code the network sent. */
  next?: Readonly<{ action: "approve_on_phone" | "enter_otp"; message: string | null }>;
  invoiceStatus?: string;
  createdAt: Date;
  completedAt: Date | null;
}>;

const METHOD_OF: Readonly<Record<string, PaymentMethod>> = {
  card: "card",
  mobile_money: "momo",
  bank_transfer: "bank_transfer",
};
const NETWORK_LABEL: Readonly<Record<MomoNetwork, string>> = {
  mtn: "MTN MoMo",
  telecel: "Telecel Cash",
  at: "AT Money",
};

/**
 * Paying Autoforce through the gateway (docs/25 §4, §9): hosted checkout, a saved card charged on
 * request (and by the billing automation), mobile money prompts with OTPs, and the status a payer
 * polls on return. The webhook is the source of truth, but nothing is credited on its word:
 * every success is re-verified with the provider and applied only for exactly the amount asked —
 * the server computes amounts from the invoice. Webhooks are stored (inspector, replay) and
 * idempotent by the provider's event; payments, receipts and the subscription follow the same
 * path as staff-recorded ones. Refunds go back through the gateway (or are recorded as paid
 * outside) and reopen the invoice for what was refunded.
 */
export class GatewayBilling {
  constructor(
    private readonly deps: Readonly<{
      provider: IPaymentGateway;
      gateway: IGatewayRepository;
      records: IBillingRepository;
      billing: ManualBilling;
      lifecycle: TenantLifecycleService;
      secrets: ISecretBox;
      unitOfWork: IPlatformUnitOfWork;
      tenantContext: ITenantContext;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      logger: ILogger;
      returnUrl: string;
    }>,
  ) {}

  // --- the tenant pays ---

  /** A hosted checkout page for what is left of an invoice (card, MoMo or bank transfer). */
  async checkout(
    invoiceId: string,
    request: Readonly<{ saveCard?: boolean }>,
    userId: string,
  ): Promise<AttemptView> {
    const { deps } = this;
    const invoice = await this.tenantInvoice(invoiceId);
    const { attempt, email } = await this.start(invoice, "checkout", userId, {
      saveMethod: request.saveCard ?? false,
    });
    const a = attempt.snapshot();
    const { checkoutUrl } = await deps.provider.initializeCheckout({
      reference: a.reference,
      amountMinor: a.amountMinor,
      currency: a.currency,
      email,
      callbackUrl: `${deps.returnUrl}?reference=${encodeURIComponent(a.reference)}`,
      metadata: { tenantId: a.tenantId, invoiceId: a.invoiceId, attemptId: a.id },
    });
    attempt.checkoutOpened(checkoutUrl);
    await deps.unitOfWork.run(() => deps.gateway.saveAttempt(attempt));
    return this.view(attempt);
  }

  /** Charges a saved card (a MoMo number gets a prompt) for one of the tenant's invoices. */
  async payWithSavedMethod(invoiceId: string, methodId: string, userId: string) {
    return this.chargeSaved(await this.tenantInvoice(invoiceId), methodId, userId);
  }

  /** The automatic charge of a cycle (billing automation): the default card, if any. */
  async chargeDefault(invoiceId: string): Promise<AttemptView | null> {
    const invoice = await this.deps.records.invoice(invoiceId);
    if (invoice === null) throw new InvoiceNotFoundError();
    const card = (await this.deps.records.paymentMethods(invoice.snapshot().tenantId)).find(
      (m) => m.isDefault && m.type === "card",
    );
    return card === undefined ? null : this.chargeSaved(invoice, card.id, null);
  }

  /**
   * Before the automation deactivates a tenant (gateway-health guard): asks the provider about
   * every pending attempt of the invoice, applying any that went through. True when it is paid.
   */
  async reverify(invoiceId: string): Promise<boolean> {
    const { deps } = this;
    const pending = await deps.gateway.attempts({ invoiceId, status: "pending", limit: 20 });
    for (const attempt of pending) {
      const reference = attempt.snapshot().reference;
      try {
        await this.apply(reference, await deps.provider.verify(reference));
      } catch (error) {
        deps.logger.warn("Could not re-verify a payment attempt", { reference, error });
        throw error;
      }
    }
    return (await deps.records.invoice(invoiceId))?.snapshot().status === "paid";
  }

  /** A mobile money prompt on the payer's phone (some networks first send a code to enter). */
  async payWithMomo(
    invoiceId: string,
    request: Readonly<{ phone: string; network: MomoNetwork; save?: boolean }>,
    userId: string,
  ): Promise<AttemptView> {
    return this.momo(await this.tenantInvoice(invoiceId), request, userId, null);
  }

  async submitOtp(reference: string, otp: string): Promise<AttemptView> {
    const attempt = await this.ownAttempt(reference);
    if (attempt.isFinal) return this.view(attempt);
    return this.afterMomo(reference, await this.deps.provider.submitOtp(reference, otp.trim()));
  }

  /** Where a payment stands (the return page polls it): asks the provider while pending. */
  async status(reference: string): Promise<AttemptView> {
    const attempt = await this.ownAttempt(reference);
    if (attempt.isFinal) return this.withInvoice(attempt);
    return this.apply(reference, await this.deps.provider.verify(reference));
  }

  // --- the provider tells us ---

  /** A webhook POST: stored, checked, applied once. Returns the HTTP status to answer. */
  async receiveWebhook(
    rawBody: Buffer,
    signature: string | undefined,
    payload: unknown,
  ): Promise<number> {
    const { deps } = this;
    const valid = deps.provider.verifySignature(rawBody, signature);
    const event = valid ? deps.provider.parseWebhook(payload) : null;
    const { record, duplicate } = await deps.unitOfWork.run(() =>
      deps.gateway.receiveWebhook({
        provider: deps.provider.provider,
        eventKey: event?.key ?? null,
        eventType:
          typeof (payload as { event?: unknown }).event === "string"
            ? (payload as { event: string }).event
            : null,
        signatureValid: valid,
        payload,
      }),
    );
    if (!valid) {
      await this.finish(record.id, "rejected", "Invalid signature");
      deps.logger.warn("Billing webhook with an invalid signature", { webhookId: record.id });
      return 401;
    }
    if (event === null) {
      await this.finish(record.id, "ignored", null);
      return 200;
    }
    if (duplicate && (record.outcome === "applied" || record.outcome === "ignored")) return 200;
    return this.process(record.id, event);
  }

  /** Processes a stored, signed webhook again (inspector). */
  async replayWebhook(id: string, actor: PlatformPrincipal): Promise<WebhookRecord> {
    const { deps } = this;
    const record = await deps.gateway.webhook(id);
    if (record === null) throw new WebhookNotFoundError();
    if (!record.signatureValid)
      throw new PaymentNotPossibleError(
        "REFUND_NOT_POSSIBLE",
        "Unsigned webhooks are never replayed",
      );
    const event = deps.provider.parseWebhook(record.payload);
    if (event === null) await this.finish(id, "ignored", null);
    else await this.process(id, event);
    await deps.unitOfWork.run(() =>
      recordStaffAction(deps, actor, {
        action: "billing.webhook_replayed",
        entityType: "webhook_event",
        entityId: id,
      }),
    );
    return (await deps.gateway.webhook(id))!;
  }

  webhooks(
    filter: Readonly<{ outcome?: WebhookRecord["outcome"]; before?: string; limit: number }>,
  ) {
    return this.deps.gateway.webhooks(filter);
  }

  async webhook(id: string): Promise<WebhookRecord> {
    const record = await this.deps.gateway.webhook(id);
    if (record === null) throw new WebhookNotFoundError();
    return record;
  }

  /** Attempts for the console (the failed-payments queue: `status=failed`). */
  async attempts(
    filter: Readonly<{ status?: PaymentAttempt["status"]; tenantId?: string; limit: number }>,
  ): Promise<AttemptView[]> {
    return (await this.deps.gateway.attempts(filter)).map((a) => this.view(a));
  }

  /** The attempts of one of the tenant's invoices (Billing tab). */
  async invoiceAttempts(invoiceId: string): Promise<AttemptView[]> {
    await this.tenantInvoice(invoiceId);
    return (await this.deps.gateway.attempts({ invoiceId, limit: 50 })).map((a) => this.view(a));
  }

  // --- refunds (console) ---

  /** Gives money back: through the gateway for a gateway payment, else as paid back outside. */
  async refund(
    paymentId: string,
    request: Readonly<{ amountMinor: number; reason: string }>,
    actor: PlatformPrincipal,
  ): Promise<RefundRecord> {
    const { deps } = this;
    const payment = await deps.records.payment(paymentId);
    if (payment === null) throw new ReceiptNotFoundError();
    const reason = request.reason.trim();
    const already = (await deps.gateway.refunds({ paymentId }))
      .filter((r) => r.status !== "failed")
      .reduce((sum, r) => sum + r.amountMinor, 0);
    if (!Number.isInteger(request.amountMinor) || request.amountMinor <= 0)
      throw new PaymentNotPossibleError("REFUND_NOT_POSSIBLE", "A refund is above zero");
    if (request.amountMinor > payment.amountMinor - already)
      throw new PaymentNotPossibleError(
        "REFUND_NOT_POSSIBLE",
        `At most ${payment.amountMinor - already} of this payment is left to refund`,
      );
    const viaGateway =
      payment.gatewayTransactionId !== null && payment.gatewayTransactionId !== undefined;
    const provider = viaGateway
      ? await deps.provider.refund({
          reference: payment.reference,
          amountMinor: request.amountMinor,
          note: reason,
        })
      : null;
    const id = deps.ids.next();
    await deps.unitOfWork.run(async () => {
      await deps.gateway.addRefund({
        id,
        paymentId,
        invoiceId: payment.invoiceId,
        tenantId: payment.tenantId,
        amountMinor: request.amountMinor,
        currency: payment.currency,
        reason,
        status:
          provider === null
            ? "processed"
            : provider.status === "processed"
              ? "processed"
              : "pending",
        provider: provider === null ? null : deps.provider.provider,
        providerRefundId: provider?.providerRefundId ?? null,
        requestedBy: actor.userId,
      });
      if (provider === null || provider.status === "processed")
        await this.refunded(payment, request.amountMinor, id);
      await recordStaffAction(deps, actor, {
        action: "billing.refund_issued",
        entityType: "billing_payment",
        entityId: paymentId,
        targetTenantId: payment.tenantId,
        reason,
        after: { refundId: id, amountMinor: request.amountMinor, viaGateway },
      });
    });
    return (await deps.gateway.refund(id))!;
  }

  refunds(paymentId: string): Promise<RefundRecord[]> {
    return this.deps.gateway.refunds({ paymentId });
  }

  // --- helpers ---

  private async chargeSaved(
    invoice: Invoice,
    methodId: string,
    userId: string | null,
  ): Promise<AttemptView> {
    const { deps } = this;
    const methods = await deps.records.paymentMethods(invoice.snapshot().tenantId);
    const method = methods.find((m) => m.id === methodId);
    if (method === undefined || method.sealedAuthorization === null)
      throw new PaymentMethodNotFoundError();
    if (method.type === "momo") {
      const saved = JSON.parse(deps.secrets.open(method.sealedAuthorization)) as {
        phone: string;
        network: MomoNetwork;
      };
      return this.momo(invoice, { ...saved, save: false }, userId, method.id);
    }
    const { attempt, email } = await this.start(invoice, "saved_card", userId, {
      paymentMethodId: method.id,
    });
    const a = attempt.snapshot();
    const result = await deps.provider.chargeAuthorization({
      reference: a.reference,
      authorizationCode: deps.secrets.open(method.sealedAuthorization),
      email,
      amountMinor: a.amountMinor,
      currency: a.currency,
      metadata: { tenantId: a.tenantId, invoiceId: a.invoiceId, attemptId: a.id },
    });
    return this.apply(a.reference, result);
  }

  private async momo(
    invoice: Invoice,
    request: Readonly<{ phone: string; network: MomoNetwork; save?: boolean }>,
    userId: string | null,
    paymentMethodId: string | null,
  ): Promise<AttemptView> {
    const { deps } = this;
    const phone = request.phone.replaceAll(/\s/g, "");
    if (!/^\+?[0-9]{9,15}$/.test(phone))
      throw new PaymentNotPossibleError(
        "INVOICE_NOT_PAYABLE",
        "Give the MoMo number, e.g. 0244123456",
      );
    const { attempt, email } = await this.start(invoice, "mobile_money", userId, {
      saveMethod: request.save ?? false,
      momoPhone: phone,
      momoNetwork: request.network,
      paymentMethodId,
    });
    const a = attempt.snapshot();
    const result = await deps.provider.chargeMobileMoney({
      reference: a.reference,
      phone,
      network: request.network,
      email,
      amountMinor: a.amountMinor,
      currency: a.currency,
      metadata: { tenantId: a.tenantId, invoiceId: a.invoiceId, attemptId: a.id },
    });
    return this.afterMomo(a.reference, result);
  }

  /** Applies what the provider says about an attempt (idempotent), then restores the tenant. */
  async apply(reference: string, result: GatewayTransaction): Promise<AttemptView> {
    const { deps } = this;
    const outcome = await deps.unitOfWork.run(async () => {
      const attempt = await deps.gateway.attempt(reference, true);
      if (attempt === null) throw new PaymentAttemptNotFoundError();
      if (attempt.isFinal) return { attempt, settled: false };
      const now = deps.clock.now();
      if (result.status === "pending") return { attempt, settled: false };
      if (result.status !== "success") {
        attempt.failed(result.failureReason, now, result.status === "abandoned");
        await deps.gateway.saveAttempt(attempt);
        return { attempt, settled: false };
      }
      const matches = attempt.succeeded(
        {
          amountMinor: result.amountMinor,
          currency: result.currency,
          channel: result.channel,
          providerTransactionId: result.providerTransactionId,
          feesMinor: result.feesMinor,
        },
        now,
      );
      const a = attempt.snapshot();
      const invoice = matches ? await deps.records.invoice(a.invoiceId, true) : null;
      if (!matches || invoice === null || !this.payable(invoice, a.amountMinor)) {
        if (matches)
          attempt.review(
            "The invoice was settled or voided meanwhile: refund or apply by hand",
            now,
          );
        await deps.gateway.saveAttempt(attempt);
        await this.systemAudit("billing.gateway_payment_review", a.id, a.tenantId, {
          reference,
          reason: attempt.snapshot().failureReason,
        });
        deps.logger.error("Gateway payment needs review", {
          reference,
          reason: attempt.snapshot().failureReason,
        });
        return { attempt, settled: false };
      }
      await deps.gateway.saveAttempt(attempt);
      const settled = await deps.billing.applyPayment(
        invoice,
        {
          method: METHOD_OF[result.channel ?? ""] ?? "other",
          reference,
          amountMinor: a.amountMinor,
          receivedAt: result.paidAt ?? now,
          notes: null,
          recordedBy: null,
          provider: deps.provider.provider,
          gatewayTransactionId: a.id,
          feesMinor: result.feesMinor,
        },
        { type: "system", id: null },
      );
      if (a.saveMethod) await this.saveMethod(a.tenantId, a, result);
      await this.systemAudit("billing.gateway_payment_received", a.invoiceId, a.tenantId, {
        reference,
        amountMinor: a.amountMinor,
        channel: result.channel,
        settled,
      });
      return { attempt, settled };
    });
    if (outcome.settled)
      await deps.lifecycle.applyLicencePayment(outcome.attempt.snapshot().tenantId, null);
    return this.withInvoice(outcome.attempt);
  }

  private async process(webhookId: string, event: WebhookEvent): Promise<number> {
    const { deps } = this;
    try {
      if (event.kind === "charge") {
        const attempt = await deps.gateway.attempt(event.reference);
        if (attempt === null) {
          await this.finish(webhookId, "ignored", "Not one of our references");
          return 200;
        }
        await this.apply(event.reference, await deps.provider.verify(event.reference));
      } else {
        const applied = await deps.unitOfWork.run(async () => {
          const refund = await deps.gateway.pendingRefundFor(event.transactionReference);
          if (refund === null) return false;
          if (event.status === "pending") return true;
          await deps.gateway.finishRefund(refund.id, event.status, deps.clock.now());
          if (event.status === "processed") {
            const payment = (await deps.records.payment(refund.paymentId))!;
            await this.refunded(payment, refund.amountMinor, refund.id);
          }
          return true;
        });
        if (!applied) {
          await this.finish(webhookId, "ignored", "No pending refund for this transaction");
          return 200;
        }
      }
      await this.finish(webhookId, "applied", null);
      return 200;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finish(webhookId, "failed", message);
      deps.logger.error("Billing webhook failed", { webhookId, error: message });
      return 500;
    }
  }

  /** The refunded amount is owed again on the invoice (inside the unit of work). */
  private async refunded(
    payment: PaymentRecord,
    amountMinor: number,
    refundId: string,
  ): Promise<void> {
    const { deps } = this;
    const invoice = (await deps.records.invoice(payment.invoiceId, true))!;
    invoice.refund(amountMinor);
    await deps.records.saveInvoice(invoice);
    const subscription = await deps.records.subscriptionOf(payment.tenantId);
    if (subscription !== null)
      await deps.records.appendEvent(subscription.id, {
        type: "payment_refunded",
        details: { paymentId: payment.id, refundId, amountMinor, invoiceId: payment.invoiceId },
        actorType: "system",
        actorId: null,
      });
  }

  private async start(
    invoice: Invoice,
    kind: AttemptKind,
    userId: string | null,
    extra: Readonly<{
      saveMethod?: boolean;
      paymentMethodId?: string | null;
      momoPhone?: string;
      momoNetwork?: MomoNetwork;
    }>,
  ): Promise<Readonly<{ attempt: PaymentAttempt; email: string }>> {
    const { deps } = this;
    const i = invoice.snapshot();
    if (i.status !== "open")
      throw new PaymentNotPossibleError("INVOICE_NOT_PAYABLE", `This invoice is ${i.status}`);
    const email = await this.payerEmail(i.tenantId);
    const id = deps.ids.next();
    const attempt = PaymentAttempt.start({
      id,
      reference: `${i.code}-${id.replaceAll("-", "").slice(-10)}`,
      tenantId: i.tenantId,
      invoiceId: i.id,
      provider: deps.provider.provider,
      kind,
      amountMinor: invoice.outstandingMinor,
      currency: i.currency,
      paymentMethodId: extra.paymentMethodId ?? null,
      saveMethod: extra.saveMethod ?? false,
      momoPhone: extra.momoPhone ?? null,
      momoNetwork: extra.momoNetwork ?? null,
      initiatedByType: userId === null ? "system" : "user",
      initiatedBy: userId,
      createdAt: deps.clock.now(),
    });
    await deps.unitOfWork.run(() => deps.gateway.saveAttempt(attempt));
    return { attempt, email };
  }

  private async afterMomo(reference: string, result: MobileMoneyResult): Promise<AttemptView> {
    if (result.status === "success")
      return this.apply(reference, await this.deps.provider.verify(reference));
    if (result.status === "failed") {
      const view = await this.apply(reference, {
        ...(await this.deps.provider.verify(reference)),
        status: "failed",
        failureReason: result.message ?? "The mobile money payment failed",
      });
      return view;
    }
    const attempt = (await this.deps.gateway.attempt(reference))!;
    return {
      ...this.view(attempt),
      next: {
        action: result.status === "otp" ? "enter_otp" : "approve_on_phone",
        message: result.message,
      },
    };
  }

  private async saveMethod(
    tenantId: string,
    a: ReturnType<PaymentAttempt["snapshot"]>,
    result: GatewayTransaction,
  ): Promise<void> {
    const { deps } = this;
    const existing = await deps.records.paymentMethods(tenantId);
    let method: {
      type: "card" | "momo";
      label: string;
      sealed: string;
      expiresOn: string | null;
    } | null = null;
    if (result.channel === "card" && result.authorization?.reusable === true)
      method = {
        type: "card",
        label: result.authorization.label,
        sealed: deps.secrets.seal(result.authorization.code),
        expiresOn: result.authorization.expiresOn,
      };
    else if (a.kind === "mobile_money" && a.momoPhone !== null && a.momoNetwork !== null)
      method = {
        type: "momo",
        label: `${NETWORK_LABEL[a.momoNetwork]} •• ${a.momoPhone.slice(-4)}`,
        sealed: deps.secrets.seal(JSON.stringify({ phone: a.momoPhone, network: a.momoNetwork })),
        expiresOn: null,
      };
    if (
      method === null ||
      existing.some((m) => m.label === method.label && m.provider === a.provider)
    )
      return;
    await deps.records.savePaymentMethod({
      id: deps.ids.next(),
      tenantId,
      provider: a.provider,
      type: method.type,
      label: method.label,
      sealedAuthorization: method.sealed,
      isDefault: !existing.some((m) => m.isDefault),
      expiresOn: method.expiresOn,
      createdAt: deps.clock.now(),
    });
  }

  private payable(invoice: Invoice, amountMinor: number): boolean {
    return invoice.status === "open" && invoice.outstandingMinor >= amountMinor;
  }

  private async payerEmail(tenantId: string): Promise<string> {
    const contacts = await this.deps.records.contacts(tenantId);
    const email = (
      contacts.find((c) => c.isPrimary && c.email !== null) ??
      contacts.find((c) => c.email !== null)
    )?.email;
    if (email === undefined || email === null)
      throw new PaymentNotPossibleError(
        "BILLING_EMAIL_REQUIRED",
        "Add a billing contact with an email address first (the receipt is sent there)",
      );
    return email;
  }

  /** One of the signed-in tenant's invoices. */
  private async tenantInvoice(invoiceId: string): Promise<Invoice> {
    const invoice = await this.deps.records.invoice(invoiceId);
    const tenantId = this.deps.tenantContext.currentTenantId().value;
    if (invoice === null || invoice.snapshot().tenantId !== tenantId)
      throw new InvoiceNotFoundError();
    return invoice;
  }

  private async ownAttempt(reference: string): Promise<PaymentAttempt> {
    const attempt = await this.deps.gateway.attempt(reference);
    const tenantId = this.deps.tenantContext.currentTenantId().value;
    if (attempt === null || attempt.snapshot().tenantId !== tenantId)
      throw new PaymentAttemptNotFoundError();
    return attempt;
  }

  private async finish(
    id: string,
    outcome: NonNullable<WebhookRecord["outcome"]>,
    error: string | null,
  ) {
    await this.deps.unitOfWork.run(() =>
      this.deps.gateway.finishWebhook(id, outcome, error, this.deps.clock.now()),
    );
  }

  private async systemAudit(
    action: string,
    entityId: string,
    tenantId: string,
    after: Readonly<Record<string, unknown>>,
  ) {
    await this.deps.audit.record({
      actorType: "system",
      actorId: null,
      action,
      entityType: "billing_invoice",
      entityId,
      targetTenantId: tenantId,
      after,
      requestId: this.deps.requestContext.current()?.requestId ?? null,
      ip: null,
    });
  }

  private view(attempt: PaymentAttempt): AttemptView {
    const a = attempt.snapshot();
    return {
      reference: a.reference,
      invoiceId: a.invoiceId,
      kind: a.kind,
      status: a.status,
      amountMinor: a.amountMinor,
      currency: a.currency,
      checkoutUrl: a.checkoutUrl,
      channel: a.channel,
      failureReason: a.failureReason,
      createdAt: a.createdAt,
      completedAt: a.completedAt,
    };
  }

  /** The view with the invoice's status (the payer's return page). */
  private async withInvoice(attempt: PaymentAttempt): Promise<AttemptView> {
    const invoice = await this.deps.records.invoice(attempt.snapshot().invoiceId);
    return { ...this.view(attempt), invoiceStatus: invoice?.status ?? "unknown" };
  }
}
