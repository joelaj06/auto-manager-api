import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IPasswordHasher } from "../../application/ports/IPasswordHasher.js";
import { TotpService } from "../../infrastructure/security/TotpService.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

let container: Container;
let app: Express;
let platform: pg.Pool;
let staff: TestStaff;
let tenants: ProvisionedTenants;

const api = () => request(app);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const console_ = (path: string) => `/api/platform/v1/tenants${path}`;

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  staff = await new StaffFixtures(container).create(["super_admin"]);
  tenants = new ProvisionedTenants(container, app, staff);
  // Sensitive console actions need a recent step-up (one code step after enrolment).
  const code = new TotpService().codeAt(staff.totpSecret, new Date(Date.now() + 30_000));
  const stepUp = await api()
    .post("/api/platform/v1/auth/step-up")
    .set(bearer(staff.accessToken))
    .send({ password: staff.password, code });
  expect(stepUp.status, JSON.stringify(stepUp.body)).toBe(204);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("public tenant-config", () => {
  it("returns only public data for a provisioned tenant and 404 otherwise", async () => {
    const { slug } = await tenants.create();
    const res = await api().get("/api/v1/public/tenant-config").query({ slug });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      tenant: { slug, status: "trialing", notice: null },
      currency: { base: "GHS", symbol: "₵" },
      auth: { methods: ["password"], invitationsOnly: true },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/"id"|@example\.com/);
    const unknown = await api().get("/api/v1/public/tenant-config").query({ slug: "nobody-here" });
    expect([unknown.status, unknown.body.error.code]).toEqual([404, "TENANT_NOT_FOUND"]);
  });
});

