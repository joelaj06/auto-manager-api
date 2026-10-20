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
let driver: string;
let vehicle: string;
let category: string;
let supplier: string;

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const today = day(0);
const range = `from=${day(-6)}&to=${today}`;

const spend = async (amount: string, expenseDate: string) => {
  const created = await api()
    .post("/api/v1/expenses")
    .set(owner())
    .send({
      categoryId: category,
      description: "Tyres",
      payeeType: "supplier",
      payeeId: supplier,
      amount,
      expenseDate,
      vehicleIds: [vehicle],
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const submitted = await api()
    .post(`/api/v1/expenses/${created.body.data.expense.id}/submit`)
    .set(owner());
  expect(submitted.body.data.status).toBe("approved");
};

const vehicleRow = async () => {
  const res = await api().get(`/api/v1/dashboards/vehicles?${range}`).set(owner());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.data.vehicles as { vehicleId: string; days: { working: number } }[]).find(
    (v) => v.vehicleId === vehicle,
  )!;
};

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();

  const tree = await api().get("/api/v1/expense-categories").set(owner());
  category = (tree.body.data as { code: string; id: string }[]).find((c) => c.code === "tyres")!.id;
  supplier = (
    await api().post("/api/v1/suppliers").set(owner()).send({ name: "Tyre Hub", type: "parts" })
  ).body.data.id;
  await api()
    .post("/api/v1/expense-approval-rules")
    .set(owner())
    .send({ name: "Anything", maxAmount: "100000.00", action: "auto_approve", priority: 1 });

  const created = await api()
    .post("/api/v1/drivers")
    .set(owner())
    .send({
      firstName: "Ama",
      lastName: "Owusu",
      phone: `024${digits(7)}`,
      ghanaCardNumber: `GHA-${digits(9)}-1`,
      licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
      licenceClass: "B",
      licenceExpiresOn: "2030-01-01",
    });
  driver = created.body.data.id;
  await api()
    .post(`/api/v1/drivers/${driver}/guarantors`)
    .set(owner())
    .send({ name: "Yaw", phone: `020${digits(7)}` });
  await api().post(`/api/v1/drivers/${driver}/activate`).set(owner()).send({});

  vehicle = (
    await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Toyota", model: "Vitz", plateNumber: `GR ${digits(4)}-26`, odometer: 1_000 })
  ).body.data.id;
  const settings = await api().get("/api/v1/settings/assignments").set(owner());
  const assigned = await api()
    .post(`/api/v1/vehicles/${vehicle}/assignment`)
    .set(owner())
    .send({
      driverId: driver,
      odometer: 1_000,
      checklist: {
        items: (settings.body.data.handoverItems as { key: string }[]).map((i) => ({
          key: i.key,
          ok: true,
        })),
      },
      terms: { mode: "fixed_target", target: "250.00", frequency: "daily" },
      startedAt: new Date(`${day(-3)}T06:00:00Z`).toISOString(),
    });
  expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);

  // Days -3 and -2 are past their grace day: their targets are income owed by the driver.
  await t.tenant.run(() =>
    container.get<RemittanceScheduler>(TYPES.RemittanceScheduler).run(today),
  );
  const rows = await api().get(`/api/v1/remittances?driverId=${driver}`).set(owner());
  const todays = (rows.body.data as { id: string; periodStart: string }[]).find(
    (r) => r.periodStart === today,
  )!;
  const paid = await api()
    .post(`/api/v1/remittances/${todays.id}/record`)
    .set(owner())
    .send({ amount: "250.00", method: "bank_transfer" });
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);

  await api().post(`/api/v1/vehicles/${vehicle}/odometer`).set(owner()).send({ value: 1_420 });
  await spend("300.00", today);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("vehicle P&L", () => {
  it("shows income, costs, distance and profit from the daily stats", async () => {
    const row = await vehicleRow();
    expect(row).toMatchObject({
      income: { total: { amountMinor: 75_000 }, remittances: { amountMinor: 75_000 } },
      costs: { amountMinor: 30_000 },
      depreciation: { amountMinor: 0 },
      profit: { amountMinor: 45_000 },
      distance: { value: 420, unit: "km" },
      costPerDistance: { amountMinor: 71 },
    });
    expect(row.days.working).toBeGreaterThanOrEqual(1);
  });

  it("picks up a back-dated expense on the next read", async () => {
    await spend("100.00", day(-5));
    const row = await vehicleRow();
    expect(row).toMatchObject({
      costs: { amountMinor: 40_000 },
      profit: { amountMinor: 35_000 },
    });

    const trend = await api()
      .get(`/api/v1/vehicles/${vehicle}/profit?${range}&groupBy=day`)
      .set(owner());
    expect(trend.status, JSON.stringify(trend.body)).toBe(200);
    expect(trend.body.data.series).toHaveLength(7);
    expect(trend.body.data.series[1]).toMatchObject({
      key: day(-5),
      costs: { amountMinor: 10_000 },
    });
  });

  it("rebuilds on request", async () => {
    const res = await api().post("/api/v1/dashboards/stats/rebuild").set(owner());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.rows).toBeGreaterThanOrEqual(0);
  });
});

