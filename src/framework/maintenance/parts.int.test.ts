import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Parts inventory (P6-3) end to end: the catalogue and the parts that fit a vehicle, opening
 * stock and a purchase at average cost (the purchase an expense to the supplier posted to the
 * inventory), a transfer between branches, parts issued to a work order on completion, a count
 * taking the stock to its reorder level with the alert, and the ledger agreeing throughout.
 */
let container: Container;
let app: Express;
let t: ProvisionedTenant;
let hq: string;
let kumasi: string;
let supplier: string;

type Money = { amountMinor: number };
type StockView = {
  branchId: string;
  onHand: number;
  avgCost: Money;
  value: Money;
  low: boolean;
  reorderLevel: number | null;
};

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");

async function vehicle(make: string, model: string): Promise<string> {
  const res = await api()
    .post("/api/v1/vehicles")
    .set(owner())
    .send({ make, model, plateNumber: `GR ${digits(4)}-26`, odometer: 20_000 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

/** An account's balance from the trial balance, which must balance. */
async function balance(code: string): Promise<number> {
  const tb = await api().get("/api/v1/ledger/trial-balance").set(owner());
  expect(tb.body.data.balanced).toBe(true);
  return (
    (tb.body.data.accounts as { code: string; balance: Money }[]).find((a) => a.code === code)
      ?.balance.amountMinor ?? 0
  );
}

const at = (part: string, branch: string, path: string, body: Record<string, unknown>) =>
  api().post(`/api/v1/parts/${part}/stock/${branch}/${path}`).set(owner()).send(body);

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const branches = await api().get("/api/v1/branches").set(owner());
  hq = (branches.body.data as { id: string; isDefault: boolean }[]).find((b) => b.isDefault)!.id;
  const branch = await api()
    .post("/api/v1/branches")
    .set(owner())
    .send({ code: "KSI", name: "Kumasi" });
  expect(branch.status, JSON.stringify(branch.body)).toBe(201);
  kumasi = branch.body.data.id as string;
  const created = await api()
    .post("/api/v1/suppliers")
    .set(owner())
    .send({ name: "Abossey Okai Spares", type: "parts" });
  supplier = created.body.data.id as string;
  await api()
    .post("/api/v1/expense-approval-rules")
    .set(owner())
    .send({ name: "Small spend", maxAmount: "5000.00", action: "auto_approve", priority: 10 })
    .expect(201);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("parts inventory", () => {
  it("stocks parts at average cost, issues them to work orders and alerts at the reorder level", async () => {
    // --- the catalogue ---
    const filter = await api()
      .post("/api/v1/parts")
      .set(owner())
      .send({
        sku: "of-1",
        name: "Oil filter",
        category: "Filters",
        compatible: [{ make: "Toyota", model: "Corolla" }],
      });
    expect(filter.status, JSON.stringify(filter.body)).toBe(201);
    expect(filter.body.data).toMatchObject({ sku: "OF-1", unit: "each" });
    const filterId = filter.body.data.id as string;
    const oil = await api()
      .post("/api/v1/parts")
      .set(owner())
      .send({ sku: "OIL-5W30", name: "Engine oil 5W-30", unit: "litre" });
    const oilId = oil.body.data.id as string;
    const dup = await api().post("/api/v1/parts").set(owner()).send({ sku: "OF-1", name: "Again" });
    expect([dup.status, dup.body.error.message]).toEqual([422, "There is already a part OF-1"]);
    const corolla = await vehicle("Toyota", "Corolla");
    const almera = await vehicle("Nissan", "Almera");
    const fits = async (id: string) =>
      (
        (await api().get(`/api/v1/parts?vehicleId=${id}`).set(owner())).body.data as {
          sku: string;
        }[]
      )
        .map((p) => p.sku)
        .sort();
    expect(await fits(corolla)).toEqual(["OF-1", "OIL-5W30"]);
    expect(await fits(almera)).toEqual(["OIL-5W30"]);

    // --- opening stock and a purchase: the average cost ---
    const opened = await at(filterId, hq, "opening", { quantity: 4, unitCost: "40.00" });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.data).toMatchObject({ onHand: 4, avgCost: { amountMinor: 4_000 } });
    const bought = await at(filterId, hq, "receipts", {
      quantity: 6,
      unitCost: "50.00",
      supplierId: supplier,
      reference: "INV-77",
    });
    expect(bought.status, JSON.stringify(bought.body)).toBe(201);
    expect(bought.body.data).toMatchObject({
      onHand: 10,
      avgCost: { amountMinor: 4_600 },
      value: { amountMinor: 46_000 },
    });
    const expense = await api().get(`/api/v1/expenses/${bought.body.data.expenseId}`).set(owner());
    expect(expense.body.data).toMatchObject({
      status: "approved",
      amount: { amountMinor: 30_000 },
    });
    expect(await balance("1400")).toBe(46_000);
    expect(await balance("3000")).toBe(16_000);
    // Never stocked here: not priced on a work order.
    await at(oilId, kumasi, "opening", { quantity: 20, unitCost: "35.00" }).expect(201);

    // --- the reorder level, and a transfer to Kumasi ---
    const level = await api()
      .put(`/api/v1/parts/${filterId}/stock/${hq}`)
      .set(owner())
      .send({ reorderLevel: 3, reorderQty: 10, location: "Shelf A-2" });
    expect(level.body.data).toMatchObject({ reorderLevel: 3, location: "Shelf A-2", low: false });
    const moved = await api()
      .post(`/api/v1/parts/${filterId}/transfers`)
      .set(owner())
      .send({ fromBranchId: hq, toBranchId: kumasi, quantity: 3 });
    expect(moved.status, JSON.stringify(moved.body)).toBe(201);
    expect((moved.body.data as StockView[]).map((s) => [s.onHand, s.avgCost.amountMinor])).toEqual([
      [7, 4_600],
      [3, 4_600],
    ]);
    const tooMany = await api()
      .post(`/api/v1/parts/${filterId}/transfers`)
      .set(owner())
      .send({ fromBranchId: kumasi, toBranchId: hq, quantity: 4 });
    expect(tooMany.body.error.message).toBe(
      "Only 3 of Oil filter (OF-1) in stock: 4 cannot be taken",
    );

    // --- a work order with parts from stock ---
    const noStock = await api()
      .post("/api/v1/work-orders")
      .set(owner())
      .send({
        vehicleId: corolla,
        type: "preventive",
        title: "Oil change",
        lines: [{ kind: "part", description: "Oil", quantity: 4, partId: oilId }],
      });
    expect(noStock.body.error.message).toMatch(/never been stocked at the work order's branch/);
    const job = await api()
      .post("/api/v1/work-orders")
      .set(owner())
      .send({
        vehicleId: corolla,
        type: "preventive",
        title: "Oil change",
        lines: [
          { kind: "labour", description: "Change filter", quantity: 1, unitCost: "50.00" },
          { kind: "part", description: "Oil filter", quantity: 2, partId: filterId },
        ],
      });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    expect(job.body.data.lines[1]).toMatchObject({
      partId: filterId,
      unitCost: { amountMinor: 4_600 },
    });
    expect(job.body.data.total).toMatchObject({ amountMinor: 14_200 });
    const big = await api()
      .post("/api/v1/work-orders")
      .set(owner())
      .send({
        vehicleId: corolla,
        type: "corrective",
        title: "Fleet stock-up",
        lines: [{ kind: "part", description: "Filters", quantity: 50, partId: filterId }],
      });
    const short = await api()
      .post(`/api/v1/work-orders/${big.body.data.id}/complete`)
      .set(owner())
      .send({});
    expect(short.body.error.message).toBe(
      "Only 7 of Oil filter (OF-1) in stock: 50 cannot be taken",
    );
    await api()
      .post(`/api/v1/work-orders/${big.body.data.id}/cancel`)
      .set(owner())
      .send({ reason: "Raised by mistake" })
      .expect(200);

    const vehicleExpenses = await balance("5000");
    const done = await api()
      .post(`/api/v1/work-orders/${job.body.data.id}/complete`)
      .set(owner())
      .send({});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // In-house labour and parts from stock: no expense, the parts' cost out of the inventory.
    expect(done.body.data).toMatchObject({ status: "completed", expenseId: null });
    expect(await balance("5000")).toBe(vehicleExpenses + 9_200);
    expect(await balance("1400")).toBe(46_000 + 70_000 - 9_200);
    const issued = await api()
      .get(`/api/v1/part-moves?workOrderId=${job.body.data.id}`)
      .set(owner());
    expect(issued.body.data).toEqual([
      expect.objectContaining({
        kind: "issue",
        quantity: -2,
        onHandAfter: 5,
        reference: done.body.data.number,
        value: expect.objectContaining({ amountMinor: -9_200 }),
      }),
    ]);

    // --- a count down to the reorder level: the alert, once ---
    const counted = await at(filterId, hq, "counts", {
      counted: 3,
      reason: "Two crushed in the store",
    });
    expect(counted.status, JSON.stringify(counted.body)).toBe(201);
    expect(counted.body.data).toMatchObject({ onHand: 3, low: true });
    expect(await balance("5010")).toBe(9_200);
    const same = await at(filterId, hq, "counts", { counted: 3, reason: "Recount" });
    expect(same.body.error.message).toBe("Oil filter (OF-1): the count matches the stock");
    const inbox = await api().get("/api/v1/notifications?limit=50").set(owner());
    expect(
      (inbox.body.data as { title: string }[]).filter(
        (n) => n.title === "Oil filter is low: 3 left",
      ),
    ).toHaveLength(1);
    const low = await api().get(`/api/v1/part-stock?low=true`).set(owner());
    expect((low.body.data as StockView[]).map((s) => [s.branchId, s.onHand])).toEqual([[hq, 3]]);

    // --- the part with its stock at each branch and its moves ---
    const detail = await api().get(`/api/v1/parts/${filterId}`).set(owner());
    expect(
      (detail.body.data.stock as StockView[])
        .map((s) => [s.branchId, s.onHand, s.value.amountMinor])
        .sort(),
    ).toEqual(
      [
        [hq, 3, 13_800],
        [kumasi, 3, 13_800],
      ].sort(),
    );
    const moves = await api()
      .get(`/api/v1/part-moves?partId=${filterId}&branchId=${hq}`)
      .set(owner());
    expect((moves.body.data as { kind: string }[]).map((m) => m.kind)).toEqual([
      "adjustment",
      "issue",
      "transfer_out",
      "receipt",
      "opening",
    ]);

    // --- no longer stocked ---
    await api().patch(`/api/v1/parts/${filterId}`).set(owner()).send({ active: false }).expect(200);
    const retired = await at(filterId, hq, "opening", { quantity: 1, unitCost: "40.00" });
    expect(retired.body.error.message).toBe("Oil filter (OF-1) is no longer stocked");
    expect(await fits(corolla)).toEqual(["OIL-5W30"]);
  });
});
