import { createHmac, timingSafeEqual } from "node:crypto";
import {
  PaymentGatewayError,
  type AuthorizationCharge,
  type CheckoutRequest,
  type GatewayTransaction,
  type IPaymentGateway,
  type MobileMoneyCharge,
  type MobileMoneyResult,
  type MomoNetwork,
  type SettledTransaction,
  type WebhookEvent,
} from "../../application/ports/IPaymentGateway.js";

type PaystackAuthorization = {
  authorization_code?: string;
  brand?: string;
  card_type?: string;
  last4?: string;
  exp_month?: string;
  exp_year?: string;
  reusable?: boolean;
  channel?: string;
  mobile_money_number?: string;
};

type PaystackTransaction = {
  id?: number;
  status?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  paid_at?: string | null;
  channel?: string;
  fees?: number | null;
  gateway_response?: string;
  authorization?: PaystackAuthorization | null;
  display_text?: string;
  message?: string;
};

/** Paystack's codes for the Ghana networks. */
const NETWORK: Readonly<Record<MomoNetwork, string>> = { mtn: "mtn", telecel: "vod", at: "atl" };
const TIMEOUT_MS = 15_000;

const channelOf = (channel: string | undefined): GatewayTransaction["channel"] =>
  channel === "card"
    ? "card"
    : channel === "mobile_money"
      ? "mobile_money"
      : channel === "bank" || channel === "bank_transfer"
        ? "bank_transfer"
        : channel === undefined
          ? null
          : "other";

const statusOf = (status: string | undefined): GatewayTransaction["status"] =>
  status === "success"
    ? "success"
    : status === "failed" || status === "reversed"
      ? "failed"
      : status === "abandoned"
        ? "abandoned"
        : "pending";

/**
 * Paystack (https://paystack.com/docs/api): hosted checkout (`transaction/initialize`),
 * verification, charges on saved authorizations, mobile money charges (`charge`, Ghana networks
 * MTN, Telecel, AT), refunds and the transaction list; webhooks are signed with HMAC-SHA512 of
 * the raw body using the secret key (`x-paystack-signature`). Amounts are in the currency's
 * minor unit (pesewas), as Paystack expects.
 */
export class PaystackGateway implements IPaymentGateway {
  readonly provider = "paystack";

  constructor(
    private readonly options: Readonly<{
      secretKey: string;
      baseUrl: string;
      fetch?: typeof fetch;
    }>,
  ) {}

  async initializeCheckout(r: CheckoutRequest) {
    const data = await this.call<{ authorization_url: string }>("POST", "/transaction/initialize", {
      email: r.email,
      amount: r.amountMinor,
      currency: r.currency,
      reference: r.reference,
      callback_url: r.callbackUrl,
      ...(r.channels === undefined
        ? {}
        : { channels: r.channels.map((c) => (c === "bank_transfer" ? "bank_transfer" : c)) }),
      metadata: r.metadata,
    });
    return { checkoutUrl: data.authorization_url };
  }

  async verify(reference: string): Promise<GatewayTransaction> {
    const data = await this.call<PaystackTransaction>(
      "GET",
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
    return this.transaction(data, reference);
  }

  async chargeAuthorization(r: AuthorizationCharge): Promise<GatewayTransaction> {
    const data = await this.call<PaystackTransaction>("POST", "/transaction/charge_authorization", {
      email: r.email,
      amount: r.amountMinor,
      currency: r.currency,
      authorization_code: r.authorizationCode,
      reference: r.reference,
      metadata: r.metadata,
    });
    return this.transaction(data, r.reference);
  }

  async chargeMobileMoney(r: MobileMoneyCharge): Promise<MobileMoneyResult> {
    const data = await this.call<PaystackTransaction>("POST", "/charge", {
      email: r.email,
      amount: r.amountMinor,
      currency: r.currency,
      reference: r.reference,
      mobile_money: { phone: r.phone, provider: NETWORK[r.network] },
      metadata: r.metadata,
    });
    return this.momo(data);
  }

  async submitOtp(reference: string, otp: string): Promise<MobileMoneyResult> {
    return this.momo(
      await this.call<PaystackTransaction>("POST", "/charge/submit_otp", { reference, otp }),
    );
  }

  async refund(r: Readonly<{ reference: string; amountMinor: number; note: string }>) {
    const data = await this.call<{ id: number; status: string }>("POST", "/refund", {
      transaction: r.reference,
      amount: r.amountMinor,
      merchant_note: r.note,
    });
    return {
      providerRefundId: String(data.id),
      status:
        data.status === "processed"
          ? ("processed" as const)
          : data.status === "failed"
            ? ("failed" as const)
            : ("pending" as const),
    };
  }

  async transactions(range: Readonly<{ from: Date; to: Date }>): Promise<SettledTransaction[]> {
    const settled: SettledTransaction[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const query = new URLSearchParams({
        status: "success",
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        perPage: "100",
        page: String(page),
      });
      const { data, meta } = await this.raw<PaystackTransaction[]>(
        "GET",
        `/transaction?${query.toString()}`,
      );
      for (const t of data)
        if (t.reference !== undefined && t.paid_at)
          settled.push({
            reference: t.reference,
            amountMinor: t.amount ?? 0,
            currency: t.currency ?? "GHS",
            paidAt: new Date(t.paid_at),
            feesMinor: t.fees ?? null,
          });
      if (page >= Number((meta as { pageCount?: number } | undefined)?.pageCount ?? 1)) break;
    }
    return settled;
  }

  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (signature === undefined || !/^[0-9a-f]{128}$/i.test(signature)) return false;
    const expected = createHmac("sha512", this.options.secretKey).update(rawBody).digest();
    return timingSafeEqual(expected, Buffer.from(signature, "hex"));
  }

