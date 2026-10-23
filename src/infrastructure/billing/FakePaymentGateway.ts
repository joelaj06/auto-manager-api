import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AuthorizationCharge,
  CheckoutRequest,
  GatewayTransaction,
  IPaymentGateway,
  MobileMoneyCharge,
  MobileMoneyResult,
  SettledTransaction,
  WebhookEvent,
} from "../../application/ports/IPaymentGateway.js";
import { parsePaystackWebhook } from "./PaystackGateway.js";

type Stored = {
  reference: string;
  amountMinor: number;
  currency: string;
  status: GatewayTransaction["status"];
  channel: GatewayTransaction["channel"];
  paidAt: Date | null;
  authorization: GatewayTransaction["authorization"];
  mobileMoneyLabel: string | null;
  id: number;
};

/** Saved-card codes the fake declines (tests of a failed automatic charge). */
export const FAKE_DECLINED_AUTHORIZATION = "AUTH_declined";

/**
 * An in-process payment gateway for development and tests (refused in production): it keeps
 * transactions in memory, behaves like Paystack (checkout, saved cards, MoMo prompts and OTPs,
 * refunds) and emits Paystack-shaped webhooks signed with its own secret. `complete`,
 * `fail` and `processRefund` play the payer's and the provider's part.
 */
export class FakePaymentGateway implements IPaymentGateway {
  readonly provider = "fake";
  private readonly transactions_ = new Map<string, Stored>();
  private readonly refunds = new Map<string, { reference: string; amountMinor: number }>();
  /** Provider ids stay unique across restarts (webhooks are deduplicated by them). */
  private nextId = Date.now();

  constructor(
    private readonly options: Readonly<{ webhookSecret: string; checkoutBaseUrl: string }>,
  ) {}

  initializeCheckout(r: CheckoutRequest): Promise<Readonly<{ checkoutUrl: string }>> {
    this.store(r.reference, r.amountMinor, r.currency);
    return Promise.resolve({
      checkoutUrl: `${this.options.checkoutBaseUrl}?reference=${encodeURIComponent(r.reference)}&gateway=fake`,
    });
  }

  verify(reference: string): Promise<GatewayTransaction> {
    const t = this.transactions_.get(reference);
    return Promise.resolve(
      t === undefined
        ? {
            reference,
            status: "failed",
            amountMinor: 0,
            currency: "GHS",
            paidAt: null,
            channel: null,
            providerTransactionId: null,
            feesMinor: null,
            authorization: null,
            mobileMoneyLabel: null,
            failureReason: "Unknown transaction",
          }
        : this.view(t),
    );
  }

  chargeAuthorization(r: AuthorizationCharge): Promise<GatewayTransaction> {
    const t = this.store(r.reference, r.amountMinor, r.currency);
    t.channel = "card";
    if (r.authorizationCode === FAKE_DECLINED_AUTHORIZATION) t.status = "failed";
    else this.succeed(t);
    return Promise.resolve(this.view(t));
  }

  chargeMobileMoney(r: MobileMoneyCharge): Promise<MobileMoneyResult> {
    const t = this.store(r.reference, r.amountMinor, r.currency);
    t.channel = "mobile_money";
    t.mobileMoneyLabel = `MoMo •• ${r.phone.slice(-4)}`;
    return Promise.resolve(
      r.network === "telecel"
        ? { status: "otp", message: "Enter the voucher code sent to your phone" }
        : { status: "prompt", message: "Approve the payment prompt on your phone" },
    );
  }

  submitOtp(reference: string, otp: string): Promise<MobileMoneyResult> {
    const t = this.transactions_.get(reference);
    if (t === undefined || otp !== "123456")
      return Promise.resolve({ status: "failed", message: "Wrong code" });
    return Promise.resolve({
      status: "prompt",
      message: "Approve the payment prompt on your phone",
    });
  }

  refund(r: Readonly<{ reference: string; amountMinor: number; note: string }>) {
    const providerRefundId = `RF${this.nextId++}`;
    this.refunds.set(providerRefundId, { reference: r.reference, amountMinor: r.amountMinor });
    return Promise.resolve({ providerRefundId, status: "pending" as const });
  }

