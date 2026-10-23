import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TotpService } from "../../infrastructure/security/TotpService.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Reseller commissions (P4-6): terms, the first-purchase commission (partial payments pro rata,
 * later invoices earn nothing), clawbacks on refunds, a fully refunded first purchase freeing the
 * next one, payouts with their records (cash four-eyes, acknowledgement, reversal), adjustments,
 * the minimum payout, statements and the reseller's own view.
 */
const BASE = "/api/platform/v1";
const PRICE = 25_000;
let container: Container;
let app: Express;
let platform: pg.Pool;
let fixtures: StaffFixtures;
let admin: TestStaff;
let finance: TestStaff;
let partnerId: string;
let partner: { accessToken: string };
let tenants: ProvisionedTenants;

const api = () => request(app);
const as = (who: { accessToken: string }) => ({ Authorization: `Bearer ${who.accessToken}` });
const unique = () => randomUUID().slice(0, 8);
const phone = () => `+23324${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
const month = () => new Date().toISOString().slice(0, 7);

async function stepUp(who: TestStaff) {
  const code = new TotpService().codeAt(who.totpSecret, new Date(Date.now() + 30_000));
  await api()
    .post(`${BASE}/auth/step-up`)
    .set(as(who))
    .send({ password: who.password, code })
    .expect(204);
}

/** A paying client of the reseller: trial over. */
async function client(): Promise<ProvisionedTenant> {
  const t = await tenants.create({ partnerId });
  await platform.query(
    "update subscriptions set trial_ends_at = now() - interval '1 day' where tenant_id = $1",
    [t.tenantId],
  );
  return t;
}

async function issue(t: ProvisionedTenant) {
  const res = await api().post(`${BASE}/tenants/${t.tenantId}/invoices`).set(as(admin)).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; totalMinor: number };
}

async function pay(invoiceId: string, amountMinor: number): Promise<string> {
  const res = await api()
    .post(`${BASE}/billing/invoices/${invoiceId}/payments`)
    .set(as(admin))
    .send({
      method: "bank_transfer",
      reference: `CM-${unique()}`,
      amountMinor,
      receivedAt: new Date().toISOString(),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const payments = res.body.data.payments as { id: string; amountMinor: number }[];
  return payments.at(-1)!.id;
}

async function refund(paymentId: string, amountMinor: number) {
  const res = await api()
    .post(`${BASE}/billing/payments/${paymentId}/refunds`)
    .set(as(admin))
    .send({ amountMinor, reason: "Paid twice by mistake" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

const ledger = async (tenantId?: string) =>
  (
    (await api().get(`${BASE}/partners/${partnerId}/commissions?limit=100`).set(as(admin))).body
      .data as { kind: string; amountMinor: number; status: string; tenantId: string | null }[]
  ).filter((e) => tenantId === undefined || e.tenantId === tenantId);

const balance = async () =>
  (await api().get(`${BASE}/partner/commissions/balance`).set(as(partner))).body.data as {
    payableMinor: number;
  } | null;

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  fixtures = new StaffFixtures(container);
  admin = await fixtures.create(["super_admin"]);
  finance = await fixtures.create(["billing"]);
  await stepUp(admin);
  await stepUp(finance);
  await api()
    .put(`${BASE}/billing/plans/standard/price`)
    .set(as(admin))
    .send({ branchPriceMinor: PRICE, reason: "Price list" })
    .expect(200);
  const created = await api()
    .post(`${BASE}/partners`)
    .set(as(admin))
    .send({
      name: `Reseller ${unique()}`,
      kind: "company",
      contactName: "Ama Mensah",
      email: `reseller-${unique()}@example.com`,
      phone: phone(),
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  partnerId = created.body.data.id as string;
  const email = `pu-${unique()}@example.com`;
  const invited = await api()
    .post(`${BASE}/partners/${partnerId}/users/invitations`)
    .set(as(admin))
    .send({ email, name: "Partner User" });
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries where recipient = $1
      and template = 'platform.staff_invitation' order by created_at desc limit 1`,
    [email],
  );
  const token = /#token=([A-Za-z0-9_-]+)/.exec(rows[0]!.body_text)![1]!;
  partner = await fixtures.activate(token, invited.body.data.userId as string, email);
  tenants = new ProvisionedTenants(container, app, admin);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("commission terms", () => {
  it("are set by the Super Admin only, versioned, and shown to the reseller", async () => {
    const terms = {
      standardPercent: "10",
      enterprisePercent: "15",
      minPayoutMinor: 1_000,
      reason: "Signed reseller agreement",
    };
    const refused = await api()
      .put(`${BASE}/partners/${partnerId}/commission-terms`)
      .set(as(finance))
      .send(terms);
    expect(refused.status).toBe(403);
    const saved = await api()
      .put(`${BASE}/partners/${partnerId}/commission-terms`)
      .set(as(admin))
      .send(terms);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data).toMatchObject({ version: 1, standardPercent: "10.00" });
    const profile = await api().get(`${BASE}/partner/profile`).set(as(partner));
    expect(profile.body.data.commissionTerms).toMatchObject({
      version: 1,
      standardPercent: "10.00",
      enterprisePercent: "15.00",
      minPayoutMinor: 1_000,
    });
    expect(profile.body.data.commissionTerms.reason).toBeUndefined();
  });
});

