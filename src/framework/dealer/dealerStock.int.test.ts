import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StockAlerts } from "../../application/use-cases/dealer/StockAlerts.js";
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
 * Dealer stock (P7-4) end to end: a trade-in taken into stock in reconditioning with its spend and
 * holding cost, made ready, priced (with history), listed (the vehicle goes for sale), cost and
 * minimum price hidden from sales staff, transferred to another branch, taken off sale, withdrawn
 * and restocked; a consignment on commission; ageing, the days-in-stock filter and the aged-stock
 * alert; and a purchase received for stock.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let sales: string;
let kumasi: string;

type Money = { amountMinor: number };

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const digits = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
const post = (path: string, body: Record<string, unknown> = {}, headers = owner()) =>
  api().post(path).set(headers).send(body);
const stockOf = (id: string, headers = owner()) =>
  api().get(`/api/v1/dealer/stock/${id}`).set(headers);

async function join(roleId: string): Promise<string> {
  const email = `user-${randomUUID().slice(0, 8)}@example.com`;
  const branches = await api().get("/api/v1/branches").set(owner());
  const invited = await api()
    .post("/api/v1/users/invitations")
    .set(owner())
    .send({
      name: "Sales",
      email,
      branchIds: (branches.body.data as { id: string }[]).map((b) => b.id),
      roles: [{ roleId, branchId: null }],
    });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries where recipient = $1
      and template = 'tenant.user_invitation' order by created_at desc limit 1`,
    [email],
  );
  const token = /#token=([A-Za-z0-9_-]+)/.exec(rows[0]!.body_text)![1]!;
  const accepted = await api()
    .post("/api/v1/auth/invitations/accept")
    .set("X-Tenant", t.slug)
    .send({ token, password: OWNER_PASSWORD });
  return accepted.body.data.accessToken as string;
}

async function vehicle(body: Record<string, unknown>): Promise<string> {
  const res = await post("/api/v1/vehicles", {
    make: "Toyota",
    model: "Corolla",
    year: 2018,
    plateNumber: `GR ${digits(4)}-26`,
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function vehicleOf(id: string) {
  const res = await api().get(`/api/v1/vehicles/${id}`).set(owner());
  return res.body.data as {
    status: string;
    usage: string;
    ownershipType: string;
    branchId: string;
  };
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  await post("/api/v1/expense-approval-rules", {
    name: "Everything",
    action: "auto_approve",
    priority: 1,
  }).expect(201);
  const branch = await post("/api/v1/branches", { code: "KSI", name: "Kumasi" });
  expect(branch.status, JSON.stringify(branch.body)).toBe(201);
  kumasi = branch.body.data.id as string;
  const role = await post("/api/v1/roles", {
    name: "Sales floor",
    grants: [
      { key: "dealer.stock.list", scope: "all" },
      { key: "dealer.stock.view", scope: "all" },
      { key: "dealer.stock.list_for_sale", scope: "all" },
    ],
  });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  sales = await join(role.body.data.id as string);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("dealer stock", () => {
  it("takes a trade-in through reconditioning, pricing, listing, transfer and withdrawal", async () => {
    const id = await vehicle({
      status: "reconditioning",
      financials: { acquisitionDate: day(-40), acquisitionCost: "40000.00" },
    });

    // --- into stock 40 days ago at GHS 20 a day ---
    const added = await post("/api/v1/dealer/stock", {
      vehicleId: id,
      source: "trade_in",
      stockedOn: day(-40),
      holdingCostPerDay: "20.00",
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.data).toMatchObject({
      status: "reconditioning",
      source: "trade_in",
      daysInStock: 40,
      ageing: "days31to60",
      askingPrice: null,
      cost: {
        acquisition: { amountMinor: 40_000_00 },
        reconditioning: { amountMinor: 0 },
        holding: { amountMinor: 800_00 },
        total: { amountMinor: 40_800_00 },
      },
    });
    expect(await vehicleOf(id)).toMatchObject({ status: "reconditioning", usage: "stock" });
    const twice = await post("/api/v1/dealer/stock", { vehicleId: id, source: "other" });
    expect(twice.status).toBe(422);

    // --- reconditioning spend on the vehicle counts towards its cost ---
    const categories = await api().get("/api/v1/expense-categories").set(owner());
    const insurance = (categories.body.data as { code: string; id: string }[]).find(
      (c) => c.code === "insurance",
    )!.id;
    const spent = await post("/api/v1/expenses", {
      categoryId: insurance,
      description: "Respray",
      payeeName: "Kwame's Body Shop",
      amount: "1500.00",
      expenseDate: day(-10),
      vehicleIds: [id],
    });
    expect(spent.status, JSON.stringify(spent.body)).toBe(201);
    const submitted = await post(`/api/v1/expenses/${spent.body.data.expense.id}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data.status).toBe("approved");

    const early = await post(`/api/v1/dealer/stock/${id}/list`);
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/Only a ready vehicle is listed/);
    const ready = await post(`/api/v1/dealer/stock/${id}/ready`);
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(ready.body.data).toMatchObject({
      status: "ready",
      cost: { reconditioning: { amountMinor: 1_500_00 }, total: { amountMinor: 42_300_00 } },
    });
    expect((await vehicleOf(id)).status).toBe("available");

    // --- priced, listed, then reduced: the minimum stays ---
    const priced = await api()
      .patch(`/api/v1/dealer/stock/${id}/pricing`)
      .set(owner())
      .send({ askingPrice: "55000.00", minimumPrice: "50000.00", reason: "First price" });
    expect(priced.status, JSON.stringify(priced.body)).toBe(200);
    expect(priced.body.data).toMatchObject({
      askingPrice: { amountMinor: 55_000_00 },
      minimumPrice: { amountMinor: 50_000_00 },
      margin: { amount: { amountMinor: 12_700_00 }, percent: "23.1" },
    });
    const bad = await api()
      .patch(`/api/v1/dealer/stock/${id}/pricing`)
      .set(owner())
      .send({ askingPrice: "45000.00" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/minimum price is above the asking price/);
    const listed = await post(`/api/v1/dealer/stock/${id}/list`, {}, as(sales));
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data).toMatchObject({ status: "listed", listedOn: day(0) });
    expect((await vehicleOf(id)).status).toBe("for_sale");
    await api()
      .patch(`/api/v1/dealer/stock/${id}/pricing`)
      .set(owner())
      .send({ askingPrice: "52000.00", reason: "Slow mover" })
      .expect(200);
    const history = await api().get(`/api/v1/dealer/stock/${id}/price-history`).set(owner());
    expect(
      (
        history.body.data as {
          askingPrice: Money;
          previousAskingPrice: Money | null;
          minimumPrice: Money;
          reason: string;
        }[]
      ).map((c) => [
        c.askingPrice.amountMinor,
        c.previousAskingPrice?.amountMinor ?? null,
        c.minimumPrice.amountMinor,
        c.reason,
      ]),
    ).toEqual([
      [55_000_00, null, 50_000_00, "First price"],
      [52_000_00, 55_000_00, 50_000_00, "Slow mover"],
    ]);

    // --- sales staff see the asking price, never cost, minimum or margin ---
    const seen = await stockOf(id, as(sales));
    expect(seen.status).toBe(200);
    expect(seen.body.data.askingPrice.amountMinor).toBe(52_000_00);
    expect(seen.body.data).not.toHaveProperty("cost");
    expect(seen.body.data).not.toHaveProperty("minimumPrice");
    expect(seen.body.data).not.toHaveProperty("margin");
    const theirHistory = await api().get(`/api/v1/dealer/stock/${id}/price-history`).set(as(sales));
    expect(theirHistory.body.data[0]).not.toHaveProperty("minimumPrice");
    const repricing = await api()
      .patch(`/api/v1/dealer/stock/${id}/pricing`)
      .set(as(sales))
      .send({ askingPrice: "1.00" });
    expect(repricing.status).toBe(403);
    const found = await api()
      .get("/api/v1/dealer/stock?status=listed&make=toyota&priceTo=60000")
      .set(as(sales));
    expect((found.body.data as { vehicleId: string }[]).map((s) => s.vehicleId)).toContain(id);
    const tooDear = await api().get("/api/v1/dealer/stock?priceFrom=60000").set(owner());
    expect((tooDear.body.data as { vehicleId: string }[]).map((s) => s.vehicleId)).not.toContain(
      id,
    );

    // --- moved to Kumasi with a transfer record ---
    const moved = await post(`/api/v1/dealer/stock/${id}/transfer`, {
      branchId: kumasi,
      reason: "Better market up north",
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.data.vehicle.branchId).toBe(kumasi);
    expect((await vehicleOf(id)).branchId).toBe(kumasi);
    const again = await post(`/api/v1/dealer/stock/${id}/transfer`, {
      branchId: kumasi,
      reason: "Again",
    });
    expect(again.status).toBe(422);
    const transfers = await api().get(`/api/v1/dealer/stock/${id}/transfers`).set(owner());
    expect(transfers.body.data).toMatchObject([
      { toBranchId: kumasi, reason: "Better market up north", transferredOn: day(0) },
    ]);

    // --- off sale, withdrawn into the rental fleet, then back into stock ---
    await post(`/api/v1/dealer/stock/${id}/unlist`, {}, as(sales)).expect(200);
    expect((await vehicleOf(id)).status).toBe("available");
    const withdrawn = await post(`/api/v1/dealer/stock/${id}/withdraw`, {
      reason: "Needed for rentals",
      usage: "rental",
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.data).toMatchObject({
      status: "withdrawn",
      withdrawnOn: day(0),
      withdrawReason: "Needed for rentals",
    });
    expect(await vehicleOf(id)).toMatchObject({ status: "available", usage: "rental" });
    const restocked = await post("/api/v1/dealer/stock", { vehicleId: id, source: "other" });
    expect(restocked.status, JSON.stringify(restocked.body)).toBe(201);
    expect(restocked.body.data).toMatchObject({
      status: "ready",
      stockedOn: day(0),
      daysInStock: 0,
      withdrawnOn: null,
      askingPrice: { amountMinor: 52_000_00 },
    });
    expect((await vehicleOf(id)).usage).toBe("stock");
  });

  it("sells a customer's car on consignment for a commission", async () => {
    const customer = await post("/api/v1/customers", {
      type: "individual",
      firstName: "Yaw",
      lastName: "Mensah",
      phone: `+23324${digits(7)}`,
    });
    expect(customer.status, JSON.stringify(customer.body)).toBe(201);
    const consignorId = customer.body.data.id as string;
    const id = await vehicle({ make: "Hyundai", model: "Elantra", year: 2016 });

    const missing = await post("/api/v1/dealer/stock", { vehicleId: id, source: "consignment" });
    expect(missing.status).toBe(422);
    expect(missing.body.error.message).toMatch(/consignor/);
    const added = await post("/api/v1/dealer/stock", {
      vehicleId: id,
      source: "consignment",
      consignment: { consignorId, terms: "commission", commissionRate: "10" },
      askingPrice: "30000.00",
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.data).toMatchObject({
      status: "ready",
      consignment: { consignorName: "Yaw Mensah", terms: "commission", commissionRate: "10" },
      cost: {
        acquisition: { amountMinor: 0 },
        consignorPayout: { amountMinor: 27_000_00 },
        total: { amountMinor: 27_000_00 },
      },
      margin: { amount: { amountMinor: 3_000_00 }, percent: "10.0" },
    });
    expect((await vehicleOf(id)).ownershipType).toBe("consigned");

    // --- the terms change to a fixed payout ---
    const fixed = await api()
      .patch(`/api/v1/dealer/stock/${id}`)
      .set(owner())
      .send({ consignment: { consignorId, terms: "fixed", payout: "28500.00" } });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body.data.margin).toMatchObject({ amount: { amountMinor: 1_500_00 } });
    const theirs = await api().get(`/api/v1/dealer/stock?consignorId=${consignorId}`).set(owner());
    expect((theirs.body.data as { vehicleId: string }[]).map((s) => s.vehicleId)).toEqual([id]);
  });

  it("ages stock, filters by days in stock and alerts on aged stock", async () => {
    const id = await vehicle({ make: "Nissan", model: "Almera", year: 2014 });
    await post("/api/v1/dealer/stock", {
      vehicleId: id,
      source: "repossession",
      stockedOn: day(-100),
      askingPrice: "15000.00",
    }).expect(201);

    const ageing = await api().get("/api/v1/dealer/stock/ageing").set(owner());
    expect(ageing.status, JSON.stringify(ageing.body)).toBe(200);
    expect(ageing.body.data.buckets.over90).toMatchObject({
      count: 1,
      asking: { amountMinor: 15_000_00 },
    });
    expect(ageing.body.data.total.count).toBe(3);
    expect(ageing.body.data.buckets.over90).toHaveProperty("cost");
    const theirs = await api().get("/api/v1/dealer/stock/ageing").set(as(sales));
    expect(theirs.body.data.buckets.over90).not.toHaveProperty("cost");

    const old = await api().get("/api/v1/dealer/stock?minDays=91").set(owner());
    expect((old.body.data as { vehicleId: string }[]).map((s) => s.vehicleId)).toEqual([id]);

    const alerts = container.get<StockAlerts>(TYPES.StockAlerts);
    await t.tenant.run(() => alerts.run(day(0)));
    await t.tenant.run(() => alerts.run(day(0)));
    const inbox = await api().get("/api/v1/notifications?limit=100").set(owner());
    expect(
      (inbox.body.data as { title: string }[]).filter((n) => n.title.startsWith("Nissan Almera")),
    ).toHaveLength(1);
  });

  it("puts a purchase received for resale straight into stock", async () => {
    const seller = await post("/api/v1/suppliers", { name: "Abossey Okai Motors", type: "dealer" });
    expect(seller.status, JSON.stringify(seller.body)).toBe(201);
    const purchase = await post("/api/v1/purchases", {
      type: "local",
      supplierId: seller.body.data.id,
      lines: [{ make: "Kia", model: "Rio", year: 2019, price: "35000.00" }],
    });
    expect(purchase.status, JSON.stringify(purchase.body)).toBe(201);
    const purchaseId = purchase.body.data.id as string;
    await post(`/api/v1/purchases/${purchaseId}/order`, {}).expect(200);
    const lineId = purchase.body.data.lines[0].id as string;
    const received = await post(`/api/v1/purchases/${purchaseId}/lines/${lineId}/receive`, {
      usage: "stock",
    });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    const vehicleId = received.body.data.lines[0].vehicleId as string;
    const unit = await stockOf(vehicleId);
    expect(unit.status, JSON.stringify(unit.body)).toBe(200);
    expect(unit.body.data).toMatchObject({
      source: "purchase",
      status: "reconditioning",
      cost: { acquisition: { amountMinor: 35_000_00 } },
    });
  });
});
