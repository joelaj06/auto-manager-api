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
 * Dealer stock by model and transfers of several vehicles (decisions 541–543) end to end: twelve
 * Honda CR-Vs at GHS 30,000 cost and 50,000 asking add up to 600,000 asking, 360,000 cost and
 * 240,000 profit at 40%, an unpriced car counted but left out of the profit, cost hidden from
 * sales staff; then five CR-Vs picked oldest first and sent to Kumasi under one reference, named
 * vehicles sent too, a reserved or mixed-branch batch refused whole, and the batches listed.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let sales: string;
let accra: string;
let kumasi: string;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const digits = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
const post = (path: string, body: Record<string, unknown> = {}, headers = owner()) =>
  api().post(path).set(headers).send(body);

async function join(roleId: string): Promise<string> {
  const email = `user-${randomUUID().slice(0, 8)}@example.com`;
  const branches = await api().get("/api/v1/branches").set(owner());
  const invited = await post("/api/v1/users/invitations", {
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

/** A vehicle taken into stock `daysAgo` at its cost, priced unless `asking` is null. */
async function stocked(
  model: Readonly<{ make: string; model: string; year: number }>,
  cost: string,
  asking: string | null,
  daysAgo: number,
): Promise<string> {
  const v = await post("/api/v1/vehicles", {
    ...model,
    plateNumber: `GR ${digits(4)}-26`,
    financials: { acquisitionDate: day(-daysAgo), acquisitionCost: cost },
  });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.data.id as string;
  const added = await post("/api/v1/dealer/stock", {
    vehicleId: id,
    source: "purchase",
    status: "ready",
    stockedOn: day(-daysAgo),
    ...(asking === null ? {} : { askingPrice: asking }),
  });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  return id;
}

const crv = { make: "Honda", model: "CR-V", year: 2021 };
const summaryOf = (query: string, headers = owner()) =>
  api().get(`/api/v1/dealer/stock/summary${query}`).set(headers);
const branchOf = async (id: string) =>
  (await api().get(`/api/v1/vehicles/${id}`).set(owner())).body.data.branchId as string;

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const branch = await post("/api/v1/branches", { code: "KSI", name: "Kumasi" });
  expect(branch.status, JSON.stringify(branch.body)).toBe(201);
  kumasi = branch.body.data.id as string;
  const role = await post("/api/v1/roles", {
    name: "Sales floor",
    grants: [
      { key: "dealer.stock.list", scope: "all" },
      { key: "dealer.stock.view", scope: "all" },
    ],
  });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  sales = await join(role.body.data.id as string);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("dealer stock by model and batch transfers", () => {
  const crvs: string[] = [];

  it("adds up the stock by model with its cost, profit and margin", async () => {
    // Twelve CR-Vs, the oldest stocked 12 days ago; one Accord not priced yet.
    for (let i = 12; i >= 1; i -= 1) crvs.push(await stocked(crv, "30000.00", "50000.00", i));
    await stocked({ make: "Honda", model: "Accord", year: 2019 }, "20000.00", null, 3);
    await stocked({ make: "Toyota", model: "Corolla", year: 2018 }, "40000.00", "44000.00", 2);
    accra = await branchOf(crvs[0]!);

    const res = await summaryOf("");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const lines = res.body.data.lines as Record<string, string>[];
    expect(lines.map((l) => `${l.make} ${l.model}`)).toEqual([
      "Honda Accord",
      "Honda CR-V",
      "Toyota Corolla",
    ]);
    expect(lines[1]).toMatchObject({
      units: 12,
      priced: 12,
      unpriced: 0,
      asking: { amountMinor: 600_000_00 },
      averageAsking: { amountMinor: 50_000_00 },
      costed: 12,
      cost: { amountMinor: 360_000_00 },
      averageCost: { amountMinor: 30_000_00 },
      profit: { amountMinor: 240_000_00 },
      marginPercent: "40.0",
    });
    // The unpriced Accord counts at cost but not as a loss.
    expect(lines[0]).toMatchObject({
      units: 1,
      unpriced: 1,
      asking: { amountMinor: 0 },
      averageAsking: null,
      cost: { amountMinor: 20_000_00 },
      profit: { amountMinor: 0 },
      marginPercent: null,
    });
    expect(res.body.data).toMatchObject({
      groupBy: "model",
      total: {
        units: 14,
        unpriced: 1,
        asking: { amountMinor: 644_000_00 },
        cost: { amountMinor: 420_000_00 },
        profit: { amountMinor: 244_000_00 },
        marginPercent: "37.9",
      },
    });

    // By make, by year, and narrowed to one make.
    const byMake = await summaryOf("?groupBy=make");
    expect(byMake.body.data.lines).toMatchObject([
      { make: "Honda", units: 13 },
      { make: "Toyota", units: 1 },
    ]);
    expect(byMake.body.data.lines[0]).not.toHaveProperty("model");
    const byYear = await summaryOf("?groupBy=year&make=honda");
    expect(byYear.body.data.lines).toMatchObject([
      { make: "Honda", model: "Accord", year: 2019, units: 1 },
      { make: "Honda", model: "CR-V", year: 2021, units: 12 },
    ]);
    expect(byYear.body.data.total.units).toBe(13);
  });

  it("hides cost, profit and margin from those without cost access", async () => {
    const res = await summaryOf("", as(sales));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.total).toMatchObject({ units: 14, asking: { amountMinor: 644_000_00 } });
    for (const key of ["cost", "costed", "averageCost", "profit", "marginPercent"])
      expect(res.body.data.total).not.toHaveProperty(key);
  });

  it("lists the summary as a report", async () => {
    const res = await post("/api/v1/reports/dealer_stock_by_model/run", { params: {} });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = (res.body.data.rows as Record<string, unknown>[]).find(
      (r) => r.name === "Honda CR-V",
    );
    expect(row).toMatchObject({
      units: 12,
      asking: { amountMinor: 600_000_00 },
      cost: { amountMinor: 360_000_00 },
      profit: { amountMinor: 240_000_00 },
      margin: 40,
    });
  });

  it("sends five CR-Vs to Kumasi, oldest first, under one reference", async () => {
    const sent = await post("/api/v1/dealer/stock/transfers", {
      branchId: kumasi,
      reason: "Kumasi is short of SUVs",
      pick: { fromBranchId: accra, make: "honda", model: "cr-v", quantity: 5 },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.data).toMatchObject({
      reference: expect.stringMatching(/^STR-\d{4}-000001$/),
      fromBranchId: accra,
      toBranchId: kumasi,
      transferredOn: day(0),
      reason: "Kumasi is short of SUVs",
      vehicleCount: 5,
    });
    const moved = (sent.body.data.vehicles as { vehicleId: string }[]).map((v) => v.vehicleId);
    expect(new Set(moved)).toEqual(new Set(crvs.slice(0, 5)));
    for (const id of crvs.slice(0, 5)) expect(await branchOf(id)).toBe(kumasi);
    expect(await branchOf(crvs[5]!)).toBe(accra);

    // Each vehicle keeps its own record pointing at the batch.
    const own = await api().get(`/api/v1/dealer/stock/${crvs[0]}/transfers`).set(owner());
    expect(own.body.data).toMatchObject([
      { fromBranchId: accra, toBranchId: kumasi, batchId: sent.body.data.id },
    ]);

    // The summary follows the branch.
    const atKumasi = await summaryOf(`?branchId=${kumasi}`);
    expect(atKumasi.body.data.lines).toMatchObject([
      { make: "Honda", model: "CR-V", units: 5, profit: { amountMinor: 100_000_00 } },
    ]);

    // Asking for more than there are moves nothing.
    const tooMany = await post("/api/v1/dealer/stock/transfers", {
      branchId: kumasi,
      reason: "All of them",
      pick: { fromBranchId: accra, make: "Honda", model: "CR-V", quantity: 8 },
    });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.message).toBe("Only 7 Honda CR-V at that branch can be transferred");
    expect(await branchOf(crvs[5]!)).toBe(accra);
  });

  it("sends named vehicles and refuses a batch that cannot all go", async () => {
    // Named vehicles in two branches at once are refused whole.
    const mixed = await post("/api/v1/dealer/stock/transfers", {
      branchId: kumasi,
      reason: "Tidy up",
      vehicleIds: [crvs[0], crvs[5]],
    });
    expect(mixed.status).toBe(422);
    expect(mixed.body.error.message).toMatch(/different branches/);

    // All or none: a withdrawn vehicle keeps the other at home too, and is named.
    const withdrawn = await post(`/api/v1/dealer/stock/${crvs[11]}/withdraw`, {
      reason: "Kept as a company car",
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    const blocked = await post("/api/v1/dealer/stock/transfers", {
      branchId: kumasi,
      reason: "Two more for the showroom",
      vehicleIds: [crvs[5], crvs[11]],
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toBe(
      `${withdrawn.body.data.vehicle.code}: The vehicle is withdrawn`,
    );
    expect(await branchOf(crvs[5]!)).toBe(accra);

    // A listed vehicle goes like any other.
    const listed = await post(`/api/v1/dealer/stock/${crvs[6]}/list`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);

    const named = await post("/api/v1/dealer/stock/transfers", {
      branchId: kumasi,
      reason: "Two more for the showroom",
      transferredOn: day(-1),
      vehicleIds: [crvs[5], crvs[6]],
    });
    expect(named.status, JSON.stringify(named.body)).toBe(201);
    expect(named.body.data).toMatchObject({
      reference: expect.stringMatching(/-000002$/),
      transferredOn: day(-1),
      vehicleCount: 2,
    });
    expect(named.body.data.vehicles.map((v: { vehicleId: string }) => v.vehicleId)).toEqual([
      crvs[5],
      crvs[6],
    ]);

    // Neither vehicleIds nor pick, or both, are refused at the door.
    const neither = await post("/api/v1/dealer/stock/transfers", {
      branchId: kumasi,
      reason: "Nothing",
    });
    expect(neither.status).toBe(400);
    const already = await post("/api/v1/dealer/stock/transfers", {
      branchId: kumasi,
      reason: "Already there",
      vehicleIds: [crvs[0]],
    });
    expect(already.status).toBe(422);
    expect(already.body.error.message).toBe("The vehicles are already there");
  });

  it("lists the batches newest first and opens one", async () => {
    const list = await api().get(`/api/v1/dealer/stock/transfers?branchId=${kumasi}`).set(owner());
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.headers["x-total-count"]).toBe("2");
    const batches = list.body.data as { id: string; vehicleCount: number }[];
    expect(batches.map((b) => b.vehicleCount)).toEqual([2, 5]);
    expect(batches[0]).not.toHaveProperty("vehicles");

    const dated = await api()
      .get(`/api/v1/dealer/stock/transfers?dateTo=${day(-1)}`)
      .set(owner());
    expect(dated.body.data).toHaveLength(1);

    const one = await api().get(`/api/v1/dealer/stock/transfers/${batches[1]!.id}`).set(as(sales));
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.data.vehicles).toHaveLength(5);
    expect(one.body.data.vehicles[0]).toMatchObject({ make: "Honda", model: "CR-V", year: 2021 });

    const missing = await api().get(`/api/v1/dealer/stock/transfers/${randomUUID()}`).set(owner());
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("STOCK_TRANSFER_NOT_FOUND");
  });
});