  transactions(range: Readonly<{ from: Date; to: Date }>): Promise<SettledTransaction[]> {
    return Promise.resolve(
      [...this.transactions_.values()]
        .filter((t) => t.status === "success" && t.paidAt !== null)
        .filter((t) => t.paidAt! >= range.from && t.paidAt! < range.to)
        .map((t) => ({
          reference: t.reference,
          amountMinor: t.amountMinor,
          currency: t.currency,
          paidAt: t.paidAt!,
          feesMinor: Math.round(t.amountMinor * 0.0195),
        })),
    );
  }

  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (signature === undefined || !/^[0-9a-f]{128}$/i.test(signature)) return false;
    return timingSafeEqual(this.sign(rawBody), Buffer.from(signature, "hex"));
  }

  parseWebhook(payload: unknown): WebhookEvent | null {
    return parsePaystackWebhook(payload);
  }

  // --- the payer's and the provider's part ---

  /** The payer paid (checkout or MoMo prompt): returns the signed `charge.success` webhook. */
  complete(
    reference: string,
    options: Readonly<{
      channel?: "card" | "mobile_money";
      reusableCard?: boolean;
      amountMinor?: number;
    }> = {},
  ) {
    const t = this.transactions_.get(reference);
    if (t === undefined) throw new Error(`Unknown fake transaction ${reference}`);
    t.channel = options.channel ?? t.channel ?? "card";
    if (options.amountMinor !== undefined) t.amountMinor = options.amountMinor;
    if (t.channel === "card")
      t.authorization = {
        code: `AUTH_${t.id}`,
        label: "Visa •• 4081",
        reusable: options.reusableCard ?? false,
        expiresOn: "2030-12-31",
      };
    this.succeed(t);
    return this.webhook({
      event: "charge.success",
      data: { id: t.id, reference, status: "success", amount: t.amountMinor, currency: t.currency },
    });
  }

  fail(reference: string): void {
    const t = this.transactions_.get(reference);
    if (t !== undefined) t.status = "failed";
  }

  /** The provider processed a refund: returns the signed `refund.processed` webhook. */
  processRefund(providerRefundId: string) {
    const refund = this.refunds.get(providerRefundId);
    if (refund === undefined) throw new Error(`Unknown fake refund ${providerRefundId}`);
    return this.webhook({
      event: "refund.processed",
      data: {
        status: "processed",
        transaction_reference: refund.reference,
        refund_reference: providerRefundId,
        amount: refund.amountMinor,
      },
    });
  }

  /** A body and its signature as the provider would POST them. */
  webhook(payload: object): Readonly<{ body: string; signature: string }> {
    const body = JSON.stringify(payload);
    return { body, signature: this.sign(Buffer.from(body)).toString("hex") };
  }

  private sign(body: Buffer): Buffer {
    return createHmac("sha512", this.options.webhookSecret).update(body).digest();
  }

  private store(reference: string, amountMinor: number, currency: string): Stored {
    const existing = this.transactions_.get(reference);
    if (existing !== undefined) return existing;
    const t: Stored = {
      reference,
      amountMinor,
      currency,
      status: "pending",
      channel: null,
      paidAt: null,
      authorization: null,
      mobileMoneyLabel: null,
      id: this.nextId++,
    };
    this.transactions_.set(reference, t);
    return t;
  }

  private succeed(t: Stored): void {
    t.status = "success";
    t.paidAt = new Date();
  }

  private view(t: Stored): GatewayTransaction {
    return {
      reference: t.reference,
      status: t.status,
      amountMinor: t.amountMinor,
      currency: t.currency,
      paidAt: t.paidAt,
      channel: t.channel,
      providerTransactionId: String(t.id),
      feesMinor: t.status === "success" ? Math.round(t.amountMinor * 0.0195) : null,
      authorization: t.authorization,
      mobileMoneyLabel: t.mobileMoneyLabel,
      failureReason: t.status === "failed" ? "Declined" : null,
    };
  }
}
