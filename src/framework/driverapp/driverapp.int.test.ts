import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ISmsGateway } from "../../application/ports/INotifications.js";
import type { RemittanceScheduler } from "../../application/use-cases/remittances/RemittanceScheduler.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

class FakeSms implements ISmsGateway {
  readonly provider = "mnotify" as const;
  readonly sent: { to: string; text: string }[] = [];
  send(_account: Parameters<ISmsGateway["send"]>[0], to: string, text: string) {
    this.sent.push({ to, text });
    return Promise.resolve({ messageId: `m-${this.sent.length}` });
  }
}

let container: Container;
let app: Express;
let t: ProvisionedTenant;
const sms = new FakeSms();
let driver: string;
let phone: string;
let vehicle: string;
let driverToken: string;
let paymentId: string;

const PASSWORD = "driver app passphrase 1";
const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const asDriver = () => ({ Authorization: `Bearer ${driverToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const today = new Date().toISOString().slice(0, 10);
const pdf = (res: request.Response) => {
  expect(res.status, res.text).toBe(200);
  expect(res.headers["content-type"]).toBe("application/pdf");
  expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
};
const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => done(null, Buffer.concat(chunks)));
  });

async function activeDriver(driverPhone: string): Promise<string> {
  const created = await api()
    .post("/api/v1/drivers")
    .set(owner())
    .send({
      firstName: "Esi",
      lastName: "Asante",
      phone: driverPhone,
      ghanaCardNumber: `GHA-${digits(9)}-1`,
      licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
      licenceClass: "B",
      licenceExpiresOn: "2030-01-01",
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

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  container.rebind<ISmsGateway[]>(TYPES.SmsGateways).toConstantValue([sms]);
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  await api()
    .put("/api/v1/settings/notifications/sms")
    .set(owner())
    .send({ provider: "mnotify", senderId: "AutoFleet", credentials: { apiKey: "k" } });

  phone = `+23324${digits(7)}`;
  driver = await activeDriver(phone);
  vehicle = (
    await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({
        make: "Toyota",
        model: "Corolla",
        plateNumber: `GR ${digits(4)}-26`,
        odometer: 2_000,
      })
  ).body.data.id;
  const settings = await api().get("/api/v1/settings/assignments").set(owner());
  const assigned = await api()
    .post(`/api/v1/vehicles/${vehicle}/assignment`)
    .set(owner())
    .send({
      driverId: driver,
      odometer: 2_000,
      checklist: {
        items: (settings.body.data.handoverItems as { key: string }[]).map((i) => ({
          key: i.key,
          ok: true,
        })),
      },
      terms: { mode: "fixed_target", target: "300.00", frequency: "daily" },
    });
  expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
  await t.tenant.run(() =>
    container.get<RemittanceScheduler>(TYPES.RemittanceScheduler).run(today),
  );
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("driver app access", () => {
  it("invites the driver with a QR, an SMS that never shows in the log, and a link", async () => {
    const before = await api().get(`/api/v1/drivers/${driver}/app-access`).set(owner());
    expect(before.body.data).toMatchObject({ status: "none", userId: null });

    const granted = await api().post(`/api/v1/drivers/${driver}/app-access`).set(owner());
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body.data).toMatchObject({
      status: "invited",
      invitation: { sentBy: ["sms"], qrSvg: expect.stringContaining("<svg") },
    });

    const log = await api()
      .get(`/api/v1/notification-deliveries?recipientId=${driver}`)
      .set(owner());
    expect(log.body.data[0]).toMatchObject({ rule: "driver_invitation", status: "queued" });
    expect(log.body.data[0].body).toMatch(/hidden/);

    const token = /#token=([A-Za-z0-9_-]+)/.exec(
      granted.body.data.invitation.webUrl as string,
    )![1]!;
    const accepted = await api()
      .post("/api/v1/auth/invitations/accept")
      .set("X-Tenant", t.slug)
      .send({ token, password: PASSWORD });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    // The driver signs in with their phone number.
    const login = await api()
      .post("/api/v1/auth/login")
      .set("X-Tenant", t.slug)
      .send({ identifier: phone, password: PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    driverToken = login.body.data.accessToken as string;

    const again = await api().post(`/api/v1/drivers/${driver}/app-access`).set(owner());
    expect([again.status, again.body.error.code]).toEqual([409, "DRIVER_APP_ACCESS"]);
  });

  it("keeps the driver to their own records", async () => {
    expect((await api().get("/api/v1/drivers").set(asDriver())).status).toBe(403);
    // Staff roles never hold the driver app permission (it belongs to the Driver role).
    expect((await api().get("/api/v1/me/driver").set(owner())).status).toBe(403);
  });
});

describe("driver app", () => {
  it("shows the driver's vehicle, terms, balance and open remittances", async () => {
    const home = await api().get("/api/v1/me/driver").set(asDriver());
    expect(home.status, JSON.stringify(home.body)).toBe(200);
    expect(home.body.data).toMatchObject({
      driver: { id: driver, phone },
      assignment: {
        vehicle: { id: vehicle },
        terms: { mode: "fixed_target", target: { amountMinor: 30_000 }, frequency: "daily" },
      },
      openRemittances: [{ periodStart: today, status: "pending" }],
    });
    const car = await api().get("/api/v1/me/driver/vehicle").set(asDriver());
    expect(car.body.data).toMatchObject({ id: vehicle, odometer: 2_000 });
    expect(car.body.data.compliance.level).toEqual(expect.any(String));
  });

  it("declares a remittance that staff approve, with a receipt matching the books", async () => {
    const [row] = (await api().get("/api/v1/me/driver/remittances").set(asDriver())).body.data;
    const declared = await api()
      .post(`/api/v1/me/driver/remittances/${row.id}/submissions`)
      .set(asDriver())
      .send({ amount: "350.00", method: "momo", momoNetwork: "mtn", reference: "MTN-77" });
    expect(declared.status, JSON.stringify(declared.body)).toBe(201);
    const approved = await api()
      .post(
        `/api/v1/remittances/${row.id}/submissions/${declared.body.data.submissions[0].id}/approve`,
      )
      .set(owner())
      .send({});
    expect(approved.body.data.status).toBe("paid");

    const mine = await api().get(`/api/v1/me/driver/remittances/${row.id}`).set(asDriver());
    paymentId = mine.body.data.payments[0].paymentId as string;
    const receipt = await api().get(`/api/v1/payments/${paymentId}/receipt`).set(owner());
    expect(receipt.body.data).toMatchObject({
      amount: { amountMinor: 35_000 },
      momoNetwork: "mtn",
      appliedTo: [
        {
          description: expect.stringMatching(/^Remittance RMT-\d{4}-\d{6} for \d{4}-\d{2}-\d{2}$/),
          amount: { amountMinor: 30_000 },
        },
      ],
      credit: { amountMinor: 5_000 },
    });

    pdf(
      await binary(
        api().get(`/api/v1/me/driver/payments/${paymentId}/receipt.pdf`).set(asDriver()),
      ),
    );
    pdf(await binary(api().get(`/api/v1/payments/${paymentId}/receipt.pdf`).set(owner())));
    pdf(await binary(api().get("/api/v1/me/driver/ledger/statement.pdf").set(asDriver())));
    pdf(await binary(api().get(`/api/v1/drivers/${driver}/ledger/statement.pdf`).set(owner())));

    const ledger = await api().get("/api/v1/me/driver/ledger").set(asDriver());
    expect(ledger.body.data.closing.amountMinor).toBe(-5_000); // the excess is the driver's credit
  });

  it("does not hand out other people's receipts", async () => {
    const other = await activeDriver(`+23320${digits(7)}`);
    const paid = await api().post("/api/v1/payments").set(owner()).send({
      direction: "in",
      partyType: "driver",
      partyId: other,
      amount: "10.00",
      method: "bank_transfer",
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const res = await api()
      .get(`/api/v1/me/driver/payments/${paid.body.data.id}/receipt.pdf`)
      .set(asDriver());
    expect(res.status).toBe(404);
  });

  it("logs fuel paid by the driver as owed to them", async () => {
    const res = await api().post("/api/v1/me/driver/fuel").set(asDriver()).send({
      litres: "30",
      amount: "450.00",
      odometer: 2_180,
      station: "Goil",
      paidByDriver: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.expense).toMatchObject({
      payee: { type: "driver", id: driver },
      driverId: driver,
    });
    expect(res.body.data.log).toMatchObject({ vehicleId: vehicle, odometer: 2_180 });
  });

  it("reports an issue that reaches the fleet staff, who resolve it", async () => {
    const reported = await api()
      .post("/api/v1/me/driver/issues")
      .set(asDriver())
      .send({ type: "accident", description: "Minor knock at Kaneshie junction", canDrive: true });
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    expect(reported.body.data).toMatchObject({
      number: expect.stringMatching(/^ISS-\d{4}-\d{6}$/),
      severity: "high",
      status: "open",
      driverId: driver,
    });
    const id = reported.body.data.id as string;

    const upload = await api()
      .post(`/api/v1/me/driver/issues/${id}/photos`)
      .set(asDriver())
      .send({ filename: "dent.jpg", contentType: "image/jpeg", sizeBytes: 1_000 });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    expect(upload.body.data.upload.url).toEqual(expect.any(String));

    const inbox = await api().get("/api/v1/notifications").set(owner());
    expect(inbox.body.data[0]).toMatchObject({
      rule: "vehicle_issue_reported",
      severity: "critical",
      title: expect.stringMatching(/Accident reported$/),
    });

    const list = await api().get("/api/v1/vehicle-issues?status=open").set(owner());
    expect((list.body.data as { id: string }[]).map((i) => i.id)).toContain(id);
    await api().post(`/api/v1/vehicle-issues/${id}/acknowledge`).set(owner());
    const resolved = await api()
      .post(`/api/v1/vehicle-issues/${id}/resolve`)
      .set(owner())
      .send({ resolution: "Bumper replaced at the workshop" });
    expect(resolved.body.data).toMatchObject({ status: "resolved" });

    const mine = await api().get(`/api/v1/me/driver/issues/${id}`).set(asDriver());
    expect(mine.body.data).toMatchObject({ status: "resolved" });
    const late = await api()
      .post(`/api/v1/me/driver/issues/${id}/photos`)
      .set(asDriver())
      .send({ filename: "dent.jpg", contentType: "image/jpeg", sizeBytes: 1_000 });
    expect([late.status, late.body.error.code]).toEqual([422, "VEHICLE_ISSUE_RULE"]);
  });
});

describe("taking access away", () => {
  it("signs the driver out when staff revoke the login", async () => {
    const revoked = await api().delete(`/api/v1/drivers/${driver}/app-access`).set(owner());
    expect(revoked.body.data.status).toBe("disabled");
    expect((await api().get("/api/v1/me/driver").set(asDriver())).status).toBe(401);
  });

  it("disables the login of a terminated driver", async () => {
    const other = await activeDriver(`+23327${digits(7)}`);
    await api().post(`/api/v1/drivers/${other}/app-access`).set(owner());
    const terminated = await api()
      .post(`/api/v1/drivers/${other}/terminate`)
      .set(owner())
      .send({ reason: "Left the business" });
    expect(terminated.status, JSON.stringify(terminated.body)).toBe(200);
    const access = await api().get(`/api/v1/drivers/${other}/app-access`).set(owner());
    expect(access.body.data.status).toBe("disabled");
  });
});
