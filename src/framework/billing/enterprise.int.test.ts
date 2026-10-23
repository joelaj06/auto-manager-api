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
 * The Enterprise licence (P4-4): a hand-built quote, approved and sent by a Super Admin,
 * accepted by the tenant, priced into its invoices (one-time items once), replaced by a new
 * version accepted by staff, and the licence type locked after the first payment.
 */
const CONSOLE = "/api/platform/v1";
const DAY_MS = 86_400_000;
let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;
let billingStaff: TestStaff;
let t: ProvisionedTenant;
let firstQuote: string;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const staff = (who: TestStaff = admin) => as(who.accessToken);
const owner = () => as(t.ownerAccessToken);
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

const LINES = [
  { kind: "branch_rate", description: "Enterprise licence", quantity: 3, unitMinor: 40_000 },
  {
    kind: "size_adjustment",
    description: "Fleet over 200 vehicles",
    quantity: 1,
    unitMinor: 30_000,
  },
  { kind: "setup", description: "Data import and training", quantity: 1, unitMinor: 150_000 },
  {
    kind: "discount",
    description: "Launch discount",
    quantity: 1,
    unitMinor: -10_000,
    recurrence: "monthly",
  },
];

async function stepUp(who: TestStaff) {
  const code = new TotpService().codeAt(who.totpSecret, new Date(Date.now() + 30_000));
  await api()
    .post(`${CONSOLE}/auth/step-up`)
    .set(staff(who))
    .send({ password: who.password, code })
    .expect(204);
}

