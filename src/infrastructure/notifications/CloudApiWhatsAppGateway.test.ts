import { describe, expect, it } from "vitest";
import { SmsProviderError } from "../../application/errors/NotificationErrors.js";
import { CloudApiWhatsAppGateway } from "./CloudApiWhatsAppGateway.js";

const account = { phoneNumberId: "1234567", accessToken: "token-token-token-token" };
const message = { template: "payment_received", language: "en", parameters: ["Ama", ""] };
const fetching = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { calls, impl: impl as unknown as typeof fetch };
};

describe("CloudApiWhatsAppGateway", () => {
  it("sends the template to the number's id with the parameters in order", async () => {
    const { calls, impl } = fetching(200, { messages: [{ id: "wamid.1" }] });
    const sent = await new CloudApiWhatsAppGateway("https://graph.test/v1", impl).send(
      account,
      "+233241234567",
      message,
    );
    expect(sent).toEqual({ messageId: "wamid.1" });
    expect(calls[0]!.url).toBe("https://graph.test/v1/1234567/messages");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      messaging_product: "whatsapp",
      to: "233241234567",
      type: "template",
      template: {
        name: "payment_received",
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Ama" },
              { type: "text", text: "-" },
            ],
          },
        ],
      },
    });
  });

  it("leaves out the body when a template has no parameters", async () => {
    const { calls, impl } = fetching(200, { messages: [{ id: "wamid.2" }] });
    await new CloudApiWhatsAppGateway("https://graph.test/v1", impl).send(
      account,
      "+233241234567",
      {
        ...message,
        parameters: [],
      },
    );
    const sent = JSON.parse(calls[0]!.init.body as string) as { template: object };
    expect(sent.template).not.toHaveProperty("components");
  });

  it("does not retry a refusal retrying cannot fix", async () => {
    const { impl } = fetching(400, { error: { code: 132001, message: "Template missing" } });
    const failure = await new CloudApiWhatsAppGateway("https://graph.test/v1", impl)
      .send(account, "+233241234567", message)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SmsProviderError);
    expect((failure as SmsProviderError).permanent).toBe(true);
  });

  it("retries throttling, which Meta answers with a 400", async () => {
    const { impl } = fetching(400, { error: { code: 131056, message: "Pair rate limit" } });
    const failure = await new CloudApiWhatsAppGateway("https://graph.test/v1", impl)
      .send(account, "+233241234567", message)
      .catch((e: unknown) => e);
    expect((failure as SmsProviderError).permanent).toBe(false);
  });
});
