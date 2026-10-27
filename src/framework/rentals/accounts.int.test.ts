import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * Rental money and accounts (P5-5) end to end: the class deposit taken before check-out, payments
 * for the booking, the invoice issued at close with the payments applied, the deposit applied and
 * the rest returned; a corporate customer on account (authorised drivers, the credit limit, the
 * due date from its payment terms); the blacklist and the watchlist; a cancellation fee invoiced.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let hq: string;
let agent: string;
let cls: string;
let renter: string;
let company: string;
let driver: string;

type Amount = { amountMinor: number };
type Account = {
  charged: Amount;
  uninvoiced: Amount;
  balance: Amount;
  credit: Amount;
  depositRequired: Amount | null;
  invoices: {
    id: string;
    number: string;
    status: string;
    issueDate: string;
    dueDate: string;
    total: Amount;
    paid: Amount;
    balance: Amount;
  }[];
  deposit: {
    status: string;
    amount: Amount;
    applied: Amount;
    refunded: Amount;
    held: Amount;
    refundPaymentId: string | null;
  } | null;
};

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function lastEmail(to: string, template: string): Promise<string> {
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries where recipient = $1 and template = $2
      order by created_at desc limit 1`,
    [to, template],
  );
  return rows[0]!.body_text;
}

async function rentalAgent(): Promise<string> {
  const roles = await api().get("/api/v1/roles").set(owner());
  const roleId = (roles.body.data as { id: string; systemKey: string | null }[]).find(
    (r) => r.systemKey === "rental_agent",
  )!.id;
  const email = `agent-${randomUUID().slice(0, 8)}@example.com`;
  await api()
    .post("/api/v1/users/invitations")
    .set(owner())
    .send({ name: "Rental Agent", email, branchIds: [hq], roles: [{ roleId, branchId: hq }] })
    .expect(201);
  const token = /#token=([A-Za-z0-9_-]+)/.exec(
    await lastEmail(email, "tenant.user_invitation"),
  )![1]!;
  const accepted = await api()
    .post("/api/v1/auth/invitations/accept")
    .set("X-Tenant", t.slug)
    .send({ token, password: OWNER_PASSWORD });
  return accepted.body.data.accessToken as string;
}

const person = (firstName: string) => ({
  type: "individual",
  firstName,
  lastName: randomUUID().slice(0, 6),
  email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
  dateOfBirth: "1990-04-01",
  licenceNumber: `DL-${randomUUID().slice(0, 5)}`,
  licenceClass: "B",
  licenceExpiresOn: "2030-01-01",
});

async function customer(body: Record<string, unknown>): Promise<string> {
  const created = await api().post("/api/v1/customers").set(owner()).send(body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

const book = (customerId: string, days: number, extra: Record<string, unknown> = {}) => {
  const now = Date.now();
  return api()
    .post("/api/v1/rentals")
    .set(as(agent))
    .send({
      classId: cls,
      customerId,
      pickupAt: iso(now + HOUR),
      returnAt: iso(now + HOUR + days * 24 * HOUR),
      confirm: true,
      ...extra,
    });
};

const step = (id: string, path: string, body: Record<string, unknown> = {}, token = agent) =>
  api().post(`/api/v1/rentals/${id}/${path}`).set(as(token)).send(body);

const account = async (id: string) => {
  const res = await api().get(`/api/v1/rentals/${id}/account`).set(as(agent));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as Account;
};

const refused = (res: request.Response, status: number, message: string) =>
  expect([res.status, res.body.error?.message]).toEqual([status, expect.stringContaining(message)]);

let odometer = 1_000;
/** Out and back after the agreed days (no extra km, full tank). */
async function rentAndReturn(id: string, checkout: Record<string, unknown> = {}) {
  odometer += 1_000;
  const out = await step(id, "checkout", {
    odometer,
    fuel: "full",
    idChecked: true,
    ...checkout,
  });
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  const back = await step(id, "checkin", { odometer: odometer + 50, fuel: "full" });
  expect(back.status, JSON.stringify(back.body)).toBe(200);
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const branches = await api().get("/api/v1/branches").set(owner());
  hq = (branches.body.data as { id: string; isDefault: boolean }[]).find((b) => b.isDefault)!.id;
  agent = await rentalAgent();

  const created = await api()
    .post("/api/v1/vehicle-classes")
    .set(owner())
    .send({ code: "SED", name: "Saloon", deposit: "500.00" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.depositMinor).toBe(50_000);
  cls = created.body.data.id as string;
  for (let i = 0; i < 4; i++) {
    const registered = await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Toyota", model: "Corolla", plateNumber: `GR ${randomUUID().slice(0, 4)}-27` });
    await api()
      .put(`/api/v1/vehicles/${registered.body.data.id}/rental-class`)
      .set(owner())
      .send({ classId: cls })
      .expect(200);
  }
  await api()
    .post("/api/v1/rental-rate-plans")
    .set(owner())
    .send({ code: "SED-STD", name: "Saloon standard", classId: cls, dailyRate: "300.00" })
    .expect(201);
  // Inspections are P5-4's test; here the keys go out without the checklist and photos.
  await api()
    .patch("/api/v1/settings/rentals")
    .set(owner())
    .send({ inspectionItems: [], inspectionPhotoViews: [] })
    .expect(200);

  renter = await customer(person("Kofi"));
  driver = await customer(person("Ama"));
  company = await customer({
    type: "corporate",
    companyName: `Acme ${randomUUID().slice(0, 6)} Ltd`,
    email: `acme-${randomUUID().slice(0, 8)}@example.com`,
    creditLimit: "1000.00",
    paymentTermsDays: 30,
  });
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("rental accounts", () => {
  it("takes the deposit and payments, invoices at close, applies and returns the deposit", async () => {
    const booked = await book(renter, 1);
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const id = booked.body.data.id as string;

    // No keys without the class deposit; only an override waives it.
    refused(
      await step(id, "checkout", { odometer: 1_000, fuel: "full", idChecked: true }),
      422,
      "deposit first",
    );
    const waived = await step(id, "checkout", {
      odometer: 1_000,
      fuel: "full",
      idChecked: true,
      waiveDeposit: true,
    });
    expect(waived.status).toBe(403);

    const held = await step(id, "deposit", {
      amount: "500.00",
      method: "momo",
      momoNetwork: "mtn",
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(held.body.data).toMatchObject({
      depositRequired: { amountMinor: 50_000 },
      deposit: { status: "held", held: { amountMinor: 50_000 } },
    });
    refused(await step(id, "deposit", { amount: "100.00", method: "momo" }), 422, "already");

    const paid = await step(id, "payments", { amount: "100.00", method: "bank_transfer" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect((paid.body.data as Account).credit.amountMinor).toBe(10_000);
    // Released only once the vehicle is back.
    refused(await step(id, "deposit/release", { method: "momo" }), 422, "once the vehicle is back");

    await rentAndReturn(id);
    expect((await step(id, "close")).status).toBe(200);

    // One day at ₵300, invoiced at close with the ₵100 paid already applied.
    let acc = await account(id);
    expect(acc.invoices).toEqual([
      expect.objectContaining({
        status: "partially_paid",
        total: expect.objectContaining({ amountMinor: 30_000 }),
        paid: expect.objectContaining({ amountMinor: 10_000 }),
      }),
    ]);
    const invoice = acc.invoices[0]!;
    expect(invoice.number).toMatch(/^INV-/);
    expect(invoice.dueDate).toBe(invoice.issueDate);
    expect([acc.uninvoiced.amountMinor, acc.credit.amountMinor, acc.balance.amountMinor]).toEqual([
      0, 0, 20_000,
    ]);
    refused(await step(id, "invoice", {}, t.ownerAccessToken), 422, "Nothing to invoice");

    // The deposit pays the rest of the invoice; the remaining ₵300 goes back.
    refused(await step(id, "deposit/apply", { amount: "600.00" }), 422, "still holds");
    const applied = await step(id, "deposit/apply", {});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    acc = applied.body.data as Account;
    expect(acc.invoices[0]).toMatchObject({ status: "paid", balance: { amountMinor: 0 } });
    expect(acc.deposit).toMatchObject({
      status: "partially_applied",
      applied: { amountMinor: 20_000 },
      held: { amountMinor: 30_000 },
    });
    expect(acc.balance.amountMinor).toBe(0);

    const released = await step(id, "deposit/release", { method: "momo", momoNetwork: "mtn" });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    acc = released.body.data as Account;
    expect(acc.deposit).toMatchObject({
      status: "released",
      refunded: { amountMinor: 30_000 },
      held: { amountMinor: 0 },
    });
    const refund = await t.tenant.query<{ direction: string; amount_minor: string }>(
      "select direction, amount_minor from payments where id = $1",
      [acc.deposit!.refundPaymentId],
    );
    expect(refund).toEqual([{ direction: "out", amount_minor: "30000" }]);
    refused(await step(id, "deposit/release", { method: "momo" }), 422, "holds nothing to release");

    const events = await t.tenant.query<{ type: string }>(
      "select type from rental_booking_events where booking_id = $1 order by at, id",
      [id],
    );
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "deposit_held",
        "payment_recorded",
        "invoiced",
        "deposit_applied",
        "deposit_released",
      ]),
    );
  });

  it("rents to a company on account: authorised drivers, credit limit and payment terms", async () => {
    // ₵1,200 for four days is over the ₵1,000 limit.
    refused(await book(company, 4), 422, "over the credit limit");
    const booked = await book(company, 2);
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.data.warnings).toEqual([expect.stringContaining("Name the driver")]);
    const id = booked.body.data.id as string;

    const out = { odometer: 1_000, fuel: "full", idChecked: true };
    refused(await step(id, "checkout", out), 422, "Name the driver");
    refused(await step(id, "checkout", { ...out, driverId: driver }), 422, "not one of");
    refused(
      await book(renter, 1, { driverId: driver }),
      422,
      "Only a company's rental names another driver",
    );

    const authorised = await api()
      .post(`/api/v1/customers/${company}/authorised-drivers`)
      .set(owner())
      .send({ driverId: driver });
    expect(authorised.status, JSON.stringify(authorised.body)).toBe(200);
    expect(authorised.body.data.authorisedDrivers).toEqual([
      expect.objectContaining({ id: driver }),
    ]);
    const individual = await api()
      .post(`/api/v1/customers/${renter}/authorised-drivers`)
      .set(owner())
      .send({ driverId: driver });
    refused(individual, 422, "Only a corporate customer");

    // On account: no deposit.
    expect((await account(id)).depositRequired).toBeNull();
    await rentAndReturn(id, { driverId: driver });
    const detail = await api().get(`/api/v1/rentals/${id}`).set(as(agent));
    expect(detail.body.data.driver).toMatchObject({ id: driver });
    expect((await step(id, "close")).status).toBe(200);

    const acc = await account(id);
    const invoice = acc.invoices[0]!;
    expect(invoice.total.amountMinor).toBe(60_000);
    const due = new Date(`${invoice.issueDate}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + 30);
    expect(invoice.dueDate).toBe(due.toISOString().slice(0, 10));

    const summary = await api().get(`/api/v1/customers/${company}/rental-account`).set(owner());
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body.data).toMatchObject({
      customer: { id: company, type: "corporate", riskStatus: "ok" },
      onAccount: true,
      creditLimit: { amountMinor: 100_000 },
      paymentTermsDays: 30,
      owed: { amountMinor: 60_000 },
      available: { amountMinor: 40_000 },
      authorisedDrivers: [{ id: driver }],
    });
    expect(summary.body.data.history).toMatchObject({ charged: { amountMinor: 60_000 } });

    // ₵600 owed: another two days (₵600) would be ₵1,200.
    refused(await book(company, 2, { driverId: driver }), 422, "over the credit limit");
    const overridden = await api()
      .post("/api/v1/rentals")
      .set(owner())
      .send({
        classId: cls,
        customerId: company,
        driverId: driver,
        pickupAt: iso(Date.now() + 10 * 24 * HOUR),
        returnAt: iso(Date.now() + 12 * 24 * HOUR),
      });
    expect(overridden.status, JSON.stringify(overridden.body)).toBe(201);
    await step(overridden.body.data.id as string, "cancel", { reason: "Test over" }).expect(200);

    const revoked = await api()
      .delete(`/api/v1/customers/${company}/authorised-drivers/${driver}`)
      .set(owner());
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.data.authorisedDrivers).toEqual([]);
  });

  it("refuses the blacklisted and warns about the watchlist", async () => {
    const watched = await customer(person("Yaw"));
    await api()
      .post(`/api/v1/customers/${watched}/risk`)
      .set(owner())
      .send({ status: "watch", reason: "Late returns" })
      .expect(200);
    const booked = await book(watched, 1);
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.data.warnings).toEqual([
      expect.stringContaining("on the watchlist: Late returns"),
    ]);

    await api()
      .post(`/api/v1/customers/${watched}/risk`)
      .set(owner())
      .send({ status: "blacklisted", reason: "Unpaid damage" })
      .expect(200);
    refused(await book(watched, 1), 422, "is blacklisted: Unpaid damage");
    // Blacklisted after booking: the keys stay.
    refused(
      await step(
        booked.body.data.id as string,
        "checkout",
        {
          odometer: 1_000,
          fuel: "full",
          idChecked: true,
          waiveDeposit: true,
        },
        t.ownerAccessToken,
      ),
      422,
      "is blacklisted",
    );
    await step(booked.body.data.id as string, "cancel", { reason: "Test over" }).expect(200);
  });

  it("invoices a late cancellation fee", async () => {
    const booked = await book(renter, 1);
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const id = booked.body.data.id as string;
    const cancelled = await step(id, "cancel", { reason: "Plans changed" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const fee = (cancelled.body.data.charges as { kind: string; total: Amount }[]).find(
      (c) => c.kind === "cancellation_fee",
    )!.total.amountMinor;
    expect(fee).toBeGreaterThan(0);

    // The rental and its reversal cancel out; only the fee is billed.
    const acc = await account(id);
    expect(acc.invoices).toEqual([
      expect.objectContaining({
        status: "issued",
        total: expect.objectContaining({ amountMinor: fee }),
      }),
    ]);
    expect([acc.uninvoiced.amountMinor, acc.balance.amountMinor]).toEqual([0, fee]);
    refused(await step(id, "payments", { amount: "10.00", method: "momo" }), 422, "in finance");
  });
});
