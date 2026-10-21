import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { ISmsGateway } from "../../application/ports/INotifications.js";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { signaturePng } from "../../testing/fixtures/signaturePng.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

class FakeSms implements ISmsGateway {
  readonly provider = "arkesel" as const;
  readonly sent: { to: string; text: string }[] = [];
  send(_account: Parameters<ISmsGateway["send"]>[0], to: string, text: string) {
    this.sent.push({ to, text });
    return Promise.resolve({ messageId: `s-${this.sent.length}` });
  }
}

let container: Container;
let app: Express;
let t: ProvisionedTenant;
const sms = new FakeSms();
let driver: string;
let driverToken: string;
let vehicle: string;
let checklist: { items: { key: string; ok: boolean }[] };
const guarantorPhone = `+23320${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const asDriver = () => ({ Authorization: `Bearer ${driverToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const drawn = { type: "drawn", png: signaturePng() };

async function smsTo(phone: string): Promise<string> {
  const send = container
    .get<IJobHandler[]>(TYPES.NotificationJobHandlers)
    .find((h) => h.job === "notifications.send")!;
  await t.tenant.run(() => send.handle({ tenantId: t.tenantId }, { jobId: "j", attempt: 1 }));
  return sms.sent.filter((m) => m.to === phone).at(-1)!.text;
}

const terms = {
  vehicleValue: "60000.00",
  pricing: { kind: "multiplier", multiplier: "2" },
  deposit: "5000.00",
  frequency: "weekly",
  periods: 104,
  firstDueOn: day(7),
  roundTo: "1.00",
};

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  container.rebind<ISmsGateway[]>(TYPES.SmsGateways).toConstantValue([sms]);
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  await api()
    .put("/api/v1/settings/notifications/sms")
    .set(owner())
    .send({ provider: "arkesel", senderId: "AutoFleet", credentials: { apiKey: "k" } });
  await api().patch("/api/v1/settings/notifications").set(owner()).send({ quietHours: null });
  // Signing codes are covered by the signing tests.
  await api().patch("/api/v1/settings/documents").set(owner()).send({ requireOtp: false });

  driver = (
    await api()
      .post("/api/v1/drivers")
      .set(owner())
      .send({
        firstName: "Kojo",
        lastName: "Antwi",
        phone: `+23324${digits(7)}`,
        ghanaCardNumber: `GHA-${digits(9)}-1`,
        licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
        licenceClass: "B",
        licenceExpiresOn: "2030-01-01",
        employmentType: "workpay",
      })
  ).body.data.id as string;
  await api()
    .post(`/api/v1/drivers/${driver}/guarantors`)
    .set(owner())
    .send({ name: "Yaw", phone: `020${digits(7)}` });
  await api().post(`/api/v1/drivers/${driver}/activate`).set(owner()).send({});
  const access = await api().post(`/api/v1/drivers/${driver}/app-access`).set(owner());
  const token = /#token=([A-Za-z0-9_-]+)/.exec(access.body.data.invitation.webUrl as string)![1]!;
  driverToken = (
    await api()
      .post("/api/v1/auth/invitations/accept")
      .set("X-Tenant", t.slug)
      .send({ token, password: OWNER_PASSWORD })
  ).body.data.accessToken as string;

  vehicle = (
    await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({
        make: "Toyota",
        model: "Vitz",
        plateNumber: `GR ${digits(4)}-26`,
        odometer: 40_000,
        financials: { acquisitionCost: "58000.00", acquisitionDate: day(-30) },
      })
  ).body.data.id as string;
  const settings = await api().get("/api/v1/settings/assignments").set(owner());
  checklist = {
    items: (settings.body.data.handoverItems as { key: string }[]).map((i) => ({
      key: i.key,
      ok: true,
    })),
  };
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("work and pay", () => {
  let agreement: string;

  it("simulates terms from the vehicle's value", async () => {
    const res = await api()
      .post("/api/v1/workpay/simulate")
      .set(owner())
      .send({ vehicleId: vehicle, terms: { ...terms, vehicleValue: undefined } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      vehicleValue: { amountMinor: 5_800_000 },
      totalPrice: { amountMinor: 11_600_000 },
      deposit: { amountMinor: 500_000 },
      financed: { amountMinor: 11_100_000 },
      periods: 104,
      instalment: { amountMinor: 106_700 },
      lastInstalment: { amountMinor: 109_900 },
    });
    expect(res.body.data.schedule).toHaveLength(104);
  });

  it("drafts an agreement with a guarantor who signs", async () => {
    const res = await api()
      .post("/api/v1/workpay/agreements")
      .set(owner())
      .send({
        vehicleId: vehicle,
        driverId: driver,
        terms,
        guarantors: [
          { name: "Akua Mensah", phone: guarantorPhone, relationship: "Sister", signs: true },
        ],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      number: expect.stringMatching(/^WP-\d{4}-\d{6}$/),
      status: "draft",
      terms: { totalPrice: { amountMinor: 12_000_000 }, instalment: { amountMinor: 110_500 } },
      depositOutstanding: { amountMinor: 500_000 },
      graceDays: 3,
      maintenance: "driver",
      insurance: "owner",
    });
    agreement = res.body.data.id as string;
    const twice = await api()
      .post("/api/v1/workpay/agreements")
      .set(owner())
      .send({ vehicleId: vehicle, driverId: driver, terms });
    expect(twice.status, JSON.stringify(twice.body)).toBe(201); // drafts may compete …
    const revised = await api()
      .patch(`/api/v1/workpay/agreements/${agreement}`)
      .set(owner())
      .send({ graceDays: 2 });
    expect(revised.body.data.graceDays).toBe(2);
    await api()
      .post(`/api/v1/workpay/agreements/${twice.body.data.id}/cancel`)
      .set(owner())
      .send({ reason: "Duplicate" });
  });

  it("goes out for signature by the owner, the driver and the guarantor, freezing the terms", async () => {
    const sent = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/send-for-signature`)
      .set(owner())
      .send({});
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.data).toMatchObject({
      status: "awaiting_signatures",
      document: { number: expect.stringMatching(/^WPA-/), status: "pending_signatures" },
    });
    const frozen = await api()
      .patch(`/api/v1/workpay/agreements/${agreement}`)
      .set(owner())
      .send({ graceDays: 5 });
    expect(frozen.body.error.message).toMatch(/withdraw it/);
    const document = await api()
      .get(`/api/v1/documents/${sent.body.data.document.id}`)
      .set(owner());
    expect((document.body.data.signers as { role: string }[]).map((s) => s.role)).toEqual([
      "owner",
      "driver",
      "guarantor_1",
    ]);
    expect(document.body.data.data.schedule).toHaveLength(104);
  });

  it("starts only once signed and the deposit is paid", async () => {
    const early = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/activate`)
      .set(owner())
      .send({ odometer: 40_100, checklist });
    expect(early.body.error.message).toMatch(/not signed by everyone yet/);

    // The owner and the driver sign signed in, the guarantor by link.
    for (const as of [owner(), asDriver()]) {
      const [task] = (await api().get("/api/v1/me/signatures").set(as)).body.data as {
        signer: { id: string };
      }[];
      const signed = await api()
        .post(`/api/v1/me/signatures/${task!.signer.id}/sign`)
        .set(as)
        .send({ signature: drawn, consent: true });
      expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    }
    const token = /#token=([A-Za-z0-9_-]+)/.exec(await smsTo(guarantorPhone))![1]!;
    const guarantor = await api()
      .post("/api/v1/public/signing/sign")
      .set("X-Tenant", t.slug)
      .send({ token, signature: drawn, consent: true });
    expect(guarantor.body.data.document.status).toBe("fully_signed");

    const noDeposit = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/activate`)
      .set(owner())
      .send({ odometer: 40_100, checklist });
    expect(noDeposit.body.error.message).toMatch(/deposit has not been paid/);
    const deposit = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/deposit`)
      .set(owner())
      .send({ amount: "5000.00", method: "momo", momoNetwork: "mtn", reference: "DEP-1" });
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(200);
    expect(deposit.body.data.depositOutstanding.amountMinor).toBe(0);
    const payments = await api()
      .get(`/api/v1/payments?partyType=driver&partyId=${driver}`)
      .set(owner());
    const receipt = await api()
      .get(`/api/v1/payments/${(payments.body.data as { id: string }[])[0]!.id}/receipt`)
      .set(owner());
    expect(receipt.body.data.appliedTo[0]).toMatchObject({
      description: expect.stringMatching(/^Deposit, work and pay agreement WP-/),
      amount: { amountMinor: 500_000 },
    });

    const active = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/activate`)
      .set(owner())
      .send({ odometer: 40_100, checklist });
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body.data).toMatchObject({ status: "active", startedOn: day(0) });
    expect(active.body.data.schedule).toHaveLength(104);
    expect(active.body.data.schedule[0]).toMatchObject({
      number: 1,
      dueOn: day(7),
      amount: { amountMinor: 110_500 },
      status: "upcoming",
    });
    expect(active.body.data.schedule[103].amount.amountMinor).toBe(11_500_000 - 110_500 * 103);

    const car = await api().get(`/api/v1/vehicles/${vehicle}`).set(owner());
    expect(car.body.data.status).toBe("on_workpay");
    const mine = await api().get("/api/v1/me/driver/workpay").set(asDriver());
    expect(mine.body.data[0]).toMatchObject({ id: agreement, status: "active" });
  });

  it("keeps one live agreement per vehicle and driver", async () => {
    const other = await api()
      .post("/api/v1/workpay/agreements")
      .set(owner())
      .send({ vehicleId: vehicle, driverId: driver, terms });
    expect(other.body.error.message).toMatch(/already on agreement WP-/);
    const cancel = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/cancel`)
      .set(owner())
      .send({ reason: "Too late" });
    expect(cancel.body.error.message).toMatch(/not started/);
  });

  it("withdraws an agreement out for signature, voiding its document", async () => {
    const otherVehicle = (
      await api()
        .post("/api/v1/vehicles")
        .set(owner())
        .send({ make: "Kia", model: "Rio", plateNumber: `GR ${digits(4)}-26`, odometer: 10 })
    ).body.data.id as string;
    const otherDriver = (
      await api()
        .post("/api/v1/drivers")
        .set(owner())
        .send({
          firstName: "Esi",
          lastName: "Boadu",
          phone: `+23327${digits(7)}`,
          licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
          licenceClass: "B",
          licenceExpiresOn: "2030-01-01",
          ghanaCardNumber: `GHA-${digits(9)}-1`,
        })
    ).body.data.id as string;
    await api()
      .post(`/api/v1/drivers/${otherDriver}/guarantors`)
      .set(owner())
      .send({ name: "Yaw", phone: `020${digits(7)}` });
    await api().post(`/api/v1/drivers/${otherDriver}/activate`).set(owner()).send({});
    const draft = await api()
      .post("/api/v1/workpay/agreements")
      .set(owner())
      .send({ vehicleId: otherVehicle, driverId: otherDriver, terms: { ...terms, periods: 52 } });
    const id = draft.body.data.id as string;
    const sent = await api()
      .post(`/api/v1/workpay/agreements/${id}/send-for-signature`)
      .set(owner())
      .send({});
    const withdrawn = await api()
      .post(`/api/v1/workpay/agreements/${id}/withdraw`)
      .set(owner())
      .send({ reason: "Price to change" });
    expect(withdrawn.body.data).toMatchObject({ status: "draft", document: null });
    const old = await api().get(`/api/v1/documents/${sent.body.data.document.id}`).set(owner());
    expect(old.body.data).toMatchObject({
      status: "void",
      voidReason: "Agreement withdrawn: Price to change",
    });
  });
});
