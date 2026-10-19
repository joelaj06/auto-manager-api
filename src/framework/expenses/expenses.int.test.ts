import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RecurringExpenses } from "../../application/use-cases/expenses/RecurringExpenses.js";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let categories: Record<string, string>;
let supplier: string;
let vehicles: string[];
let administrator: string;
let limited: string;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const today = () => new Date().toISOString().slice(0, 10);
const png = () => {
  const bytes = Buffer.alloc(64, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
};

async function join(roles: { roleId: string; branchId: string | null }[]): Promise<string> {
  const email = `user-${randomUUID().slice(0, 8)}@example.com`;
  const branches = await api().get("/api/v1/branches").set(owner());
  const branchIds = (branches.body.data as { id: string }[]).map((b) => b.id);
  const invited = await api()
    .post("/api/v1/users/invitations")
    .set(owner())
    .send({ name: "Approver", email, branchIds, roles });
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

const create = (body: Record<string, unknown>) =>
  api()
    .post("/api/v1/expenses")
    .set(owner())
    .send({
      categoryId: categories.insurance,
      description: "Insurance",
      payeeType: "supplier",
      payeeId: supplier,
      amount: "100.00",
      ...body,
    });

const submitted = async (body: Record<string, unknown>) => {
  const res = await create(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const done = await api().post(`/api/v1/expenses/${res.body.data.expense.id}/submit`).set(owner());
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return done.body.data as {
    id: string;
    status: string;
    number: string;
    approvalRuleId: string | null;
  };
};

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
  await api().put("/api/v1/settings/tax").set(owner()).send({
    scheme: "standard",
    vatNumber: "C0001234567",
    pricesIncludeTax: false,
    defaultSalesTaxCode: "VAT_STANDARD",
  });
  const tree = await api().get("/api/v1/expense-categories").set(owner());
  categories = Object.fromEntries(
    (tree.body.data as { code: string; id: string }[]).map((c) => [c.code, c.id]),
  );
  supplier = (
    await api()
      .post("/api/v1/suppliers")
      .set(owner())
      .send({ name: "SIC Insurance", type: "insurer" })
  ).body.data.id;
  vehicles = [];
  for (let i = 0; i < 3; i += 1)
    vehicles.push(
      (
        await api()
          .post("/api/v1/vehicles")
          .set(owner())
          .send({
            make: "Toyota",
            model: "Corolla",
            plateNumber: `GR ${digits(4)}-26`,
            odometer: 10_000,
          })
      ).body.data.id,
    );

  const roles = await api().get("/api/v1/roles").set(owner());
  const adminRole = (roles.body.data as { id: string; systemKey: string | null }[]).find(
    (r) => r.systemKey === "administrator",
  )!.id;
  administrator = await join([{ roleId: adminRole, branchId: null }]);
  const limitedRole = await api()
    .post("/api/v1/roles")
    .set(owner())
    .send({
      name: "Small approver",
      grants: [
        { key: "expenses.list", scope: "all" },
        { key: "expenses.view", scope: "all" },
        { key: "expenses.approve", scope: "all", limits: { max_amount_minor: 50_000 } },
      ],
    });
  expect(limitedRole.status, JSON.stringify(limitedRole.body)).toBe(201);
  limited = await join([{ roleId: limitedRole.body.data.id, branchId: null }]);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("expenses", () => {
  it("splits a bill across vehicles with recoverable VAT and flags a likely duplicate", async () => {
    const res = await create({ amount: "1200.00", taxCode: "VAT_STANDARD", vehicleIds: vehicles });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.expense).toMatchObject({
      status: "draft",
      net: { amountMinor: 100_000 },
      tax: { amountMinor: 20_000 },
    });
    expect(
      (res.body.data.expense.lines as { amount: { amountMinor: number } }[]).map(
        (l) => l.amount.amountMinor,
      ),
    ).toEqual([40_000, 40_000, 40_000]);
    expect(res.body.data.warnings).toEqual([]);
    const again = await create({
      amount: "1200.00",
      taxCode: "VAT_STANDARD",
      vehicleIds: vehicles,
    });
    expect(again.body.data.warnings[0]).toMatch(/same category, date and amount/);
  });

  it("is approved by someone else within their limit, posted, paid, and reopened by a reversal", async () => {
    const expense = await submitted({
      amount: "1200.00",
      taxCode: "VAT_STANDARD",
      vehicleIds: vehicles.slice(0, 2),
    });
    expect(expense).toMatchObject({
      status: "submitted",
      number: expect.stringMatching(/^EXP-\d{4}-\d{6}$/),
    });

    const self = await api().post(`/api/v1/expenses/${expense.id}/approve`).set(owner());
    expect(self.body.error.message).toMatch(/Someone else approves/);
    const overLimit = await api().post(`/api/v1/expenses/${expense.id}/approve`).set(as(limited));
    expect([overLimit.status, overLimit.body.error.code]).toEqual([403, "APPROVAL_LIMIT_EXCEEDED"]);

    const payablesBefore = await balanceOf("2000");
    const inputTaxBefore = await balanceOf("1300");
    const approved = await api()
      .post(`/api/v1/expenses/${expense.id}/approve`)
      .set(as(administrator));
    expect(approved.body.data.status).toBe("approved");
    expect(await balanceOf("2000")).toBe(payablesBefore + 120_000);
    expect(await balanceOf("1300")).toBe(inputTaxBefore + 20_000);
    const lines = await api().get(`/api/v1/ledger/lines?vehicleId=${vehicles[0]}`).set(owner());
    expect(lines.body.data[0]).toMatchObject({ debitMinor: 50_000 });

    const paid = await api()
      .post(`/api/v1/expenses/${expense.id}/pay`)
      .set(owner())
      .send({ method: "bank_transfer", reference: "TRF-1" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.data.status).toBe("paid");
    expect(await balanceOf("2000")).toBe(payablesBefore);

    const reversed = await api()
      .post(`/api/v1/payments/${paid.body.data.paymentId}/reverse`)
      .set(owner())
      .send({ reason: "Paid twice" });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(
      (await api().get(`/api/v1/expenses/${expense.id}`).set(owner())).body.data,
    ).toMatchObject({
      status: "approved",
      paymentId: null,
    });
  });

  it("approves small expenses by rule and lets rejected ones be corrected", async () => {
    const rule = await api()
      .post("/api/v1/expense-approval-rules")
      .set(owner())
      .send({ name: "Small spend", maxAmount: "500.00", action: "auto_approve", priority: 10 });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const small = await submitted({ amount: "300.00" });
    expect(small).toMatchObject({ status: "approved", approvalRuleId: rule.body.data.id });

    const big = await submitted({ amount: "800.00", description: "Wrong amount" });
    await api()
      .post(`/api/v1/expenses/${big.id}/reject`)
      .set(as(administrator))
      .send({ reason: "Check the amount" });
    const fixed = await api().put(`/api/v1/expenses/${big.id}`).set(owner()).send({
      categoryId: categories.insurance,
      description: "Fixed",
      payeeType: "supplier",
      payeeId: supplier,
      amount: "450.00",
    });
    expect(fixed.body.data.expense.status).toBe("rejected");
    const resubmitted = await api().post(`/api/v1/expenses/${big.id}/submit`).set(owner());
    expect(resubmitted.body.data).toMatchObject({ status: "approved", number: big.number });
  });

  it("requires a receipt above the business's threshold", async () => {
    await api()
      .patch("/api/v1/settings/expenses")
      .set(owner())
      .send({ receiptRequiredAbove: "1000.00" });
    const res = await create({
      amount: "1500.00",
      description: "Brake pads",
      categoryId: categories.maintenance,
    });
    const id = res.body.data.expense.id as string;
    const early = await api().post(`/api/v1/expenses/${id}/submit`).set(owner());
    expect(early.body.error.message).toMatch(/Attach the receipt/);

    const started = await api()
      .post(`/api/v1/expenses/${id}/receipts`)
      .set(owner())
      .send({ filename: "receipt.png", contentType: "image/png", sizeBytes: png().length });
    const { method, url, headers } = started.body.data.upload;
    await fetch(url, { method, headers, body: png() });
    await api()
      .post(`/api/v1/expenses/${id}/receipts/${started.body.data.file.id}/complete`)
      .set(owner());
    expect((await api().post(`/api/v1/expenses/${id}/submit`).set(owner())).body.data.status).toBe(
      "submitted",
    );
    const got = await api().get(`/api/v1/expenses/${id}`).set(owner());
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.data.receipts).toHaveLength(1);
    await api()
      .patch("/api/v1/settings/expenses")
      .set(owner())
      .send({ receiptRequiredAbove: null });
  });

  it("voids an approved expense by reversing it", async () => {
    const expense = await submitted({ amount: "200.00", description: "Voided" });
    expect(expense.status).toBe("approved");
    const before = await balanceOf("2000");
    const voided = await api()
      .post(`/api/v1/expenses/${expense.id}/void`)
      .set(owner())
      .send({ reason: "Duplicate" });
    expect(voided.body.data.status).toBe("void");
    expect(await balanceOf("2000")).toBe(before - 20_000);
  });
});

describe("fuel, budgets and recurring expenses", () => {
  it("records fuel fills as expenses and odometer readings, and measures efficiency", async () => {
    const v = vehicles[2]!;
    const fill = (odometer: number, litres: string, amount: string) =>
      api()
        .post(`/api/v1/vehicles/${v}/fuel`)
        .set(owner())
        .send({ litres, amount, odometer, station: "GOIL Spintex" });
    const first = await fill(10_100, "40", "460.00");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.expense).toMatchObject({ status: "approved", sourceType: "fuel_log" });
    expect(first.body.data.log.pricePerLitre.amountMinor).toBe(1_150);
    await fill(10_580, "40", "460.00");
    await fill(11_060, "40", "460.00");
    const report = await api().get(`/api/v1/vehicles/${v}/fuel`).set(owner());
    expect(report.body.data).toMatchObject({ averageKmPerLitre: 12 });
    expect((await api().get(`/api/v1/vehicles/${v}`).set(owner())).body.data.odometer.value).toBe(
      11_060,
    );
    const lower = await fill(9_000, "10", "100.00");
    expect(lower.body.error.code).toBe("ODOMETER_INVALID");
  });

  it("shows spending against a monthly budget", async () => {
    await api().post("/api/v1/budgets").set(owner()).send({
      name: "Fuel, third car",
      categoryId: categories.fuel,
      vehicleId: vehicles[2],
      monthlyAmount: "1500.00",
    });
    const statuses = await api().get("/api/v1/budgets").set(owner());
    expect(statuses.body.data[0]).toMatchObject({
      spent: { amountMinor: 138_000 },
      percent: 92,
      level: "warning",
    });
  });

  it("creates recurring expenses when due, catching up and moving to the next run", async () => {
    const branches = await api().get("/api/v1/branches").set(owner());
    const branchId = (branches.body.data as { id: string }[])[0]!.id;
    const start = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    const created = await api().post("/api/v1/recurring-expenses").set(owner()).send({
      name: "Tracker subscription",
      categoryId: categories.other,
      branchId,
      description: "GPS tracker",
      payeeName: "Tracker Ltd",
      amount: "150.00",
      frequency: "monthly",
      startOn: start,
      autoSubmit: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await t.tenant.run(() =>
      container.get<RecurringExpenses>(TYPES.RecurringExpenses).run(today()),
    );
    const list = await api().get(`/api/v1/expenses?categoryId=${categories.other}`).set(owner());
    const tracker = (list.body.data as { description: string; status: string }[]).filter(
      (e) => e.description === "GPS tracker",
    );
    expect(tracker).toHaveLength(2);
    expect(tracker.every((e) => e.status === "approved")).toBe(true);
    const after = await api().get("/api/v1/recurring-expenses").set(owner());
    expect(after.body.data[0].nextRunOn > today()).toBe(true);
  });
});
