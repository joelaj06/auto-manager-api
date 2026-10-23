import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TotpService } from "../../infrastructure/security/TotpService.js";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * The billing automation (P4-3) end to end: an invoice issued before the trial ends, reminders,
 * past due, the safeguards (dry run, gateway guard, dispute hold), deactivation for an unpaid
 * trial, billing-only sign-in, an extension that restores the tenant, its lapse, and the payment
 * that restores it again with the period re-anchored. Days pass by moving the invoice's dates.
 */
const CONSOLE = "/api/platform/v1";
const PRICE = 25_000;
const DAY_MS = 86_400_000;
let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;
let t: ProvisionedTenant;
let invoiceId: string;
let member: { email: string; password: string };

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const staff = () => as(admin.accessToken);
const date = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

const POLICY = {
  invoiceLeadDays: 7,
  reminderDaysBefore: [7, 3, 1],
  overdueReminderDays: [1, 3, 5],
  graceDays: 7,
  readOnlyAfterDays: null,
  skipSundays: false,
  extension: { maxDays: 10, maxPer90Days: 2, finalGraceDays: 1 },
  dryRun: false,
  circuitBreaker: { maxCount: 5, maxPercent: 10 },
  reviewBranchThreshold: 1,
  gatewayGuard: { maxFailedWebhooks24h: 5 },
  channels: ["email", "sms", "in_app", "push"],
};

async function run() {
  const res = await api().post(`${CONSOLE}/billing/automation/runs`).set(staff());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as {
    status: string;
    dryRun: boolean;
    invoicesIssued: number;
    deactivated: { tenantId: string }[];
    wouldDeactivate: { tenantId: string }[];
    heldBack: { tenantId: string; reason: string }[];
  };
}

/** The invoice fell due `days` ago (its period started then too). */
async function dueDaysAgo(days: number) {
  await platform.query(
    `update billing_invoices set due_at = now() - make_interval(days => $2),
            period_start = current_date - $2::int, period_end = current_date - $2::int + 30
      where id = $1`,
    [invoiceId, days],
  );
}

async function login(email: string, password: string) {
  return api()
    .post("/api/v1/auth/login")
    .set("X-Tenant", t.slug)
    .send({ identifier: email, password });
}

const tenantStatus = async () =>
  (
    await platform.query<{ status: string; deactivation_reason: string | null }>(
      "select status, deactivation_reason from tenants where id = $1",
      [t.tenantId],
    )
  ).rows[0]!;

