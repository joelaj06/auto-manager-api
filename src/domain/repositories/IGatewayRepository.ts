import type { AttemptStatus, PaymentAttempt } from "../billing/PaymentAttempt.js";

export type WebhookRecord = Readonly<{
  id: string;
  provider: string;
  eventKey: string | null;
  eventType: string | null;
  signatureValid: boolean;
  payload: unknown;
  receivedAt: Date;
  attempts: number;
  processedAt: Date | null;
  outcome: "applied" | "ignored" | "failed" | "rejected" | null;
  error: string | null;
}>;

export type RefundRecord = Readonly<{
  id: string;
  paymentId: string;
  invoiceId: string;
  tenantId: string;
  amountMinor: number;
  currency: string;
  reason: string;
  status: "pending" | "processed" | "failed";
  provider: string | null;
  providerRefundId: string | null;
  requestedBy: string;
  createdAt: Date;
  processedAt: Date | null;
}>;

export type ReconciliationRecord = Readonly<{
  id: string;
  provider: string;
  day: string;
  status: "matched" | "mismatched" | "failed";
  ourCount: number;
  ourMinor: number;
  providerCount: number;
  providerMinor: number;
  feesMinor: number;
  missingHere: readonly Readonly<Record<string, unknown>>[];
  missingThere: readonly Readonly<Record<string, unknown>>[];
  amountMismatches: readonly Readonly<Record<string, unknown>>[];
  error: string | null;
  ranAt: Date;
}>;

/** Gateway attempts, webhooks, refunds and reconciliations (platform unit of work). */
export interface IGatewayRepository {
  saveAttempt(attempt: PaymentAttempt): Promise<void>;
  attempt(reference: string, lock?: boolean): Promise<PaymentAttempt | null>;
  attempts(
    filter: Readonly<{
      status?: AttemptStatus;
      tenantId?: string;
      invoiceId?: string;
      limit: number;
    }>,
  ): Promise<PaymentAttempt[]>;
  /** Succeeded attempts completed in [from, to) (reconciliation). */
  succeededBetween(provider: string, from: Date, to: Date): Promise<PaymentAttempt[]>;

  /**
   * Stores a received webhook. A second delivery of the same event returns the first record
   * (`duplicate: true`).
   */
  receiveWebhook(
    event: Omit<
      WebhookRecord,
      "id" | "receivedAt" | "attempts" | "processedAt" | "outcome" | "error"
    >,
  ): Promise<Readonly<{ record: WebhookRecord; duplicate: boolean }>>;
  webhook(id: string, lock?: boolean): Promise<WebhookRecord | null>;
  finishWebhook(
    id: string,
    outcome: NonNullable<WebhookRecord["outcome"]>,
    error: string | null,
    now: Date,
  ): Promise<void>;
  webhooks(
    filter: Readonly<{ outcome?: WebhookRecord["outcome"]; before?: string; limit: number }>,
  ): Promise<WebhookRecord[]>;

  addRefund(refund: Omit<RefundRecord, "createdAt" | "processedAt">): Promise<void>;
  refund(id: string, lock?: boolean): Promise<RefundRecord | null>;
  /** The oldest pending refund of the payment made by this gateway reference. */
  pendingRefundFor(reference: string): Promise<RefundRecord | null>;
  finishRefund(id: string, status: "processed" | "failed", now: Date): Promise<void>;
  refunds(filter: Readonly<{ paymentId?: string; tenantId?: string }>): Promise<RefundRecord[]>;

  saveReconciliation(
    record: Omit<ReconciliationRecord, "id" | "ranAt">,
  ): Promise<ReconciliationRecord>;
  reconciliations(limit: number): Promise<ReconciliationRecord[]>;
}
