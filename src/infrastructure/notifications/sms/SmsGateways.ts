import { SmsProviderError } from "../../../application/errors/NotificationErrors.js";
import type { SmsResult } from "../../../application/ports/INotifications.js";
import { describe, HttpSmsGateway, msisdn, type SmsAccountInput } from "./HttpSmsGateway.js";

/**
 * Hubtel SMS (https://developers.hubtel.com): POST /v1/messages/send with Basic auth
 * (client id : client secret). Status 0 is accepted.
 */
export class HubtelSmsGateway extends HttpSmsGateway {
  readonly provider = "hubtel" as const;

  async send(account: SmsAccountInput, to: string, text: string): Promise<SmsResult> {
    const auth = Buffer.from(
      `${this.credential(account, "clientId")}:${this.credential(account, "clientSecret")}`,
    ).toString("base64");
    const body = await this.call("https://sms.hubtel.com/v1/messages/send", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ From: account.senderId, To: msisdn(to), Content: text }),
    });
    const status = body.status ?? body.Status;
    const messageId = body.messageId ?? body.MessageId;
    if ((status !== undefined && Number(status) !== 0) || typeof messageId !== "string")
      throw new SmsProviderError(`hubtel refused the message: ${describe(body)}`, true);
    return { messageId };
  }
}

/**
 * Arkesel SMS v2 (https://developers.arkesel.com): POST /api/v2/sms/send with the `api-key`
 * header; `status: "success"` with one entry per recipient.
 */
export class ArkeselSmsGateway extends HttpSmsGateway {
  readonly provider = "arkesel" as const;

  async send(account: SmsAccountInput, to: string, text: string): Promise<SmsResult> {
    const body = await this.call("https://sms.arkesel.com/api/v2/sms/send", {
      method: "POST",
      headers: {
        "api-key": this.credential(account, "apiKey"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sender: account.senderId, message: text, recipients: [msisdn(to)] }),
    });
    const data = Array.isArray(body.data) ? (body.data as { id?: unknown }[]) : [];
    if (body.status !== "success" || typeof data[0]?.id !== "string")
      throw new SmsProviderError(`arkesel refused the message: ${describe(body)}`, true);
    return { messageId: data[0].id };
  }
}

/**
 * mNotify Quick SMS (https://developer.mnotify.com): POST /api/sms/quick?key=…; code 2000 is
 * accepted, the campaign id identifies the message.
 */
export class MnotifySmsGateway extends HttpSmsGateway {
  readonly provider = "mnotify" as const;

  async send(account: SmsAccountInput, to: string, text: string): Promise<SmsResult> {
    const key = encodeURIComponent(this.credential(account, "apiKey"));
    const body = await this.call(`https://api.mnotify.com/api/sms/quick?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: [msisdn(to)],
        sender: account.senderId,
        message: text,
        is_schedule: false,
        schedule_date: "",
      }),
    });
    const summary = (body.summary ?? {}) as { _id?: unknown };
    if (String(body.code) !== "2000" || typeof summary._id !== "string")
      throw new SmsProviderError(`mnotify refused the message: ${describe(body)}`, true);
    return { messageId: summary._id };
  }
}
