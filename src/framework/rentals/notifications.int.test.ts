import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { ISmsGateway } from "../../application/ports/INotifications.js";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Rental notifications and reports (P5-7) end to end: the renter told when the booking is
 * confirmed, for the deposit and each payment, before pickup and return, when overdue (the
 * agent too) and when invoiced; then utilisation, revenue with ADR and RevPAV, balances and
 * deposits held, damage recovery and the day's board.
 */
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
let platform: pg.Pool;
let t: ProvisionedTenant;
const sms = new FakeSms();
let hq: string;
let agent: string;
let renter: string;
let renterPhone: string;
let renterEmail: string;
let suv: string;
let firstCar: string;

type Amount = { amountMinor: number };

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");

async function lastEmail(to: string, template: string): Promise<string> {
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries where recipient = $1 and template = $2
      order by created_at desc limit 1`,
    [to, template],
  );
  return rows[0]!.body_text;
}

const handler = (job: string) =>
  container.get<IJobHandler[]>(TYPES.NotificationJobHandlers).find((h) => h.job === job)!;

/** Sends the queued SMS (the worker's job) and returns everything sent to `phone` since. */
async function sendQueued(phone: string): Promise<string[]> {
  const before = sms.sent.length;
  await t.tenant.run(() =>
    handler("notifications.send").handle({ tenantId: t.tenantId }, { jobId: "j", attempt: 1 }),
  );
  return sms.sent
    .slice(before)
    .filter((m) => m.to === phone)
    .map((m) => m.text);
}

/** The hourly rental reminders run, then the SMS they queued. */
async function remind(): Promise<string[]> {
  await t.tenant.run(() =>
    handler("tenant.rental_reminders").handle({ tenantId: t.tenantId }, { jobId: "r", attempt: 1 }),
  );
  return sendQueued(renterPhone);
}

const step = (id: string, path: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/rentals/${id}/${path}`).set(as(agent)).send(body);

async function book(pickupAt: number, returnAt: number, confirm: boolean): Promise<string> {
  const booked = await api()
    .post("/api/v1/rentals")
    .set(as(agent))
    .send({
      classId: suv,
      customerId: renter,
      pickupAt: iso(pickupAt),
      returnAt: iso(returnAt),
      confirm,
    });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  return booked.body.data.id as string;
}