describe("dashboards", () => {
  it("separates revenue by source from cash collected and compares with the period before", async () => {
    const res = await api().get(`/api/v1/dashboards/overview?${range}`).set(owner());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      period: { from: day(-6), to: today, groupBy: "day" },
      revenue: {
        total: { amountMinor: 75_000 },
        bySource: { remittances: { amountMinor: 75_000 } },
      },
      costs: { total: { amountMinor: 40_000 } },
      net: { amountMinor: 35_000 },
      cash: { in: { amountMinor: 25_000 } },
      previous: { to: day(-7), revenue: { amountMinor: 0 } },
    });
    expect(res.body.data.series).toHaveLength(7);
  });

  it("shows remittances expected against received with the drivers short", async () => {
    const res = await api().get(`/api/v1/dashboards/remittances?${range}`).set(owner());
    expect(res.body.data).toMatchObject({
      expected: { amountMinor: 100_000 },
      received: { amountMinor: 25_000 },
      outstanding: { amountMinor: 75_000 },
      collectionRatePercent: 25,
      periods: 4,
    });
    expect(res.body.data.driversShort[0]).toMatchObject({
      driverId: driver,
      periods: 3,
      outstanding: { amountMinor: 75_000 },
    });
  });

  it("shows approved spending by category and vehicle", async () => {
    const res = await api().get(`/api/v1/dashboards/expenses?${range}`).set(owner());
    expect(res.body.data).toMatchObject({
      total: { amountMinor: 40_000 },
      count: 2,
      byCategory: [{ categoryId: category, count: 2, amount: { amountMinor: 40_000 } }],
      topVehicles: [{ vehicleId: vehicle, amount: { amountMinor: 40_000 } }],
      pendingApproval: { count: 0 },
    });
    expect(Array.isArray(res.body.data.budgets)).toBe(true);
  });

  // Audit H12: a month has as many weekly points as the ISO weeks it touches.
  it("charts a month by real calendar weeks", async () => {
    const res = await api()
      .get("/api/v1/dashboards/expenses?from=2026-08-01&to=2026-08-31&groupBy=week")
      .set(owner());
    expect((res.body.data.series as { key: string }[]).map((p) => p.key)).toEqual([
      "2026-W31",
      "2026-W32",
      "2026-W33",
      "2026-W34",
      "2026-W35",
      "2026-W36",
    ]);
  });

  it("refuses an inverted period", async () => {
    const res = await api()
      .get(`/api/v1/dashboards/overview?from=${today}&to=${day(-1)}`)
      .set(owner());
    expect([res.status, res.body.error.code]).toEqual([422, "REPORT_RANGE"]);
  });
});
