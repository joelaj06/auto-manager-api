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

const CONSOLE = "/api/platform/v1";
const PRICE = 25_000; // GHS 250.00 per branch per month
let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;
let sales: TestStaff;
let tenants: ProvisionedTenants;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const staff = (who: TestStaff = admin) => as(who.accessToken);

async function addBranch(t: ProvisionedTenant, confirmBranchPurchase?: boolean) {
  return api()
    .post("/api/v1/branches")
    .set(as(t.ownerAccessToken))
    .send({
      code: `B${randomUUID().slice(0, 6).toUpperCase()}`,
      name: "Branch",
      ...(confirmBranchPurchase === undefined ? {} : { confirmBranchPurchase }),
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by expect()
type Body = any;
const subscription = async (t: ProvisionedTenant): Promise<Body> =>
  (await api().get("/api/v1/billing/subscription").set(as(t.ownerAccessToken))).body.data;

async function issue(t: ProvisionedTenant) {
  const res = await api().post(`${CONSOLE}/tenants/${t.tenantId}/invoices`).set(staff()).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; code: string; totalMinor: number; periodStart: string };
}

const pay = (invoiceId: string, amountMinor: number, reference: string = randomUUID()) =>
  api()
    .post(`${CONSOLE}/billing/invoices/${invoiceId}/payments`)
    .set(staff())
    .send({ method: "momo", reference, amountMinor, receivedAt: new Date().toISOString() });

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const fixtures = new StaffFixtures(container);
  admin = await fixtures.create(["super_admin"]);
  sales = await fixtures.create(["sales"]);
  tenants = new ProvisionedTenants(container, app, admin);
  const code = new TotpService().codeAt(admin.totpSecret, new Date(Date.now() + 30_000));
  await api()
    .post(`${CONSOLE}/auth/step-up`)
    .set(staff())
    .send({ password: admin.password, code })
    .expect(204);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("trial subscription and branch entitlement", () => {
  it("starts a standard trial at provisioning, limited to the trial's branches", async () => {
    const t = await tenants.create();
    const s = await subscription(t);
    expect(s).toMatchObject({
      status: "trialing",
      licenceType: "standard",
      branchCount: 1,
      licenceLocked: false,
      entitlements: { branchesMax: 3, canBuyBranches: false, trialEnded: false },
    });
    expect(new Date(s.trialEndsAt).getTime()).toBeGreaterThan(Date.now());

    expect((await addBranch(t)).status).toBe(201);
    expect((await addBranch(t)).status).toBe(201);
    expect((await subscription(t)).branchCount).toBe(3);
    const fourth = await addBranch(t, true);
    expect([fourth.status, fourth.body.error.code]).toEqual([409, "ENTITLEMENT_BRANCH_LIMIT"]);
    expect(fourth.body.error.message).toContain("trial includes up to 3");
  });
});

describe("manual billing", () => {
  it("invoices billed branches, records payments and activates the tenant", async () => {
    const t = await tenants.create();
    await addBranch(t); // 2 active branches billed

    const early = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/invoices`)
      .set(staff())
      .send({});
    if (early.status !== 201) {
      expect([early.status, early.body.error.code]).toEqual([409, "PRICE_NOT_SET"]);
      const notAllowed = await api()
        .put(`${CONSOLE}/billing/plans/standard/price`)
        .set(staff(sales))
        .send({ branchPriceMinor: PRICE, reason: "Launch price list" });
      expect(notAllowed.status).toBe(403);
      await api()
        .put(`${CONSOLE}/billing/plans/standard/price`)
        .set(staff())
        .send({ branchPriceMinor: PRICE, reason: "Launch price list" })
        .expect(200);
    } else {
      await api()
        .post(`${CONSOLE}/billing/invoices/${early.body.data.id}/void`)
        .set(staff())
        .send({ reason: "Price list test" })
        .expect(200);
      // Another file may have set another price.
      await api()
        .put(`${CONSOLE}/billing/plans/standard/price`)
        .set(staff())
        .send({ branchPriceMinor: PRICE, reason: "Launch price list" })
        .expect(200);
    }

    const invoice = await issue(t);
    expect(invoice.totalMinor).toBe(2 * PRICE);
    expect(invoice.code).toMatch(/^AF-INV-\d{4}-\d{6}$/);
    const again = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/invoices`)
      .set(staff())
      .send({});
    expect([again.status, again.body.error.code]).toEqual([409, "PERIOD_INVOICED"]);

    // The tenant sees the invoice, without internal fields.
    const mine = await api().get("/api/v1/billing/invoices").set(as(t.ownerAccessToken));
    expect(mine.body.data.map((i: { id: string }) => i.id)).toEqual([invoice.id]);
    expect(mine.body.data[0]).not.toHaveProperty("createdBy");

    // A partial payment does not activate anything.
    const partial = await pay(invoice.id, PRICE, "MOMO-REF-1");
    expect(partial.status, JSON.stringify(partial.body)).toBe(200);
    expect(partial.body.data).toMatchObject({ status: "open", outstandingMinor: PRICE });
    expect((await subscription(t)).status).toBe("trialing");
    const duplicate = await pay(invoice.id, 1, "MOMO-REF-1");
    expect([duplicate.status, duplicate.body.error.code]).toEqual([409, "DUPLICATE_PAYMENT"]);
    const over = await pay(invoice.id, PRICE + 1);
    expect([over.status, over.body.error.code]).toEqual([422, "INVOICE_RULE"]);

    const rest = await pay(invoice.id, PRICE, "MOMO-REF-2");
    expect(rest.body.data).toMatchObject({ status: "paid", outstandingMinor: 0 });
    expect(rest.body.data.payments).toHaveLength(2);

    const s = await subscription(t);
    expect(s).toMatchObject({
      status: "active",
      licenceLocked: true,
      branchCount: 2,
      monthlyPriceMinor: 2 * PRICE,
      currentPeriod: { start: invoice.periodStart },
      entitlements: { branchesMax: 2, canBuyBranches: true },
    });
    const config = await api().get(`/api/v1/public/tenant-config?slug=${t.slug}`);
    expect(config.body.data.tenant.status).toBe("active");

    const locked = await api()
      .put(`${CONSOLE}/tenants/${t.tenantId}/licence-type`)
      .set(staff())
      .send({ licenceType: "enterprise", reason: "Bigger customer" });
    expect([locked.status, locked.body.error.code]).toEqual([409, "LICENCE_TYPE_LOCKED"]);

    const history = await api().get("/api/v1/billing/transactions").set(as(t.ownerAccessToken));
    const paid = (history.body.data.transactions as { type: string }[]).filter(
      (e) => e.type === "payment",
    );
    expect(paid).toHaveLength(2);
    expect(history.body.data.balanceMinor).toBe(0);
    expect(paid[0]).not.toHaveProperty("recordedBy");
    expect(paid[0]).not.toHaveProperty("notes");

    // Paying tenants may add a branch by confirming the extra charge.
    const blocked = await addBranch(t);
    expect([blocked.status, blocked.body.error.code]).toEqual([409, "ENTITLEMENT_BRANCH_LIMIT"]);
    expect(blocked.body.error.message).toContain("GHS 250.00 more per month");
    expect((await addBranch(t, true)).status).toBe(201);
    expect((await subscription(t)).branchCount).toBe(3);

    // The next invoice continues from the paid period with the new branch count.
    const next = await issue(t);
    expect(next.totalMinor).toBe(3 * PRICE);
    expect(next.periodStart).toBe(s.currentPeriod.end);

    const console_ = await api().get(`${CONSOLE}/tenants/${t.tenantId}/subscription`).set(staff());
    expect(console_.body.data.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(["trial_started", "invoice_issued", "invoice_paid", "branch_added"]),
    );
    const dashboard = await api().get(`${CONSOLE}/dashboard`).set(staff());
    expect(dashboard.body.data.billing.mrrMinor).toBeGreaterThanOrEqual(3 * PRICE);
    expect(dashboard.body.data.billing.openInvoices).toBeGreaterThanOrEqual(1);
  });

  it("lowers the billed branches when a branch is deactivated", async () => {
    const t = await tenants.create();
    const created = await addBranch(t);
    expect((await subscription(t)).branchCount).toBe(2);
    await api()
      .post(`/api/v1/branches/${created.body.data.id}/deactivate`)
      .set(as(t.ownerAccessToken))
      .send({ reason: "Closed for renovation" })
      .expect(204);
    expect((await subscription(t)).branchCount).toBe(1);
  });

  it("restores a tenant deactivated for non-payment, but never a manual deactivation", async () => {
    const billingCase = await tenants.create();
    const manualCase = await tenants.create();
    await platform.query(
      `update tenants set status = 'deactivated', previous_status = 'past_due',
              deactivation_reason = 'non_payment', auto_restore_locked = false where id = $1`,
      [billingCase.tenantId],
    );
    await platform.query(
      `update tenants set status = 'deactivated', previous_status = 'active',
              deactivation_reason = 'abuse', auto_restore_locked = true where id = $1`,
      [manualCase.tenantId],
    );
    for (const t of [billingCase, manualCase]) {
      const invoice = await issue(t);
      await pay(invoice.id, invoice.totalMinor).expect(200);
    }
    const status = async (id: string) =>
      (await platform.query<{ status: string }>("select status from tenants where id = $1", [id]))
        .rows[0]!.status;
    expect(await status(billingCase.tenantId)).toBe("active");
    expect(await status(manualCase.tenantId)).toBe("deactivated");
  });

  it("lets staff adjust trials, licence and branches before the first payment", async () => {
    const t = await tenants.create();
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const extended = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/subscription/extend-trial`)
      .set(staff())
      .send({ until, reason: "Onboarding took longer" });
    expect(extended.status, JSON.stringify(extended.body)).toBe(200);
    expect(extended.body.data.trialEndsAt).toBe(until);
    const tooLong = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/subscription/extend-trial`)
      .set(staff())
      .send({
        until: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        reason: "Way too long",
      });
    expect(tooLong.status).toBe(422);

    const enterprise = await api()
      .put(`${CONSOLE}/tenants/${t.tenantId}/licence-type`)
      .set(staff())
      .send({ licenceType: "enterprise", reason: "Large fleet, custom quote" });
    expect(enterprise.body.data).toMatchObject({
      licenceType: "enterprise",
      monthlyPriceMinor: null,
    });
    const noLines = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/invoices`)
      .set(staff())
      .send({});
    expect([noLines.status, noLines.body.error.code]).toEqual([400, "LINES_REQUIRED"]);
    const custom = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/invoices`)
      .set(staff())
      .send({
        lines: [
          { kind: "branch_rate", description: "Negotiated rate", quantity: 5, unitMinor: 20_000 },
          { kind: "setup", description: "Data import", quantity: 1, unitMinor: 150_000 },
          { kind: "discount", description: "Contract discount", quantity: 1, unitMinor: -10_000 },
        ],
      });
    expect(custom.status, JSON.stringify(custom.body)).toBe(201);
    expect(custom.body.data.totalMinor).toBe(240_000);
    expect(
      custom.body.data.lines.map((l: { countsAsLicence: boolean }) => l.countsAsLicence),
    ).toEqual([true, false, false]);

    const branches = await api()
      .put(`${CONSOLE}/tenants/${t.tenantId}/subscription/branches`)
      .set(staff())
      .send({ branchCount: 5, reason: "Agreed in the quote" });
    expect(branches.body.data.branchCount).toBe(5);
    const notStaff = await api().get(`/api/v1/billing/subscription`).set(staff());
    expect(notStaff.status).toBe(401);
  });
});

