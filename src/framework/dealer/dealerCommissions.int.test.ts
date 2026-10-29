import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DealerDealAlerts } from "../../application/use-cases/dealer/DealerDealAlerts.js";
import type { VehicleDepreciation } from "../../application/use-cases/finance/VehicleDepreciation.js";
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
 * Dealer commissions and the cost of sales (P7-7) end to end: depreciation posted monthly and to
 * the day of the sale; the sold vehicle's book value taken out of the books as the cost of the
 * sale and the gross profit per unit; plans for everyone and for one seller, a sale's commission
 * split between two sellers and accrued at delivery, payable once the sale is paid, paid out,
 * clawed back before and after payment; the statement and the gross-profit report.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let ama: Session;
let kofi: Session;
let branchId: string;

type Session = { token: string; userId: string };
type Money = { amountMinor: number };
type Statement = {
  totals: Record<"earned" | "accrued" | "payable" | "paid" | "clawedBack", Money>;
  commissions: {
    id: string;
    userId: string;
    dealNumber: string;
    status: string;
    kind: string;
    rate: string;
    amount: Money;
  }[];
  payouts: { number: string; amount: Money }[];
};

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const month = day(0).slice(0, 7);
const digits = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
const post = (path: string, body: Record<string, unknown> = {}, headers = owner()) =>
  api().post(path).set(headers).send(body);
const decimal = (m: Money) => (m.amountMinor / 100).toFixed(2);
const checklist = [{ item: "Spare key", checked: true }];

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

/** A vehicle in stock, priced and listed; `financials` makes it depreciate. */
async function listed(financials?: Record<string, unknown>) {
  const v = await post("/api/v1/vehicles", {
    make: "Honda",
    model: "Civic",
    year: 2018,
    plateNumber: `GR ${digits(4)}-25`,
    ...(financials === undefined ? {} : { financials }),
  });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.data.id as string;
  await post("/api/v1/dealer/stock", { vehicleId: id, source: "other" }).expect(201);
  const priced = await api()
    .patch(`/api/v1/dealer/stock/${id}/pricing`)
    .set(owner())
    .send({ askingPrice: "60000.00", minimumPrice: "50000.00" });
  expect(priced.status, JSON.stringify(priced.body)).toBe(200);
  await post(`/api/v1/dealer/stock/${id}/list`).expect(200);
  return id;
}