async function addCar(): Promise<string> {
  const car = await api()
    .post("/api/v1/vehicles")
    .set(owner())
    .send({
      make: "Toyota",
      model: "RAV4",
      year: 2022,
      colour: "White",
      plateNumber: `GR ${digits(4)}-28`,
    });
  expect(car.status, JSON.stringify(car.body)).toBe(201);
  await api()
    .put(`/api/v1/vehicles/${car.body.data.id}/rental-class`)
    .set(owner())
    .send({ classId: suv })
    .expect(200);
  return car.body.data.id as string;
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  container.rebind<ISmsGateway[]>(TYPES.SmsGateways).toConstantValue([sms]);
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const branches = await api().get("/api/v1/branches").set(owner());
  hq = (branches.body.data as { id: string; isDefault: boolean }[]).find((b) => b.isDefault)!.id;
  await api()
    .put("/api/v1/settings/notifications/sms")
    .set(owner())
    .send({ provider: "arkesel", senderId: "AutoFleet", credentials: { apiKey: "k" } })
    .expect(200);
  await api().patch("/api/v1/settings/notifications").set(owner()).send({ quietHours: null });

  const roles = await api().get("/api/v1/roles").set(owner());
  const roleId = (roles.body.data as { id: string; systemKey: string | null }[]).find(
    (r) => r.systemKey === "rental_agent",
  )!.id;
  const agentEmail = `agent-${randomUUID().slice(0, 8)}@example.com`;
  await api()
    .post("/api/v1/users/invitations")
    .set(owner())
    .send({
      name: "Rental Agent",
      email: agentEmail,
      branchIds: [hq],
      roles: [{ roleId, branchId: hq }],
    })
    .expect(201);
  const invite = /#token=([A-Za-z0-9_-]+)/.exec(
    await lastEmail(agentEmail, "tenant.user_invitation"),
  )![1]!;
  agent = (
    await api()
      .post("/api/v1/auth/invitations/accept")
      .set("X-Tenant", t.slug)
      .send({ token: invite, password: OWNER_PASSWORD })
  ).body.data.accessToken as string;

  suv = (
    await api()
      .post("/api/v1/vehicle-classes")
      .set(owner())
      .send({ code: "SUV", name: "SUV", deposit: "200.00" })
  ).body.data.id as string;
  firstCar = await addCar();
  await addCar();
  await api()
    .post("/api/v1/rental-rate-plans")
    .set(owner())
    .send({ code: "SUV-STD", name: "SUV standard", classId: suv, dailyRate: "300.00" })
    .expect(201);
  await api()
    .patch("/api/v1/settings/rentals")
    .set(owner())
    .send({ inspectionItems: [], inspectionPhotoViews: [] })
    .expect(200);
  renterPhone = `+23324${digits(7)}`;
  renterEmail = `kofi-${randomUUID().slice(0, 8)}@example.com`;
  const customer = await api()
    .post("/api/v1/customers")
    .set(owner())
    .send({
      type: "individual",
      firstName: "Kofi",
      lastName: "Boateng",
      phone: renterPhone,
      email: renterEmail,
      dateOfBirth: "1988-02-11",
      ghanaCardNumber: `GHA-${digits(9)}-0`,
      licenceNumber: "DL-778899",
      licenceClass: "B",
      licenceExpiresOn: "2030-01-01",
    });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  renter = customer.body.data.id as string;
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("rental notifications and reports", () => {
  it("tells the renter and the agent through the rental, and reports on it", async () => {
    const now = Date.now();
    const id = await book(now + 3 * HOUR, now + 27 * HOUR, true);
    const number = (await api().get(`/api/v1/rentals/${id}`).set(as(agent))).body.data
      .number as string;

    // --- confirmed: SMS and email to the renter ---
    const [confirmed] = await sendQueued(renterPhone);
    expect(confirmed).toMatch(new RegExp(`Kofi.*${number} is confirmed.*RAV4.*Total`));
    const emails = await t.tenant.query<{ rule: string; address: string }>(
      `select rule, address from notification_deliveries
        where channel = 'email' and recipient_type = 'customer' and recipient_id = $1`,
      [renter],
    );
    expect(emails).toEqual([{ rule: "rental_confirmed", address: renterEmail }]);

    // --- the deposit and a payment, each with a receipt ---
    const held = await step(id, "deposit", {
      amount: "200.00",
      method: "momo",
      momoNetwork: "mtn",
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(await sendQueued(renterPhone)).toEqual([
      expect.stringMatching(/security deposit of .*200\.00 .*receipt/),
    ]);
    const paid = await step(id, "payments", { amount: "100.00", method: "bank_transfer" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(await sendQueued(renterPhone)).toEqual([
      expect.stringMatching(/received .*100\.00 for rental .*Balance: .*200\.00/),
    ]);

    // --- the hourly run: pickup within 24 hours, once ---
    expect(await remind()).toEqual([expect.stringContaining("a reminder that you collect")]);
    expect(await remind()).toEqual([]);

    // --- out; the return reminder once within the hours set ---
    const out = await step(id, "checkout", { odometer: 5_000, fuel: "full", idChecked: true });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    // The agreement's signing link; not yet within the two hours before return.
    expect(await sendQueued(renterPhone)).toEqual([expect.stringContaining("please sign")]);
    expect(await remind()).toEqual([]);
    await api()
      .patch("/api/v1/settings/rentals")
      .set(owner())
      .send({ returnReminderHours: 30 })
      .expect(200);
    expect(await remind()).toEqual([expect.stringContaining("is due back")]);
    expect(await remind()).toEqual([]);

    // --- overdue: out since yesterday, due two hours ago ---
    await t.tenant.query(
      `update rental_bookings
          set pickup_at = now() - interval '26 hours', checked_out_at = now() - interval '26 hours',
              return_at = now() - interval '2 hours'
        where id = $1`,
      [id],
    );
    expect(await remind()).toEqual([expect.stringContaining("was due back")]);
    expect(await remind()).toEqual([]);
    const inbox = await api().get("/api/v1/notifications").set(as(agent));
    expect(
      (inbox.body.data as { title: string }[]).filter((n) => n.title === `${number} is overdue`),
    ).toHaveLength(1);

    // --- the board while it is out ---
    const second = await book(now + 5 * HOUR, now + 29 * HOUR, false);
    const today = iso(now + 5 * HOUR).slice(0, 10);
    const board = await api().get(`/api/v1/rental-board?date=${today}`).set(as(agent));
    expect(board.status, JSON.stringify(board.body)).toBe(200);
    expect(board.body.data.overdue).toEqual([
      expect.objectContaining({
        bookingId: id,
        customer: expect.objectContaining({ name: expect.stringContaining("Kofi") }),
        vehicle: expect.objectContaining({ id: firstCar, name: "Toyota RAV4" }),
        overdueMinutes: expect.any(Number),
      }),
    ]);
    expect(board.body.data.overdue[0].overdueMinutes).toBeGreaterThanOrEqual(119);
    const lapsing = await t.tenant.query<{ expires_at: Date }>(
      "select expires_at from rental_bookings where id = $1",
      [second],
    );
    const lapseDay = lapsing[0]!.expires_at.toISOString().slice(0, 10);
    const later = await api().get(`/api/v1/rental-board?date=${lapseDay}`).set(as(agent));
    expect((later.body.data.expiring as { bookingId: string }[]).map((r) => r.bookingId)).toEqual([
      second,
    ]);
    if (today === lapseDay) expect(board.body.data.pickups).toEqual([]); // a reservation is not yet a pickup
    await step(second, "confirm").expect(200);
    const confirmedBoard = await api().get(`/api/v1/rental-board?date=${today}`).set(as(agent));
    expect(
      (confirmedBoard.body.data.pickups as { bookingId: string }[]).map((r) => r.bookingId),
    ).toEqual([second]);

    // --- back late and closed: the invoice ---
    const back = await step(id, "checkin", { odometer: 5_200, fuel: "full" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await step(id, "close")).status).toBe(200);
    expect(await sendQueued(renterPhone)).toEqual(
      expect.arrayContaining([expect.stringMatching(/invoice INV-\S+ for rental .*Balance/)]),
    );

    // --- reports: owner only ---
    const report = (path: string) => api().get(`/api/v1/dashboards/rentals/${path}`).set(owner());
    expect((await api().get("/api/v1/dashboards/rentals/revenue").set(as(agent))).status).toBe(403);

    const util = await report("utilisation");
    expect(util.status, JSON.stringify(util.body)).toBe(200);
    expect(util.body.data.fleet).toMatchObject({ vehicles: 2 });
    expect(util.body.data.fleet.rentedHours).toBeGreaterThanOrEqual(25);
    expect(util.body.data.byClass).toEqual([
      expect.objectContaining({ classId: suv, className: "SUV", vehicles: 2 }),
    ]);
    const rented = (util.body.data.byVehicle as { vehicleId: string; percent: number }[]).find(
      (v) => v.vehicleId === firstCar,
    )!;
    expect(rented.percent).toBeGreaterThan(0);

    const revenue = await report("revenue");
    expect(revenue.status, JSON.stringify(revenue.body)).toBe(200);
    const total = (revenue.body.data.revenue as Amount).amountMinor;
    // Two days booked at ₵300 and the late return.
    expect(total).toBeGreaterThan(60_000);
    expect(revenue.body.data).toMatchObject({
      bookings: 2,
      averageDailyRate: { amountMinor: expect.any(Number) },
      revenuePerAvailableVehicle: { amountMinor: expect.any(Number) },
      byClass: [expect.objectContaining({ classId: suv, share: 100 })],
      byBranch: [expect.objectContaining({ branchId: hq, share: 100 })],
      byCustomerType: [expect.objectContaining({ customerType: "individual", share: 100 })],
    });

    const balances = await report("balances");
    expect(balances.status, JSON.stringify(balances.body)).toBe(200);
    const owed = (balances.body.data.bookings as { bookingId: string; balance: Amount }[]).find(
      (b) => b.bookingId === id,
    )!;
    const acc = await api().get(`/api/v1/rentals/${id}/account`).set(as(agent));
    expect(owed.balance.amountMinor).toBe(acc.body.data.balance.amountMinor);
    expect(owed.balance.amountMinor).toBeGreaterThan(0);
    expect(balances.body.data.deposits).toEqual([
      expect.objectContaining({
        bookingId: id,
        held: expect.objectContaining({ amountMinor: 20_000 }),
      }),
    ]);
    expect(balances.body.data.depositsHeld.amountMinor).toBe(20_000);

    await api()
      .post("/api/v1/vehicle-damages")
      .set(owner())
      .send({
        vehicleId: firstCar,
        area: "front",
        severity: "minor",
        description: "Scratched bumper",
        estimate: "400.00",
      })
      .expect(201);
    const damages = await report("damages");
    expect(damages.status, JSON.stringify(damages.body)).toBe(200);
    expect(damages.body.data).toMatchObject({
      damages: 1,
      cost: { amountMinor: 40_000 },
      recovered: { amountMinor: 0 },
      recoveredPercent: 0,
      byLiability: [expect.objectContaining({ damages: 1 })],
    });

    // Periods are checked.
    const backwards = await report("revenue?from=2026-02-01&to=2026-01-01");
    expect(backwards.status).toBe(422);
  });
});
