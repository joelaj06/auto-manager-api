import { createTransport, type Transporter } from "nodemailer";
import type { EmailMessage, IEmailSender } from "../../application/ports/IEmailSender.js";

export type SmtpSettings = Readonly<{
  host: string;
  port: number;
  /** TLS from the first byte (port 465). Otherwise STARTTLS is used when the server offers it. */
  secure: boolean;
  user: string | undefined;
  password: string | undefined;
  from: string;
}>;

/**
 * Email over SMTP: Mailpit locally (http://localhost:8025 shows what was sent), the chosen
 * provider's SMTP relay in production.
 */
export class SmtpEmailSender implements IEmailSender {
  private readonly transport: Transporter;

  constructor(private readonly settings: SmtpSettings) {
    this.transport = createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      ...(settings.user === undefined
        ? {}
        : { auth: { user: settings.user, pass: settings.password ?? "" } }),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  async send(message: EmailMessage): Promise<string> {
    const info = await this.transport.sendMail({
      from: this.settings.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: { "X-Autoforce-Delivery-Id": message.deliveryId },
    });
    return info.messageId;
  }

  close(): void {
    this.transport.close();
  }
}
