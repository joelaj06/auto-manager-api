import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlatformAlerts } from "../../application/use-cases/console/PlatformAlerts.js";
import type {
  TenantUsageHistory,
  UsageMeter,
} from "../../application/use-cases/console/TenantUsageHistory.js";
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
 * Console operations readiness (P4-7): the alerts centre, support access with its trail (read
 * and four-eyes write mode, masking, blocked actions, the tenant's log), user support and owner
 * recovery, four-eyes refunds, announcements and maintenance windows, feature flags, kill
 * switches and entitlement overrides, and daily usage.
 */
const BASE = "/api/platform/v1";
let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;
let second: TestStaff;
let support: TestStaff;
let t: ProvisionedTenant;

const api = () => request(app);
const as = (who: { accessToken: string }) => ({ Authorization: `Bearer ${who.accessToken}` });
const tenantToken = (token: string) => ({ Authorization: `Bearer ${token}` });
const reason = "Customer called the help line";
const unique = () => randomUUID().slice(0, 8);

async function stepUp(who: TestStaff) {
  const code = new TotpService().codeAt(who.totpSecret, new Date(Date.now() + 30_000));
  await api()
    .post(`${BASE}/auth/step-up`)
    .set(as(who))
    .send({ password: who.password, code })
    .expect(204);
}

async function approve(approvalId: string) {
  const res = await api()
    .post(`${BASE}/approvals/${approvalId}/approve`)
    .set(as(second))
    .send({ note: "Checked" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.data.status, JSON.stringify(res.body.data)).toBe("approved");
}

const lastEmail = async (to: string, template: string) =>
  (
    await platform.query<{ body_text: string }>(
      `select body_text from email_deliveries where recipient = $1 and template = $2
        order by created_at desc limit 1`,
      [to, template],
    )
  ).rows[0]?.body_text;

beforeAll(async () => {
  container = await createTestContainer({
    AUTH_RATE_LIMIT_MAX: "10000",
    RATE_LIMIT_MAX: "100000",
    REFUND_APPROVAL_THRESHOLD_MINOR: "1000",
    BULK_MESSAGE_APPROVAL_TENANTS: "0",
  });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const fixtures = new StaffFixtures(container);
  admin = await fixtures.create(["super_admin"]);
  second = await fixtures.create(["super_admin"]);
  support = await fixtures.create(["support"]);
  for (const who of [admin, second, support]) await stepUp(who);
  t = await new ProvisionedTenants(container, app, admin).create();
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("alerts centre", () => {
  it("counts a repeated alert once, queues on-call, and is acknowledged and resolved", async () => {
    const alerts = container.get<PlatformAlerts>(TYPES.PlatformAlerts);
    const key = `test.alert:${unique()}`;
    await alerts.raise({ key, severity: "warning", source: "system", title: "Disk filling up" });
    await alerts.raise({ key, severity: "critical", source: "system", title: "Disk filling up" });
    const list = await api().get(`${BASE}/alerts?status=open`).set(as(support));
    const alert = (list.body.data as { id: string; key: string }[]).find((a) => a.key === key)!;
    expect(alert).toMatchObject({ severity: "critical", occurrences: 2 });
    const { rows } = await platform.query(
      "select 1 from pgboss.job where name = 'alerts.notify' and data->>'alertId' = $1",
      [alert.id],
    );
    expect(rows.length).toBe(2); // new, then escalated
    await api().post(`${BASE}/alerts/${alert.id}/acknowledge`).set(as(support)).expect(200);
    const resolved = await api()
      .post(`${BASE}/alerts/${alert.id}/resolve`)
      .set(as(support))
      .send({ note: "Freed space" });
    expect(resolved.body.data).toMatchObject({ status: "resolved", acknowledgedBy: support.id });
  });
});

describe("support access", () => {
  let driverId: string;

  beforeAll(async () => {
    const driver = await api()
      .post("/api/v1/drivers")
      .set(tenantToken(t.ownerAccessToken))
      .send({
        firstName: "Kwame",
        lastName: "Mensah",
        phone: `024${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
        ghanaCardNumber: `GHA-${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}-1`,
        licenceNumber: `DL-${unique()}`,
        licenceClass: "B",
        licenceExpiresOn: "2030-01-01",
      });
    expect(driver.status, JSON.stringify(driver.body)).toBe(201);
    driverId = driver.body.data.id as string;
  });

  it("opens read-only with a reason, masks numbers, blocks writes and exports, and logs it all", async () => {
    const opened = await api()
      .post(`${BASE}/tenants/${t.tenantId}/support-sessions`)
      .set(as(support))
      .send({ reason: "Owner cannot find a driver", ticket: "T-101" });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const id = opened.body.data.id as string;
    const token = (await api().post(`${BASE}/support-sessions/${id}/token`).set(as(support))).body
      .data;
    expect(token).toMatchObject({ mode: "read", tenant: { id: t.tenantId } });
    const bearer = tenantToken(token.accessToken as string);

    const driver = await api().get(`/api/v1/drivers/${driverId}`).set(bearer);
    expect(driver.status).toBe(200);
    expect(driver.body.data.ghanaCardNumber).toMatch(/^••••/);
    const write = await api()
      .post("/api/v1/vehicles")
      .set(bearer)
      .send({ make: "Toyota", model: "Corolla", plateNumber: `GR ${unique().slice(0, 4)}-26` });
    expect(write.body.error.code).toBe("SUPPORT_READ_ONLY");
    expect((await api().get("/api/v1/vehicles/export").set(bearer)).body.error.code).toBe(
      "SUPPORT_ACTION_BLOCKED",
    );

    await api().post(`${BASE}/support-sessions/${id}/end`).set(as(support)).expect(200);
    expect((await api().get("/api/v1/vehicles").set(bearer)).status).toBe(401);
    const trail = await api().get(`${BASE}/support-sessions/${id}`).set(as(support));
    expect(trail.body.data.requests.map((r: { statusCode: number }) => r.statusCode)).toEqual([
      200, 403, 403,
    ]);

    const log = await api()
      .get("/api/v1/settings/support-access")
      .set(tenantToken(t.ownerAccessToken));
    expect(log.body.data).toMatchObject({
      visible: true,
      sessions: [
        expect.objectContaining({ id, reason: "Owner cannot find a driver", requestCount: 3 }),
      ],
    });
  });

  it("needs the write permission and a second approver for write mode; staff are the actor", async () => {
    const refused = await api()
      .post(`${BASE}/tenants/${t.tenantId}/support-sessions`)
      .set(as(support))
      .send({ mode: "write", reason: "Fix a wrong plate number" });
    expect(refused.status).toBe(403);

    const opened = await api()
      .post(`${BASE}/tenants/${t.tenantId}/support-sessions`)
      .set(as(admin))
      .send({ mode: "write", reason: "Fix a wrong plate number", durationMinutes: 15 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(202);
    const id = opened.body.data.id as string;
    const early = await api().post(`${BASE}/support-sessions/${id}/token`).set(as(admin));
    expect(early.status).toBe(422);
    await approve(opened.body.data.approvalId as string);

    const token = (await api().post(`${BASE}/support-sessions/${id}/token`).set(as(admin))).body
      .data;
    const created = await api()
      .post("/api/v1/vehicles")
      .set(tenantToken(token.accessToken as string))
      .send({ make: "Toyota", model: "Corolla", plateNumber: `GR ${unique().slice(0, 4)}-26` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const audit = await t.tenant.query<{
      actor_type: string;
      actor_id: string;
      metadata: { support: { sessionId: string } };
    }>(
      "select actor_type, actor_id, metadata from audit_logs where action = 'vehicle.created' and entity_id = $1",
      [created.body.data.id],
    );
    expect(audit[0]).toMatchObject({
      actor_type: "platform_staff",
      actor_id: admin.id,
      metadata: { support: { sessionId: id } },
    });
    await api().post(`${BASE}/support-sessions/${id}/end`).set(as(admin)).expect(200);
  });
});

describe("user support", () => {
  it("finds the owner, signs them out everywhere and sends a reset code", async () => {
    const found = await api()
      .get(`${BASE}/users/search?identifier=${encodeURIComponent(t.ownerEmail)}`)
      .set(as(support));
    expect(found.body.data).toEqual([
      expect.objectContaining({
        tenantId: t.tenantId,
        user: expect.objectContaining({ isOwner: true }),
      }),
    ]);
    const ownerId = found.body.data[0].user.id as string;
    const users = await api().get(`${BASE}/tenants/${t.tenantId}/users`).set(as(support));
    expect(users.body.data.map((u: { id: string }) => u.id)).toContain(ownerId);

    await api()
      .post(`${BASE}/tenants/${t.tenantId}/users/${ownerId}/force-logout`)
      .set(as(support))
      .send({ reason })
      .expect(200);
    expect((await api().get("/api/v1/me").set(tenantToken(t.ownerAccessToken))).status).toBe(401);
    await api()
      .post(`${BASE}/tenants/${t.tenantId}/users/${ownerId}/reset-password`)
      .set(as(support))
      .send({ reason })
      .expect(200);
    expect(await lastEmail(t.ownerEmail, "auth.otp_code")).toMatch(/reset your password/);
    const disable = await api()
      .post(`${BASE}/tenants/${t.tenantId}/users/${ownerId}/disable`)
      .set(as(support))
      .send({ reason });
    expect(disable.body.error.code).toBe("OWNER_PROTECTED");
  });

  it("recovers an owner's access to a new email after a Super Admin approves", async () => {
    const newEmail = `recovered-${unique()}@example.com`;
    const asked = await api()
      .post(`${BASE}/tenants/${t.tenantId}/owner-recovery`)
      .set(as(admin))
      .send({
        newEmail,
        identityChecks: "Ghana Card and business registration checked on a video call",
        reason: "Owner lost access to the old mailbox",
      });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await approve(asked.body.data.approvalId as string);
    const users = await api().get(`${BASE}/tenants/${t.tenantId}/users`).set(as(support));
    expect(users.body.data.find((u: { isOwner: boolean }) => u.isOwner).email).toBe(newEmail);
    expect(await lastEmail(newEmail, "auth.otp_code")).toMatch(/reset your password/);
  });
});

describe("four-eyes refunds", () => {
  it("waits for a Super Admin above the threshold", async () => {
    await api()
      .put(`${BASE}/billing/plans/standard/price`)
      .set(as(admin))
      .send({ branchPriceMinor: 25_000, reason: "Price list" })
      .expect(200);
    await platform.query(
      "update subscriptions set trial_ends_at = now() - interval '1 day' where tenant_id = $1",
      [t.tenantId],
    );
    const invoice = await api()
      .post(`${BASE}/tenants/${t.tenantId}/invoices`)
      .set(as(admin))
      .send({});
    const paid = await api()
      .post(`${BASE}/billing/invoices/${invoice.body.data.id}/payments`)
      .set(as(admin))
      .send({
        method: "bank_transfer",
        reference: `OPS-${unique()}`,
        amountMinor: invoice.body.data.totalMinor,
        receivedAt: new Date().toISOString(),
      });
    const paymentId = paid.body.data.payments[0].id as string;
    const small = await api()
      .post(`${BASE}/billing/payments/${paymentId}/refunds`)
      .set(as(admin))
      .send({ amountMinor: 500, reason: "Rounding difference" });
    expect(small.status).toBe(201);
    const large = await api()
      .post(`${BASE}/billing/payments/${paymentId}/refunds`)
      .set(as(admin))
      .send({ amountMinor: 5_000, reason: "Charged for a closed branch" });
    expect(large.status, JSON.stringify(large.body)).toBe(202);
    expect(
      (await api().get(`${BASE}/billing/payments/${paymentId}/refunds`).set(as(admin))).body.data,
    ).toHaveLength(1);
    await approve(large.body.data.approvalId as string);
    expect(
      (await api().get(`${BASE}/billing/payments/${paymentId}/refunds`).set(as(admin))).body.data,
    ).toHaveLength(2);
  });
});

describe("communications", () => {
  it("shows a banner to the tenant, counts reads, and asks approval before mass email", async () => {
    const staffToken = as(support);
    const banner = await api()
      .post(`${BASE}/announcements`)
      .set(staffToken)
      .send({
        title: "New: work and pay statements",
        body: "Download statements from the agreement page.",
        audience: { tenantIds: [t.tenantId] },
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    expect(banner.status, JSON.stringify(banner.body)).toBe(201);
    const published = await api()
      .post(`${BASE}/announcements/${banner.body.data.id}/publish`)
      .set(staffToken);
    expect(published.body.data).toMatchObject({ status: "published", tenants: 1 });

    const visit = await api()
      .post(`${BASE}/tenants/${t.tenantId}/support-sessions`)
      .set(as(admin))
      .send({ reason: "Check the announcement banner" });
    const token = (
      await api().post(`${BASE}/support-sessions/${visit.body.data.id}/token`).set(as(admin))
    ).body.data;
    const seen = await api()
      .get("/api/v1/announcements")
      .set(tenantToken(token.accessToken as string));
    expect(seen.body.data.announcements).toEqual([
      expect.objectContaining({ id: banner.body.data.id, read: false }),
    ]);
    await api()
      .post(`${BASE}/support-sessions/${visit.body.data.id}/end`)
      .set(as(admin))
      .expect(200);

    const mass = await api()
      .post(`${BASE}/announcements`)
      .set(staffToken)
      .send({
        title: "Planned upgrade",
        body: "We upgrade on Sunday night.",
        audience: { tenantIds: [t.tenantId] },
        email: true,
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    const waiting = await api()
      .post(`${BASE}/announcements/${mass.body.data.id}/publish`)
      .set(staffToken);
    expect(waiting.status).toBe(202);
    await approve(waiting.body.data.approvalId as string);
    const { rows } = await platform.query(
      "select 1 from pgboss.job where name = 'announcements.email' and data->>'announcementId' = $1",
      [mass.body.data.id],
    );
    expect(rows.length).toBe(1);
  });

  it("makes every tenant read-only during a read-only maintenance window", async () => {
    const window = await api()
      .post(`${BASE}/maintenance-windows`)
      .set(as(admin))
      .send({
        title: "Database upgrade",
        message: "Changes are paused for 30 minutes.",
        startsAt: new Date(Date.now() - 1_000).toISOString(),
        endsAt: new Date(Date.now() + 1_800_000).toISOString(),
        readOnly: true,
      });
    expect(window.status, JSON.stringify(window.body)).toBe(201);
    const session = await api()
      .post(`${BASE}/tenants/${t.tenantId}/support-sessions`)
      .set(as(admin))
      .send({ mode: "write", reason: "Try a change during maintenance" });
    await approve(session.body.data.approvalId as string);
    const bearer = tenantToken(
      (await api().post(`${BASE}/support-sessions/${session.body.data.id}/token`).set(as(admin)))
        .body.data.accessToken as string,
    );
    const blocked = await api()
      .post("/api/v1/vehicles")
      .set(bearer)
      .send({ make: "Toyota", model: "Corolla", plateNumber: `GR ${unique().slice(0, 4)}-26` });
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe("MAINTENANCE_READ_ONLY");
    expect((await api().get("/api/v1/announcements").set(bearer)).body.data.maintenance).toEqual([
      expect.objectContaining({ title: "Database upgrade", readOnly: true }),
    ]);
    await api()
      .post(`${BASE}/maintenance-windows/${window.body.data.id}/cancel`)
      .set(as(admin))
      .expect(200);
    const allowed = await api()
      .post("/api/v1/vehicles")
      .set(bearer)
      .send({ make: "Toyota", model: "Corolla", plateNumber: `GR ${unique().slice(0, 4)}-26` });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);

    // Feature flags: a module off for this tenant, then a kill switch for everyone.
    await api()
      .put(`${BASE}/tenants/${t.tenantId}/flags/workpay`)
      .set(as(admin))
      .send({ enabled: false, reason: "Not part of their pilot" })
      .expect(200);
    const off = await api().get("/api/v1/workpay/agreements").set(bearer);
    expect(off.body.error.code).toBe("FEATURE_DISABLED");
    expect((await api().get("/api/v1/features").set(bearer)).body.data).toMatchObject({
      workpay: false,
      documents: true,
    });
    expect(
      (await api().get(`${BASE}/flags/workpay/resolve?tenantId=${t.tenantId}`).set(as(admin))).body
        .data,
    ).toEqual({ key: "workpay", enabled: false, because: "override" });
    await api()
      .post(`${BASE}/tenants/${t.tenantId}/flags/workpay/clear`)
      .set(as(admin))
      .send({ reason: "Pilot extended" })
      .expect(204);
    expect((await api().get("/api/v1/workpay/agreements").set(bearer)).status).toBe(200);

    await api()
      .patch(`${BASE}/flags/documents.signing`)
      .set(as(admin))
      .send({ enabled: false, reason: "Signing provider incident" })
      .expect(200);
    const killed = await api()
      .post("/api/v1/public/signing/open")
      .set("X-Tenant", t.slug)
      .send({ token: "x".repeat(40) });
    expect(killed.body.error.code).toBe("FEATURE_DISABLED");
    await api()
      .patch(`${BASE}/flags/documents.signing`)
      .set(as(admin))
      .send({ enabled: true, reason: "Incident over" })
      .expect(200);
    await api()
      .post(`${BASE}/support-sessions/${session.body.data.id}/end`)
      .set(as(admin))
      .expect(200);
  });
});

describe("entitlements and usage", () => {
  it("lets staff allow more active branches than billed", async () => {
    const res = await api()
      .put(`${BASE}/tenants/${t.tenantId}/entitlements/branches`)
      .set(as(admin))
      .send({ branches: 4, reason: "Pilot of four shops" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      branchLimitOverride: { branches: 4 },
      entitlements: { branchesMax: 4 },
    });
  });

  it("records a day of usage, API calls included", async () => {
    await container.get<UsageMeter>(TYPES.UsageMeter).flush();
    const day = new Date().toISOString().slice(0, 10);
    const history = container.get<TenantUsageHistory>(TYPES.TenantUsageHistory);
    expect(await history.collect(day)).toBeGreaterThan(0);
    const usage = await api().get(`${BASE}/tenants/${t.tenantId}/usage?days=2`).set(as(admin));
    expect(usage.body.data).toEqual([expect.objectContaining({ day, branches: 1, vehicles: 2 })]);
    expect(usage.body.data[0].apiCalls).toBeGreaterThan(5);
  });
});
