import { createHmac, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SmsProviderError } from "../../application/errors/NotificationErrors.js";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type {
  INotificationSettingsStore,
  ISmsGateway,
} from "../../application/ports/INotifications.js";
import type { IUnitOfWork } from "../../application/ports/IUnitOfWork.js";
import type { IWhatsAppGateway, WhatsAppMessage } from "../../application/ports/IWhatsApp.js";
import type { Notifier } from "../../application/use-cases/notifications/Notifier.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

class FakeWhatsApp implements IWhatsAppGateway {
  readonly sent: { to: string; message: WhatsAppMessage; accessToken: string }[] = [];

  send(account: Parameters<IWhatsAppGateway["send"]>[0], to: string, message: WhatsAppMessage) {
    if (to.endsWith("999"))
      return Promise.reject(new SmsProviderError("WhatsApp refused: bad template", true));
    this.sent.push({ to, message, accessToken: account.accessToken });
    return Promise.resolve({ messageId: `wamid.${randomUUID()}` });
  }
}

class FakeSms implements ISmsGateway {
  readonly provider = "arkesel" as const;
  readonly sent: { to: string; text: string }[] = [];

  send(_account: Parameters<ISmsGateway["send"]>[0], to: string, text: string) {
    this.sent.push({ to, text });
    return Promise.resolve({ messageId: `ark-${this.sent.length}` });
  }
}

const APP_SECRET = "app-secret-app-secret";
const VERIFY_TOKEN = "verify-token-verify-token";
const RULE = "driver_licence_expiry" as const;

let container: Container;
let app: Express;
let t: ProvisionedTenant;
const whatsapp = new FakeWhatsApp();
const sms = new FakeSms();

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const phone = () => `+23324${String(Math.floor(Math.random() * 10 ** 6)).padStart(6, "0")}1`;
const inTenant = <T>(work: () => Promise<T>) => t.tenant.run(work);
const sendDue = () =>
  inTenant(() =>
    container
      .get<IJobHandler[]>(TYPES.NotificationJobHandlers)
      .find((h) => h.job === "notifications.send")!
      .handle({ tenantId: t.tenantId }, { jobId: "test", attempt: 1 }),
  );
async function queue(to: string, key: string, sensitive = false): Promise<boolean> {
  return inTenant(async () => {
    const settingsStore = container.get<INotificationSettingsStore>(
      TYPES.NotificationSettingsStore,
    );
    const notifier = container.get<Notifier>(TYPES.Notifier);
    const unitOfWork = container.get<IUnitOfWork>(TYPES.UnitOfWork);
    return unitOfWork.run(async () =>
      notifier.sms(await settingsStore.get(), "Africa/Accra", {
        rule: RULE,
        driverId: randomUUID(),
        phone: to,
        dedupeKey: key,
        standardText: "{{driverName}}, your licence expires on {{expiresOn}}.",
        values: { driverName: "Kofi", expiresOn: "2026-12-01", businessName: "Acme" },
        ...(sensitive ? { sensitive } : {}),
      }),
    );
  });
}

const log = async (address: string) =>
  (
    (await api().get("/api/v1/notification-deliveries?pageSize=100").set(owner())).body.data as {
      address: string;
      channel: string;
      status: string;
      id: string;
    }[]
  ).filter((d) => d.address === address);