const notices = async (token: string) =>
  (await api().get("/api/v1/billing/notices?limit=100").set(as(token))).body.data as {
    step: string;
    channel: string;
  }[];

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  admin = await new StaffFixtures(container).create(["super_admin"]);
  const code = new TotpService().codeAt(admin.totpSecret, new Date(Date.now() + 30_000));
  await api()
    .post(`${CONSOLE}/auth/step-up`)
    .set(staff())
    .send({ password: admin.password, code })
    .expect(204);
  await api()
    .put(`${CONSOLE}/billing/plans/standard/price`)
    .set(staff())
    .send({ branchPriceMinor: PRICE, reason: "Price list" })
    .expect(200);
  // The run covers every tenant: the ones other test files left behind are out of the way.
  await platform.query("update tenants set status = 'archived' where status <> 'archived'");
  t = await new ProvisionedTenants(container, app, admin).create();
  await platform.query(
    `update subscriptions set trial_ends_at = now() + interval '7 days' where tenant_id = $1`,
    [t.tenantId],
  );
  await api().put(`${CONSOLE}/billing/dunning-policy`).set(staff()).send(POLICY).expect(200);

  // A user without billing access, to sign in later.
  const email = `member-${randomUUID().slice(0, 8)}@example.com`;
  const branches = await api().get("/api/v1/branches").set(as(t.ownerAccessToken));
  const branchId = (branches.body.data as { id: string; isDefault: boolean }[]).find(
    (b) => b.isDefault,
  )!.id;
  const invited = await api()
    .post("/api/v1/users/invitations")
    .set(as(t.ownerAccessToken))
    .send({ name: "Fleet Member", email, branchIds: [branchId] });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries where recipient = $1
      and template = 'tenant.user_invitation' order by created_at desc limit 1`,
    [email],
  );
  const token = /#token=([A-Za-z0-9_-]+)/.exec(rows[0]!.body_text)![1]!;
  member = { email, password: "another correct horse battery" };
  await api()
    .post("/api/v1/auth/invitations/accept")
    .set("X-Tenant", t.slug)
    .send({ token, password: member.password })
    .expect(200);
});

afterAll(async () => {
  await api()
    .put(`${CONSOLE}/billing/dunning-policy`)
    .set(staff())
    .send({ ...POLICY, dryRun: true, reviewBranchThreshold: 5 });
  await disposeContainer(container);
});

describe("billing automation", () => {
  it("issues the first invoice a week before the trial ends and reminds the owner", async () => {
    const result = await run();
    expect(result).toMatchObject({ status: "completed", dryRun: false });
    expect(result.invoicesIssued).toBe(1);
    const invoices = await api().get("/api/v1/billing/invoices").set(as(t.ownerAccessToken));
    expect(invoices.body.data).toHaveLength(1);
    invoiceId = invoices.body.data[0].id as string;
    expect(invoices.body.data[0]).toMatchObject({
      status: "open",
      dueAt: expect.stringContaining(date(7)),
    });
    expect((await run()).invoicesIssued).toBe(0); // one invoice per period

    const sent = await notices(t.ownerAccessToken);
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: "reminder_7", channel: "email" }),
        expect.objectContaining({ step: "reminder_7", channel: "in_app" }),
      ]),
    );
    expect(sent.filter((n) => n.step === "reminder_7" && n.channel === "email")).toHaveLength(1);
    const { rows } = await platform.query<{ body_text: string }>(
      `select body_text from email_deliveries where recipient = $1 and template = 'billing.notice'`,
      [t.ownerEmail],
    );
    expect(rows[0]!.body_text).toContain("/billing");
    expect(rows[0]!.body_text).not.toMatch(/AF-INV-/);
    const banner = await api().get("/api/v1/billing/banner").set(as(t.ownerAccessToken));
    expect(banner.body.data).toMatchObject({ state: "due_soon", invoiceId, dueOn: date(7) });
  });

  it("puts the tenant past due the day after the due date, with full access", async () => {
    await dueDaysAgo(1);
    await run();
    expect(await tenantStatus()).toMatchObject({ status: "past_due" });
    const subscription = await api()
      .get("/api/v1/billing/subscription")
      .set(as(t.ownerAccessToken));
    expect(subscription.body.data.status).toBe("past_due");
    expect((await notices(t.ownerAccessToken)).map((n) => n.step)).toContain("overdue_1");
    expect((await api().get("/api/v1/vehicles").set(as(t.ownerAccessToken))).status).toBe(200);
  });

  it("lists the tenant for review the day before, and holds back behind the safeguards", async () => {
    await dueDaysAgo(6);
    await run();
    expect((await notices(t.ownerAccessToken)).map((n) => n.step)).toContain("final_notice");
    const pending = await api().get(`${CONSOLE}/billing/automation/pending`).set(staff());
    expect(pending.body.data).toEqual([
      expect.objectContaining({ tenantId: t.tenantId, deactivateOn: date(1), large: true }),
    ]);

    await dueDaysAgo(7);
    await api()
      .put(`${CONSOLE}/billing/dunning-policy`)
      .set(staff())
      .send({ ...POLICY, dryRun: true })
      .expect(200);
    const dry = await run();
    expect(dry.wouldDeactivate.map((d) => d.tenantId)).toEqual([t.tenantId]);
    expect(dry.deactivated).toEqual([]);
    await api().put(`${CONSOLE}/billing/dunning-policy`).set(staff()).send(POLICY).expect(200);

    await api()
      .put(`${CONSOLE}/tenants/${t.tenantId}/billing/dispute-hold`)
      .set(staff())
      .send({ reason: "Disputes the branch count" })
      .expect(204);
    expect((await run()).heldBack).toEqual([
      expect.objectContaining({ tenantId: t.tenantId, reason: expect.stringMatching(/Dispute/) }),
    ]);
    await api()
      .put(`${CONSOLE}/tenants/${t.tenantId}/billing/dispute-hold`)
      .set(staff())
      .send({ reason: null })
      .expect(204);

    const now = new Date();
    for (let i = 0; i < 6; i++)
      await platform.query(
        `insert into webhook_events (provider, signature_valid, payload, outcome, received_at)
         values ('fake', true, '{}', 'failed', $1)`,
        [now],
      );
    expect((await run()).heldBack).toEqual([
      expect.objectContaining({ reason: expect.stringMatching(/Gateway guard/) }),
    ]);
    await platform.query("update webhook_events set outcome = 'ignored' where outcome = 'failed'");
    expect((await tenantStatus()).status).toBe("past_due");
  });

  it("deactivates an unpaid trial at the end of grace; only billing users get in", async () => {
    const result = await run();
    expect(result.deactivated.map((d) => d.tenantId)).toEqual([t.tenantId]);
    expect(await tenantStatus()).toEqual({
      status: "deactivated",
      deactivation_reason: "trial_expired",
    });

    const signedIn = await login(t.ownerEmail, OWNER_PASSWORD);
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const owner = as(signedIn.body.data.accessToken as string);
    expect((await api().get("/api/v1/billing/invoices").set(owner)).status).toBe(200);
    expect((await api().get("/api/v1/me").set(owner)).status).toBe(200);
    const blocked = await api().get("/api/v1/vehicles").set(owner);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("TENANT_DEACTIVATED");
    expect((await api().get("/api/v1/billing/banner").set(owner)).body.data.state).toBe(
      "deactivated",
    );

    const refused = await login(member.email, member.password);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("TENANT_DEACTIVATED");
  });

  it("restores the tenant when staff grant an extension, within the limits", async () => {
    const owner = as((await login(t.ownerEmail, OWNER_PASSWORD)).body.data.accessToken as string);
    const tooLong = await api()
      .post("/api/v1/billing/extensions")
      .set(owner)
      .send({ invoiceId, requestedUntil: date(4) });
    expect(tooLong.status).toBe(422);
    const asked = await api()
      .post("/api/v1/billing/extensions")
      .set(owner)
      .send({ invoiceId, requestedUntil: date(3), note: "Customer pays us on Friday" });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const again = await api()
      .post("/api/v1/billing/extensions")
      .set(owner)
      .send({ invoiceId, requestedUntil: date(2) });
    expect(again.body.error.code).toBe("EXTENSION_OPEN");

    const queue = await api().get(`${CONSOLE}/billing/extensions?status=requested`).set(staff());
    expect(queue.body.data).toEqual([expect.objectContaining({ id: asked.body.data.id })]);
    const approved = await api()
      .put(`${CONSOLE}/billing/extensions/${asked.body.data.id}/approve`)
      .set(staff())
      .send({ reason: "Long-standing customer" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({ status: "approved", approvedUntil: date(3) });
    expect((await tenantStatus()).status).toBe("past_due");

    const token = (await login(member.email, member.password)).body.data.accessToken as string;
    expect((await api().get("/api/v1/billing/banner").set(as(token))).body.data).toMatchObject({
      state: "extended",
      deactivateOn: date(4),
    });
    await run();
    expect((await tenantStatus()).status).toBe("past_due");
    expect((await notices(t.ownerAccessToken)).map((n) => n.step)).toContain(
      "extension_reminder_3",
    );
  });

  it("deactivates again after the extension lapses, and a payment restores it re-anchored", async () => {
    await platform.query(
      "update billing_extensions set approved_until = current_date - 1 where invoice_id = $1",
      [invoiceId],
    );
    expect((await run()).deactivated.map((d) => d.tenantId)).toEqual([t.tenantId]);
    const extensions = await api().get("/api/v1/billing/extensions").set(as(t.ownerAccessToken));
    expect(extensions.body.data[0].status).toBe("expired");

    const owner = as((await login(t.ownerEmail, OWNER_PASSWORD)).body.data.accessToken as string);
    // Recorded by staff: a gateway payment here would show up in other files' reconciliations.
    const paid = await api()
      .post(`${CONSOLE}/billing/invoices/${invoiceId}/payments`)
      .set(staff())
      .send({
        method: "bank_transfer",
        reference: `BT-${randomUUID().slice(0, 8)}`,
        amountMinor: PRICE,
        receivedAt: new Date().toISOString(),
      });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.data.status).toBe("paid");

    expect(await tenantStatus()).toEqual({ status: "active", deactivation_reason: null });
    const subscription = await api().get("/api/v1/billing/subscription").set(owner);
    expect(subscription.body.data).toMatchObject({
      status: "active",
      currentPeriod: { start: date(0) },
    });
    expect((await api().get("/api/v1/vehicles").set(owner)).status).toBe(200);
    expect((await api().get("/api/v1/billing/banner").set(owner)).body.data).toBeNull();

    const runs = await api().get(`${CONSOLE}/billing/automation/runs?limit=3`).set(staff());
    expect(runs.body.data[0]).toMatchObject({ status: "completed" });
  });
});