describe("tenant deactivation and restore", () => {
  let t: ProvisionedTenant;

  beforeAll(async () => {
    t = await tenants.create();
  });

  it("blocks every user immediately, revokes sessions and tells the tenant why", async () => {
    expect((await api().get("/api/v1/me").set(bearer(t.ownerAccessToken))).status).toBe(200);

    const res = await api()
      .post(console_(`/${t.tenantId}/deactivate`))
      .set(bearer(staff.accessToken))
      .send({
        reasonCategory: "requested_pause",
        reason: "Owner asked to pause",
        message: "Paused at your request",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    const me = await api().get("/api/v1/me").set(bearer(t.ownerAccessToken));
    expect([me.status, me.body.error.code]).toEqual([403, "TENANT_DEACTIVATED"]);
    const sessions = await t.tenant.query<{ open: string; reason: string }>(
      `select count(*) filter (where revoked_at is null) as open,
              max(revocation_reason) as reason from auth_sessions`,
    );
    expect(sessions[0]).toEqual({ open: "0", reason: "tenant_deactivated" });

    const config = await api().get("/api/v1/public/tenant-config").query({ slug: t.slug });
    expect(config.body.data.tenant).toMatchObject({
      status: "deactivated",
      notice: { reasonCategory: "requested_pause", message: "Paused at your request" },
    });
    const { rows } = await platform.query(
      "select 1 from email_deliveries where recipient = $1 and template = 'tenant.deactivated'",
      [t.ownerEmail],
    );
    expect(rows).toHaveLength(1);
  });

  it("restores to the previous status and records the history", async () => {
    const restored = await api()
      .post(console_(`/${t.tenantId}/restore`))
      .set(bearer(staff.accessToken))
      .send({ reason: "Owner ready to continue" });
    expect(restored.status).toBe(204);
    expect((await api().get("/api/v1/me").set(bearer(t.ownerAccessToken))).status).toBe(200);

    const again = await api()
      .post(console_(`/${t.tenantId}/restore`))
      .set(bearer(staff.accessToken))
      .send({ reason: "Twice by mistake" });
    expect([again.status, again.body.error.code]).toEqual([409, "TENANT_STATE"]);

    const history = await api()
      .get(console_(`/${t.tenantId}/status-history`))
      .set(bearer(staff.accessToken));
    expect(
      history.body.data.map(
        (h: { fromStatus: string; toStatus: string }) => `${h.fromStatus}→${h.toStatus}`,
      ),
    ).toEqual(["deactivated→trialing", "trialing→deactivated"]);
    expect(history.body.data[1]).toMatchObject({
      reason: "Owner asked to pause",
      actorId: staff.id,
    });
  });

  it("refuses manual deactivation with billing reasons", async () => {
    const res = await api()
      .post(console_(`/${t.tenantId}/deactivate`))
      .set(bearer(staff.accessToken))
      .send({ reasonCategory: "non_payment", reason: "Should be automatic" });
    expect(res.status).toBe(400);
  });
});

describe("read-only tenants", () => {
  it("allow reads and refuse changes until cleared", async () => {
    const t = await tenants.create();
    expect(
      (
        await api()
          .post(console_(`/${t.tenantId}/read-only`))
          .set(bearer(staff.accessToken))
          .send({ reason: "Data review", message: "Under review" })
      ).status,
    ).toBe(204);

    const branches = await api().get("/api/v1/branches").set(bearer(t.ownerAccessToken));
    expect(branches.status).toBe(200);
    const hq = branches.body.data[0].id as string;
    const write = await api()
      .post(`/api/v1/branches/${hq}/deactivate`)
      .set(bearer(t.ownerAccessToken))
      .send({ reason: "testing read-only" });
    expect([write.status, write.body.error.code]).toEqual([403, "TENANT_READ_ONLY"]);

    expect(
      (
        await api()
          .post(console_(`/${t.tenantId}/read-only/clear`))
          .set(bearer(staff.accessToken))
          .send({ reason: "Review done" })
      ).status,
    ).toBe(204);
    const config = await api().get("/api/v1/public/tenant-config").query({ slug: t.slug });
    expect(config.body.data.tenant).toMatchObject({ status: "trialing", notice: null });
  });
});

describe("branch lifecycle", () => {
  let t: ProvisionedTenant;
  let branchId: string;
  let managerId: string;
  const managerToken = async () => {
    const [user] = await t.tenant.query<{ permission_version: number }>(
      "select permission_version from users where id = $1",
      [managerId],
    );
    return t.tenant.accessToken(managerId, user!.permission_version);
  };

  beforeAll(async () => {
    t = await tenants.create();
    const hash = await container
      .get<IPasswordHasher>(TYPES.PasswordHasher)
      .hash("manager password 2026");
    const [created] = await t.tenant.query<{ branch_id: string; user_id: string }>(
      `with b as (insert into branches (code, name) values ('KSI', 'Kumasi') returning id),
            u as (insert into users (email, name, status, password_hash)
                  values ('manager-' || gen_random_uuid() || '@example.com', 'Kumasi Manager', 'active', $1)
                  returning id),
            m as (insert into user_branches (user_id, branch_id) select u.id, b.id from u, b),
            r as (insert into user_roles (user_id, role_id, branch_id)
                  select u.id, roles.id, b.id from u, b, roles where roles.system_key = 'branch_manager')
       select b.id as branch_id, u.id as user_id from b, u`,
      [hash],
    );
    branchId = created!.branch_id;
    managerId = created!.user_id;
  });

  it("refuses to deactivate the default branch", async () => {
    const branches = await api().get("/api/v1/branches").set(bearer(t.ownerAccessToken));
    const hq = branches.body.data.find((b: { isDefault: boolean }) => b.isDefault).id as string;
    const res = await api()
      .post(`/api/v1/branches/${hq}/deactivate`)
      .set(bearer(t.ownerAccessToken))
      .send({ reason: "closing head office" });
    expect([res.status, res.body.error.code]).toEqual([422, "BRANCH_DEACTIVATION_BLOCKED"]);
  });

  it("blocks users whose only branch is deactivated, without affecting the tenant", async () => {
    const before = await api()
      .get("/api/v1/me")
      .set(bearer(await managerToken()));
    expect(before.status).toBe(200);
    expect(before.body.data.branchIds).toEqual([branchId]);
    expect(before.body.data.permissions.map((p: { key: string }) => p.key)).toContain("users.list");
    const oldToken = await managerToken();

    const res = await api()
      .post(`/api/v1/branches/${branchId}/deactivate`)
      .set(bearer(t.ownerAccessToken))
      .send({ reason: "Kumasi shop closing" });
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    // Members got a new permission version: old tokens stop working at once.
    expect((await api().get("/api/v1/me").set(bearer(oldToken))).status).toBe(401);
    const blocked = await api()
      .get("/api/v1/me")
      .set(bearer(await managerToken()));
    expect([blocked.status, blocked.body.error.code]).toEqual([403, "BRANCH_DEACTIVATED"]);
    expect((await api().get("/api/v1/me").set(bearer(t.ownerAccessToken))).status).toBe(200);
  });

  it("lets staff see and reactivate a tenant's branches from the console", async () => {
    const list = await api()
      .get(console_(`/${t.tenantId}/branches`))
      .set(bearer(staff.accessToken));
    expect(list.body.data.find((b: { id: string }) => b.id === branchId)).toMatchObject({
      status: "inactive",
    });

    const res = await api()
      .post(console_(`/${t.tenantId}/branches/${branchId}/reactivate`))
      .set(bearer(staff.accessToken))
      .send({ reason: "Shop reopened" });
    expect(res.status).toBe(204);
    expect(
      (
        await api()
          .get("/api/v1/me")
          .set(bearer(await managerToken()))
      ).status,
    ).toBe(200);

    const audit = await t.tenant.query<{ action: string; actor_type: string }>(
      "select action, actor_type from audit_logs where entity_id = $1 order by id",
      [branchId],
    );
    expect(audit).toEqual([
      { action: "branch.deactivated", actor_type: "user" },
      { action: "branch.reactivated", actor_type: "platform_staff" },
    ]);
  });
});