const webhook = (payload: object, secret = APP_SECRET) => {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return api()
    .post(`/api/v1/webhooks/whatsapp/${t.slug}`)
    .set({ "Content-Type": "application/json", "X-Hub-Signature-256": signature })
    .send(raw);
};
const value = (v: object) => ({ entry: [{ changes: [{ value: v }] }] });

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  container.rebind<ISmsGateway[]>(TYPES.SmsGateways).toConstantValue([sms]);
  container.rebind<IWhatsAppGateway>(TYPES.WhatsAppGateway).toConstantValue(whatsapp);
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  await api().patch("/api/v1/settings/notifications").set(owner()).send({ quietHours: null });
  await api()
    .put("/api/v1/settings/notifications/sms")
    .set(owner())
    .send({ provider: "arkesel", senderId: "ACME", credentials: { apiKey: "key" } });
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("the WhatsApp account", () => {
  it("is set up with its credentials kept out of every answer", async () => {
    const res = await api().put("/api/v1/settings/notifications/whatsapp").set(owner()).send({
      phoneNumberId: "1234567890",
      displayNumber: "+233200000001",
      accessToken: "access-token-access-token",
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.whatsapp).toMatchObject({ displayNumber: "+233200000001" });
    expect(res.body.data.whatsapp.webhookUrl).toContain(`/api/v1/webhooks/whatsapp/${t.slug}`);
    expect(JSON.stringify(res.body)).not.toContain("access-token");
    expect(JSON.stringify(res.body)).not.toContain(APP_SECRET);
  });

  it("will not take the channel without an approved template", async () => {
    const res = await api()
      .patch("/api/v1/settings/notifications")
      .set(owner())
      .send({ rules: { [RULE]: { channels: ["in_app", "sms", "whatsapp"] } } });
    expect(res.status).toBe(422);
  });

  it("offers the channel only on rules that text a person", async () => {
    const res = await api()
      .patch("/api/v1/settings/notifications")
      .set(owner())
      .send({ rules: { budget_threshold: { channels: ["whatsapp"] } } });
    expect(res.status).toBe(422);
  });

  it("takes a template whose parameters are the rule's placeholders", async () => {
    const bad = await api()
      .patch("/api/v1/settings/notifications")
      .set(owner())
      .send({
        rules: {
          [RULE]: {
            channels: ["in_app", "sms", "whatsapp"],
            whatsappTemplate: { name: "licence_expiry", language: "en", parameters: ["nope"] },
          },
        },
      });
    expect(bad.status).toBe(422);
    const res = await api()
      .patch("/api/v1/settings/notifications")
      .set(owner())
      .send({
        rules: {
          [RULE]: {
            channels: ["in_app", "sms", "whatsapp"],
            whatsappTemplate: {
              name: "licence_expiry",
              language: "en",
              parameters: ["driverName", "expiresOn"],
            },
          },
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("answers Meta's handshake only with the business's verify token", async () => {
    const challenge = await api().get(`/api/v1/webhooks/whatsapp/${t.slug}`).query({
      "hub.mode": "subscribe",
      "hub.verify_token": VERIFY_TOKEN,
      "hub.challenge": "12345",
    });
    expect(challenge.status).toBe(200);
    expect(challenge.text).toBe("12345");
    const wrong = await api()
      .get(`/api/v1/webhooks/whatsapp/${t.slug}`)
      .query({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" });
    expect(wrong.status).toBe(401);
  });
});

describe("sending", () => {
  it("sends the approved template instead of the SMS", async () => {
    const to = phone();
    expect(await queue(to, `a:${to}`)).toBe(true);
    await sendDue();
    expect(whatsapp.sent.find((s) => s.to === to)).toEqual({
      to,
      accessToken: "access-token-access-token",
      message: {
        template: "licence_expiry",
        language: "en",
        parameters: ["Kofi", "2026-12-01"],
      },
    });
    expect(sms.sent.some((s) => s.to === to)).toBe(false);
    expect(await log(to)).toMatchObject([{ channel: "whatsapp", status: "sent" }]);
  });

  it("keeps a message with a one-time link on SMS", async () => {
    const to = phone();
    await queue(to, `b:${to}`, true);
    await sendDue();
    expect(whatsapp.sent.some((s) => s.to === to)).toBe(false);
    expect(sms.sent.some((s) => s.to === to)).toBe(true);
  });

  it("sends by SMS when WhatsApp refuses for good", async () => {
    const to = "+233241234999";
    await queue(to, `c:${randomUUID()}`);
    await sendDue();
    await sendDue();
    expect((await log(to)).map((d) => `${d.channel} ${d.status}`).sort()).toEqual([
      "sms sent",
      "whatsapp failed",
    ]);
  });
});

describe("what Meta tells us", () => {
  const sentTo = async (to: string) => {
    await queue(to, `d:${to}`);
    await sendDue();
    const [delivery] = await log(to);
    const full = (await api().get("/api/v1/notification-deliveries?pageSize=100").set(owner())).body
      .data as { id: string; providerMessageId: string; providerStatus: string | null }[];
    return full.find((d) => d.id === delivery!.id)!.providerMessageId;
  };
  const statusOf = async (to: string) => {
    const [delivery] = await log(to);
    return delivery as unknown as { providerStatus: string | null; status: string };
  };

  it("refuses a call without the business's signature", async () => {
    const res = await webhook(value({ statuses: [] }), "somebody-elses-secret");
    expect(res.status).toBe(401);
  });

  it("records delivered and read, whatever order they arrive in", async () => {
    const to = phone();
    const id = await sentTo(to);
    const status = (s: string, timestamp: number) =>
      webhook(value({ statuses: [{ id, status: s, timestamp: String(timestamp) }] }));
    expect((await status("read", 1_900_000_100)).status).toBe(200);
    await status("delivered", 1_900_000_000);
    expect((await statusOf(to)).providerStatus).toBe("read");
  });

  it("sends by SMS when the number is not on WhatsApp", async () => {
    const to = phone();
    const id = await sentTo(to);
    await webhook(
      value({
        statuses: [
          {
            id,
            status: "failed",
            timestamp: "1900000000",
            errors: [{ code: 131026, title: "Message undeliverable" }],
          },
        ],
      }),
    );
    await sendDue();
    expect((await log(to)).map((d) => `${d.channel} ${d.status}`).sort()).toEqual([
      "sms sent",
      "whatsapp failed",
    ]);
  });

  it("keeps someone who replied STOP off WhatsApp until START", async () => {
    const to = phone();
    const from = to.slice(1);
    await webhook(value({ messages: [{ from, text: { body: "stop" } }] }));
    await queue(to, `e:${to}`);
    await sendDue();
    await sendDue();
    expect(whatsapp.sent.some((s) => s.to === to)).toBe(false);
    expect(sms.sent.some((s) => s.to === to)).toBe(true);
    await webhook(value({ messages: [{ from, text: { body: "START" } }] }));
    await queue(to, `f:${to}`);
    await sendDue();
    expect(whatsapp.sent.some((s) => s.to === to)).toBe(true);
  });
});

describe("removing the account", () => {
  it("sends a queued message by SMS, and later ones go straight there", async () => {
    const to = phone();
    await queue(to, `g:${to}`);
    const res = await api().delete("/api/v1/settings/notifications/whatsapp").set(owner());
    expect(res.body.data.whatsapp).toBeNull();
    await sendDue();
    await sendDue();
    expect(sms.sent.some((s) => s.to === to)).toBe(true);
    const next = phone();
    await queue(next, `h:${next}`);
    expect(await log(next)).toMatchObject([{ channel: "sms" }]);
  });
});