describe("billing core", () => {
  const owner = (t: ProvisionedTenant) => as(t.ownerAccessToken);
  const settingsBody = (vatRegistered: boolean) => ({
    sellerName: "Autoforce Technologies Ltd",
    sellerAddress: "12 Liberation Road, Accra",
    sellerTin: "C0009998887",
    sellerEmail: "billing@autoforce.example",
    sellerPhone: "+233302000000",
    vatRegistered,
    vatNumber: vatRegistered ? "V0012345678" : null,
    taxComponents: [
      {
        key: "vat",
        name: "VAT",
        rate: "15",
        base: "net",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      },
      {
        key: "nhil",
        name: "NHIL",
        rate: "2.5",
        base: "net",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      },
      {
        key: "getfund",
        name: "GETFund Levy",
        rate: "2.5",
        base: "net",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      },
    ],
    paymentInstructions: "GCB Bank, account 1234567890, Autoforce Technologies Ltd",
    invoiceDueDays: 10,
    reason: "Accountant confirmed VAT registration",
  });

  /** A paying tenant whose paid period includes today (its trial ended yesterday). */
  async function payingTenant() {
    const t = await tenants.create();
    await platform.query(
      "update subscriptions set trial_ends_at = now() - interval '1 day' where tenant_id = $1",
      [t.tenantId],
    );
    await api()
      .put(`${CONSOLE}/billing/plans/standard/price`)
      .set(staff())
      .send({ branchPriceMinor: PRICE, reason: "Price list" })
      .expect(200);
    const first = await issue(t);
    await pay(first.id, first.totalMinor).expect(200);
    return { t, first };
  }

  it("keeps the tenant's billing details and contacts, seeded from the application", async () => {
    const t = await tenants.create();
    const details = await api().get("/api/v1/billing/details").set(owner(t));
    expect(details.body.data.profile.legalName).toMatch(/^Test Fleet /);
    expect(details.body.data.contacts).toEqual([
      expect.objectContaining({ isPrimary: true, email: t.ownerEmail }),
    ]);
    const updated = await api()
      .put("/api/v1/billing/details")
      .set(owner(t))
      .send({ legalName: "Kumasi Cabs Ltd", tin: "C0004445556", address: "Adum, Kumasi" });
    expect(updated.body.data).toMatchObject({ legalName: "Kumasi Cabs Ltd", tin: "C0004445556" });
    const noPrimary = await api()
      .put("/api/v1/billing/contacts")
      .set(owner(t))
      .send({ contacts: [{ name: "Accounts", email: "accounts@kumasicabs.example" }] });
    expect(noPrimary.body.error.message).toMatch(/exactly one primary/);
    const contacts = await api()
      .put("/api/v1/billing/contacts")
      .set(owner(t))
      .send({
        contacts: [
          { name: "Ama Owner", email: t.ownerEmail, isPrimary: true },
          { name: "Accounts", email: "accounts@kumasicabs.example", phone: "+233244000111" },
        ],
      });
    expect(contacts.body.data).toHaveLength(2);
    const console_ = await api()
      .get(`${CONSOLE}/tenants/${t.tenantId}/billing-details`)
      .set(staff());
    expect(console_.body.data.profile.legalName).toBe("Kumasi Cabs Ltd");
  });

  it("prorates a branch added during the paid period onto the next invoice, with VAT", async () => {
    const { t, first } = await payingTenant();
    expect(first.totalMinor).toBe(PRICE);
    expect((await addBranch(t, true)).status).toBe(201);

    const upcoming = await api().get("/api/v1/billing/upcoming").set(owner(t));
    expect(upcoming.status, JSON.stringify(upcoming.body)).toBe(200);
    const proration = (upcoming.body.data.lines as { kind: string; amountMinor: number }[]).find(
      (l) => l.kind === "proration",
    );
    // Added on the first day of the period: the whole month for the new branch.
    expect(proration).toMatchObject({ amountMinor: PRICE });
    expect(upcoming.body.data).toMatchObject({ subtotalMinor: 3 * PRICE, taxLines: [] });

    const vat = await api()
      .put(`${CONSOLE}/billing/settings`)
      .set(staff())
      .send(settingsBody(true));
    expect(vat.status, JSON.stringify(vat.body)).toBe(200);
    try {
      const next = await issue(t);
      const full = await api().get(`/api/v1/billing/invoices/${next.id}`).set(owner(t));
      expect(full.body.data).toMatchObject({
        subtotalMinor: 3 * PRICE,
        taxMinor: Math.round(3 * PRICE * 0.2),
        totalMinor: 3 * PRICE + Math.round(3 * PRICE * 0.2),
        seller: { name: "Autoforce Technologies Ltd", vatNumber: "V0012345678" },
        buyer: { name: expect.stringMatching(/^Test Fleet /), email: t.ownerEmail },
      });
      expect(full.body.data.taxLines.map((l: { key: string }) => l.key)).toEqual([
        "vat",
        "nhil",
        "getfund",
      ]);
      expect(full.body.data.lines.map((l: { kind: string }) => l.kind)).toEqual([
        "branch_rate",
        "proration",
      ]);
      // The proration is charged once: the next preview has none left.
      const after = await api().get("/api/v1/billing/upcoming").set(owner(t));
      expect(after.body.data.lines.map((l: { kind: string }) => l.kind)).toEqual(["branch_rate"]);
      const events = await api().get(`${CONSOLE}/tenants/${t.tenantId}/subscription`).set(staff());
      expect(events.body.data.events.map((e: { type: string }) => e.type)).toContain(
        "proration_charged",
      );

      // Voiding the invoice gives the proration back to the next one.
      await api()
        .post(`${CONSOLE}/billing/invoices/${next.id}/void`)
        .set(staff())
        .send({ reason: "Wrong VAT test" })
        .expect(200);
      const back = await api().get("/api/v1/billing/upcoming").set(owner(t));
      expect(back.body.data.lines.map((l: { kind: string }) => l.kind)).toEqual([
        "branch_rate",
        "proration",
      ]);
    } finally {
      await api().put(`${CONSOLE}/billing/settings`).set(staff()).send(settingsBody(false));
    }
  });

  it("numbers receipts, prints invoices and receipts, and keeps the full history", async () => {
    const { t, first } = await payingTenant();
    const receipts = await api().get("/api/v1/billing/receipts").set(owner(t));
    expect(receipts.body.data[0]).toMatchObject({
      invoiceId: first.id,
      receiptNumber: expect.stringMatching(/^AF-RCT-\d{4}-\d{6}$/),
    });
    const receiptId = receipts.body.data[0].id as string;
    for (const path of [
      `/api/v1/billing/invoices/${first.id}/pdf`,
      `/api/v1/billing/receipts/${receiptId}/pdf`,
    ]) {
      const pdf = await api().get(path).set(owner(t));
      expect(pdf.status, path).toBe(200);
      expect(pdf.headers["content-type"]).toMatch(/application\/pdf/);
    }
    for (const path of [
      `${CONSOLE}/billing/invoices/${first.id}/pdf`,
      `${CONSOLE}/billing/payments/${receiptId}/receipt/pdf`,
    ])
      expect((await api().get(path).set(staff())).status, path).toBe(200);
    const other = await tenants.create();
    expect(
      (await api().get(`/api/v1/billing/receipts/${receiptId}`).set(owner(other))).status,
    ).toBe(404);

    await addBranch(t, true);
    const open = await issue(t);
    const history = await api().get("/api/v1/billing/transactions").set(owner(t));
    expect(history.body.data).toMatchObject({ currency: "GHS", balanceMinor: open.totalMinor });
    expect(
      (history.body.data.transactions as { type: string; balanceMinor: number }[]).map((e) => [
        e.type,
        e.balanceMinor,
      ]),
    ).toEqual([
      ["invoice", PRICE],
      ["payment", 0],
      ["invoice", open.totalMinor],
    ]);
  });

  it("lists, defaults and forgets saved payment methods without exposing authorizations", async () => {
    const t = await tenants.create();
    for (const [label, isDefault] of [
      ["Visa •• 4081", true],
      ["MTN MoMo •• 5521", false],
    ] as const)
      await platform.query(
        `insert into payment_methods (tenant_id, provider, type, label, sealed_authorization, is_default)
         values ($1, 'paystack', $2, $3, 'sealed:secret', $4)`,
        [t.tenantId, label.startsWith("Visa") ? "card" : "momo", label, isDefault],
      );
    const listed = await api().get("/api/v1/billing/payment-methods").set(owner(t));
    expect(listed.body.data.map((m: { label: string }) => m.label)).toEqual([
      "Visa •• 4081",
      "MTN MoMo •• 5521",
    ]);
    expect(JSON.stringify(listed.body)).not.toContain("sealed");
    const momo = listed.body.data[1].id as string;
    const defaulted = await api()
      .post(`/api/v1/billing/payment-methods/${momo}/default`)
      .set(owner(t));
    expect(defaulted.body.data[0]).toMatchObject({ id: momo, isDefault: true });
    await api().delete(`/api/v1/billing/payment-methods/${momo}`).set(owner(t)).expect(204);
    expect(
      (await api().delete(`/api/v1/billing/payment-methods/${momo}`).set(owner(t))).status,
    ).toBe(404);
    const { rows } = await platform.query<{ sealed_authorization: string | null }>(
      "select sealed_authorization from payment_methods where id = $1",
      [momo],
    );
    expect(rows[0]?.sealed_authorization).toBeNull();
  });
});
