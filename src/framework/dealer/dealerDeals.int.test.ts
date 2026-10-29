import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DealerDealAlerts } from "../../application/use-cases/dealer/DealerDealAlerts.js";
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
 * Dealer deals (P7-6) end to end: a trade-in appraised; a cash deal over the seller's discount
 * limit approved, held against a deposit, sold with its invoice, the trade-in taken into stock
 * and the agreement, refused delivery until paid and delivered with the note and the after-sale
 * call; a bank deal sold once the loan is approved and paid by the disbursement; an in-house deal
 * with its schedule and charge, delivered after the down payment and reported overdue; a hold
 * that runs out and a cancelled deal.
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
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const digits = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
const post = (path: string, body: Record<string, unknown> = {}, headers = owner()) =>
  api().post(path).set(headers).send(body);
const decimal = (m: Money) => (m.amountMinor / 100).toFixed(2);
const checklist = [
  { item: "Spare key", checked: true },
  { item: "Registration papers", checked: true },
  { item: "Floor mats", checked: false, note: "Ordered, coming next week" },
];

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
    firstName: "Yaw",
    lastName: `Buyer${digits(4)}`,
    phone: `+23324${digits(7)}`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

/** A stock vehicle, ready, priced and listed. */
async function listed(price = "60000.00", minimum = "55000.00") {
  const v = await post("/api/v1/vehicles", {
    make: "Toyota",
    model: "Corolla",
    year: 2019,
    plateNumber: `GR ${digits(4)}-26`,
  });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.data.id as string;
  await post("/api/v1/dealer/stock", { vehicleId: id, source: "other" }).expect(201);
  const priced = await api()
    .patch(`/api/v1/dealer/stock/${id}/pricing`)
    .set(owner())
    .send({ askingPrice: price, minimumPrice: minimum });
  expect(priced.status, JSON.stringify(priced.body)).toBe(200);
  await post(`/api/v1/dealer/stock/${id}/list`).expect(200);
  return id;
}

const vehicleStatus = async (id: string) =>
  (await api().get(`/api/v1/vehicles/${id}`).set(owner())).body.data.status as string;
