import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { ITenantDailyTask } from "../../application/jobs/ITenantDailyTask.js";
import type { IClock } from "../../application/ports/IClock.js";
import type { WorkPayNotifications } from "../../application/use-cases/workpay/WorkPayNotifications.js";
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

/** Moved forward to let instalments fall overdue (tokens are issued again after a move). */
class TestClock implements IClock {
  private offsetMs = 0;
  now = () => new Date(Date.now() + this.offsetMs);
  advanceDays(days: number) {
    this.offsetMs += days * 86_400_000;
  }
}

const clock = new TestClock();
let container: Container;
let app: Express;
let t: ProvisionedTenant;
const sms = new FakeSms();
let driver: string;
let driverToken: string;
let ownerToken: string;
let vehicle: string;
let checklist: { items: { key: string; ok: boolean }[] };
const driverPhone = `+23324${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const guarantorPhone = `+23320${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${ownerToken}` });
const asDriver = () => ({ Authorization: `Bearer ${driverToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const day = (offset: number) =>
  new Date(clock.now().getTime() + offset * 86_400_000).toISOString().slice(0, 10);
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
  container.rebind<IClock>(TYPES.Clock).toConstantValue(clock);
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  ownerToken = t.ownerAccessToken;
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
        phone: driverPhone,
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
        penalty: { kind: "flat", amount: "50.00" },
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
      penalty: { kind: "flat", amountMinor: 5_000 },
      lateFee: "A late fee of ₵50.00 is charged once on each overdue instalment",
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

  // --- collections (P3-4): grace is 2 days, the late fee ₵50.00 flat, instalments 1,105.00 ---

  type Balance = Record<string, unknown> & {
    outstanding: { amountMinor: number };
    penalties: { id: string }[];
  };
  const balance = async () =>
    (await api().get(`/api/v1/workpay/agreements/${agreement}/balance`).set(owner())).body
      .data as Balance;
  const pay = (amount: string) =>
    api()
      .post(`/api/v1/workpay/agreements/${agreement}/payments`)
      .set(owner())
      .send({ amount, method: "momo", momoNetwork: "mtn", reference: `WP-${digits(6)}` });
  const arrearsJob = () =>
    t.tenant.run(() =>
      container
        .get<ITenantDailyTask[]>(TYPES.TenantDailyTasks)
        .find((task) => task.name === "workpay_arrears")!
        .run(day(0)),
    );
  const morning = (today: string) =>
    t.tenant.run(() =>
      container.get<WorkPayNotifications>(TYPES.WorkPayNotifications).morning(today),
    );
  /** Moves the clock and signs the owner in again (their token was issued before the move). */
  async function travel(days: number) {
    clock.advanceDays(days);
    const login = await api()
      .post("/api/v1/auth/login")
      .set("X-Tenant", t.slug)
      .send({ identifier: t.ownerEmail, password: OWNER_PASSWORD });
    ownerToken = login.body.data.accessToken as string;
    const driverLogin = await api()
      .post("/api/v1/auth/login")
      .set("X-Tenant", t.slug)
      .send({ identifier: driverPhone, password: OWNER_PASSWORD });
    expect(driverLogin.status, JSON.stringify(driverLogin.body)).toBe(200);
    driverToken = driverLogin.body.data.accessToken as string;
  }
  let reversible: string;

  it("posts the price as a receivable when the agreement starts, the books balanced", async () => {
    const tb = await api().get("/api/v1/ledger/trial-balance").set(owner());
    expect(tb.body.data.balanced).toBe(true);
    const integrity = await api().get("/api/v1/ledger/integrity").set(owner());
    expect(integrity.body.data.passed, JSON.stringify(integrity.body.data.checks)).toBe(true);
    const byCode = (code: string) =>
      (tb.body.data.accounts as { code: string; balance: { amountMinor: number } }[]).find(
        (a) => a.code === code,
      )?.balance.amountMinor;
    expect(Math.abs(byCode("1210")!)).toBe(11_500_000);
    expect(Math.abs(byCode("4200")!)).toBe(500_000);
  });

  it("takes a payment ahead of the due date against the first instalment", async () => {
    const res = await pay("500.00");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.allocations).toEqual([
      {
        kind: "instalment",
        instalmentNumber: 1,
        amount: expect.objectContaining({ amountMinor: 50_000 }),
      },
    ]);
    expect(res.body.data.balance).toMatchObject({
      status: "active",
      outstanding: { amountMinor: 11_450_000 },
      dueNow: { amountMinor: 0 },
      nextDue: { number: 1, outstanding: { amountMinor: 60_500 } },
    });
    const tooMuch = await pay("200000.00");
    expect(tooMuch.body.error.message).toMatch(/more than the .* still owed/);
    expect(await smsTo(driverPhone)).toMatch(
      /we received GHS 500\.00 for WP-.*Balance: GHS 114,500\.00\. Next due: \d{4}-\d{2}-\d{2}/,
    );
  });

  it("reminds the driver the day before an instalment is due", async () => {
    await morning(day(6));
    expect(await smsTo(driverPhone)).toMatch(
      new RegExp(`instalment of GHS 605\\.00 \\(WP-.*\\) is due on ${day(7)}`),
    );
  });

  it("falls into arrears after the grace days and charges the late fee once", async () => {
    await travel(9); // due on day 7, grace 2: overdue from day 10
    await arrearsJob();
    expect(await balance()).toMatchObject({ status: "active", overdueCount: 0 });
    await travel(1);
    await arrearsJob();
    await arrearsJob(); // a second run charges nothing more
    const b = await balance();
    expect(b).toMatchObject({
      status: "in_arrears",
      overdueCount: 1,
      overdue: { amountMinor: 60_500 },
      penaltiesOutstanding: { amountMinor: 5_000 },
      dueNow: { amountMinor: 65_500 },
      arrearsSince: day(0),
      daysInArrears: 1,
    });
    expect(b.penalties).toHaveLength(1);
    const listed = await api().get("/api/v1/workpay/agreements?status=in_arrears").set(owner());
    expect((listed.body.data as { id: string }[]).map((a) => a.id)).toContain(agreement);
  });

  it("tells the driver an instalment is overdue, and the guarantor when the business opts in", async () => {
    await api()
      .patch("/api/v1/settings/notifications")
      .set(owner())
      .send({ rules: { workpay_guarantor_alert: { enabled: true, channels: ["sms"] } } });
    await api().patch("/api/v1/settings/workpay").set(owner()).send({ guarantorAlertAfterDays: 1 });
    await morning(day(0));
    expect(await smsTo(driverPhone)).toMatch(
      /instalment of GHS 605\.00 \(WP-.*\) due .* is overdue/,
    );
    expect(await smsTo(guarantorPhone)).toMatch(
      /Hello Akua Mensah, Kojo Antwi, whose work and pay agreement WP-.* you guarantee, is behind by GHS 605\.00/,
    );
    const inbox = await api().get("/api/v1/notifications").set(owner());
    expect(JSON.stringify(inbox.body.data)).toMatch(/work and pay agreement is behind/);
  });

  it("states the agreement for staff and the driver, as JSON and PDF", async () => {
    const res = await api().get(`/api/v1/workpay/agreements/${agreement}/statement`).set(owner());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      driver: { name: "Kojo Antwi" },
      totals: {
        paidToDate: { amountMinor: 550_000 },
        overdue: { amountMinor: 60_500 },
        penaltiesOutstanding: { amountMinor: 5_000 },
        daysInArrears: 1,
      },
    });
    expect(res.body.data.schedule).toHaveLength(104);
    expect((res.body.data.payments as { kind: string }[]).map((p) => p.kind)).toEqual([
      "deposit",
      "instalments",
    ]);
    const pdf = await api()
      .get(`/api/v1/workpay/agreements/${agreement}/statement.pdf`)
      .set(owner());
    expect(pdf.headers["content-type"]).toMatch(/application\/pdf/);
    const mine = await api()
      .get(`/api/v1/me/driver/workpay/${agreement}/statement`)
      .set(asDriver());
    expect(mine.body.data.totals.percentComplete).toBeCloseTo(0.4, 1);
    const minePdf = await api()
      .get(`/api/v1/me/driver/workpay/${agreement}/statement.pdf`)
      .set(asDriver());
    expect(minePdf.status).toBe(200);
  });

  it("shows the portfolio: arrears, ageing, collection rate and forecast", async () => {
    const res = await api().get("/api/v1/dashboards/workpay").set(owner());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      agreements: { running: 1, byStatus: { in_arrears: 1 } },
      outstanding: { amountMinor: 11_450_000 },
      overdue: { amountMinor: 60_500 },
      penaltiesOutstanding: { amountMinor: 5_000 },
      ageing: { "1-7": { amountMinor: 60_500 }, "8-30": { amountMinor: 0 } },
      collectionRate: {
        due: { amountMinor: 110_500 },
        paid: { amountMinor: 50_000 },
        percent: 45.2,
      },
      forecast: { next7: { amountMinor: 110_500 } },
    });
    expect(res.body.data.par[0]).toMatchObject({ days: 7, agreements: 0 });
    expect(res.body.data.forecast.weeks).toHaveLength(13);
    const arrears = await api().get("/api/v1/dashboards/workpay/arrears").set(owner());
    expect(arrears.body.data[0]).toMatchObject({
      agreementId: agreement,
      daysInArrears: 1,
      driver: { name: "Kojo Antwi", phone: driverPhone },
      overdue: { amountMinor: 60_500 },
    });
  });

  it("applies a payment to the late fee, then the overdue instalment, then the next one", async () => {
    const res = await pay("1000.00");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(
      (
        res.body.data.allocations as {
          kind: string;
          instalmentNumber: number;
          amount: { amountMinor: number };
        }[]
      ).map((l) => [l.kind, l.instalmentNumber, l.amount.amountMinor]),
    ).toEqual([
      ["penalty", 1, 5_000],
      ["instalment", 1, 60_500],
      ["instalment", 2, 34_500],
    ]);
    expect(res.body.data.balance).toMatchObject({ status: "active", arrearsSince: null });
    reversible = res.body.data.payment.id as string;
    const receipt = await api().get(`/api/v1/payments/${reversible}/receipt`).set(owner());
    expect(receipt.body.data.appliedTo[0]).toMatchObject({
      description: expect.stringMatching(
        /^Work and pay agreement WP-.*: instalments 1–2 and late fees$/,
      ),
      amount: { amountMinor: 100_000 },
    });
    const listed = await api().get(`/api/v1/workpay/agreements/${agreement}/payments`).set(owner());
    expect(listed.body.data).toHaveLength(2);
  });

  it("puts the agreement back in arrears when a payment is reversed", async () => {
    const res = await api()
      .post(`/api/v1/payments/${reversible}/reverse`)
      .set(owner())
      .send({ reason: "Cheque bounced" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await balance()).toMatchObject({
      status: "in_arrears",
      overdue: { amountMinor: 60_500 },
      penaltiesOutstanding: { amountMinor: 5_000 },
    });
    const listed = await api().get(`/api/v1/workpay/agreements/${agreement}/payments`).set(owner());
    expect(
      listed.body.data.find((p: { paymentId: string }) => p.paymentId === reversible),
    ).toMatchObject({
      reversed: true,
    });
  });

  it("waives a late fee and an instalment, with a reason", async () => {
    const { penalties } = await balance();
    const noReason = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/penalties/${penalties[0]!.id}/waive`)
      .set(owner())
      .send({ reason: "" });
    expect(noReason.status).toBe(400);
    const fee = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/penalties/${penalties[0]!.id}/waive`)
      .set(owner())
      .send({ reason: "First time late" });
    expect(fee.status, JSON.stringify(fee.body)).toBe(200);
    expect(fee.body.data).toMatchObject({
      status: "in_arrears",
      penaltiesOutstanding: { amountMinor: 0 },
    });
    const instalment = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/instalments/1/waive`)
      .set(owner())
      .send({ amount: "605.00", reason: "Vehicle in the workshop" });
    expect(instalment.body.data).toMatchObject({ status: "active", overdueCount: 0 });
    const again = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/instalments/1/waive`)
      .set(owner())
      .send({ reason: "Again" });
    expect(again.body.error.message).toMatch(/Nothing is left/);
  });

  it("completes once everything is paid, the books still balanced", async () => {
    const { outstanding } = await balance();
    const amount = (outstanding.amountMinor / 100).toFixed(2);
    const res = await pay(amount);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.balance).toMatchObject({
      status: "completed",
      outstanding: { amountMinor: 0 },
      nextDue: null,
    });
    const after = await api().get(`/api/v1/workpay/agreements/${agreement}`).set(owner());
    expect(after.body.data.completedAt).not.toBeNull();
    expect(
      after.body.data.schedule.every(
        (i: { status: string }) => i.status === "paid" || i.status === "waived",
      ),
    ).toBe(true);
    expect((await pay("10.00")).body.error.message).toMatch(/fully paid/);
    expect(await smsTo(driverPhone)).toMatch(
      /Congratulations Kojo Antwi! Agreement WP-.* is paid in full/,
    );

    const tb = await api().get("/api/v1/ledger/trial-balance").set(owner());
    expect(tb.body.data.balanced).toBe(true);
    const integrity = await api().get("/api/v1/ledger/integrity").set(owner());
    expect(integrity.body.data.passed, JSON.stringify(integrity.body.data.checks)).toBe(true);
    const byCode = (code: string) =>
      (tb.body.data.accounts as { code: string; balance: { amountMinor: number } }[]).find(
        (a) => a.code === code,
      )?.balance.amountMinor ?? 0;
    expect(byCode("1210")).toBe(0); // nothing left receivable
    expect(byCode("2300")).toBe(0); // everything earned or waived
  });

  // --- completion and transfer (P3-6) ---

  const transfer = async () =>
    (await api().get(`/api/v1/workpay/agreements/${agreement}/transfer`).set(owner())).body as {
      data: { status: string; document: { id: string } } & Record<string, unknown>;
    };
  let letter: string;

  it("issues the transfer letter for the owner and the driver once paid in full", async () => {
    const res = await transfer();
    expect(res.data, JSON.stringify(res)).toMatchObject({
      status: "awaiting_signatures",
      document: { number: expect.stringMatching(/^TRL-/), status: "pending_signatures" },
      handedOver: expect.arrayContaining([{ item: "Insurance certificate", included: true }]),
      transferredAt: null,
      dvla: { status: "not_started" },
    });
    letter = res.data.document.id;
    const view = await api().get(`/api/v1/workpay/agreements/${agreement}`).set(owner());
    expect(view.body.data.transfer).toMatchObject({ status: "awaiting_signatures" });
    const car = await api().get(`/api/v1/vehicles/${vehicle}`).set(owner());
    expect(car.body.data.status).toBe("on_workpay");
    const early = await api()
      .patch(`/api/v1/workpay/agreements/${agreement}/transfer/dvla`)
      .set(owner())
      .send({ status: "submitted" });
    expect(early.body.error.message).toMatch(/follows the signed transfer/);
  });

  it("corrects the letter before it is signed, voiding the first one", async () => {
    const res = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/transfer-letter`)
      .set(owner())
      .send({ odometer: 61_500, condition: "Good, small dent on the rear door" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      odometer: 61_500,
      condition: expect.stringMatching(/dent/),
    });
    const old = await api().get(`/api/v1/documents/${letter}`).set(owner());
    expect(old.body.data.status).toBe("void");
    letter = res.body.data.document.id as string;
  });

  it("transfers ownership to the driver once both signed", async () => {
    const sign = async (as: Record<string, string>) => {
      const tasks = (await api().get("/api/v1/me/signatures").set(as)).body.data as {
        signer: { id: string };
        document: { id: string };
      }[];
      const task = tasks.find((x) => x.document.id === letter)!;
      const signed = await api()
        .post(`/api/v1/me/signatures/${task.signer.id}/sign`)
        .set(as)
        .send({ signature: drawn, consent: true });
      expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    };
    await sign(owner());
    expect((await transfer()).data.status).toBe("awaiting_signatures");
    await sign(asDriver()); // the driver signs last: no staff permission needed
    expect(await smsTo(driverPhone)).toMatch(
      /Congratulations Kojo Antwi! GR \d{4}-26 is now yours/,
    );
    expect((await transfer()).data).toMatchObject({
      status: "transferred",
      transferredAt: expect.any(String),
      document: { status: "fully_signed" },
    });
    const car = await api().get(`/api/v1/vehicles/${vehicle}`).set(owner());
    expect(car.body.data).toMatchObject({ status: "transferred", ownershipType: "driver_owned" });
    const mine = await api()
      .get(`/api/v1/me/driver/workpay/${agreement}/transfer-letter`)
      .set(asDriver());
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.data.url).toEqual(expect.any(String));
  });

  it("refuses to reopen a transferred agreement and tracks the DVLA change of ownership", async () => {
    const paid = await api().get(`/api/v1/workpay/agreements/${agreement}/payments`).set(owner());
    const last = (paid.body.data as { paymentId: string; reversed: boolean }[]).find(
      (p) => !p.reversed,
    )!;
    const reverse = await api()
      .post(`/api/v1/payments/${last.paymentId}/reverse`)
      .set(owner())
      .send({ reason: "Mistake" });
    expect(reverse.body.error.message).toMatch(/transferred to the driver/);
    const submitted = await api()
      .patch(`/api/v1/workpay/agreements/${agreement}/transfer/dvla`)
      .set(owner())
      .send({ status: "submitted", reference: "DVLA-12345" });
    expect(submitted.body.data.dvla).toMatchObject({
      status: "submitted",
      submittedOn: day(0),
      reference: "DVLA-12345",
    });
    const done = await api()
      .patch(`/api/v1/workpay/agreements/${agreement}/transfer/dvla`)
      .set(owner())
      .send({ status: "completed" });
    expect(done.body.data.dvla).toMatchObject({ status: "completed", completedOn: day(0) });
    const paper = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/transfer/papers`)
      .set(owner())
      .send({ filename: "dvla-form.pdf", contentType: "application/pdf", sizeBytes: 20_000 });
    expect(paper.status, JSON.stringify(paper.body)).toBe(201);
  });
});
