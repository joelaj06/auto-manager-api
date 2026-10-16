export type EmailMessage = Readonly<{
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Sent as a header so provider logs can be matched to our delivery record. */
  deliveryId: string;
}>;

/** Hands one email to the provider (SMTP locally: Mailpit). */
export interface IEmailSender {
  /** Returns the provider's message id. Throws when the provider rejects or is unreachable. */
  send(message: EmailMessage): Promise<string>;
}
