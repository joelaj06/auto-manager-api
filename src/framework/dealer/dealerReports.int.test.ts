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
 * Dealer reports (P7-8) end to end: a WhatsApp lead won by a sale paid and delivered, a second
 * sale part paid, a deposit on a draft deal and a price cut; the overview, price reductions and
 * collections, stock valuation by status, source, make and branch, gross profit by make, seller
 * and source, and commissions per seller.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let ama: Session;
let branchId: string;

type Session = { token: string; userId: string };
type Money = { amountMinor: number };

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const today = () => new Date().toISOString().slice(0, 10);
const digits = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
const post = (path: string, body: Record<string, unknown> = {}, headers = owner()) =>
  api().post(path).set(headers).send(body);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by expect()
type Report = any;
const get = async (path: string, headers = owner()): Promise<Report> => {
  const res = await api().get(path).set(headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};
const decimal = (m: Money) => (m.amountMinor / 100).toFixed(2);

async function join(roleId: string, name: string): Promise<Session> {
  const email = `user-${randomUUID().slice(0, 8)}@example.com`;
  const invited = await post("/api/v1/users/invitations", {
    name,
    email,
    branchIds: [branchId],
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
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const me = await api()
    .get("/api/v1/me")
    .set(as(accepted.body.data.accessToken as string));
  return {
    token: accepted.body.data.accessToken as string,
    userId: me.body.data.userId as string,
  };
}

async function customer(): Promise<string> {
  const res = await post("/api/v1/customers", {
    type: "individual",
    firstName: "Esi",
    lastName: `Buyer${digits(4)}`,
    phone: `+23324${digits(7)}`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

/** A vehicle in stock, priced at 60,000 and listed. */
async function listed(make: string) {
  const v = await post("/api/v1/vehicles", {
    make,
    model: "Model",
    year: 2019,
    plateNumber: `GR ${digits(4)}-25`,
  });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.data.id as string;
  await post("/api/v1/dealer/stock", { vehicleId: id, source: "other" }).expect(201);
  await price(id, "60000.00");
  await post(`/api/v1/dealer/stock/${id}/list`).expect(200);
  return id;
}

async function price(vehicleId: string, askingPrice: string, reason?: string) {
  const res = await api()
    .patch(`/api/v1/dealer/stock/${vehicleId}/pricing`)
    .set(owner())
    .send({ askingPrice, minimumPrice: "40000.00", ...(reason === undefined ? {} : { reason }) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function deal(vehicleId: string, customerId: string, leadId?: string) {
  const res = await post("/api/v1/dealer/deals", {
    vehicleId,
    customerId,
    salesExecutiveId: ama.userId,
    ...(leadId === undefined ? {} : { leadId }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const branches = await api().get("/api/v1/branches").set(owner());
  branchId = (branches.body.data as { id: string }[])[0]!.id;
  const roles = await api().get("/api/v1/roles").set(owner());
  const role = (roles.body.data as { id: string; name: string }[]).find(
    (r) => r.name === "Sales Executive",
  )!;
  ama = await join(role.id, "Ama Sales");
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("dealer reports", () => {
  it("reports sales, stock, leads, price cuts, cash, gross profit and commissions", async () => {
    await post("/api/v1/dealer/commission-plans", {
      name: "Flat",
      userId: null,
      basis: "flat",
      tiers: [{ fromUnits: 1, amount: "300.00" }],
    }).expect(201);

    // --- a WhatsApp lead buys a Toyota, cut to 55,000, paid and delivered ---
    const buyer = await customer();
    const lead = await post("/api/v1/dealer/leads", {
      source: "whatsapp",
      name: "Esi Buyer",
      phone: `+23320${digits(7)}`,
      customerId: buyer,
      assignedTo: ama.userId,
    });
    expect(lead.status, JSON.stringify(lead.body)).toBe(201);
    const toyota = await listed("Toyota");
    await price(toyota, "55000.00", "Slow mover");
    const first = await deal(toyota, buyer, lead.body.data.id as string);
    const sold = await post(`/api/v1/dealer/deals/${first}/sell`);
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    const firstTotal = sold.body.data.account.balance as Money;
    await post(`/api/v1/dealer/deals/${first}/payments`, {
      amount: decimal(firstTotal),
      method: "bank_transfer",
    }).expect(200);
    const delivered = await post(`/api/v1/dealer/deals/${first}/deliver`, {
      odometer: 40_000,
      checklist: [{ item: "Spare key", checked: true }],
    });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);

    // --- a Honda sold with 10,000 paid; another Honda with a 5,000 deposit on a draft ---
    const honda = await listed("Honda");
    const second = await deal(honda, await customer());
    const secondSold = await post(`/api/v1/dealer/deals/${second}/sell`);
    expect(secondSold.status, JSON.stringify(secondSold.body)).toBe(200);
    const secondTotal = (secondSold.body.data.account.balance as Money).amountMinor;
    const part = await post(`/api/v1/dealer/deals/${second}/payments`, {
      amount: "10000.00",
      method: "momo",
      momoNetwork: "mtn",
      reference: "MM-2041",
    });
    expect(part.status, JSON.stringify(part.body)).toBe(200);
    const draft = await deal(await listed("Honda"), await customer());
    const deposit = await post(`/api/v1/dealer/deals/${draft}/payments`, {
      amount: "5000.00",
      method: "bank_transfer",
    });
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(200);
    await listed("Kia");

    const period = `from=${today()}&to=${today()}`;

    // --- the overview ---
    const overview = await get(`/api/v1/dashboards/dealer?${period}`);
    expect(overview.sales.sold).toBe(2);
    expect(overview.sales.delivered).toBe(1);
    expect(overview.sales.averageDaysToSell).toBe(0);
    expect(overview.stock).toMatchObject({ count: 2, agedOver90: 0 });
    expect(overview.stock.asking.amountMinor).toBe(120_000_00);
    expect(overview.leads).toMatchObject({
      created: 1,
      won: 1,
      lost: 0,
      conversionPercent: "100.0",
    });
    expect(overview.cash.collected.amountMinor).toBe(firstTotal.amountMinor + 10_000_00 + 5_000_00);
    expect(overview.cash.outstanding.amountMinor).toBe(secondTotal - 10_000_00);
    expect(overview.cash.depositsHeld.amountMinor).toBe(5_000_00);

    // --- price reductions ---
    const cuts = await get(`/api/v1/dashboards/dealer/price-reductions?${period}`);
    expect(cuts.totals).toMatchObject({
      reductions: 1,
      vehicles: 1,
      reduced: { amountMinor: 5_000_00 },
    });
    expect(cuts.byMake).toEqual([expect.objectContaining({ make: "Toyota", reductions: 1 })]);
    expect(cuts.reductions[0]).toMatchObject({
      vehicle: { id: toyota, stockStatus: "delivered", daysInStockAtChange: 0 },
      previousAskingPrice: { amountMinor: 60_000_00 },
      askingPrice: { amountMinor: 55_000_00 },
      reductionPercent: "8.3",
      reason: "Slow mover",
    });

    // --- collections ---
    const cash = await get(`/api/v1/dashboards/dealer/collections?${period}`);
    expect(cash.collected.amountMinor).toBe(overview.cash.collected.amountMinor);
    expect(cash.tradeIns.amountMinor).toBe(0);
    const byMethod = Object.fromEntries(
      (cash.byMethod as { method: string; amount: Money }[]).map((r) => [
        r.method,
        r.amount.amountMinor,
      ]),
    );
    expect(byMethod).toEqual({
      bank_transfer: firstTotal.amountMinor + 5_000_00,
      momo: 10_000_00,
    });
    expect(cash.byBranch).toEqual([
      expect.objectContaining({ branchId, collected: overview.cash.collected }),
    ]);
    expect(cash.deals).toEqual([
      expect.objectContaining({
        dealId: second,
        financing: "cash",
        balance: overview.cash.outstanding,
      }),
    ]);
    expect(cash.deposits).toEqual([
      expect.objectContaining({
        dealId: draft,
        status: "draft",
        held: expect.objectContaining({ amountMinor: 5_000_00 }),
      }),
    ]);

    // --- stock valuation by status, source, make and branch ---
    const stock = await get("/api/v1/dealer/stock/ageing");
    expect(stock.total.count).toBe(2);
    expect(stock.byStatus).toEqual([expect.objectContaining({ status: "listed", count: 2 })]);
    expect(stock.bySource).toEqual([expect.objectContaining({ source: "other", count: 2 })]);
    expect(stock.byMake.map((r: { make: string }) => r.make)).toEqual(["Honda", "Kia"]);
    expect(stock.byBranch).toEqual([expect.objectContaining({ branchId, count: 2 })]);

    // --- gross profit by make, seller and lead source ---
    const profit = await get(`/api/v1/dealer/gross-profit?${period}`);
    expect(profit.totals.count).toBe(2);
    expect(
      profit.byMake.map((r: { make: string; count: number }) => [r.make, r.count]).sort(),
    ).toEqual([
      ["Honda", 1],
      ["Toyota", 1],
    ]);
    expect(profit.bySalesExecutive).toEqual([
      expect.objectContaining({ salesExecutiveId: ama.userId, count: 2 }),
    ]);
    expect(profit.bySource.map((r: { source: string | null }) => r.source).sort()).toEqual(
      [null, "whatsapp"].sort(),
    );
    expect(profit.totals.perUnit.amountMinor).toBe(
      Math.round(profit.totals.grossProfit.amountMinor / 2),
    );

    // --- commissions per seller ---
    const statement = await get(`/api/v1/dealer/commissions?period=${today().slice(0, 7)}`);
    expect(statement.bySeller).toEqual([
      expect.objectContaining({
        userId: ama.userId,
        userName: "Ama Sales",
        units: 1,
        earned: expect.objectContaining({ amountMinor: 300_00 }),
      }),
    ]);

    // --- a sales executive does not see the dealer dashboards ---
    const refused = await api().get(`/api/v1/dashboards/dealer?${period}`).set(as(ama.token));
    expect(refused.status).toBe(403);
    const backwards = await api()
      .get("/api/v1/dashboards/dealer/collections?from=2026-02-01&to=2026-01-01")
      .set(owner());
    expect(backwards.status).toBe(422);
  });
});
