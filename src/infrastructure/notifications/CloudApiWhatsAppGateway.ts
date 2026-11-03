import { SmsProviderError } from "../../application/errors/NotificationErrors.js";
import type { IWhatsAppGateway, WhatsAppMessage } from "../../application/ports/IWhatsApp.js";

type Fetch = typeof fetch;

const TIMEOUT_MS = 15_000;
/** Cloud API throttling and temporary errors: worth another try. */
const RETRY = new Set([4, 80007, 130429, 131016, 131048, 131056, 133004]);

/**
 * WhatsApp Cloud API with the business's own account (decision 515). Only approved templates go
 * out: a parameter must not be empty, so a value that is missing goes as a dash.
 */
export class CloudApiWhatsAppGateway implements IWhatsAppGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async send(
    account: Parameters<IWhatsAppGateway["send"]>[0],
    to: string,
    message: WhatsAppMessage,
  ): Promise<Readonly<{ messageId: string }>> {
    const parameters = message.parameters.map((value) => ({
      type: "text",
      text: value.trim() === "" ? "-" : value,
    }));
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${account.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: to.replace(/^\+/, ""),
          type: "template",
          template: {
            name: message.template,
            language: { code: message.language },
            ...(parameters.length === 0 ? {} : { components: [{ type: "body", parameters }] }),
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new SmsProviderError(
        `WhatsApp could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
    const raw = await response.text();
    let body: { messages?: { id?: unknown }[]; error?: { code?: unknown; message?: unknown } };
    try {
      body = raw === "" ? {} : (JSON.parse(raw) as typeof body);
    } catch {
      body = { error: { message: raw.slice(0, 200) } };
    }
    if (!response.ok) {
      const code = Number(body.error?.code);
      const detail = typeof body.error?.message === "string" ? body.error.message : "no detail";
      throw new SmsProviderError(
        `WhatsApp refused the message (HTTP ${response.status}): ${detail}`,
        !(response.status >= 500 || response.status === 429 || RETRY.has(code)),
      );
    }
    const id = body.messages?.[0]?.id;
    if (typeof id !== "string" || id === "")
      throw new SmsProviderError("WhatsApp gave no message id", false);
    return { messageId: id };
  }
}
