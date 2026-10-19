import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RemittanceScheduler } from "../../application/use-cases/remittances/RemittanceScheduler.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

let container: Container;
let app: Express;
let t: ProvisionedTenant;
let checklist: { items: { key: string; ok: boolean }[] };
let driver: string;

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const today = day(0);

async function activeDriver(): Promise<string> {
  const created = await api()
    .post("/api/v1/drivers")
    .set(owner())
    .send({
      firstName: "Kwame",
      lastName: "Mensah",
      phone: `024${digits(7)}`,
      ghanaCardNumber: `GHA-${digits(9)}-1`,
      licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
      licenceClass: "B",
      licenceExpiresOn: "2030-01-01",
    });
  const id = created.body.data.id as string;
  await api()
    .post(`/api/v1/drivers/${id}/guarantors`)
    .set(owner())
    .send({ name: "Yaw", phone: `020${digits(7)}` });
  await api().post(`/api/v1/drivers/${id}/activate`).set(owner()).send({});
  return id;
}

async function assign(
  driverId: string,
  terms: Record<string, unknown>,
  daysAgo: number,
): Promise<string> {
  const vehicle = (
    await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({
        make: "Toyota",
        model: "Corolla",
        plateNumber: `GR ${digits(4)}-26`,
        odometer: 1_000,
      })
  ).body.data.id as string;
  const res = await api()
    .post(`/api/v1/vehicles/${vehicle}/assignment`)
    .set(owner())
    .send({
      driverId,
      odometer: 1_000,
      checklist,
      terms,
      startedAt: new Date(`${day(-daysAgo)}T06:00:00Z`).toISOString(),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return vehicle;
}

const runJob = () =>
  t.tenant.run(() => container.get<RemittanceScheduler>(TYPES.RemittanceScheduler).run(today));

const rows = async (driverId: string) =>
  (await api().get(`/api/v1/remittances?driverId=${driverId}`).set(owner())).body.data as {
    id: string;
    periodStart: string;
    status: string;
    received: { amountMinor: number };
    outstanding: { amountMinor: number };
  }[];
const rowOn = async (driverId: string, date: string) =>
  (await rows(driverId)).find((r) => r.periodStart === date)!;
const owes = async (driverId: string) =>
  (await api().get(`/api/v1/drivers/${driverId}/ledger`).set(owner())).body.data.closing
    .amountMinor as number;

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const settings = await api().get("/api/v1/settings/assignments").set(owner());
  checklist = {
    items: (settings.body.data.handoverItems as { key: string }[]).map((i) => ({
      key: i.key,
      ok: true,
    })),
  };
  driver = await activeDriver();
  await assign(driver, { mode: "fixed_target", target: "250.00", frequency: "daily" }, 3);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("remittances", () => {
  it("creates the expected rows and puts past targets on the driver's ledger", async () => {
    await runJob();
    await runJob(); // idempotent
    const all = await rows(driver);
    expect(all.map((r) => [r.periodStart, r.status])).toEqual([
      [day(0), "pending"],
      [day(-1), "pending"],
      [day(-2), "overdue"],
      [day(-3), "overdue"],
    ]);
    expect(await owes(driver)).toBe(50_000);

    await api()
      .patch("/api/v1/settings/remittances")
      .set(owner())
      .send({ shortfallAlertPeriods: 2 });
    const board = await api().get("/api/v1/operations/board").set(owner());
    expect(board.body.data).toMatchObject({
      fleet: { out: 1 },
      remittances: { due: 1, expected: { amountMinor: 25_000 } },
    });
    expect(board.body.data.driversShort[0]).toMatchObject({
      driverId: driver,
      periods: 2,
      outstanding: { amountMinor: 50_000 },
    });
  });

  it("confirms a declaration as a payment that settles the period", async () => {
    const row = await rowOn(driver, today);
    const declared = await api()
      .post(`/api/v1/remittances/${row.id}/submissions`)
      .set(owner())
      .send({
        amount: "250.00",
        method: "momo",
        momoNetwork: "mtn",
        reference: "MTN-1",
        earnings: { uber: 400 },
      });
    expect(declared.status, JSON.stringify(declared.body)).toBe(201);
    expect(declared.body.data.status).toBe("submitted");
    const twice = await api()
      .post(`/api/v1/remittances/${row.id}/submissions`)
      .set(owner())
      .send({ amount: "250.00", method: "cash" });
    expect(twice.body.error.message).toMatch(/already waiting/);

    const approved = await api()
      .post(
        `/api/v1/remittances/${row.id}/submissions/${declared.body.data.submissions[0].id}/approve`,
      )
      .set(owner())
      .send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "paid",
      number: expect.stringMatching(/^RMT-\d{4}-\d{6}$/),
      received: { amountMinor: 25_000 },
    });
    // Today's target accrued on confirmation and was settled: still owes the two overdue days.
    expect(await owes(driver)).toBe(50_000);
  });

  it("records part of a missed day, rejects a false declaration and waives the rest", async () => {
    const missed = await rowOn(driver, day(-3));
    const part = await api()
      .post(`/api/v1/remittances/${missed.id}/record`)
      .set(owner())
      .send({ amount: "100.00", method: "bank_transfer" });
    expect(part.body.data).toMatchObject({
      status: "overdue",
      outstanding: { amountMinor: 15_000 },
    });

    const other = await rowOn(driver, day(-2));
    const claim = await api()
      .post(`/api/v1/remittances/${other.id}/submissions`)
      .set(owner())
      .send({ amount: "250.00", method: "cash" });
    const rejected = await api()
      .post(
        `/api/v1/remittances/${other.id}/submissions/${claim.body.data.submissions[0].id}/reject`,
      )
      .set(owner())
      .send({ reason: "Nothing received" });
    expect(rejected.body.data.status).toBe("overdue");

    const waived = await api()
      .post(`/api/v1/remittances/${missed.id}/waive`)
      .set(owner())
      .send({ reason: "Car broke down at noon" });
    expect(waived.body.data).toMatchObject({ status: "waived", waived: { amountMinor: 15_000 } });
    expect(await owes(driver)).toBe(25_000);
  });

  it("makes the period owed again when its payment is reversed", async () => {
    const row = await api()
      .get(`/api/v1/remittances/${(await rowOn(driver, today)).id}`)
      .set(owner());
    const paymentId = row.body.data.payments[0].paymentId as string;
    const reversed = await api()
      .post(`/api/v1/payments/${paymentId}/reverse`)
      .set(owner())
      .send({ reason: "Bounced" });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect((await rowOn(driver, today)).status).toBe("pending");
    expect(await owes(driver)).toBe(50_000);
  });
});

