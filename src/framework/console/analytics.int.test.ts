import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * Platform analytics (P8-4) end to end: the nightly usage with modules, jobs and onboarding
 * milestones, the growth funnel, adoption by module, the health score and onboarding checklist
 * of a tenant, cohorts, cost to serve with its rates, reseller performance and churn — and staff
 * without the analytics permission kept out.
 */
const BASE = "/api/platform/v1/analytics";
let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;
let support: TestStaff;
let t: ProvisionedTenant;
let partnerId: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by expect()
type Body = any;

const api = () => request(app);
const as = (who: { accessToken: string }) => ({ Authorization: `Bearer ${who.accessToken}` });
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const get = async (path: string, who: TestStaff = admin): Promise<Body> => {
  const res = await api().get(`${BASE}${path}`).set(as(who));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};

async function stepUp(who: TestStaff) {
  const code = new TotpService().codeAt(who.totpSecret, new Date(Date.now() + 30_000));
  await api()
    .post("/api/platform/v1/auth/step-up")
    .set(as(who))
    .send({ password: who.password, code })
    .expect(204);
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const fixtures = new StaffFixtures(container);
  admin = await fixtures.create(["super_admin"]);
  support = await fixtures.create(["support"]);
  await stepUp(admin);
  t = await new ProvisionedTenants(container, app, admin).create();

  // Some work in the tenant: a vehicle and a server error-free day of calls.
  const vehicle = await api()
    .post("/api/v1/vehicles")
    .set(owner())
    .send({ make: "Toyota", model: "Vitz", plateNumber: `GR ${digits(4)}-26`, odometer: 1_000 });
  expect(vehicle.status, JSON.stringify(vehicle.body)).toBe(201);

  // Last night's collection: today's work, filed as yesterday's day.
  await container.get<UsageMeter>(TYPES.UsageMeter).flush();
  const today = new Date().toISOString().slice(0, 10);
  await container.get<TenantUsageHistory>(TYPES.TenantUsageHistory).collect(today);
  await platform.query(`delete from usage_daily where tenant_id = $1 and day < $2`, [
    t.tenantId,
    today,
  ]);
  await platform.query(`update usage_daily set day = day - 1 where tenant_id = $1`, [t.tenantId]);

  const code = `R${randomUUID()
    .slice(0, 8)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "X")}`;
  const partner = await platform.query<{ id: string }>(
    `insert into partners (name, contact_name, email, phone, referral_code)
     values ('Kumasi Fleet Partners', 'Yaw Mensah', $1, '+233201234567', $2) returning id`,
    [`partner-${randomUUID().slice(0, 8)}@example.com`, code],
  );
  partnerId = partner.rows[0]!.id;
  await platform.query(
    `insert into partner_tenant_attributions (tenant_id, partner_id, source, reason)
     values ($1, $2, 'manual', 'Analytics test')`,
    [t.tenantId, partnerId],
  );
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("platform analytics", () => {
  it("keeps staff without the analytics permission out", async () => {
    expect((await api().get(`${BASE}/health`).set(as(support))).status).toBe(403);
  });

  it("collects modules and onboarding milestones nightly", async () => {
    const { rows } = await platform.query<{ modules: Record<string, number> }>(
      `select modules from usage_daily where tenant_id = $1`,
      [t.tenantId],
    );
    expect(rows[0]!.modules.vehicle).toBeGreaterThanOrEqual(1);
    const steps = await platform.query<{ steps: Record<string, string> }>(
      `select steps from tenant_onboarding where tenant_id = $1`,
      [t.tenantId],
    );
    expect(Object.keys(steps.rows[0]!.steps)).toContain("vehicle_added");
  });

  it("follows applications from sign-up to paying", async () => {
    const funnel = await get("/funnel");
    expect((funnel.steps as { key: string }[]).map((s) => s.key)).toEqual([
      "signups",
      "verified",
      "approved",
      "provisioned",
      "firstVehicle",
      "firstTransaction",
      "paying",
    ]);
    const [signups, , , provisioned, firstVehicle] = funnel.steps as Body[];
    expect(signups.count).toBeGreaterThanOrEqual(1);
    expect(provisioned.count).toBeGreaterThanOrEqual(1);
    expect(firstVehicle.count).toBeGreaterThanOrEqual(1);
    expect(signups.conversion).toBeNull();
    expect(
      (await api().get(`${BASE}/funnel?from=2026-10-30&to=2026-10-01`).set(as(admin))).status,
    ).toBe(422);
  });

  it("scores a tenant's health with its onboarding checklist", async () => {
    const health = await get(`/tenants/${t.tenantId}`);
    expect(health).toMatchObject({ tenantId: t.tenantId, flags: ["new"] });
    expect(health.score).toBeGreaterThan(0);
    expect(health.score).toBeLessThanOrEqual(100);
    expect(Object.keys(health.components)).toEqual([
      "logins",
      "activeUsers",
      "records",
      "breadth",
      "payments",
      "support",
      "errors",
    ]);
    expect(health.modulesUsed).toContain("fleet");
    expect(
      health.onboarding.steps.find((s: Body) => s.key === "vehicle_added").doneOn,
    ).not.toBeNull();

    const fresh = await get("/health?flag=new&limit=1000");
    expect((fresh as { tenantId: string }[]).map((h) => h.tenantId)).toContain(t.tenantId);
    const atRisk = await get("/health?flag=at_risk&limit=1000");
    expect((atRisk as { tenantId: string }[]).map((h) => h.tenantId)).not.toContain(t.tenantId);
    expect((await api().get(`${BASE}/tenants/${randomUUID()}`).set(as(admin))).status).toBe(404);
  });

  it("shows adoption by module and cohorts", async () => {
    const adoption = await get("/adoption");
    expect(adoption.modules).toHaveLength(10);
    const fleet = (adoption.modules as Body[]).find((m) => m.module === "fleet");
    expect(fleet.tenants).toBeGreaterThanOrEqual(1);

    const cohorts = (await get("/cohorts?months=3")) as Body[];
    expect(cohorts).toHaveLength(3);
    const current = cohorts.at(-1);
    expect(current.cohort).toBe(new Date().toISOString().slice(0, 7));
    expect(current.tenants).toBeGreaterThanOrEqual(1);
    expect(current.retention).toHaveLength(1);
    expect((await api().get(`${BASE}/cohorts?months=30`).set(as(admin))).status).toBe(400);
  });

  it("weighs the cost to serve against MRR at the rates set", async () => {
    const before = await get("/cost-to-serve");
    const mine = (before.tenants as Body[]).find((c) => c.tenantId === t.tenantId);
    expect(mine.cost.fixedMinor).toBe(before.rates.tenantMonthMinor);
    expect(mine.databaseBytes).toBeGreaterThan(0);

    const rates = { ...before.rates, tenantMonthMinor: 5_000 };
    expect((await api().put(`${BASE}/cost-rates`).set(as(support)).send(rates)).status).toBe(403);
    const set = await api().put(`${BASE}/cost-rates`).set(as(admin)).send(rates);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const after = await get("/cost-to-serve");
    const now = (after.tenants as Body[]).find((c) => c.tenantId === t.tenantId);
    expect(now.cost.fixedMinor).toBe(5_000);
    expect(now.marginMinor).toBe(now.mrrMinor - now.cost.totalMinor);
    const audit = await platform.query(
      `select 1 from platform_audit_logs where action = 'analytics.cost_rates_changed'
         and actor_id = $1`,
      [admin.id],
    );
    expect(audit.rows).toHaveLength(1);
    await api().put(`${BASE}/cost-rates`).set(as(admin)).send(before.rates).expect(200);
  });

  it("measures resellers and churn", async () => {
    const resellers = await get("/resellers");
    const partner = (resellers.partners as Body[]).find((p) => p.partnerId === partnerId);
    expect(partner).toMatchObject({
      name: "Kumasi Fleet Partners",
      tenants: 1,
      newTenants: 1,
      live: 1,
      churned: 0,
      atRisk: 0,
      commission: { earnedMinor: 0, outstandingMinor: 0 },
    });
    expect(partner.averageHealth).toBeGreaterThan(0);

    const churn = await get("/churn");
    expect(churn).toMatchObject({ period: { to: new Date().toISOString().slice(0, 10) } });
    expect(churn.deactivated).toBe(
      (churn.byReason as { count: number }[]).reduce((n, r) => n + r.count, 0),
    );
  });
});