const deal = async (id: string) => {
  const res = await api().get(`/api/v1/dealer/deals/${id}`).set(owner());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { status: string; holdUntil: string | null; number: string };
};
async function inbox(token: string): Promise<{ title: string }[]> {
  const res = await api().get("/api/v1/notifications?limit=100").set(as(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { title: string }[];
}
const balanced = async () => {
  const tb = await api().get("/api/v1/ledger/trial-balance").set(owner());
  expect(tb.body.data.balanced).toBe(true);
  return tb.body.data as { accounts: { code: string; balance: Money }[] };
};
const runAlerts = (on: string) =>
  t.tenant.run(() => container.get<DealerDealAlerts>(TYPES.DealerDealAlerts).run(on));

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

describe("dealer deals", () => {
  it("sells for cash with a trade-in, a deposit, a hold and an approval, then delivers", async () => {
    const buyer = await customer();
    const vehicleId = await listed();
    const lead = await post(
      "/api/v1/dealer/leads",
      { source: "walk_in", name: "Yaw Buyer", phone: `+23324${digits(7)}`, customerId: buyer },
      as(ama.token),
    );
    expect(lead.status, JSON.stringify(lead.body)).toBe(201);
    const leadId = lead.body.data.id as string;

    // --- the trade-in appraised ---
    const appraisal = await post(
      "/api/v1/dealer/appraisals",
      {
        customerId: buyer,
        leadId,
        make: "Toyota",
        model: "Vitz",
        year: 2012,
        plateNumber: `gr ${digits(4)}-12`,
        mileage: 140_000,
        condition: "fair",
        findings: "Scratched rear bumper",
        value: "15000.00",
      },
      as(ama.token),
    );
    expect(appraisal.status, JSON.stringify(appraisal.body)).toBe(201);
    expect(appraisal.body.data).toMatchObject({ status: "open", validUntil: day(14) });
    expect(appraisal.body.data.number).toMatch(/^APR-/);
    const appraisalId = appraisal.body.data.id as string;

    // --- the deal: 10% off is over the seller's 5% and below the minimum ---
    const created = await post(
      "/api/v1/dealer/deals",
      {
        vehicleId,
        leadId,
        discount: "6000.00",
        addOns: [{ kind: "tint", amount: "1000.00" }],
        tradeInId: appraisalId,
        warrantyMonths: 6,
        serviceVouchers: 2,
      },
      as(ama.token),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      status: "draft",
      customerId: buyer,
      salesExecutiveId: ama.userId,
      needsApproval: true,
      approvedBy: null,
      tradeIn: { appraisalId, value: { amountMinor: 15_000_00 } },
      totals: { total: { amountMinor: 55_000_00 }, balance: { amountMinor: 40_000_00 } },
    });
    expect(created.body.data.number).toMatch(/^DEAL-/);
    const id = created.body.data.id as string;
    const other = await post("/api/v1/dealer/deals", { vehicleId, customerId: buyer });
    expect(other.status).toBe(422);

    // --- a hold needs a deposit and the approval ---
    expect((await post(`/api/v1/dealer/deals/${id}/reserve`, {}, as(ama.token))).status).toBe(422);
    expect(
      (
        await post(
          `/api/v1/dealer/deals/${id}/payments`,
          { amount: "5000.00", method: "bank_transfer" },
          as(ama.token),
        )
      ).status,
    ).toBe(403);
    const deposit = await post(`/api/v1/dealer/deals/${id}/payments`, {
      amount: "5000.00",
      method: "momo",
      momoNetwork: "mtn",
      reference: "MP123",
    });
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(200);
    expect(deposit.body.data.account).toMatchObject({
      credit: { amountMinor: 5_000_00 },
      balance: { amountMinor: 35_000_00 },
    });
    expect(deposit.body.data.account.payments).toHaveLength(1);
    const unapproved = await post(`/api/v1/dealer/deals/${id}/reserve`, {}, as(ama.token));
    expect(unapproved.status).toBe(422);
    expect((await post(`/api/v1/dealer/deals/${id}/approve`, {}, as(ama.token))).status).toBe(403);
    const approved = await post(`/api/v1/dealer/deals/${id}/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.approvedBy).toBeTruthy();
    expect(
      (await post(`/api/v1/dealer/deals/${id}/reserve`, { holdUntil: day(40) }, as(ama.token)))
        .status,
    ).toBe(422);
    const reserved = await post(`/api/v1/dealer/deals/${id}/reserve`, {}, as(ama.token));
    expect(reserved.status, JSON.stringify(reserved.body)).toBe(200);
    expect(reserved.body.data).toMatchObject({ status: "reserved", holdUntil: day(7) });
    expect(await vehicleStatus(vehicleId)).toBe("reserved");

    // --- the sale: invoice, the trade-in into stock, the agreement, the lead won ---
    const sold = await post(`/api/v1/dealer/deals/${id}/sell`);
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    const s = sold.body.data;
    expect(s).toMatchObject({ status: "sold", soldOn: day(0) });
    expect(s.invoiceId).toBeTruthy();
    expect(s.agreementDocumentId).toBeTruthy();
    expect(s.tradeInPaymentId).toBeTruthy();
    expect(s.account.invoiced.amountMinor).toBeGreaterThanOrEqual(55_000_00);
    expect(s.account.paid.amountMinor).toBe(20_000_00);
    expect(s.account.credit.amountMinor).toBe(0);
    expect(await vehicleStatus(vehicleId)).toBe("sold");
    const invoice = await api().get(`/api/v1/invoices/${s.invoiceId}`).set(owner());
    expect(invoice.body.data.lines).toHaveLength(2);

    const used = await api().get(`/api/v1/dealer/appraisals/${appraisalId}`).set(owner());
    expect(used.body.data).toMatchObject({ status: "used", dealId: id });
    const tradeIn = used.body.data.vehicleId as string;
    const stock = await api().get(`/api/v1/dealer/stock/${tradeIn}`).set(owner());
    expect(stock.status, JSON.stringify(stock.body)).toBe(200);
    expect(stock.body.data).toMatchObject({ status: "reconditioning", source: "trade_in" });
    expect(await vehicleStatus(tradeIn)).toBe("reconditioning");

    const agreement = await api().get(`/api/v1/documents/${s.agreementDocumentId}`).set(owner());
    expect(agreement.status, JSON.stringify(agreement.body)).toBe(200);
    expect(agreement.body.data.type).toBe("dealer_sales_agreement");
    const won = await api().get(`/api/v1/dealer/leads/${leadId}`).set(as(ama.token));
    expect(won.body.data.stage).toBe("won");

    // --- delivery once paid in full ---
    const early = await post(
      `/api/v1/dealer/deals/${id}/deliver`,
      { odometer: 52_000, checklist },
      as(ama.token),
    );
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/paid in full/);
    const rest = await post(`/api/v1/dealer/deals/${id}/payments`, {
      amount: decimal(s.account.balance),
      method: "bank_transfer",
    });
    expect(rest.status, JSON.stringify(rest.body)).toBe(200);
    expect(rest.body.data.account.balance.amountMinor).toBe(0);
    const unnoted = await post(
      `/api/v1/dealer/deals/${id}/deliver`,
      { odometer: 52_000, checklist: [{ item: "Spare key", checked: false }] },
      as(ama.token),
    );
    expect(unnoted.status).toBe(422);
    const delivered = await post(
      `/api/v1/dealer/deals/${id}/deliver`,
      { odometer: 52_000, checklist },
      as(ama.token),
    );
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(delivered.body.data).toMatchObject({
      status: "delivered",
      deliveredOn: day(0),
      deliveryOdometer: 52_000,
    });
    expect(delivered.body.data.warrantyEndsOn).toBeTruthy();
    const note = await api()
      .get(`/api/v1/documents/${delivered.body.data.deliveryDocumentId}`)
      .set(owner());
    expect(note.body.data.type).toBe("dealer_delivery_note");
    const after = await api().get(`/api/v1/dealer/leads/${leadId}`).set(as(ama.token));
    expect((after.body.data.tasks as { title: string; dueOn: string }[])[0]).toMatchObject({
      dueOn: day(7),
    });
    const sold2 = await api().get(`/api/v1/dealer/stock/${vehicleId}`).set(owner());
    expect(sold2.body.data.status).toBe("delivered");

    // --- the sales executive sees their deal; the books balance with the trade-in in 1500 ---
    const mine = await api().get("/api/v1/dealer/deals").set(as(ama.token));
    expect((mine.body.data as { id: string }[]).map((d) => d.id)).toContain(id);
    const tb = await balanced();
    expect(tb.accounts.find((a) => a.code === "1500")!.balance.amountMinor).toBeGreaterThanOrEqual(
      15_000_00,
    );
    // A trade-in is only taken in by its deal.
    const direct = await api().post("/api/v1/payments").set(owner()).send({
      direction: "in",
      partyType: "customer",
      partyId: buyer,
      method: "trade_in",
      amount: "10.00",
    });
    expect(direct.status).toBe(400);
  });

  it("sells on a bank loan once approved and is paid by the disbursement", async () => {
    const buyer = await customer();
    const vehicleId = await listed();
    const created = await post("/api/v1/dealer/deals", {
      vehicleId,
      customerId: buyer,
      salesExecutiveId: ama.userId,
      financing: "bank",
      loan: { lender: "GCB Bank", amount: "40000.00" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ loanStatus: "applied", needsApproval: false });
    const id = created.body.data.id as string;
    expect((await post(`/api/v1/dealer/deals/${id}/sell`)).status).toBe(422);
    const ok = await post(`/api/v1/dealer/deals/${id}/loan`, {
      status: "approved",
      reference: "GCB-77",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.loan.reference).toBe("GCB-77");
    const sold = await post(`/api/v1/dealer/deals/${id}/sell`);
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    const paid = await post(`/api/v1/dealer/deals/${id}/loan`, { status: "disbursed" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.data.loanStatus).toBe("disbursed");
    expect(paid.body.data.account.paid.amountMinor).toBe(40_000_00);
    const rest = await post(`/api/v1/dealer/deals/${id}/payments`, {
      amount: decimal(paid.body.data.account.balance),
      method: "bank_transfer",
    });
    expect(rest.body.data.account.balance.amountMinor).toBe(0);
    const delivered = await post(`/api/v1/dealer/deals/${id}/deliver`, {
      odometer: 30_000,
      checklist,
    });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(delivered.body.data.warrantyEndsOn).toBeNull();
    await balanced();
  });

  it("sells on in-house instalments, delivers after the down payment and reports arrears", async () => {
    const buyer = await customer();
    const vehicleId = await listed();
    const created = await post("/api/v1/dealer/deals", {
      vehicleId,
      customerId: buyer,
      salesExecutiveId: ama.userId,
      financing: "in_house",
      plan: { downPayment: "20000.00", markupPercent: "10", frequency: "monthly", months: 6 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const sold = await post(`/api/v1/dealer/deals/${id}/sell`);
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    const s = sold.body.data;
    expect(s.chargeInvoiceId).toBeTruthy();
    expect(s.plan.charge.amountMinor).toBeGreaterThan(0);
    expect(s.instalments.lines).toHaveLength(6);
    expect(s.instalments.lines[0].status).toBe("upcoming");
    expect(s.account.dueBeforeDelivery.amountMinor).toBe(20_000_00);
    const charge = await api().get(`/api/v1/invoices/${s.chargeInvoiceId}`).set(owner());
    expect(charge.body.data.total.amountMinor).toBe(s.plan.charge.amountMinor);

    const early = await post(`/api/v1/dealer/deals/${id}/deliver`, { odometer: 41_000, checklist });
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/down payment/);
    await post(`/api/v1/dealer/deals/${id}/payments`, {
      amount: "20000.00",
      method: "bank_transfer",
    }).expect(200);
    const delivered = await post(`/api/v1/dealer/deals/${id}/deliver`, {
      odometer: 41_000,
      checklist,
    });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(delivered.body.data.instalments.paid.amountMinor).toBe(0);

    // --- the first instalment paid; the second missed ---
    const first = s.instalments.lines[0];
    await post(`/api/v1/dealer/deals/${id}/payments`, {
      amount: decimal(first.amount),
      method: "momo",
      momoNetwork: "mtn",
    }).expect(200);
    const later = s.instalments.lines[1].dueOn as string;
    const lateDay = new Date(Date.parse(`${later}T00:00:00Z`) + 2 * DAY).toISOString().slice(0, 10);
    await runAlerts(lateDay);
    await runAlerts(lateDay);
    const notices = (await inbox(ama.token)).filter((n) => n.title.includes(s.number));
    expect(notices.map((n) => n.title)).toEqual([`Instalment 2 on deal ${s.number} is overdue`]);
    await balanced();
  });

  it("lets a hold run out and cancels a deal with the deposit kept as credit", async () => {
    const buyer = await customer();
    const vehicleId = await listed();
    const created = await post("/api/v1/dealer/deals", {
      vehicleId,
      customerId: buyer,
      salesExecutiveId: ama.userId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    await post(`/api/v1/dealer/deals/${id}/payments`, {
      amount: "2000.00",
      method: "bank_transfer",
    }).expect(200);
    const reserved = await post(`/api/v1/dealer/deals/${id}/reserve`, { holdUntil: day(2) });
    expect(reserved.status, JSON.stringify(reserved.body)).toBe(200);
    const extended = await post(`/api/v1/dealer/deals/${id}/reserve`, { holdUntil: day(3) });
    expect(extended.body.data.holdUntil).toBe(day(3));

    await runAlerts(day(4));
    const lapsed = await deal(id);
    expect(lapsed).toMatchObject({ status: "draft", holdUntil: null });
    expect(await vehicleStatus(vehicleId)).toBe("for_sale");
    expect(
      (await inbox(ama.token)).some((n) => n.title === `Hold on deal ${lapsed.number} ran out`),
    ).toBe(true);

    expect((await post(`/api/v1/dealer/deals/${id}/cancel`, { reason: "" })).status).toBe(400);
    const cancelled = await post(`/api/v1/dealer/deals/${id}/cancel`, {
      reason: "Bought elsewhere",
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data).toMatchObject({
      status: "cancelled",
      cancelReason: "Bought elsewhere",
      account: { credit: { amountMinor: 2_000_00 } },
    });
    const again = await post("/api/v1/dealer/deals", { vehicleId, customerId: buyer });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });
});
