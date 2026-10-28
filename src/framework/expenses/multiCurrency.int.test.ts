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
 * Multi-currency expenses (P7-1) end to end: a bill in US dollars kept at the day's rate with its
 * cedi amounts frozen, approved by rule on the cedi amount, paid at another rate with the
 * exchange difference posted and undone with the payment, a different rate refused without
 * `finance.fx_rates.override`, and a currency still in use kept enabled.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let category: string;
let supplier: string;
let clerk: string;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const today = () => new Date().toISOString().slice(0, 10);

async function join(roleId: string): Promise<string> {
  const email = `user-${randomUUID().slice(0, 8)}@example.com`;
  const branches = await api().get("/api/v1/branches").set(owner());
  const invited = await api()
    .post("/api/v1/users/invitations")
    .set(owner())
    .send({
      name: "Clerk",
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

const create = (body: Record<string, unknown>, headers = owner()) =>
  api()
    .post("/api/v1/expenses")
    .set(headers)
    .send({
      categoryId: category,
      description: "Spare parts from Dubai",
      payeeType: "supplier",
      payeeId: supplier,
      currency: "USD",
      ...body,
    });

const balanceOf = async (code: string) => {
  const tb = await api().get("/api/v1/ledger/trial-balance").set(owner());
  expect(tb.body.data.balanced).toBe(true);
  return (tb.body.data.accounts as { code: string; balance: { amountMinor: number } }[]).find(
    (a) => a.code === code,
  )!.balance.amountMinor;
};

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const tree = await api().get("/api/v1/expense-categories").set(owner());
  category = (tree.body.data as { code: string; id: string }[]).find(
    (c) => c.code === "insurance",
  )!.id;
  supplier = (
    await api().post("/api/v1/suppliers").set(owner()).send({ name: "Gulf Motors", type: "parts" })
  ).body.data.id;
  const role = await api()
    .post("/api/v1/roles")
    .set(owner())
    .send({
      name: "Expense clerk",
      grants: [
        { key: "expenses.list", scope: "all" },
        { key: "expenses.view", scope: "all" },
        { key: "expenses.create", scope: "all" },
      ],
    });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  clerk = await join(role.body.data.id);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("multi-currency expenses", () => {
  it("keeps a dollar bill at the day's rate, pays it at another and posts the difference", async () => {
    const notEnabled = await create({ amount: "100.00", fxRate: "15" });
    expect([notEnabled.status, notEnabled.body.error.code]).toEqual([422, "CURRENCY_NOT_ENABLED"]);
    await api()
      .patch("/api/v1/settings/currency")
      .set(owner())
      .send({ enabledCurrencies: ["USD"] })
      .expect(200);
    const noRate = await create({ amount: "100.00" });
    expect(noRate.body.error.code).toBe("FX_RATE_REQUIRED");
    await api()
      .post("/api/v1/fx-rates")
      .set(owner())
      .send({ quote: "USD", rate: "15", rateDate: today() })
      .expect(201);
    await api()
      .post("/api/v1/expense-approval-rules")
      .set(owner())
      .send({ name: "Small spend", maxAmount: "2000.00", action: "auto_approve", priority: 10 })
      .expect(201);

    // --- the rate is suggested; the rules see the cedi amount ---
    const small = await create({ amount: "100.00" });
    expect(small.status, JSON.stringify(small.body)).toBe(201);
    expect(small.body.data.expense).toMatchObject({
      currency: "USD",
      fxRate: "15",
      amount: { amountMinor: 10_000, currency: "USD" },
      amountBase: { amountMinor: 150_000, currency: "GHS" },
    });
    const payablesBefore = await balanceOf("2000");
    const fxBefore = await balanceOf("4950");
    const id = small.body.data.expense.id as string;
    const approved = await api().post(`/api/v1/expenses/${id}/submit`).set(owner());
    expect(approved.body.data.status).toBe("approved");
    expect(await balanceOf("2000")).toBe(payablesBefore + 150_000);
    const big = await create({ amount: "200.00" });
    const held = await api()
      .post(`/api/v1/expenses/${big.body.data.expense.id}/submit`)
      .set(owner());
    expect(held.body.data.status).toBe("submitted");

    // --- paid when the dollar is at 14: GHS 100 less leaves the books as a gain ---
    const paid = await api()
      .post(`/api/v1/expenses/${id}/pay`)
      .set(owner())
      .send({ method: "bank_transfer", fxRate: "14" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.data).toMatchObject({
      status: "paid",
      fxDifference: { amountMinor: 10_000, currency: "GHS" },
    });
    expect(await balanceOf("2000")).toBe(payablesBefore);
    expect(Math.abs((await balanceOf("4950")) - fxBefore)).toBe(10_000);
    const payment = await api().get(`/api/v1/payments/${paid.body.data.paymentId}`).set(owner());
    expect(payment.body.data).toMatchObject({
      currency: "USD",
      amount: { amountMinor: 10_000 },
      amountBase: { amountMinor: 140_000 },
    });

    // --- the reversal undoes the payment and its difference ---
    const reversed = await api()
      .post(`/api/v1/payments/${paid.body.data.paymentId}/reverse`)
      .set(owner())
      .send({ reason: "Wrong account" });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(await balanceOf("4950")).toBe(fxBefore);
    expect(await balanceOf("2000")).toBe(payablesBefore + 150_000);
    expect((await api().get(`/api/v1/expenses/${id}`).set(owner())).body.data).toMatchObject({
      status: "approved",
      fxDifference: { amountMinor: 0 },
    });

    // --- a different rate needs finance.fx_rates.override ---
    const typed = await create({ amount: "50.00", fxRate: "16" }, as(clerk));
    expect([typed.status, typed.body.error.code]).toEqual([403, "FX_RATE_OVERRIDE_DENIED"]);
    const same = await create({ amount: "50.00", fxRate: "15.00" }, as(clerk));
    expect(same.status, JSON.stringify(same.body)).toBe(201);
    const overridden = await create({ amount: "50.00", fxRate: "16" });
    expect(overridden.body.data.expense.amountBase.amountMinor).toBe(80_000);

    // --- a currency on open documents stays enabled ---
    const disable = await api()
      .patch("/api/v1/settings/currency")
      .set(owner())
      .send({ enabledCurrencies: ["GHS"] });
    expect([disable.status, disable.body.error.code]).toEqual([409, "CURRENCY_IN_USE"]);
  });
});
