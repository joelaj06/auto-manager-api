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
 * Supplier payables (P7-2) end to end: approved expenses as bills due after the supplier's
 * payment terms, aged payables, a supplier's open bills and statement, one payment for several
 * bills with withholding tax, its reversal reopening them, a dollar bill paid at another rate
 * and the permission to pay.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let category: string;
let clerk: string;

type Money = { amountMinor: number; currency?: string };

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

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

async function supplier(name: string, paymentTermsDays: number | null): Promise<string> {
  const res = await api()
    .post("/api/v1/suppliers")
    .set(owner())
    .send({ name, type: "parts", paymentTermsDays });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

/** An approved bill (the auto-approve rule takes everything). */
async function bill(supplierId: string, body: Record<string, unknown>): Promise<string> {
  const res = await api()
    .post("/api/v1/expenses")
    .set(owner())
    .send({
      categoryId: category,
      description: "Parts",
      payeeType: "supplier",
      payeeId: supplierId,
      ...body,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.data.expense.id as string;
  const submitted = await api().post(`/api/v1/expenses/${id}/submit`).set(owner());
  expect(submitted.body.data.status).toBe("approved");
  return id;
}

const balanceOf = async (code: string) => {
  const tb = await api().get("/api/v1/ledger/trial-balance").set(owner());
  expect(tb.body.data.balanced).toBe(true);
  return (tb.body.data.accounts as { code: string; balance: { amountMinor: number } }[]).find(
    (a) => a.code === code,
  )!.balance.amountMinor;
};

const pay = (supplierId: string, body: Record<string, unknown>, headers = owner()) =>
  api()
    .post(`/api/v1/suppliers/${supplierId}/payments`)
    .set(headers)
    .send({ method: "bank_transfer", ...body });

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
  await api()
    .post("/api/v1/expense-approval-rules")
    .set(owner())
    .send({ name: "Everything", action: "auto_approve", priority: 1 })
    .expect(201);
  const role = await api()
    .post("/api/v1/roles")
    .set(owner())
    .send({
      name: "Payables clerk",
      grants: [
        { key: "finance.payables.view", scope: "all" },
        { key: "finance.payments.record", scope: "all" },
      ],
    });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  clerk = await join(role.body.data.id);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("supplier payables", () => {
  it("ages bills on the supplier's terms, pays several with withholding tax and reverses", async () => {
    const gulf = await supplier("Gulf Motors", 30);
    const kofi = await supplier("Kofi Spares", null);
    const old = await bill(gulf, { amount: "1000.00", expenseDate: day(-60) });
    const recent = await bill(gulf, { amount: "500.00" });
    const other = await bill(kofi, { amount: "200.00" });

    // --- aged payables and the supplier's open bills ---
    const aged = await api().get("/api/v1/payables/aged").set(as(clerk));
    expect(aged.status, JSON.stringify(aged.body)).toBe(200);
    expect(aged.body.data).toMatchObject({
      total: { amountMinor: 170_000 },
      buckets: { current: { amountMinor: 70_000 }, days1to30: { amountMinor: 100_000 } },
    });
    expect(
      (aged.body.data.payees as { name: string; bills: number; total: Money }[]).map((p) => [
        p.name,
        p.bills,
        p.total.amountMinor,
      ]),
    ).toEqual([
      ["Gulf Motors", 2, 150_000],
      ["Kofi Spares", 1, 20_000],
    ]);
    const bills = await api().get(`/api/v1/suppliers/${gulf}/bills`).set(owner());
    expect(
      (bills.body.data.bills as { expenseId: string; dueOn: string; daysOverdue: number }[]).map(
        (b) => [b.expenseId, b.dueOn, b.daysOverdue],
      ),
    ).toEqual([
      [old, day(-30), 30],
      [recent, day(30), 0],
    ]);

    // --- one payment for both bills, 7.5% withheld ---
    const denied = await pay(gulf, { expenseIds: [old] }, as(clerk));
    expect(denied.status).toBe(403);
    const wrong = await pay(gulf, { expenseIds: [old, other] });
    expect([wrong.status, wrong.body.error.message]).toEqual([
      422,
      expect.stringMatching(/not one of Gulf Motors/),
    ]);
    const withheldBefore = await balanceOf("2230");
    const paid = await pay(gulf, {
      expenseIds: [old, recent],
      withholdingRate: "7.5",
      reference: "TRF-88",
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.data).toMatchObject({
      payment: { amount: { amountMinor: 138_750 }, direction: "out" },
      withholding: { rate: "7.5", amount: { amountMinor: 11_250 } },
      fxDifference: { amountMinor: 0 },
    });
    expect(Math.abs((await balanceOf("2230")) - withheldBefore)).toBe(11_250);
    for (const id of [old, recent])
      expect((await api().get(`/api/v1/expenses/${id}`).set(owner())).body.data).toMatchObject({
        status: "paid",
        paymentId: paid.body.data.payment.id,
      });
    const again = await pay(gulf, { expenseIds: [recent] });
    expect(again.body.error.message).toMatch(/not approved and unpaid/);

    const statement = await api()
      .get(`/api/v1/suppliers/${gulf}/statement?from=${day(-90)}`)
      .set(owner());
    expect(statement.status, JSON.stringify(statement.body)).toBe(200);
    const s = statement.body.data;
    expect([s.opening.amountMinor, s.closing.amountMinor, s.openBills.count]).toEqual([0, 0, 0]);
    expect(
      (s.lines as { billed: Money | null; paid: Money | null }[]).map((l) => [
        l.billed?.amountMinor ?? 0,
        l.paid?.amountMinor ?? 0,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [100_000, 0],
        [50_000, 0],
        [0, 138_750],
        [0, 11_250],
      ]),
    );

    // --- reversing the payment reopens both bills and undoes the tax withheld ---
    const reversed = await api()
      .post(`/api/v1/payments/${paid.body.data.payment.id}/reverse`)
      .set(owner())
      .send({ reason: "Bounced" });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(await balanceOf("2230")).toBe(withheldBefore);
    const reopened = await api().get(`/api/v1/suppliers/${gulf}/bills`).set(owner());
    expect(reopened.body.data.total.amountMinor).toBe(150_000);
    const after = await api().get(`/api/v1/suppliers/${gulf}/statement`).set(owner());
    expect(after.body.data.closing.amountMinor).toBe(150_000);
  });

  it("pays dollar bills at the payment date's rate with the exchange difference", async () => {
    await api()
      .patch("/api/v1/settings/currency")
      .set(owner())
      .send({ enabledCurrencies: ["USD"] })
      .expect(200);
    await api()
      .post("/api/v1/fx-rates")
      .set(owner())
      .send({ quote: "USD", rate: "15", rateDate: day(0) })
      .expect(201);
    const dubai = await supplier("Dubai Auto Parts", 0);
    const a = await bill(dubai, { amount: "100.00", currency: "USD" });
    const b = await bill(dubai, { amount: "50.00", currency: "USD" });
    const cedi = await bill(dubai, { amount: "10.00" });
    const mixed = await pay(dubai, { expenseIds: [a, cedi] });
    expect(mixed.body.error.message).toMatch(/one currency/);

    const fxBefore = await balanceOf("4950");
    const paid = await pay(dubai, { expenseIds: [a, b], fxRate: "14" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.data).toMatchObject({
      payment: {
        currency: "USD",
        amount: { amountMinor: 15_000 },
        amountBase: { amountMinor: 210_000 },
      },
      fxDifference: { amountMinor: 15_000 },
      withholding: null,
    });
    expect(
      (paid.body.data.bills as { paidBase: Money; fxDifference: Money }[]).map((x) => [
        x.paidBase.amountMinor,
        x.fxDifference.amountMinor,
      ]),
    ).toEqual([
      [140_000, 10_000],
      [70_000, 5_000],
    ]);
    expect(Math.abs((await balanceOf("4950")) - fxBefore)).toBe(15_000);
    const bills = await api().get(`/api/v1/suppliers/${dubai}/bills`).set(owner());
    expect(bills.body.data.total.amountMinor).toBe(1_000);
  });
});
