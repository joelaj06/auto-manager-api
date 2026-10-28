import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PurchaseAlerts } from "../../application/use-cases/purchases/PurchaseAlerts.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Vehicle purchases (P7-3) end to end: an import from a US auction in dollars, ordered (the
 * prices become bills), shipping in dollars shared by value, clearing in cedis shared equally and
 * duty on one car, the landed cost per car, the timeline with ETA and demurrage alerts, receiving
 * each car into the fleet at its landed cost, a late cost following onto the vehicle, and a local
 * purchase cancelled with its bills voided once its paid bill's payment is reversed.
 */
let container: Container;
let app: Express;
let t: ProvisionedTenant;

type Money = { amountMinor: number };
type Line = { id: string; vehicleId: string | null; landedCost: { total: Money; shared: Money } };

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

async function supplier(name: string, type: string): Promise<string> {
  const res = await api().post("/api/v1/suppliers").set(owner()).send({ name, type });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

const post = (path: string, body: Record<string, unknown> = {}) =>
  api().post(path).set(owner()).send(body);

const balanceOf = async (code: string) => {
  const tb = await api().get("/api/v1/ledger/trial-balance").set(owner());
  expect(tb.body.data.balanced).toBe(true);
  return (tb.body.data.accounts as { code: string; balance: { amountMinor: number } }[]).find(
    (a) => a.code === code,
  )!.balance.amountMinor;
};

async function titles(): Promise<string[]> {
  const inbox = await api().get("/api/v1/notifications?limit=100").set(owner());
  return (inbox.body.data as { title: string }[]).map((n) => n.title);
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  await post("/api/v1/expense-approval-rules", {
    name: "Everything",
    action: "auto_approve",
    priority: 1,
  }).expect(201);
  await api()
    .patch("/api/v1/settings/currency")
    .set(owner())
    .send({ enabledCurrencies: ["USD"] })
    .expect(200);
  await post("/api/v1/fx-rates", { quote: "USD", rate: "15", rateDate: day(-60) }).expect(201);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("vehicle purchases", () => {
  it("lands an import's cars at their landed cost and follows late costs", async () => {
    const copart = await supplier("Copart USA", "auction");
    const shipper = await supplier("Grimaldi Lines", "other");
    const agent = await supplier("Tema Clearing Ltd", "clearing_agent");
    const gra = await supplier("Ghana Revenue Authority", "other");
    const vehiclesBefore = await balanceOf("1500");

    // --- a draft from the auction, then ordered: the prices become bills in dollars ---
    const created = await post("/api/v1/purchases", {
      type: "import",
      supplierId: copart,
      currency: "USD",
      reference: "LOT-55120",
      lines: [
        { make: "Toyota", model: "Camry", year: 2019, vin: "4T1B11HK5KU123456", price: "8000.00" },
        { make: "Honda", model: "Civic", year: 2017, price: "2000.00" },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    expect(created.body.data).toMatchObject({
      number: expect.stringMatching(/^PUR-\d{4}-\d{6}$/),
      status: "draft",
      supplierName: "Copart USA",
    });
    const early = await post(`/api/v1/purchases/${id}/costs`, {
      kind: "shipping",
      supplierId: shipper,
      amount: "1.00",
    });
    expect(early.body.error.message).toMatch(/Order the purchase first/);
    const ordered = await post(`/api/v1/purchases/${id}/order`, { orderedOn: day(-30) });
    expect(ordered.status, JSON.stringify(ordered.body)).toBe(200);
    expect(ordered.body.data).toMatchObject({ status: "ordered", stage: "ordered" });
    expect(
      (ordered.body.data.costs as { kind: string; expense: { status: string } }[]).map((c) => [
        c.kind,
        c.expense.status,
      ]),
    ).toEqual([
      ["vehicle_price", "approved"],
      ["vehicle_price", "approved"],
    ]);
    const [camry, civic] = ordered.body.data.lines as Line[];

    // --- shipping in dollars by value, clearing in cedis equally, duty on the Camry ---
    for (const cost of [
      { kind: "shipping", supplierId: shipper, amount: "1000.00", currency: "USD" },
      { kind: "clearing", supplierId: agent, amount: "5000.00", allocation: "equal" },
      { kind: "import_duty", supplierId: gra, amount: "10000.00", lineId: camry!.id },
    ]) {
      const res = await post(`/api/v1/purchases/${id}/costs`, cost);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const landed = await api().get(`/api/v1/purchases/${id}/landed-cost`).set(owner());
    expect(landed.status, JSON.stringify(landed.body)).toBe(200);
    expect(
      (
        landed.body.data.lines as { price: Money; direct: Money; shared: Money; total: Money }[]
      ).map((l) => [
        l.price.amountMinor,
        l.direct.amountMinor,
        l.shared.amountMinor,
        l.total.amountMinor,
      ]),
    ).toEqual([
      [12_000_000, 1_000_000, 1_450_000, 14_450_000],
      [3_000_000, 0, 550_000, 3_550_000],
    ]);
    expect(landed.body.data.totals.capitalised.amountMinor).toBe(18_000_000);
    expect(await balanceOf("1500")).toBe(vehiclesBefore + 18_000_000);

    // --- the timeline: shipped past its ETA, then at the port nearing its free days ---
    await api()
      .patch(`/api/v1/purchases/${id}/shipping`)
      .set(owner())
      .send({ vessel: "Grande Ghana", billOfLading: "GRI-889", eta: day(-1), portFreeDays: 3 })
      .expect(200);
    await post(`/api/v1/purchases/${id}/stage`, { stage: "shipped", on: day(-20) }).expect(200);
    const alerts = container.get<PurchaseAlerts>(TYPES.PurchaseAlerts);
    const number = created.body.data.number as string;
    await t.tenant.run(() => alerts.run(day(0)));
    await t.tenant.run(() => alerts.run(day(0)));
    expect(
      (await titles()).filter((x) => x === `${number} was due at the port on ${day(-1)}`),
    ).toHaveLength(1);
    const back = await post(`/api/v1/purchases/${id}/stage`, { stage: "paid" });
    expect(back.body.error.message).toMatch(/already at shipped/);
    await post(`/api/v1/purchases/${id}/stage`, { stage: "arrived_port", on: day(-2) }).expect(200);
    await t.tenant.run(() => alerts.run(day(0)));
    expect(
      (await titles()).filter((x) => x === `${number}: free days at the port end on ${day(1)}`),
    ).toHaveLength(1);
    await t.tenant.run(() => alerts.run(day(1)));
    expect((await titles()).filter((x) => x === `${number} is paying demurrage`)).toHaveLength(1);
    const released = await post(`/api/v1/purchases/${id}/stage`, {
      stage: "released",
      note: "Duty paid, gate pass issued",
    });
    expect(released.body.data).toMatchObject({ stage: "released", daysAtPort: 2 });

    // --- receiving the Camry registers it at its landed cost ---
    const received = await post(`/api/v1/purchases/${id}/lines/${camry!.id}/receive`, {
      plateNumber: "GR 4410-26",
      odometer: 42_000,
    });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    const vehicleId = (received.body.data.lines as Line[])[0]!.vehicleId!;
    const vehicle = async () =>
      (await api().get(`/api/v1/vehicles/${vehicleId}`).set(owner())).body.data as {
        financials: { acquisitionCost: Money };
      };
    expect(await vehicle()).toMatchObject({
      make: "Toyota",
      model: "Camry",
      vin: "4T1B11HK5KU123456",
      status: "reconditioning",
      financials: { acquisitionDate: day(0), acquisitionCost: { amountMinor: 14_450_000 } },
    });
    const twice = await post(`/api/v1/purchases/${id}/lines/${camry!.id}/receive`);
    expect(twice.body.error.message).toMatch(/already received/);

    // --- a late cost follows onto the vehicle, and leaves it when removed ---
    const late = await post(`/api/v1/purchases/${id}/costs`, {
      kind: "registration",
      supplierId: gra,
      amount: "1000.00",
      lineId: camry!.id,
    });
    expect(late.status, JSON.stringify(late.body)).toBe(201);
    expect((await vehicle()).financials.acquisitionCost.amountMinor).toBe(14_550_000);
    const lateCost = (late.body.data.costs as { id: string; kind: string }[]).find(
      (c) => c.kind === "registration",
    )!;
    const removed = await post(`/api/v1/purchases/${id}/costs/${lateCost.id}/remove`, {
      reason: "Entered twice",
    });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await vehicle()).financials.acquisitionCost.amountMinor).toBe(14_450_000);

    // --- the Civic closes the purchase ---
    const done = await post(`/api/v1/purchases/${id}/lines/${civic!.id}/receive`, {
      usage: "stock",
      status: "available",
    });
    expect(done.body.data).toMatchObject({ status: "received", receivedOn: day(0) });
    expect(
      (done.body.data.events as { kind: string; stage: string | null }[]).map((e) =>
        e.stage === null ? e.kind : `${e.kind}:${e.stage}`,
      ),
    ).toEqual([
      "created",
      "ordered",
      "stage:shipped",
      "stage:arrived_port",
      "stage:released",
      "received",
      "received",
    ]);
  });

  it("cancels a local purchase once its paid bill's payment is reversed", async () => {
    const dealer = await supplier("Accra Auto Mart", "dealer");
    const vehiclesBefore = await balanceOf("1500");
    const created = await post("/api/v1/purchases", {
      type: "local",
      supplierId: dealer,
      lines: [{ make: "Kia", model: "Picanto", year: 2016, price: "45000.00" }],
    });
    const id = created.body.data.id as string;
    const ordered = await post(`/api/v1/purchases/${id}/order`);
    expect(ordered.body.data.stage).toBeNull();
    const expenseId = ordered.body.data.costs[0].expense.id as string;
    const paid = await post(`/api/v1/expenses/${expenseId}/pay`, { method: "bank_transfer" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);

    const refused = await post(`/api/v1/purchases/${id}/cancel`, {
      reason: "Car failed inspection",
    });
    expect(refused.body.error.message).toMatch(/already paid/);
    await post(`/api/v1/payments/${paid.body.data.paymentId}/reverse`, {
      reason: "Refunded by the dealer",
    }).expect(200);
    const cancelled = await post(`/api/v1/purchases/${id}/cancel`, {
      reason: "Car failed inspection",
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data).toMatchObject({
      status: "cancelled",
      totals: { capitalised: { amountMinor: 0 } },
    });
    expect(cancelled.body.data.costs[0].expense.status).toBe("void");
    expect(await balanceOf("1500")).toBe(vehiclesBefore);
    const list = await api().get("/api/v1/purchases?status=cancelled").set(owner());
    expect((list.body.data as { id: string }[]).map((p) => p.id)).toContain(id);
  });
});
