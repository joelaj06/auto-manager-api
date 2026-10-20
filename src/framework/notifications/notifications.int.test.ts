import { randomUUID } from "node:crypto";
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
import type { ISecretBox } from "../../application/ports/ISecretBox.js";
import type { IUnitOfWork } from "../../application/ports/IUnitOfWork.js";
import type { ReminderRules } from "../../application/use-cases/notifications/ReminderRules.js";
import type { RemittanceScheduler } from "../../application/use-cases/remittances/RemittanceScheduler.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/** Records what would have gone to the provider; numbers ending in 999 are refused. */
class FakeArkesel implements ISmsGateway {
  readonly provider = "arkesel" as const;
  readonly sent: { to: string; text: string; senderId: string; apiKey: string }[] = [];

  send(account: Parameters<ISmsGateway["send"]>[0], to: string, text: string) {
    if (to.endsWith("999"))
      return Promise.reject(new SmsProviderError("arkesel refused: invalid number", true));
    this.sent.push({ to, text, senderId: account.senderId, apiKey: account.credentials.apiKey! });
    return Promise.resolve({ messageId: `ark-${this.sent.length}` });
  }
}

let container: Container;
let app: Express;
let t: ProvisionedTenant;
const gateway = new FakeArkesel();

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const today = day(0);

const inTenant = <T>(work: () => Promise<T>) => t.tenant.run(work);
const rules = () => container.get<ReminderRules>(TYPES.ReminderRules);
const sendAll = () =>
  inTenant(() =>
    container
      .get<IJobHandler[]>(TYPES.NotificationJobHandlers)
      .find((h) => h.job === "notifications.send")!
      .handle({ tenantId: t.tenantId }, { jobId: "test", attempt: 1 }),
  );