const balances = async () => {
  const tb = await api().get("/api/v1/ledger/trial-balance").set(owner());
  expect(tb.body.data.balanced).toBe(true);
  const accounts = tb.body.data.accounts as { code: string; balance: Money }[];
  return (code: string) => accounts.find((a) => a.code === code)?.balance.amountMinor ?? 0;
};
const statement = async (headers = owner(), userId?: string) => {
  const res = await api()
    .get(
      `/api/v1/dealer/commissions?period=${month}${userId === undefined ? "" : `&userId=${userId}`}`,
    )
    .set(headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as Statement;
};

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
  kofi = await join(role.id, "Kofi Sales");
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("dealer commissions and the cost of sales", () => {
  it("depreciates monthly and costs the sale at its book value", async () => {
    const vehicleId = await listed({
      acquisitionDate: day(-400),
      acquisitionCost: "48000.00",
      residualValue: "0.00",
      depreciationMethod: "straight_line",
      usefulLifeMonths: 48,
    });
    const depreciation = container.get<VehicleDepreciation>(TYPES.VehicleDepreciation);
    await t.tenant.run(() => depreciation.run(day(0)));
    await t.tenant.run(() => depreciation.run(day(0)));
    const before = await balances();
    expect(before("6000")).toBeGreaterThanOrEqual(12_000_00);
    expect(before("6000") % 1_000_00).toBe(0);
    expect(before("1510")).toBe(-before("6000"));

    const created = await post("/api/v1/dealer/deals", {
      vehicleId,
      customerId: await customer(),
      salesExecutiveId: ama.userId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const sold = await post(`/api/v1/dealer/deals/${id}/sell`);
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    const vehicle = await api().get(`/api/v1/vehicles/${vehicleId}`).set(owner());
    const bookValue = vehicle.body.data.financials.bookValue.amountMinor as number;
    expect(sold.body.data.profit).toMatchObject({
      revenue: { amountMinor: 60_000_00 },
      cost: { amountMinor: bookValue },
      holding: { amountMinor: 0 },
    });
    expect(sold.body.data.profit.grossProfit.amountMinor).toBe(60_000_00 - bookValue);
    expect(sold.body.data.costOfSaleMinor).toBeUndefined();

    // The cost (never in the books: stocked without a purchase) came from equity.
    const after = await balances();
    expect(after("5100")).toBe(bookValue);
    expect(after("1510")).toBe(0);
    expect(after("3000") - before("3000")).toBe(48_000_00);

    // A sales executive sees the deal but not its cost.
    const own = await api().get(`/api/v1/dealer/deals/${id}`).set(as(ama.token));
    expect(own.status).toBe(200);
    expect(own.body.data.profit).toBeUndefined();
  });

  it("splits, accrues, pays out and claws back commissions", async () => {
    // --- plans: 10% then 20% of gross profit for everyone; Kofi a flat 500 ---
    const everyone = await post("/api/v1/dealer/commission-plans", {
      name: "Sales team",
      userId: null,
      basis: "gross_profit_percent",
      tiers: [
        { fromUnits: 1, percent: "10" },
        { fromUnits: 3, percent: "20" },
      ],
    });
    expect(everyone.status, JSON.stringify(everyone.body)).toBe(201);
    const twice = await post("/api/v1/dealer/commission-plans", {
      name: "Again",
      userId: null,
      basis: "flat",
      tiers: [{ fromUnits: 1, amount: "100.00" }],
    });
    expect(twice.status).toBe(422);
    const flat = await post("/api/v1/dealer/commission-plans", {
      name: "Kofi",
      userId: kofi.userId,
      basis: "flat",
      tiers: [{ fromUnits: 1, amount: "500.00" }],
    });
    expect(flat.status, JSON.stringify(flat.body)).toBe(201);
    expect(flat.body.data.tiers[0].amount.amountMinor).toBe(500_00);
    expect(
      (
        await post(
          "/api/v1/dealer/commission-plans",
          { name: "x", userId: null, basis: "flat", tiers: [] },
          as(ama.token),
        )
      ).status,
    ).toBe(403);

    // --- a cash sale split between Ama and Kofi, paid and delivered ---
    const vehicleId = await listed();
    const created = await post("/api/v1/dealer/deals", {
      vehicleId,
      customerId: await customer(),
      salesExecutiveId: ama.userId,
    });
    const id = created.body.data.id as string;
    const bad = await api()
      .put(`/api/v1/dealer/deals/${id}/commission-split`)
      .set(owner())
      .send({ split: [{ userId: ama.userId, percent: 60 }] });
    expect(bad.status).toBe(422);
    const split = await api()
      .put(`/api/v1/dealer/deals/${id}/commission-split`)
      .set(owner())
      .send({
        split: [
          { userId: ama.userId, percent: 50 },
          { userId: kofi.userId, percent: 50 },
        ],
      });
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    const sold = await post(`/api/v1/dealer/deals/${id}/sell`);
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    await post(`/api/v1/dealer/deals/${id}/payments`, {
      amount: decimal(sold.body.data.account.balance),
      method: "bank_transfer",
    }).expect(200);
    const delivered = await post(`/api/v1/dealer/deals/${id}/deliver`, {
      odometer: 70_000,
      checklist,
    });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    const number = delivered.body.data.number as string;
    // No cost recorded: the whole revenue is gross profit before commission.
    const beforeCommission = delivered.body.data.profit.beforeCommission.amountMinor as number;
    const amaShare = Math.round(beforeCommission * 0.1 * 0.5);
    expect(delivered.body.data.profit.commission.amountMinor).toBe(amaShare + 250_00);

    const all = await statement();
    const mine = all.commissions.filter((c) => c.dealNumber === number);
    expect(mine.map((c) => [c.userId, c.status, c.rate, c.amount.amountMinor]).sort()).toEqual(
      [
        [ama.userId, "payable", "10", amaShare],
        [kofi.userId, "payable", "50000", 250_00],
      ].sort(),
    );
    const amaOnly = await statement(as(ama.token));
    expect(amaOnly.commissions.every((c) => c.userId === ama.userId)).toBe(true);
    expect((await balances())("2400")).toBe(amaShare + 250_00);

    // --- Ama is paid; Kofi's is clawed back unpaid; Ama's paid one is recovered ---
    const payout = await post("/api/v1/dealer/commissions/payouts", {
      userId: ama.userId,
      period: month,
      method: "momo",
      reference: "MM-1",
    });
    expect(payout.status, JSON.stringify(payout.body)).toBe(201);
    expect(payout.body.data.number).toMatch(/^CPO-/);
    expect(payout.body.data.amount.amountMinor).toBe(amaShare);
    const kofiLine = mine.find((c) => c.userId === kofi.userId)!;
    const amaLine = mine.find((c) => c.userId === ama.userId)!;
    const unpaid = await post(`/api/v1/dealer/commissions/${kofiLine.id}/clawback`, {
      reason: "Vehicle returned",
    });
    expect(unpaid.status, JSON.stringify(unpaid.body)).toBe(200);
    expect(unpaid.body.data.status).toBe("clawed_back");
    const paid = await post(`/api/v1/dealer/commissions/${amaLine.id}/clawback`, {
      reason: "Vehicle returned",
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const nothing = await post("/api/v1/dealer/commissions/payouts", {
      userId: ama.userId,
      period: month,
      method: "cash",
    });
    expect(nothing.status).toBe(422);

    const after = await statement(owner(), ama.userId);
    expect(
      after.commissions
        .filter((c) => c.dealNumber === number)
        .map((c) => c.kind)
        .sort(),
    ).toEqual(["clawback", "earned"]);
    expect(after.totals.clawedBack.amountMinor).toBe(amaShare);
    expect(after.payouts).toHaveLength(1);
    const books = await balances();
    // Ama owes back what she was paid: a debit on the payable, netted from her next payout.
    expect(books("2400")).toBe(-amaShare);
    expect(books("5200")).toBe(0);
  });

  it("makes an instalment sale's commission payable once it is paid in full", async () => {
    const vehicleId = await listed();
    const created = await post("/api/v1/dealer/deals", {
      vehicleId,
      customerId: await customer(),
      salesExecutiveId: kofi.userId,
      financing: "in_house",
      plan: { downPayment: "20000.00", markupPercent: "10", frequency: "monthly", months: 3 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    await post(`/api/v1/dealer/deals/${id}/sell`).expect(200);
    await post(`/api/v1/dealer/deals/${id}/payments`, {
      amount: "20000.00",
      method: "bank_transfer",
    }).expect(200);
    const delivered = await post(`/api/v1/dealer/deals/${id}/deliver`, {
      odometer: 12_000,
      checklist,
    });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    const number = delivered.body.data.number as string;
    const line = () =>
      statement(as(kofi.token)).then((s) => s.commissions.find((c) => c.dealNumber === number)!);
    expect(await line()).toMatchObject({ status: "accrued", amount: { amountMinor: 500_00 } });

    await post(`/api/v1/dealer/deals/${id}/payments`, {
      amount: decimal(delivered.body.data.account.balance),
      method: "bank_transfer",
    }).expect(200);
    await t.tenant.run(() => container.get<DealerDealAlerts>(TYPES.DealerDealAlerts).run(day(0)));
    expect((await line()).status).toBe("payable");
  });

  it("reports gross profit per unit to those who see cost", async () => {
    const res = await api()
      .get(`/api/v1/dealer/gross-profit?from=${day(0)}&to=${day(0)}`)
      .set(owner());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const report = res.body.data as {
      units: { dealNumber: string; figures: { revenue: Money; grossProfit: Money } }[];
      totals: { count: number; revenue: Money; marginPercent: string | null };
    };
    expect(report.totals.count).toBe(3);
    expect(report.units).toHaveLength(3);
    expect(report.totals.revenue.amountMinor).toBe(
      report.units.reduce((s, u) => s + u.figures.revenue.amountMinor, 0),
    );
    expect(report.totals.marginPercent).not.toBeNull();
    const refused = await api()
      .get(`/api/v1/dealer/gross-profit?from=${day(0)}&to=${day(0)}`)
      .set(as(ama.token));
    expect(refused.status).toBe(403);
  });
});
