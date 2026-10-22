import { ApplicationError } from "../errors/ApplicationError.js";

/**
 * The payment provider for tenants paying Autoforce (docs/25 §4): hosted checkout, a charge on a
 * saved card, a mobile money prompt, server-side verification, refunds, the provider's own list
 * of transactions (reconciliation) and webhook signatures. Paystack today; the interface keeps the
 * provider replaceable (Hubtel, Flutterwave). Amounts are minor units; the server always decides
 * them from the invoice.
 */
export interface IPaymentGateway {
  readonly provider: string;

  /** A hosted checkout page for one transaction. */
  initializeCheckout(request: CheckoutRequest): Promise<Readonly<{ checkoutUrl: string }>>;
  /** What the provider says about a transaction (never trust a webhook payload alone). */
  verify(reference: string): Promise<GatewayTransaction>;
  /** Charges a saved card authorization. */
  chargeAuthorization(request: AuthorizationCharge): Promise<GatewayTransaction>;
  /** Sends a mobile money approval prompt (or asks for a voucher / OTP). */
  chargeMobileMoney(request: MobileMoneyCharge): Promise<MobileMoneyResult>;
  /** Completes a mobile money charge that asked for an OTP or voucher. */
  submitOtp(reference: string, otp: string): Promise<MobileMoneyResult>;
  refund(
    request: Readonly<{ reference: string; amountMinor: number; note: string }>,
  ): Promise<Readonly<{ providerRefundId: string; status: "pending" | "processed" | "failed" }>>;
  /** The provider's successful transactions in [from, to) (reconciliation). */
  transactions(range: Readonly<{ from: Date; to: Date }>): Promise<readonly SettledTransaction[]>;
  /** True when the webhook body was signed by the provider. */
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean;
  /** The provider's webhook body in our terms (null: an event we do not use). */
  parseWebhook(payload: unknown): WebhookEvent | null;
}

export type CheckoutRequest = Readonly<{
  reference: string;
  amountMinor: number;
  currency: string;
  email: string;
  callbackUrl: string;
  /** Card, mobile money, bank transfer … (the provider's checkout offers these). */
  channels?: readonly ("card" | "mobile_money" | "bank_transfer")[];
  metadata: Readonly<Record<string, string>>;
}>;

export type AuthorizationCharge = Readonly<{
  reference: string;
  authorizationCode: string;
  email: string;
  amountMinor: number;
  currency: string;
  metadata: Readonly<Record<string, string>>;
}>;

export type MomoNetwork = "mtn" | "telecel" | "at";

export type MobileMoneyCharge = Readonly<{
  reference: string;
  phone: string;
  network: MomoNetwork;
  email: string;
  amountMinor: number;
  currency: string;
  metadata: Readonly<Record<string, string>>;
}>;

export type MobileMoneyResult = Readonly<{
  /** `prompt`: approve on the phone; `otp`: enter the code/voucher the network sent. */
  status: "prompt" | "otp" | "success" | "failed";
  message: string | null;
}>;

/** A saved, reusable card authorization (we keep the code sealed and the label only). */
export type GatewayAuthorization = Readonly<{
  code: string;
  label: string;
  reusable: boolean;
  expiresOn: string | null;
}>;

export type GatewayTransaction = Readonly<{
  reference: string;
  status: "success" | "pending" | "failed" | "abandoned";
  amountMinor: number;
  currency: string;
  paidAt: Date | null;
  channel: "card" | "mobile_money" | "bank_transfer" | "other" | null;
  providerTransactionId: string | null;
  feesMinor: number | null;
  authorization: GatewayAuthorization | null;
  /** The payer's MoMo number as the provider masks it ("024 *** 5521"). */
  mobileMoneyLabel: string | null;
  failureReason: string | null;
}>;

export type SettledTransaction = Readonly<{
  reference: string;
  amountMinor: number;
  currency: string;
  paidAt: Date;
  feesMinor: number | null;
}>;

export type WebhookEvent =
  | Readonly<{ kind: "charge"; key: string; type: string; reference: string }>
  | Readonly<{
      kind: "refund";
      key: string;
      type: string;
      /** The refunded transaction (refund events do not carry our refund's id). */
      transactionReference: string;
      status: "processed" | "failed" | "pending";
    }>;

/** The provider could not be reached or refused the request (502 to the caller). */
export class PaymentGatewayError extends ApplicationError {
  readonly code = "PAYMENT_GATEWAY_ERROR";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
