import type { InvoiceProps } from "../../../domain/billing/Invoice.js";
import { Money } from "../../../domain/money/Money.js";
import {
  basisPoints,
  clawbackAmount,
  commissionAmount,
  licenceBase,
  percentOf,
} from "../../../domain/partners/Commissions.js";
import type {
  IBillingRepository,
  PaymentRecord,
} from "../../../domain/repositories/IBillingRepository.js";
import type { IPartnerCommissionRepository } from "../../../domain/repositories/IPartnerCommissionRepository.js";
import type { ICommissionHooks } from "../../ports/ICommissionHooks.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { PartnerNotifier } from "./PartnerNotifier.js";

const DAY_MS = 86_400_000;

/**
 * The first-purchase commission engine (docs/29 §4–§5, decisions 46, 49, 54, 57), run in the
 * billing unit of work for every licence payment and refund:
 * - only a tenant attributed to a reseller (not terminated) earns, and only on its first licence
 *   purchase — the first invoice with licence lines that receives a payment; each payment on it
 *   earns pro rata (partial payments too), staff-recorded or through the gateway;
 * - the base is the licence share collected, excluding VAT, after discounts; one-time costs
 *   never count; the rate is the tenant's override, else its terms' Standard or Enterprise
 *   percentage (the licence type at payment), within the per-tenant cap;
 * - payable at once, or after the reseller's hold period;
 * - a refund claws back its share; a fully refunded first purchase frees the next paid licence
 *   invoice to become the first purchase.
 * Idempotent per payment and per refund.
 */
export class CommissionEngine implements ICommissionHooks {
  constructor(
    private readonly deps: Readonly<{
      commissions: IPartnerCommissionRepository;
      billing: IBillingRepository;
      notifier: PartnerNotifier;
      ids: IIdGenerator;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async paymentApplied(payment: PaymentRecord, invoice: InvoiceProps): Promise<void> {
    const { deps } = this;
    const attribution = await deps.commissions.attribution(payment.tenantId, true);
    if (attribution === null || attribution.partnerStatus === "terminated") return;
    if ((await deps.commissions.forPayment(payment.id)).length > 0) return;
    const base = licenceBase(invoice, payment.amountMinor);
    if (base <= 0) return;
    if (attribution.commissionInvoiceId === null)
      await deps.commissions.setCommissionInvoice(payment.tenantId, invoice.id);
    else if (attribution.commissionInvoiceId !== invoice.id) return;

    const terms =
      attribution.termsId === null
        ? await deps.commissions.latestTerms(attribution.partnerId)
        : await deps.commissions.termsById(attribution.termsId);
    if (terms === null) return;
    if (attribution.termsId === null) await deps.commissions.bindTerms(payment.tenantId, terms.id);
    const type = (await deps.billing.subscriptionOf(payment.tenantId))?.licenceType ?? "standard";
    const bp = basisPoints(
      attribution.overridePercent ??
        (type === "enterprise" ? terms.enterprisePercent : terms.standardPercent),
    );
    if (bp === null || bp === 0) return;
    const capLeft =
      terms.capPerTenantMinor === null
        ? null
        : terms.capPerTenantMinor - (await deps.commissions.tenantTotal(payment.tenantId));
    const amount = commissionAmount(base, bp, capLeft);
    if (amount <= 0) return;
    const now = deps.clock.now();
    const held = terms.holdDays > 0;
    await deps.commissions.addEntry({
      id: deps.ids.next(),
      partnerId: attribution.partnerId,
      tenantId: payment.tenantId,
      kind: "commission",
      invoiceId: invoice.id,
      sourcePaymentId: payment.id,
      sourceRefundId: null,
      commissionType: type,
      termsId: terms.id,
      baseMinor: base,
      ratePercent: percentOf(bp),
      amountMinor: amount,
      currency: payment.currency,
      status: held ? "accrued" : "payable",
      releaseAt: held ? new Date(now.getTime() + terms.holdDays * DAY_MS) : null,
      reason: null,
      createdBy: null,
    });
    const m = Money.ofMinor(amount, payment.currency).formatAscii();
    await this.tell(attribution.partnerId, {
      subject: held ? "Commission earned" : "Commission payable",
      body: held
        ? `You earned ${m} on a client's first licence payment. It becomes payable after ${terms.holdDays} days.`
        : `You earned ${m} on a client's first licence payment. It is payable now.`,
      key: `commission:${payment.id}`,
    });
  }

  async paymentRefunded(
    payment: PaymentRecord,
    refund: Readonly<{ id: string; amountMinor: number }>,
    invoice: InvoiceProps,
  ): Promise<void> {
    const { deps } = this;
    const entries = await deps.commissions.forPayment(payment.id);
    const earned = entries.find((e) => e.kind === "commission");
    if (earned === undefined) {
      await this.freeFirstPurchase(payment.tenantId, invoice);
      return;
    }
    if (entries.some((e) => e.sourceRefundId === refund.id)) return;
    const clawed = -entries
      .filter((e) => e.kind === "clawback")
      .reduce((sum, e) => sum + e.amountMinor, 0);
    const amount = clawbackAmount(
      earned.amountMinor,
      clawed,
      payment.amountMinor,
      refund.amountMinor,
    );
    if (amount > 0)
      await deps.commissions.addEntry({
        ...earned,
        id: deps.ids.next(),
        kind: "clawback",
        sourceRefundId: refund.id,
        baseMinor: null,
        amountMinor: -amount,
        status: "payable",
        releaseAt: null,
        reason: "Client payment refunded",
      });
    await this.freeFirstPurchase(payment.tenantId, invoice);
  }

  /** Nothing is left paid on the first purchase: the next paid licence invoice is the first. */
  private async freeFirstPurchase(tenantId: string, invoice: InvoiceProps): Promise<void> {
    const attribution = await this.deps.commissions.attribution(tenantId, true);
    if (attribution?.commissionInvoiceId === invoice.id && invoice.paidMinor === 0)
      await this.deps.commissions.setCommissionInvoice(tenantId, null);
  }

  private async tell(
    partnerId: string,
    message: Readonly<{ subject: string; body: string; key: string }>,
  ): Promise<void> {
    try {
      await this.deps.notifier.tell(partnerId, message);
    } catch (error) {
      this.deps.logger.warn("Could not tell a reseller about a commission", { partnerId, error });
    }
  }
}
