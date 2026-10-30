import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RemittanceScheduler } from "../../application/use-cases/remittances/RemittanceScheduler.js";
import type { Reports } from "../../application/use-cases/reporting/Reports.js";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * The report catalogue (P8-2) end to end: every report in the catalogue runs for the owner with
 * its parameters and returns a well-formed table, and the figures of a small business — a driver
 * on a fixed target who paid one day by bank transfer, a tyre bill on their vehicle — agree
 * across the executive, fleet, driver and finance reports; one is built as a file.
 */
let container: Container;
let app: Express;
let t: ProvisionedTenant;
let driver: string;
let vehicle: string;
let plate: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by expect()
type Body = any;
type Column = { key: string; type: string };

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const today = day(0);
const period = { from: day(-6), to: today };
const run = async (report: string, params: Record<string, string> = period): Promise<Body> => {
  const res = await api().post(`/api/v1/reports/${report}/run`).set(owner()).send({ params });
  expect(res.status, `${report}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.data;
};
const row = (table: Body, key: string, value: string): Body =>
  (table.rows as Body[]).find((r) => r[key] === value);

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();

  const tree = await api().get("/api/v1/expense-categories").set(owner());
  const category = (tree.body.data as { code: string; id: string }[]).find(
    (c) => c.code === "tyres",
  )!.id;
  const supplier = (
    await api().post("/api/v1/suppliers").set(owner()).send({ name: "Tyre Hub", type: "parts" })
  ).body.data.id as string;
  await api()
    .post("/api/v1/expense-approval-rules")
    .set(owner())
    .send({ name: "Anything", maxAmount: "100000.00", action: "auto_approve", priority: 1 });

  driver = (
    await api()
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
      })
  ).body.data.id as string;
  await api()
    .post(`/api/v1/drivers/${driver}/guarantors`)
    .set(owner())
    .send({ name: "Yaw", phone: `020${digits(7)}` });
  await api().post(`/api/v1/drivers/${driver}/activate`).set(owner()).send({});

  plate = `GR ${digits(4)}-26`;
  vehicle = (
    await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Toyota", model: "Vitz", plateNumber: plate, odometer: 1_000 })
  ).body.data.id as string;
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
  await t.tenant.run(() =>
    container.get<RemittanceScheduler>(TYPES.RemittanceScheduler).run(today),
  );
  const remittances = await api().get(`/api/v1/remittances?driverId=${driver}`).set(owner());
  const todays = (remittances.body.data as { id: string; periodStart: string }[]).find(
    (r) => r.periodStart === today,
  )!;
  const paid = await api()
    .post(`/api/v1/remittances/${todays.id}/record`)
    .set(owner())
    .send({ amount: "250.00", method: "bank_transfer" });
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  await api().post(`/api/v1/vehicles/${vehicle}/odometer`).set(owner()).send({ value: 1_420 });

  const expense = await api()
    .post("/api/v1/expenses")
    .set(owner())
    .send({
      categoryId: category,
      description: "Tyres",
      payeeType: "supplier",
      payeeId: supplier,
      amount: "300.00",
      expenseDate: today,
      vehicleIds: [vehicle],
    });
  expect(expense.status, JSON.stringify(expense.body)).toBe(201);
  await api().post(`/api/v1/expenses/${expense.body.data.expense.id}/submit`).set(owner());
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("report catalogue", () => {
  it("offers every report of docs/14 §3 in each category, and each runs to a well-formed table", async () => {
    const res = await api().get("/api/v1/reports").set(owner());
    expect(res.status).toBe(200);
    const catalogue = res.body.data as {
      id: string;
      category: string;
      params: { key: string; type: string; required: boolean }[];
    }[];
    expect(new Set(catalogue.map((r) => r.id)).size).toBe(catalogue.length);
    expect(new Set(catalogue.map((r) => r.category))).toEqual(
      new Set([
        "executive",
        "fleet",
        "drivers",
        "workpay",
        "rentals",
        "dealer",
        "maintenance",
        "finance",
      ]),
    );
    expect(catalogue.length).toBeGreaterThanOrEqual(46);

    const value = (key: string, type: string) =>
      key === "driverId" ? driver : type === "month" ? today.slice(0, 7) : period[key as "from"];
    for (const report of catalogue) {
      if (report.id === "workpay_statement") continue;
      const params = Object.fromEntries(
        report.params
          .filter((p) => p.required || p.key === "from" || p.key === "to")
          .map((p) => [p.key, value(p.key, p.type)]),
      );
      const table = await run(report.id, params);
      const keys = (table.columns as Column[]).map((c) => c.key);
      expect(new Set(keys).size, report.id).toBe(keys.length);
      for (const line of [
        ...(table.rows as Body[]),
        ...(table.totals === null ? [] : [table.totals]),
      ])
        for (const [key, cell] of Object.entries(line as Record<string, unknown>)) {
          expect(keys, `${report.id}.${key}`).toContain(key);
          const column = (table.columns as Column[]).find((c) => c.key === key)!;
          if (column.type === "money" && cell !== null && typeof cell === "object")
            expect(Number.isInteger((cell as { amountMinor: number }).amountMinor)).toBe(true);
        }
    }
    // An agreement that does not exist is not found.
    const missing = await api()
      .post("/api/v1/reports/workpay_statement/run")
      .set(owner())
      .send({ params: { agreementId: randomUUID() } });
    expect(missing.status).toBe(404);
  });

  it("agrees on the figures across executive, fleet and driver reports", async () => {
    const pnl = await run("vehicle_pnl");
    expect(pnl.totals).toMatchObject({
      income: { amountMinor: 75_000 },
      costs: { amountMinor: 30_000 },
      profit: { amountMinor: 45_000 },
    });
    const overview = await run("business_overview");
    expect(row(overview, "item", "Remittances").amount.amountMinor).toBe(75_000);
    expect(row(overview, "item", "Cash in").amount.amountMinor).toBe(25_000);

    const register = await run("fleet_register", {});
    expect(row(register, "plate", plate)).toMatchObject({
      vehicle: "Toyota Vitz",
      status: "assigned",
      driver: "Ama Owusu",
      odometer: 1_420,
    });
    const mileage = await run("mileage");
    expect(mileage.rows[0]).toMatchObject({ distance: 420, unit: "km" });

    const compliance = await run("remittance_compliance");
    const ama = row(compliance, "driver", "Ama Owusu");
    expect(ama.received.amountMinor).toBe(25_000);
    expect(ama.outstanding.amountMinor).toBe(ama.expected.amountMinor - 25_000);

    const statement = await run("driver_statement", { driverId: driver });
    expect(statement.title).toContain("Ama Owusu");
    expect(statement.rows[0]).toMatchObject({ description: "Opening balance" });

    const performance = await run("driver_performance");
    expect(row(performance, "driver", "Ama Owusu")).toMatchObject({
      received: { amountMinor: 25_000 },
      incidents: 0,
    });
  });

  it("lists the money in the finance reports and keeps the books balanced", async () => {
    const receipts = await run("payments_register");
    expect(receipts.title).toBe("Receipts register");
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]).toMatchObject({
      method: "bank transfer",
      amountBase: { amountMinor: 25_000 },
      status: "recorded",
    });
    const byMethod = await run("payments_by_method");
    expect(row(byMethod, "method", "bank transfer")).toMatchObject({
      inCount: 1,
      in: { amountMinor: 25_000 },
    });
    const cash = await run("cash_flow");
    expect(cash.totals.in.amountMinor).toBe(25_000);

    const dayBook = await run("day_book");
    expect(dayBook.totals.debit.amountMinor).toBe(dayBook.totals.credit.amountMinor);
    expect(dayBook.summary).toContainEqual({ label: "Balanced", value: "Yes" });

    const tax = await run("tax_report");
    expect((tax.rows as { code: string }[]).map((r) => r.code)).toEqual(
      expect.arrayContaining(["1300", "2200", "2230"]),
    );
    const approvals = await run("expense_approvals");
    expect(approvals.rows[0]).toMatchObject({ status: "approved", description: "Tyres" });
    const expenses = await run("expense_summary");
    expect(expenses.totals.amount.amountMinor).toBe(30_000);
  });

  it("checks report parameters and builds a catalogue report as a file", async () => {
    const bad = await api()
      .post("/api/v1/reports/fleet_profitability/run")
      .set(owner())
      .send({ params: { groupBy: "colour" } });
    expect(bad.status).toBe(422);
    const ranked = await run("fleet_profitability", { ...period, groupBy: "model" });
    expect(row(ranked, "name", "Toyota Vitz")).toMatchObject({ rank: 1, vehicles: 1 });

    const queued = await api()
      .post("/api/v1/reports/fleet_register/run")
      .set(owner())
      .send({ format: "csv" });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    await container
      .get<ITenantContext>(TYPES.TenantContext)
      .runAs(t.tenant.id, () =>
        container.get<Reports>(TYPES.Reports).generate(queued.body.data.id as string),
      );
    const job = await api().get(`/api/v1/reports/jobs/${queued.body.data.id}`).set(owner());
    expect(job.body.data.status).toBe("ready");
    const csv = Buffer.from(await (await fetch(job.body.data.download.url as string)).arrayBuffer())
      .subarray(3)
      .toString("utf8");
    expect(csv.split("\r\n")[0]).toBe(
      "Code,Plate,Make and model,Year,Status,Use,Ownership,Branch,Driver,Odometer,Next document,Expires,Expired",
    );
    expect(csv).toContain(`${plate},Toyota Vitz`);
  });
});
