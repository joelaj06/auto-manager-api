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

let container: Container;
let app: Express;
let t: ProvisionedTenant;
let customer: string;

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");

async function newCustomer(): Promise<string> {
  const res = await api()
    .post("/api/v1/customers")
    .set(owner())
    .send({ type: "individual", firstName: "Ama", lastName: "Owusu", phone: `024${digits(7)}` });
  return res.body.data.id as string;
}

const invoice = (body: Record<string, unknown> = {}, partyId = customer) =>
  api()
    .post("/api/v1/invoices")
    .set(owner())
    .send({
      partyType: "customer",
      partyId,
      lines: [
        { description: "Car rental", quantity: 2, unitPrice: "500.00" },
        { description: "Exempt service", quantity: 1, unitPrice: "100.00", taxCode: "EXEMPT" },
      ],
      ...body,
    });

const issued = async (body: Record<string, unknown> = {}, partyId = customer) => {
  const draft = await invoice(body, partyId);
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const res = await api().post(`/api/v1/invoices/${draft.body.data.id}/issue`).set(owner());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { id: string; number: string; total: { amountMinor: number } };
};

const pay = (body: Record<string, unknown>) =>
  api()
    .post("/api/v1/payments")
    .set(owner())
    .send({ direction: "in", partyType: "customer", partyId: customer, ...body });

const balanced = async () => {
  const tb = await api().get("/api/v1/ledger/trial-balance").set(owner());
  expect(tb.body.data.balanced).toBe(true);
  return tb.body.data as { accounts: { code: string; balance: { amountMinor: number } }[] };
};
const balanceOf = (
  tb: { accounts: { code: string; balance: { amountMinor: number } }[] },
  code: string,
) => tb.accounts.find((a) => a.code === code)!.balance.amountMinor;

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  customer = await newCustomer();
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("invoices", () => {
  it("charges tax only for VAT-registered businesses, with the standard 20% breakdown", async () => {
    const refused = await invoice({
      lines: [{ description: "Rental", quantity: 1, unitPrice: "100", taxCode: "VAT_STANDARD" }],
    });
    expect(refused.body.error.message).toMatch(/only VAT-registered businesses charge tax/);

    await api().put("/api/v1/settings/tax").set(owner()).send({
      scheme: "standard",
      vatNumber: "C0001234567",
      pricesIncludeTax: false,
      defaultSalesTaxCode: "VAT_STANDARD",
    });
    const draft = await invoice();
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.data).toMatchObject({
      status: "draft",
      number: null,
      subtotal: { amountMinor: 110_000 },
      tax: { amountMinor: 20_000 },
      total: { amountMinor: 130_000, formatted: "₵1,300.00" },
    });
    expect(
      (draft.body.data.taxBreakdown as { key: string; amount: { amountMinor: number } }[]).map(
        (c) => [c.key, c.amount.amountMinor],
      ),
    ).toEqual([
      ["vat", 15_000],
      ["nhil", 2_500],
      ["getfund", 2_500],
    ]);

    const done = await api().post(`/api/v1/invoices/${draft.body.data.id}/issue`).set(owner());
    expect(done.body.data).toMatchObject({
      status: "issued",
      number: expect.stringMatching(/^INV-\d{4}-000001$/),
    });
    const tb = await balanced();
    expect(balanceOf(tb, "1100")).toBe(130_000);
    expect([balanceOf(tb, "2200"), balanceOf(tb, "2210"), balanceOf(tb, "2220")]).toEqual([
      15_000, 2_500, 2_500,
    ]);
    expect(balanceOf(tb, "4900")).toBe(110_000);

    const edit = await api()
      .put(`/api/v1/invoices/${draft.body.data.id}`)
      .set(owner())
      .send({
        partyType: "customer",
        partyId: customer,
        lines: [{ description: "Changed", quantity: 1, unitPrice: "1" }],
      });
    expect(edit.body.error.message).toMatch(/Only a draft/);
  });

  it("voids an unpaid invoice by reversing its posting", async () => {
    const inv = await issued();
    const before = await balanced();
    const voided = await api()
      .post(`/api/v1/invoices/${inv.id}/void`)
      .set(owner())
      .send({ reason: "Wrong customer" });
    expect(voided.body.data.status).toBe("void");
    const after = await balanced();
    expect(balanceOf(after, "1100")).toBe(balanceOf(before, "1100") - 130_000);
  });
});