describe("the first licence purchase", () => {
  let t: ProvisionedTenant;
  let firstPayment: string;

  it("earns commission on each payment of the first paid invoice, and nothing after", async () => {
    t = await client();
    const first = await issue(t);
    firstPayment = await pay(first.id, 10_000);
    await pay(first.id, PRICE - 10_000);
    expect(await ledger(t.tenantId)).toEqual([
      expect.objectContaining({ kind: "commission", amountMinor: 1_500, status: "payable" }),
      expect.objectContaining({ kind: "commission", amountMinor: 1_000, status: "payable" }),
    ]);
    const second = await issue(t);
    await pay(second.id, second.totalMinor);
    expect(await ledger(t.tenantId)).toHaveLength(2);
    expect((await balance())?.payableMinor).toBe(2_500);
    const { rows } = await platform.query(
      "select 1 from email_deliveries where template = 'partner.notice'",
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("claws back what a refund takes from the first purchase", async () => {
    await refund(firstPayment, 10_000);
    expect((await ledger(t.tenantId))[0]).toMatchObject({ kind: "clawback", amountMinor: -1_000 });
    expect((await balance())?.payableMinor).toBe(1_500);
  });

  it("lets the next paid invoice be the first purchase when the first is fully refunded", async () => {
    const other = await client();
    await api()
      .put(`${BASE}/tenants/${other.tenantId}/partner-terms`)
      .set(as(admin))
      .send({ percent: "20", reason: "Large fleet deal" })
      .expect(204);
    const first = await issue(other);
    const paid = await pay(first.id, PRICE);
    await refund(paid, PRICE);
    const next = await issue(other);
    await pay(next.id, next.totalMinor);
    expect((await ledger(other.tenantId)).map((e) => [e.kind, e.amountMinor])).toEqual([
      ["commission", 5_000],
      ["clawback", -5_000],
      ["commission", 5_000],
    ]);
    // Leave this reseller's balance as before: take the new commission back by adjustment.
    await api()
      .post(`${BASE}/partners/${partnerId}/adjustments`)
      .set(as(admin))
      .send({ amountMinor: -5_000, reason: "Settled directly with the reseller" })
      .expect(201);
    expect((await balance())?.payableMinor).toBe(1_500);
  });
});

describe("payouts", () => {
  it("keeps a record for every method; cash needs a second approver and an acknowledgement", async () => {
    const path = `${BASE}/partners/${partnerId}/payouts`;
    const paidAt = new Date().toISOString();
    const noRef = await api()
      .post(path)
      .set(as(finance))
      .send({ method: "momo", details: { network: "mtn", number: "0244••567" }, paidAt });
    expect(noRef.status).toBe(422);
    const noProof = await api()
      .post(path)
      .set(as(finance))
      .send({
        method: "bank",
        reference: "GCB-1",
        details: { bank: "GCB", account: "••1234" },
        proofFileIds: [randomUUID()],
        paidAt,
      });
    expect(noProof.body.error.code).toBe("PROOF_NOT_FOUND");

    const cash = await api().post(path).set(as(finance)).send({ method: "cash", paidAt });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(cash.body.data).toMatchObject({ status: "awaiting_approval", totalMinor: 1_500 });
    const id = cash.body.data.id as string;
    expect(cash.body.data.entries).toHaveLength(7); // two clients: commissions, clawbacks, an adjustment
    const self = await api().post(`${BASE}/partner-payouts/${id}/approve`).set(as(finance));
    expect(self.body.error.code).toBe("PAYOUT_SECOND_APPROVER");
    const approved = await api().post(`${BASE}/partner-payouts/${id}/approve`).set(as(admin));
    expect(approved.body.data).toMatchObject({ status: "paid", approvedBy: admin.id });
    expect((await balance())?.payableMinor ?? 0).toBe(0);

    const waiting = await api().get(`${BASE}/partner-payouts?unacknowledged=true`).set(as(admin));
    expect(waiting.body.data.map((p: { id: string }) => p.id)).toContain(id);
    const ack = await api().post(`${BASE}/partner/payouts/${id}/acknowledge`).set(as(partner));
    expect(ack.body.data.acknowledgedAt).not.toBeNull();
    const after = await api().get(`${BASE}/partner-payouts?unacknowledged=true`).set(as(admin));
    expect(after.body.data.map((p: { id: string }) => p.id)).not.toContain(id);
  });

  it("carries a balance below the minimum forward, and reverses a payout instead of editing", async () => {
    const path = `${BASE}/partners/${partnerId}/payouts`;
    const momo = {
      method: "momo",
      reference: `MM-${unique()}`,
      details: { network: "mtn", number: "0244••567" },
      paidAt: new Date().toISOString(),
    };
    await api()
      .post(`${BASE}/partners/${partnerId}/adjustments`)
      .set(as(admin))
      .send({ amountMinor: 500, reason: "Bonus for the launch campaign" })
      .expect(201);
    expect((await api().post(path).set(as(finance)).send(momo)).body.error.code).toBe(
      "BELOW_MINIMUM_PAYOUT",
    );
    await api()
      .post(`${BASE}/partners/${partnerId}/adjustments`)
      .set(as(admin))
      .send({ amountMinor: 700, reason: "Bonus for the second campaign" })
      .expect(201);
    const paid = await api().post(path).set(as(finance)).send(momo);
    expect(paid.body.data).toMatchObject({ status: "paid", totalMinor: 1_200 });
    const reversed = await api()
      .post(`${BASE}/partner-payouts/${paid.body.data.id}/reverse`)
      .set(as(finance))
      .send({ reason: "Sent to the wrong number" });
    expect(reversed.body.data.status).toBe("reversed");
    expect((await balance())?.payableMinor).toBe(1_200);
  });
});

describe("statements", () => {
  it("adds up the month for staff and the reseller", async () => {
    const statement = await api()
      .get(`${BASE}/partners/${partnerId}/statements/${month()}`)
      .set(as(admin));
    expect(statement.body.data).toMatchObject({
      openingBalanceMinor: 0,
      commissionsMinor: 2_500 + 10_000,
      clawbacksMinor: -1_000 - 5_000,
      adjustmentsMinor: -5_000 + 500 + 700,
      payoutsMinor: 1_500,
      closingBalanceMinor: 1_200,
    });
    const pdf = await api()
      .get(`${BASE}/partner/commissions/statements/${month()}/pdf`)
      .set(as(partner));
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    const csv = await api()
      .get(`${BASE}/partners/${partnerId}/statements/${month()}/csv`)
      .set(as(admin));
    expect(csv.text.split("\n")[0]).toContain("amount_minor");
    // The reseller exports only with the export capability.
    const noExport = await api()
      .get(`${BASE}/partner/commissions/statements/${month()}/csv`)
      .set(as(partner));
    expect(noExport.status).toBe(403);
    const liability = await api().get(`${BASE}/partners/reports/liability`).set(as(finance));
    expect(liability.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ partnerId, payableMinor: 1_200 })]),
    );
  });
});

describe("the reseller's clients in billing automation", () => {
  it("tells the reseller when a client's payment is overdue", async () => {
    const late = await client();
    const invoice = await issue(late);
    await platform.query(
      "update billing_invoices set due_at = now() - interval '1 day' where id = $1",
      [invoice.id],
    );
    await api().post(`${BASE}/billing/automation/runs`).set(as(admin)).expect(200);
    const { rows } = await platform.query<{ body_text: string }>(
      `select d.body_text from email_deliveries d
         join partners p on p.email = d.recipient
        where p.id = $1 and d.template = 'partner.notice'`,
      [partnerId],
    );
    expect(rows.map((r) => r.body_text).join("\n")).toMatch(/It was due on .* unless it is paid/);
  });
});