  parseWebhook(payload: unknown): WebhookEvent | null {
    return parsePaystackWebhook(payload);
  }

  // --- helpers ---

  private transaction(t: PaystackTransaction, reference: string): GatewayTransaction {
    const auth = t.authorization ?? null;
    const card = auth !== null && auth.channel === "card" && auth.authorization_code !== undefined;
    return {
      reference: t.reference ?? reference,
      status: statusOf(t.status),
      amountMinor: t.amount ?? 0,
      currency: t.currency ?? "GHS",
      paidAt: t.paid_at ? new Date(t.paid_at) : null,
      channel: channelOf(t.channel),
      providerTransactionId: t.id === undefined ? null : String(t.id),
      feesMinor: t.fees ?? null,
      authorization: card
        ? {
            code: auth.authorization_code!,
            label: `${capitalise(auth.brand ?? auth.card_type ?? "Card")} •• ${auth.last4 ?? "????"}`,
            reusable: auth.reusable === true,
            expiresOn:
              auth.exp_year !== undefined && auth.exp_month !== undefined
                ? lastDayOf(Number(auth.exp_year), Number(auth.exp_month))
                : null,
          }
        : null,
      mobileMoneyLabel:
        auth?.mobile_money_number === undefined
          ? null
          : `MoMo •• ${auth.mobile_money_number.slice(-4)}`,
      failureReason: statusOf(t.status) === "failed" ? (t.gateway_response ?? null) : null,
    };
  }

  private momo(t: PaystackTransaction): MobileMoneyResult {
    const status =
      t.status === "pay_offline" || t.status === "pending"
        ? "prompt"
        : t.status === "send_otp" || t.status === "send_pin"
          ? "otp"
          : t.status === "success"
            ? "success"
            : "failed";
    return { status, message: t.display_text ?? t.message ?? t.gateway_response ?? null };
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
    return (await this.raw<T>(method, path, body)).data;
  }

  private async raw<T>(
    method: "GET" | "POST",
    path: string,
    body?: object,
  ): Promise<{ data: T; meta?: unknown }> {
    const fetcher = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetcher(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.secretKey}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new PaymentGatewayError("The payment provider could not be reached", { cause: error });
    }
    const json = (await response.json().catch(() => ({}))) as {
      status?: boolean;
      message?: string;
      data?: T;
      meta?: unknown;
    };
    if (!response.ok || json.status !== true || json.data === undefined)
      throw new PaymentGatewayError(
        `The payment provider refused the request: ${json.message ?? response.statusText}`,
      );
    return { data: json.data, meta: json.meta };
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function lastDayOf(year: number, month: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** Paystack webhook bodies in our terms (also what the fake gateway emits). */
export function parsePaystackWebhook(payload: unknown): WebhookEvent | null {
  const body = payload as { event?: string; data?: Record<string, unknown> };
  const type = body.event;
  const data = body.data ?? {};
  if (type === "charge.success" && typeof data.reference === "string")
    return {
      kind: "charge",
      type,
      key: `${type}:${typeof data.id === "number" || typeof data.id === "string" ? data.id : data.reference}`,
      reference: data.reference,
    };
  if (
    (type === "refund.processed" || type === "refund.failed" || type === "refund.pending") &&
    typeof data.transaction_reference === "string"
  )
    return {
      kind: "refund",
      type,
      key: `${type}:${data.transaction_reference}:${scalar(data.refund_reference) ?? scalar(data.amount) ?? ""}`,
      transactionReference: data.transaction_reference,
      status:
        type === "refund.processed" ? "processed" : type === "refund.failed" ? "failed" : "pending",
    };
  return null;
}

const scalar = (v: unknown): string | null =>
  typeof v === "string" || typeof v === "number" ? String(v) : null;