describe("payments", () => {
  it("records MoMo money in, allocates it and keeps the rest as credit", async () => {
    const c = await newCustomer();
    const inv = await issued({}, c);
    const res = await api()
      .post("/api/v1/payments")
      .set(owner())
      .send({
        direction: "in",
        method: "momo",
        momoNetwork: "mtn",
        partyType: "customer",
        partyId: c,
        amount: "1000.00",
        reference: "MTN-889911",
        allocations: [{ invoiceId: inv.id, amount: "800.00" }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      number: expect.stringMatching(/^RCT-\d{4}-\d{6}$/),
      allocated: { amountMinor: 80_000 },
      unallocated: { amountMinor: 20_000 },
    });
    const account = await api().get(`/api/v1/ledger/parties/customer/${c}`).set(owner());
    expect(account.body.data).toMatchObject({
      credit: { amountMinor: 20_000 },
      receivable: { amountMinor: 50_000 },
      net: { amountMinor: 30_000 },
    });

    const more = await api()
      .post(`/api/v1/payments/${res.body.data.id}/allocations`)
      .set(owner())
      .send({ invoiceId: inv.id, amount: "200.00" });
    expect(more.body.data.unallocated.amountMinor).toBe(0);
    const invoiceNow = await api().get(`/api/v1/invoices/${inv.id}`).set(owner());
    expect(invoiceNow.body.data).toMatchObject({
      status: "partially_paid",
      balance: { amountMinor: 30_000 },
    });
    const receipt = await api().get(`/api/v1/payments/${res.body.data.id}/receipt`).set(owner());
    expect(receipt.body.data).toMatchObject({
      number: res.body.data.number,
      amount: { amountMinor: 100_000 },
      appliedTo: [
        { invoiceNumber: inv.number, amount: { amountMinor: 80_000 } },
        { invoiceNumber: inv.number, amount: { amountMinor: 20_000 } },
      ],
    });
    await balanced();
  });

  it("takes cash through the cashier's session and posts the till's variance", async () => {
    const inv = await issued();
    const noTill = await pay({ method: "cash", amount: "300" });
    expect([noTill.status, noTill.body.error.code]).toEqual([409, "CASH_SESSION_REQUIRED"]);

    const session = await api()
      .post("/api/v1/cash-sessions")
      .set(owner())
      .send({ float: "100.00" });
    expect(session.status, JSON.stringify(session.body)).toBe(201);
    const cash = await pay({
      method: "cash",
      amount: "1300.00",
      allocations: [{ invoiceId: inv.id, amount: "1300.00" }],
    });
    expect(cash.body.data.cashSessionId).toBe(session.body.data.id);
    expect((await api().get(`/api/v1/invoices/${inv.id}`).set(owner())).body.data.status).toBe(
      "paid",
    );

    const current = await api().get("/api/v1/cash-sessions/current").set(owner());
    expect(current.body.data.expected.amountMinor).toBe(140_000);
    const before = balanceOf(await balanced(), "5950");
    const closed = await api()
      .post(`/api/v1/cash-sessions/${session.body.data.id}/close`)
      .set(owner())
      .send({ counted: "1399.50" });
    expect(closed.body.data).toMatchObject({ status: "closed", variance: { amountMinor: -50 } });
    expect(balanceOf(await balanced(), "5950")).toBe(before + 50);
  });

  it("reverses a payment: allocations released, invoice open again, posting cancelled", async () => {
    const c = await newCustomer();
    const inv = await issued({}, c);
    const payment = await api()
      .post("/api/v1/payments")
      .set(owner())
      .send({
        direction: "in",
        method: "bank_transfer",
        partyType: "customer",
        partyId: c,
        amount: "1300",
        allocations: [{ invoiceId: inv.id, amount: "1300" }],
      });
    const voidPaid = await api()
      .post(`/api/v1/invoices/${inv.id}/void`)
      .set(owner())
      .send({ reason: "nope" });
    expect(voidPaid.body.error.message).toMatch(/Release the payments/);

    const reversed = await api()
      .post(`/api/v1/payments/${payment.body.data.id}/reverse`)
      .set(owner())
      .send({ reason: "Bounced transfer" });
    expect(reversed.body.data).toMatchObject({ status: "reversed", allocated: { amountMinor: 0 } });
    expect((await api().get(`/api/v1/invoices/${inv.id}`).set(owner())).body.data.status).toBe(
      "issued",
    );
    const account = await api().get(`/api/v1/ledger/parties/customer/${c}`).set(owner());
    expect(account.body.data).toMatchObject({
      credit: { amountMinor: 0 },
      receivable: { amountMinor: 130_000 },
    });
    await balanced();
  });

  it("refunds credit, never more than the party has", async () => {
    const c = await newCustomer();
    await api().post("/api/v1/payments").set(owner()).send({
      direction: "in",
      method: "bank_transfer",
      partyType: "customer",
      partyId: c,
      amount: "250",
    });
    const refund = (amount: string) =>
      api().post("/api/v1/payments").set(owner()).send({
        direction: "out",
        method: "bank_transfer",
        partyType: "customer",
        partyId: c,
        amount,
      });
    expect((await refund("300")).body.error.message).toMatch(/more than the credit/);
    const ok = await refund("250");
    expect(ok.body.data.number).toMatch(/^PAY-/);
    const account = await api().get(`/api/v1/ledger/parties/customer/${c}`).set(owner());
    expect(account.body.data.credit.amountMinor).toBe(0);
  });

  it("converts foreign-currency documents at the day's rate", async () => {
    await api()
      .patch("/api/v1/settings/currency")
      .set(owner())
      .send({ enabledCurrencies: ["USD"] });
    const noRate = await invoice({
      currency: "USD",
      lines: [{ description: "Import fee", quantity: 1, unitPrice: "100", taxCode: null }],
    });
    expect(noRate.body.error.code).toBe("FX_RATE_REQUIRED");
    const inv = await issued({
      currency: "USD",
      fxRate: "15.5",
      lines: [{ description: "Import fee", quantity: 1, unitPrice: "100", taxCode: null }],
    });
    expect(inv.total.amountMinor).toBe(10_000);
    const lines = await api()
      .get(`/api/v1/ledger/lines?partyType=customer&partyId=${customer}`)
      .set(owner());
    expect(lines.body.data[0]).toMatchObject({ debitMinor: 155_000 });
    await balanced();
  });
});

describe("integrity", () => {
  it("locks the base currency, keeps posted lines immutable and refuses locked periods", async () => {
    const base = await api()
      .patch("/api/v1/settings/currency")
      .set(owner())
      .send({ baseCurrency: "USD" });
    expect(base.body.error.code).toBe("CURRENCY_BASE_LOCKED");

    await expect(
      t.tenant.query("update ledger_lines set debit_minor = debit_minor + 1"),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      t.tenant.query(
        `insert into ledger_lines (entry_id, account_id, debit_minor)
         select e.id, a.id, 1 from journal_entries e, ledger_accounts a limit 1`,
      ),
    ).rejects.toThrow(/not balanced/);

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const lock = await api()
      .put("/api/v1/ledger/period-lock")
      .set(owner())
      .send({ lockedUntil: yesterday, reason: "Month end" });
    expect(lock.body.data.lockedUntil).toBe(yesterday);
    const late = await pay({ method: "bank_transfer", amount: "10", paidOn: yesterday });
    expect([late.status, late.body.error.code]).toEqual([409, "PERIOD_LOCKED"]);
    await api()
      .put("/api/v1/ledger/period-lock")
      .set(owner())
      .send({ lockedUntil: null, reason: "Reopen for test" });
  });
});