describe("driver ledger", () => {
  it("adds deductions and bonuses and shows the statement with ageing", async () => {
    await api()
      .post(`/api/v1/drivers/${driver}/ledger/adjustments`)
      .set(owner())
      .send({ kind: "deduction", amount: "50.00", reason: "Traffic fine" });
    const after = await api()
      .post(`/api/v1/drivers/${driver}/ledger/adjustments`)
      .set(owner())
      .send({ kind: "bonus", amount: "20.00", reason: "Clean car award" });
    expect(after.status, JSON.stringify(after.body)).toBe(201);
    const statement = after.body.data;
    expect(statement.closing.amountMinor).toBe(53_000);
    expect(statement.shortfalls).toMatchObject({ periods: 2, total: { amountMinor: 50_000 } });
    expect(statement.lines.at(-1)).toMatchObject({
      credit: { amountMinor: 2_000 },
      balance: { amountMinor: 53_000 },
    });
    const later = await api()
      .get(`/api/v1/drivers/${driver}/ledger?from=${day(1)}`)
      .set(owner());
    expect(later.body.data).toMatchObject({ opening: { amountMinor: 53_000 }, lines: [] });
  });

  it("books a variable period's money as its income", async () => {
    const other = await activeDriver();
    const vehicle = await assign(other, { mode: "variable" }, 2);
    const declared = await api()
      .post("/api/v1/remittances/declare")
      .set(owner())
      .send({
        vehicleId: vehicle,
        periodStart: day(-1),
        periodEnd: day(-1),
        amount: "310.00",
        method: "momo",
        momoNetwork: "telecel",
      });
    expect(declared.status, JSON.stringify(declared.body)).toBe(201);
    await api()
      .post(
        `/api/v1/remittances/${declared.body.data.id}/submissions/${declared.body.data.submissions[0].id}/approve`,
      )
      .set(owner())
      .send({});
    expect(await owes(other)).toBe(0);
    const tb = await api().get("/api/v1/ledger/trial-balance").set(owner());
    expect(tb.body.data.balanced).toBe(true);
    const income = (
      tb.body.data.accounts as { code: string; balance: { amountMinor: number } }[]
    ).find((a) => a.code === "4100")!;
    expect(income.balance.amountMinor).toBeGreaterThanOrEqual(31_000);
  });
});
