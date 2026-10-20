import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SmsProviderError } from "../../application/errors/NotificationErrors.js";
import { FcmPushSender } from "./push/FcmPushSender.js";
import { ArkeselSmsGateway, HubtelSmsGateway, MnotifySmsGateway } from "./sms/SmsGateways.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = (...responses: (Response | Error)[]) => {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses)
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  return fn;
};
const bodyOf = (fn: ReturnType<typeof fakeFetch>, call = 0) =>
  JSON.parse(fn.mock.calls[call]![1]!.body as string) as Record<string, unknown>;

describe("SMS providers", () => {
  it("Hubtel: basic auth, international number without plus", async () => {
    const fetchImpl = fakeFetch(json(201, { messageId: "h-1", status: 0, rate: 0.03 }));
    const result = await new HubtelSmsGateway(fetchImpl).send(
      { senderId: "AutoFleet", credentials: { clientId: "id", clientSecret: "secret" } },
      "+233241234567",
      "Hello",
    );
    expect(result).toEqual({ messageId: "h-1" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://sms.hubtel.com/v1/messages/send");
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("id:secret").toString("base64")}`,
    );
    expect(bodyOf(fetchImpl)).toEqual({ From: "AutoFleet", To: "233241234567", Content: "Hello" });
  });

  it("Arkesel: api-key header and recipients list", async () => {
    const fetchImpl = fakeFetch(
      json(200, { status: "success", data: [{ recipient: "233241234567", id: "a-1" }] }),
    );
    const result = await new ArkeselSmsGateway(fetchImpl).send(
      { senderId: "AutoFleet", credentials: { apiKey: "k" } },
      "+233241234567",
      "Hello",
    );
    expect(result).toEqual({ messageId: "a-1" });
    expect((fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>)["api-key"]).toBe("k");
    expect(bodyOf(fetchImpl)).toEqual({
      sender: "AutoFleet",
      message: "Hello",
      recipients: ["233241234567"],
    });
  });

  it("mNotify: key in the query, code 2000 accepted", async () => {
    const fetchImpl = fakeFetch(
      json(200, { status: "success", code: "2000", summary: { _id: "m-1" } }),
    );
    const result = await new MnotifySmsGateway(fetchImpl).send(
      { senderId: "AutoFleet", credentials: { apiKey: "k&1" } },
      "+233241234567",
      "Hello",
    );
    expect(result).toEqual({ messageId: "m-1" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.mnotify.com/api/sms/quick?key=k%261");
    expect(bodyOf(fetchImpl)).toMatchObject({ recipient: ["233241234567"], sender: "AutoFleet" });
  });

  it("separate failures to retry from permanent ones", async () => {
    const account = { senderId: "AutoFleet", credentials: { apiKey: "k" } };
    const fail = (response: Response | Error): Promise<SmsProviderError> =>
      new ArkeselSmsGateway(fakeFetch(response)).send(account, "+233241234567", "Hi").then(
        () => {
          throw new Error("expected a refusal");
        },
        (e: unknown) => e as SmsProviderError,
      );
    expect((await fail(json(401, { message: "Invalid API key" }))).permanent).toBe(true);
    expect((await fail(json(503, {}))).permanent).toBe(false);
    expect((await fail(new TypeError("fetch failed"))).permanent).toBe(false);
    expect(
      (await fail(json(200, { status: "error", message: "Insufficient balance" }))).message,
    ).toMatch(/Insufficient balance/);
    await expect(
      new ArkeselSmsGateway(fakeFetch()).send(
        { senderId: "AutoFleet", credentials: {} },
        "+233241234567",
        "Hi",
      ),
    ).rejects.toThrow(/missing apiKey/);
  });
});

describe("FCM push", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = {
    project_id: "autoforce-test",
    client_email: "push@autoforce-test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  const message = { title: "Insurance expires", body: "GR 1234-26", data: { vehicleId: "v1" } };

  it("signs in once, sends per device and reports unregistered tokens", async () => {
    const fetchImpl = fakeFetch(
      json(200, { access_token: "at-1", expires_in: 3600 }),
      json(200, { name: "projects/x/messages/1" }),
      json(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }),
      json(200, { name: "projects/x/messages/2" }),
    );
    const sender = new FcmPushSender(account, fetchImpl, () => 1_000_000);
    expect(await sender.send(["t1", "t2"], message)).toEqual({ invalid: ["t2"] });
    expect(await sender.send(["t1"], message)).toEqual({ invalid: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(4); // the token is reused
    const assertion = (fetchImpl.mock.calls[0]![1]!.body as URLSearchParams).get("assertion")!;
    expect(JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString())).toMatchObject(
      { iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging" },
    );
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      "https://fcm.googleapis.com/v1/projects/autoforce-test/messages:send",
    );
    expect(bodyOf(fetchImpl, 1)).toEqual({
      message: {
        token: "t1",
        notification: { title: message.title, body: message.body },
        data: message.data,
      },
    });
  });

  it("fails so the job retries when no device got it", async () => {
    const fetchImpl = fakeFetch(
      json(200, { access_token: "at-1", expires_in: 3600 }),
      json(500, { error: { status: "INTERNAL" } }),
    );
    await expect(new FcmPushSender(account, fetchImpl).send(["t1"], message)).rejects.toThrow(
      /HTTP 500/,
    );
  });
});