async function issue() {
  const res = await api().post(`${CONSOLE}/tenants/${t.tenantId}/invoices`).set(staff()).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as {
    id: string;
    totalMinor: number;
    lines: { kind: string; quantity: number; unitMinor: number; countsAsLicence: boolean }[];
  };
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const fixtures = new StaffFixtures(container);
  admin = await fixtures.create(["super_admin"]);
  billingStaff = await fixtures.create(["billing"]);
  await stepUp(admin);
  t = await new ProvisionedTenants(container, app, admin).create();
  await platform.query(
    "update subscriptions set trial_ends_at = now() - interval '1 day' where tenant_id = $1",
    [t.tenantId],
  );
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("enterprise licence", () => {
  it("quotes only Enterprise tenants", async () => {
    const standard = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/quotes`)
      .set(staff())
      .send({ lines: LINES });
    expect(standard.status).toBe(409);
    expect(standard.body.error.code).toBe("NOT_ENTERPRISE");
    await api()
      .put(`${CONSOLE}/tenants/${t.tenantId}/licence-type`)
      .set(staff())
      .send({ licenceType: "enterprise", reason: "Large fleet, negotiated deal" })
      .expect(200);
    const noQuote = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/invoices`)
      .set(staff())
      .send({});
    expect(noQuote.body.error.code).toBe("LINES_REQUIRED");
  });

  it("builds a draft the tenant cannot see; only a Super Admin sends it", async () => {
    const draft = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/quotes`)
      .set(staff())
      .send({ lines: LINES.slice(0, 2), sizeBand: "large", sizeNote: "About 240 vehicles" });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.data).toMatchObject({
      version: 1,
      status: "draft",
      code: expect.stringMatching(/^AF-QUO-\d{4}-\d{6}$/),
    });
    firstQuote = draft.body.data.id as string;
    const edited = await api()
      .put(`${CONSOLE}/billing/quotes/${firstQuote}`)
      .set(staff())
      .send({ lines: LINES, sizeBand: "large", validUntil: inDays(14) });
    expect(edited.body.data).toMatchObject({ recurringMinor: 140_000, oneTimeMinor: 150_000 });
    expect((await api().get("/api/v1/billing/quotes").set(owner())).body.data).toEqual([]);
    expect((await api().get(`/api/v1/billing/quotes/${firstQuote}`).set(owner())).status).toBe(404);

    const refused = await api()
      .post(`${CONSOLE}/billing/quotes/${firstQuote}/send`)
      .set(staff(billingStaff));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("QUOTE_APPROVAL_REQUIRED");
    const sent = await api().post(`${CONSOLE}/billing/quotes/${firstQuote}/send`).set(staff());
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.data).toMatchObject({ status: "sent", approvedBy: admin.id });

    const listed = await api().get("/api/v1/billing/quotes").set(owner());
    expect(listed.body.data).toEqual([expect.objectContaining({ id: firstQuote, status: "sent" })]);
    const pdf = await api().get(`/api/v1/billing/quotes/${firstQuote}/pdf`).set(owner());
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    const { rows } = await platform.query<{ body_text: string }>(
      `select body_text from email_deliveries where recipient = $1 and template = 'billing.notice'`,
      [t.ownerEmail],
    );
    expect(rows.map((r) => r.body_text).join()).toMatch(/Quote AF-QUO-.*Billing tab/);
  });

  it("becomes the tenant's price list when the owner accepts it", async () => {
    const accepted = await api().post(`/api/v1/billing/quotes/${firstQuote}/accept`).set(owner());
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.data).toMatchObject({ status: "accepted", acceptedBy: { type: "user" } });
    const items = await api().get("/api/v1/billing/price-items").set(owner());
    expect(items.body.data).toHaveLength(4);
    const subscription = await api().get("/api/v1/billing/subscription").set(owner());
    expect(subscription.body.data).toMatchObject({
      licenceType: "enterprise",
      branchCount: 3,
      monthlyPriceMinor: 140_000,
    });
  });

  it("invoices the quote: the rate on the billed branches, one-time items once", async () => {
    const first = await issue();
    expect(first.totalMinor).toBe(140_000 + 150_000);
    expect(first.lines.find((l) => l.kind === "branch_rate")).toMatchObject({
      quantity: 3,
      unitMinor: 40_000,
      countsAsLicence: true,
    });
    expect(first.lines.find((l) => l.kind === "setup")).toMatchObject({ countsAsLicence: false });
    // Voided: its one-time items go on the next invoice.
    await api()
      .post(`${CONSOLE}/billing/invoices/${first.id}/void`)
      .set(staff())
      .send({ reason: "Wrong period" })
      .expect(200);
    const second = await issue();
    expect(second.totalMinor).toBe(290_000);
    await api()
      .post(`${CONSOLE}/billing/invoices/${second.id}/payments`)
      .set(staff())
      .send({
        method: "bank_transfer",
        reference: `ENT-${second.id.slice(0, 8)}`,
        amountMinor: second.totalMinor,
        receivedAt: new Date().toISOString(),
      })
      .expect(200);
    const third = await issue();
    expect(third.totalMinor).toBe(140_000);
    expect(third.lines.some((l) => l.kind === "setup")).toBe(false);

    const locked = await api()
      .put(`${CONSOLE}/tenants/${t.tenantId}/licence-type`)
      .set(staff())
      .send({ licenceType: "standard", reason: "Back to the price list" });
    expect(locked.body.error.code).toBe("LICENCE_TYPE_LOCKED");
  });

  it("replaces the price list with a new version accepted by staff", async () => {
    const v2 = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/quotes`)
      .set(staff())
      .send({
        lines: [
          {
            kind: "branch_rate",
            description: "Enterprise licence",
            quantity: 5,
            unitMinor: 35_000,
          },
        ],
        validUntil: inDays(7),
      });
    expect(v2.body.data.version).toBe(2);
    await api().post(`${CONSOLE}/billing/quotes/${v2.body.data.id}/send`).set(staff()).expect(200);
    const accepted = await api()
      .post(`${CONSOLE}/billing/quotes/${v2.body.data.id}/accept`)
      .set(staff())
      .send({ reason: "Signed copy received by email" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const quotes = await api().get(`${CONSOLE}/tenants/${t.tenantId}/quotes`).set(staff());
    expect(
      quotes.body.data.map((q: { version: number; status: string }) => [q.version, q.status]),
    ).toEqual([
      [2, "accepted"],
      [1, "superseded"],
    ]);
    const items = await api().get(`${CONSOLE}/tenants/${t.tenantId}/price-items`).set(staff());
    expect(items.body.data).toEqual([
      expect.objectContaining({ kind: "branch_rate", unitMinor: 35_000 }),
    ]);
    const subscription = await api().get("/api/v1/billing/subscription").set(owner());
    expect(subscription.body.data).toMatchObject({ branchCount: 5, monthlyPriceMinor: 175_000 });
    // Two more branches during the paid period, prorated at the new rate.
    const upcoming = await api().get("/api/v1/billing/upcoming").set(owner());
    expect(upcoming.body.data.lines.some((l: { kind: string }) => l.kind === "proration")).toBe(
      true,
    );

    const v3 = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/quotes`)
      .set(staff())
      .send({ lines: [] });
    const withdrawn = await api()
      .post(`${CONSOLE}/billing/quotes/${v3.body.data.id}/withdraw`)
      .set(staff())
      .send({ reason: "Not needed after all" });
    expect(withdrawn.body.data.status).toBe("withdrawn");
  });
});