async function activeDriver(phone: string, licenceExpiresOn: string): Promise<string> {
  const created = await api()
    .post("/api/v1/drivers")
    .set(owner())
    .send({
      firstName: "Kofi",
      lastName: `Boateng${digits(3)}`,
      phone,
      ghanaCardNumber: `GHA-${digits(9)}-1`,
      licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
      licenceClass: "B",
      licenceExpiresOn,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  await api()
    .post(`/api/v1/drivers/${id}/guarantors`)
    .set(owner())
    .send({ name: "Yaw", phone: `020${digits(7)}` });
  await api().post(`/api/v1/drivers/${id}/activate`).set(owner()).send({});
  return id;
}

const vehicle = async () =>
  (
    await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Toyota", model: "Yaris", plateNumber: `GR ${digits(4)}-26`, odometer: 500 })
  ).body.data.id as string;

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  container.rebind<ISmsGateway[]>(TYPES.SmsGateways).toConstantValue([gateway]);
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("notification settings", () => {
  it("starts with the standard rules and no SMS provider", async () => {
    const res = await api().get("/api/v1/settings/notifications").set(owner());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      sms: null,
      quietHours: { start: "21:00", end: "07:00" },
      remittanceCutoff: "20:00",
    });
    const licence = (res.body.data.rules as { key: string }[]).find(
      (r) => r.key === "driver_licence_expiry",
    );
    expect(licence).toMatchObject({ enabled: true, daysBefore: [60, 30, 7, 0] });
  });

  it("seals the provider credentials and never returns them", async () => {
    const missing = await api()
      .put("/api/v1/settings/notifications/sms")
      .set(owner())
      .send({ provider: "arkesel", senderId: "AutoFleet", credentials: {} });
    expect([missing.status, missing.body.error.code]).toEqual([422, "NOTIFICATION_RULE"]);

    const res = await api()
      .put("/api/v1/settings/notifications/sms")
      .set(owner())
      .send({
        provider: "arkesel",
        senderId: "AutoFleet",
        credentials: { apiKey: "secret-key-1" },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.sms).toMatchObject({ provider: "arkesel", senderId: "AutoFleet" });
    expect(JSON.stringify(res.body)).not.toContain("secret-key-1");

    const stored = await inTenant(() =>
      container
        .get<IUnitOfWork>(TYPES.UnitOfWork)
        .run(() =>
          container.get<INotificationSettingsStore>(TYPES.NotificationSettingsStore).get(),
        ),
    );
    expect(stored.sms!.sealedCredentials).not.toContain("secret-key-1");
    expect(
      container.get<ISecretBox>(TYPES.CredentialsSecretBox).open(stored.sms!.sealedCredentials),
    ).toBe('{"apiKey":"secret-key-1"}');
  });

  it("checks rules against what they allow", async () => {
    const wrong = await api()
      .patch("/api/v1/settings/notifications")
      .set(owner())
      .send({ rules: { driver_licence_expiry: { smsTemplate: "Hi {{name}}" } } });
    expect(wrong.body.error.message).toMatch(/Unknown placeholder \{\{name\}\}/);
    const channel = await api()
      .patch("/api/v1/settings/notifications")
      .set(owner())
      .send({ rules: { budget_threshold: { channels: ["sms"] } } });
    expect(channel.body.error.message).toMatch(/cannot use the sms channel/);

    const res = await api()
      .patch("/api/v1/settings/notifications")
      .set(owner())
      .send({
        quietHours: null,
        rules: {
          driver_licence_expiry: {
            smsTemplate:
              "{{driverName}}, renew your licence before {{expiresOn}}. {{businessName}}",
          },
          remittance_due: { enabled: true },
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.quietHours).toBeNull();
  });

  it("sends a test SMS through the account and logs it", async () => {
    const res = await api()
      .post("/api/v1/settings/notifications/sms/test")
      .set(owner())
      .send({ to: "+233241112223" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ status: "sent", provider: "arkesel" });
    expect(gateway.sent.at(-1)).toMatchObject({
      to: "+233241112223",
      senderId: "AutoFleet",
      apiKey: "secret-key-1",
    });

    const refused = await api()
      .post("/api/v1/settings/notifications/sms/test")
      .set(owner())
      .send({ to: "+233241112999" });
    expect([refused.status, refused.body.error.code]).toEqual([502, "SMS_PROVIDER_FAILED"]);
    const log = await api().get("/api/v1/notification-deliveries?channel=sms").set(owner());
    expect((log.body.data as { status: string }[]).slice(0, 2).map((d) => d.status)).toEqual([
      "failed",
      "sent",
    ]);
  });
});

describe("reminders", () => {
  let phone: string;
  let late: string;
  let latePhone: string;

  beforeAll(async () => {
    phone = `+23324${digits(7)}`;
    await activeDriver(phone, day(7));
    const car = await vehicle();
    const doc = await api()
      .post(`/api/v1/vehicles/${car}/documents`)
      .set(owner())
      .send({ type: "insurance", number: "POL-1", expiresOn: day(3) });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);

    // A driver on a daily target who has paid nothing today.
    latePhone = `+23320${digits(7)}`;
    late = await activeDriver(latePhone, "2031-01-01");
    const other = await vehicle();
    const settings = await api().get("/api/v1/settings/assignments").set(owner());
    const assigned = await api()
      .post(`/api/v1/vehicles/${other}/assignment`)
      .set(owner())
      .send({
        driverId: late,
        odometer: 500,
        checklist: {
          items: (settings.body.data.handoverItems as { key: string }[]).map((i) => ({
            key: i.key,
            ok: true,
          })),
        },
        terms: { mode: "fixed_target", target: "200.00", frequency: "daily" },
      });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
    await inTenant(() => container.get<RemittanceScheduler>(TYPES.RemittanceScheduler).run(today));
    await api()
      .post("/api/v1/me/push-devices")
      .set(owner())
      .send({ token: `fcm-token-${randomUUID()}`, platform: "android" });
  });

  it("reminds staff and drivers once, on their channels", async () => {
    await inTenant(() => rules().morning(today));
    await inTenant(() => rules().morning(today)); // a repeated run adds nothing
    await sendAll();

    const toDriver = gateway.sent.filter((m) => m.to === phone);
    expect(toDriver).toHaveLength(1);
    expect(toDriver[0]!.text).toMatch(/^Kofi Boateng\d{3}, renew your licence before \d{4}-/);
    const due = gateway.sent.filter((m) => m.to === latePhone);
    expect(due.map((m) => m.text)).toEqual([expect.stringMatching(/GHS 200\.00 .* due today/)]);

    const inbox = await api().get("/api/v1/notifications").set(owner());
    const titles = (inbox.body.data as { title: string }[]).map((n) => n.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Insurance expires in 3 days$/),
        expect.stringMatching(/driving licence expires in 7 days$/),
      ]),
    );
    expect(inbox.body.meta.unread).toBe(titles.length);

    const push = await api()
      .get("/api/v1/notification-deliveries?channel=push&status=sent")
      .set(owner());
    expect(push.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("flags today's unpaid remittances at the cut-off", async () => {
    await inTenant(() => rules().cutoff(today));
    await sendAll();
    expect(gateway.sent.filter((m) => m.to === latePhone).at(-1)!.text).toMatch(
      /have not received your remittance of GHS 200\.00/,
    );
    const inbox = await api().get("/api/v1/notifications?unreadOnly=true").set(owner());
    expect(inbox.body.data[0]).toMatchObject({
      rule: "remittance_cutoff",
      title: "1 driver has not remitted today",
      severity: "warning",
    });
  });

  it("marks notifications read", async () => {
    const page = await api().get("/api/v1/notifications?limit=1").set(owner());
    expect(page.body.meta.nextCursor).not.toBeNull();
    const one = await api()
      .post("/api/v1/notifications/read")
      .set(owner())
      .send({ ids: [page.body.data[0].id] });
    expect(one.body.data.unread).toBe(page.body.meta.unread - 1);
    const all = await api().post("/api/v1/notifications/read").set(owner()).send({});
    expect(all.body.data.unread).toBe(0);
    const count = await api().get("/api/v1/notifications/unread-count").set(owner());
    expect(count.body.data.unread).toBe(0);
  });

  it("skips SMS once the provider is removed", async () => {
    await api().delete("/api/v1/settings/notifications/sms").set(owner());
    const before = gateway.sent.length;
    const fresh = await activeDriver(`+23327${digits(7)}`, day(0));
    await inTenant(() => rules().morning(today));
    await sendAll();
    expect(gateway.sent.length).toBe(before);
    const log = await api()
      .get(`/api/v1/notification-deliveries?recipientId=${fresh}`)
      .set(owner());
    expect(log.body.data).toEqual([]);
  });
});
