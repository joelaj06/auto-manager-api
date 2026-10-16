import type { RenderedEmail } from "../notifications/emailTemplates.js";

export type NewEmailDelivery = Readonly<{
  /** Same key → same delivery; a repeated request does not send twice. */
  idempotencyKey: string;
  tenantId: string | null;
  template: string;
  recipient: string;
  content: RenderedEmail;
}>;

export type EmailDelivery = Readonly<{
  id: string;
  status: "queued" | "sent" | "failed";
  recipient: string;
  attempts: number;
  /** Null once sent (content is purged). */
  content: RenderedEmail | null;
}>;

/** Platform email delivery records. */
export interface IEmailDeliveries {
  /**
   * Stores the delivery and enqueues its `email.send` job atomically. Returns the existing
   * delivery's id (and `created: false`) for a repeated idempotency key.
   */
  queue(delivery: NewEmailDelivery): Promise<Readonly<{ id: string; created: boolean }>>;
  find(id: string): Promise<EmailDelivery | null>;
  /** Marks sent and purges the rendered content. */
  markSent(id: string, providerMessageId: string, now: Date): Promise<void>;
  /** Counts the attempt; `final` marks the delivery failed for good. */
  markAttemptFailed(id: string, error: string, final: boolean): Promise<void>;
}
