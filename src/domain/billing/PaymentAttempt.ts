import { DomainError } from "../errors/DomainError.js";

export type AttemptKind = "checkout" | "saved_card" | "mobile_money";
export type AttemptStatus = "pending" | "succeeded" | "failed" | "abandoned" | "review";
export type MomoNetwork = "mtn" | "telecel" | "at";

export type PaymentAttemptProps = Readonly<{
  id: string;
  reference: string;
  tenantId: string;
  invoiceId: string;
  provider: string;
  kind: AttemptKind;
  amountMinor: number;
  currency: string;
  status: AttemptStatus;
  paymentMethodId: string | null;
  /** Save the card or MoMo number once the payment succeeds. */
  saveMethod: boolean;
  momoPhone: string | null;
  momoNetwork: MomoNetwork | null;
  checkoutUrl: string | null;
  channel: string | null;
  providerTransactionId: string | null;
  feesMinor: number | null;
  failureReason: string | null;
  initiatedByType: "user" | "platform_staff" | "system";
  initiatedBy: string | null;
  createdAt: Date;
  completedAt: Date | null;
}>;

export class PaymentAttemptError extends DomainError {
  readonly code = "PAYMENT_ATTEMPT";
  constructor(message: string) {
    super(message);
  }
}

/** What the provider confirmed for the attempt. */
export type ProviderResult = Readonly<{
  amountMinor: number;
  currency: string;
  channel: string | null;
  providerTransactionId: string | null;
  feesMinor: number | null;
}>;

/**
 * One try at collecting an invoice through the gateway (docs/25 §4): pending until the provider
 * confirms. A success is accepted only for exactly the amount and currency asked — anything else
 * goes to review, never to the invoice (the server decides amounts, §9). Final states never
 * change, which makes webhooks and polling idempotent.
 */
export class PaymentAttempt {
  private constructor(private props: PaymentAttemptProps) {}

  static start(
    params: Omit<
      PaymentAttemptProps,
      | "status"
      | "checkoutUrl"
      | "channel"
      | "providerTransactionId"
      | "feesMinor"
      | "failureReason"
      | "completedAt"
    >,
  ): PaymentAttempt {
    if (!Number.isInteger(params.amountMinor) || params.amountMinor <= 0)
      throw new PaymentAttemptError("Nothing is left to pay on this invoice");
    return new PaymentAttempt({
      ...params,
      status: "pending",
      checkoutUrl: null,
      channel: null,
      providerTransactionId: null,
      feesMinor: null,
      failureReason: null,
      completedAt: null,
    });
  }

  static restore(props: PaymentAttemptProps): PaymentAttempt {
    return new PaymentAttempt(props);
  }

  get id(): string {
    return this.props.id;
  }
  get status(): AttemptStatus {
    return this.props.status;
  }
  get isFinal(): boolean {
    return this.props.status !== "pending";
  }

  checkoutOpened(url: string): void {
    this.props = { ...this.props, checkoutUrl: url };
  }

  /** True when the result matches what was asked (the payment can be applied). */
  succeeded(result: ProviderResult, now: Date): boolean {
    if (this.isFinal) return false;
    const matches =
      result.amountMinor === this.props.amountMinor && result.currency === this.props.currency;
    this.props = {
      ...this.props,
      status: matches ? "succeeded" : "review",
      channel: result.channel,
      providerTransactionId: result.providerTransactionId,
      feesMinor: result.feesMinor,
      failureReason: matches
        ? null
        : `Paid ${result.currency} ${result.amountMinor}, expected ${this.props.currency} ${this.props.amountMinor}`,
      completedAt: now,
    };
    return matches;
  }

  /** Money was taken but cannot be applied (the invoice was settled or voided meanwhile). */
  review(reason: string, now: Date): void {
    this.props = {
      ...this.props,
      status: "review",
      failureReason: reason.slice(0, 500),
      completedAt: now,
    };
  }

  failed(reason: string | null, now: Date, abandoned = false): void {
    if (this.isFinal) return;
    this.props = {
      ...this.props,
      status: abandoned ? "abandoned" : "failed",
      failureReason: reason?.slice(0, 500) ?? null,
      completedAt: now,
    };
  }

  snapshot(): PaymentAttemptProps {
    return this.props;
  }
}
