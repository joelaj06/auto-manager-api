import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IClock } from "../../application/ports/IClock.js";
import type { IPlatformRoles } from "../../application/ports/IPlatformRoles.js";
import type { StaffAdministration } from "../../application/use-cases/platform/StaffAdministration.js";
import { TotpService } from "../../infrastructure/security/TotpService.js";
import { TenantFixtures } from "../../testing/fixtures/TenantFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/** A clock the test moves forward (TOTP steps, idle timeout, lockout expiry). */
class TestClock implements IClock {
  private offsetMs = 0;
  now = () => new Date(Date.now() + this.offsetMs);
  advance(ms: number) {
    this.offsetMs += ms;
  }
}

const BASE = "/api/platform/v1";
const PASSWORD = "correct horse battery staple";
const totp = new TotpService();
const clock = new TestClock();
let container: Container;
let app: Express;
let platform: pg.Pool;

type Staff = {
  id: string;
  email: string;
  secret: string;
  accessToken: string;
  refreshToken: string;
};

const api = () => request(app);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
/** Each TOTP code may be used once, so every use moves time to the next 30-second step. */
const nextCode = (secret: string) => {
  clock.advance(30_000);
  return totp.codeAt(secret, clock.now());
};

async function roleId(systemKey: string): Promise<string> {
  const role = await container.get<IPlatformRoles>(TYPES.PlatformRoles).findBySystemKey(systemKey);
  return role!.id;
}

/** Accepts an invitation and enrols an authenticator through the HTTP API. */
async function onboard(token: string, email: string): Promise<Staff> {
  const accepted = await api()
    .post(`${BASE}/auth/invitations/accept`)
    .send({ token, password: PASSWORD });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(accepted.body.data.next).toBe("enrol");

  const enrol = await api()
    .post(`${BASE}/auth/mfa/enrol`)
    .send({ challengeToken: accepted.body.data.challengeToken });
  expect(enrol.status).toBe(200);
  const secret = enrol.body.data.secret as string;

  const confirmed = await api()
    .post(`${BASE}/auth/mfa/enrol/confirm`)
    .set("User-Agent", "vitest-browser")
    .send({ challengeToken: accepted.body.data.challengeToken, code: nextCode(secret) });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  const me = await api().get(`${BASE}/me`).set(bearer(confirmed.body.data.accessToken));
  return {
    id: me.body.data.id,
    email,
    secret,
    accessToken: confirmed.body.data.accessToken,
    refreshToken: confirmed.body.data.refreshToken,
  };
}

async function bootstrapSuperAdmin(): Promise<Staff> {
  const email = `admin-${randomUUID().slice(0, 8)}@example.com`;
  const result = await container.get<StaffAdministration>(TYPES.StaffAdministration).invite({
    email,
    name: "Bootstrap Admin",
    roleIds: [await roleId("super_admin")],
    actor: null,
  });
  return onboard(result.invitationToken!, email);
}

/** Gets a new access token with the refresh token, as a client does when it expires. */
async function renew(staff: Staff): Promise<void> {
  const res = await api().post(`${BASE}/auth/refresh`).send({ refreshToken: staff.refreshToken });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  staff.accessToken = res.body.data.accessToken;
  staff.refreshToken = res.body.data.refreshToken;
}

async function stepUp(staff: Staff): Promise<void> {
  const res = await api()
    .post(`${BASE}/auth/step-up`)
    .set(bearer(staff.accessToken))
    .send({ password: PASSWORD, code: nextCode(staff.secret) });
  expect(res.status, JSON.stringify(res.body)).toBe(204);
}

/** The invitation token from the queued email (no worker runs in tests). */
async function invitationTokenFor(email: string): Promise<string> {
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries
      where recipient = $1 and template = 'platform.staff_invitation'
      order by created_at desc limit 1`,
    [email],
  );
  return /#token=([A-Za-z0-9_-]+)/.exec(rows[0]!.body_text)![1]!;
}

async function login(email: string, password = PASSWORD) {
  return api().post(`${BASE}/auth/login`).send({ email, password });
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  container.rebind<IClock>(TYPES.Clock).toConstantValue(clock);
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("console onboarding and sign-in", () => {
  let admin: Staff;

  it("bootstraps a Super Admin through invitation, password and authenticator enrolment", async () => {
    admin = await bootstrapSuperAdmin();
    const me = await api().get(`${BASE}/me`).set(bearer(admin.accessToken));
    expect(me.body.data).toMatchObject({ email: admin.email, systemRoles: ["super_admin"] });
    expect(me.body.data.permissions).toContain("platform.staff.manage");
  });

  it("refuses weak passwords and used or unknown invitation links", async () => {
    const email = `weak-${randomUUID().slice(0, 8)}@example.com`;
    const { invitationToken } = await container
      .get<StaffAdministration>(TYPES.StaffAdministration)
      .invite({ email, name: "Weak", roleIds: [await roleId("support")], actor: null });
    const weak = await api()
      .post(`${BASE}/auth/invitations/accept`)
      .send({ token: invitationToken, password: "password1234" });
    expect([weak.status, weak.body.error.code]).toEqual([400, "WEAK_PASSWORD"]);

    await onboard(invitationToken!, email);
    const reused = await api()
      .post(`${BASE}/auth/invitations/accept`)
      .send({ token: invitationToken, password: PASSWORD });
    expect([reused.status, reused.body.error.code]).toEqual([400, "INVITATION_INVALID"]);
  });

  it("signs in with password and code, without revealing whether an account exists", async () => {
    const wrong = await login(admin.email, "not the password at all");
    const unknown = await login(`nobody-${randomUUID()}@example.com`, "not the password at all");
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);

    const step = await login(admin.email);
    expect(step.body.data.next).toBe("mfa");
    const badCode = await api()
      .post(`${BASE}/auth/mfa`)
      .send({ challengeToken: step.body.data.challengeToken, code: "000000" });
    expect([badCode.status, badCode.body.error.code]).toEqual([401, "INVALID_MFA_CODE"]);

    const code = nextCode(admin.secret);
    const ok = await api()
      .post(`${BASE}/auth/mfa`)
      .set("User-Agent", "vitest-browser")
      .send({ challengeToken: step.body.data.challengeToken, code });
    expect(ok.status).toBe(200);
    // The same code can never be used twice.
    const replay = await api()
      .post(`${BASE}/auth/mfa`)
      .send({ challengeToken: (await login(admin.email)).body.data.challengeToken, code });
    expect(replay.body.error.code).toBe("INVALID_MFA_CODE");
  });

  it("emails the staff member when they sign in from a new device", async () => {
    const step = await login(admin.email);
    await api()
      .post(`${BASE}/auth/mfa`)
      .set("User-Agent", `other-device-${randomUUID()}`)
      .send({ challengeToken: step.body.data.challengeToken, code: nextCode(admin.secret) });
    const { rows } = await platform.query(
      "select 1 from email_deliveries where recipient = $1 and template = 'platform.new_sign_in'",
      [admin.email],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("rotates refresh tokens and ends sessions after the idle timeout", async () => {
    const refreshed = await api()
      .post(`${BASE}/auth/refresh`)
      .send({ refreshToken: admin.refreshToken });
    expect(refreshed.status).toBe(200);
    const reuse = await api()
      .post(`${BASE}/auth/refresh`)
      .send({ refreshToken: admin.refreshToken });
    expect([reuse.status, reuse.body.error.code]).toEqual([401, "REFRESH_TOKEN_REUSED"]);

    const fresh = await (async () => {
      const step = await login(admin.email);
      const res = await api()
        .post(`${BASE}/auth/mfa`)
        .set("User-Agent", "vitest-browser")
        .send({ challengeToken: step.body.data.challengeToken, code: nextCode(admin.secret) });
      return res.body.data.accessToken as string;
    })();
    clock.advance(61 * 60_000);
    const idle = await api().get(`${BASE}/me`).set(bearer(fresh));
    expect(idle.status).toBe(401);

    // Sign in again for the next tests.
    const step = await login(admin.email);
    const res = await api()
      .post(`${BASE}/auth/mfa`)
      .set("User-Agent", "vitest-browser")
      .send({ challengeToken: step.body.data.challengeToken, code: nextCode(admin.secret) });
    admin.accessToken = res.body.data.accessToken;
  });

  it("locks an account after repeated failures and alerts Super Admins", async () => {
    const victim = await bootstrapSuperAdmin();
    for (let i = 0; i < 4; i++)
      expect((await login(victim.email, "wrong-password-xyz")).status).toBe(401);
    const fifth = await login(victim.email, "wrong-password-xyz");
    expect([fifth.status, fifth.body.error.code]).toEqual([429, "TOO_MANY_ATTEMPTS"]);
    expect((await login(victim.email)).status).toBe(429);

    const { rows } = await platform.query(
      "select recipient from email_deliveries where template = 'platform.staff_locked' and body_text like $1",
      [`%${victim.email}%`],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);

    clock.advance(16 * 60_000);
    expect((await login(victim.email)).status).toBe(200);
  });
});

describe("staff administration, step-up and four-eyes", () => {
  let admin: Staff;
  let secondAdmin: Staff;
  let ops: Staff;

  beforeAll(async () => {
    admin = await bootstrapSuperAdmin();
    secondAdmin = await bootstrapSuperAdmin();
  });

  it("requires a recent step-up for sensitive actions", async () => {
    const email = `ops-${randomUUID().slice(0, 8)}@example.com`;
    const invite = () =>
      api()
        .post(`${BASE}/staff/invitations`)
        .set(bearer(admin.accessToken))
        .send({ email, name: "Ops Person", roleIds: [] });
    const roles = [await roleId("operations")];

    const denied = await invite().send({ email, name: "Ops Person", roleIds: roles });
    expect([denied.status, denied.body.error.code]).toEqual([403, "STEP_UP_REQUIRED"]);

    await stepUp(admin);
    const invited = await api()
      .post(`${BASE}/staff/invitations`)
      .set(bearer(admin.accessToken))
      .send({ email, name: "Ops Person", roleIds: roles });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    expect(invited.body.data).not.toHaveProperty("invitationToken");

    ops = await onboard(await invitationTokenFor(email), email);
    clock.advance(11 * 60_000); // the step-up window ends — and the 10-minute access token
    for (const staff of [admin, secondAdmin, ops]) await renew(staff);
    const later = await api()
      .post(`${BASE}/staff/${ops.id}/disable`)
      .set(bearer(admin.accessToken))
      .send({ reason: "testing step-up expiry" });
    expect(later.body.error.code).toBe("STEP_UP_REQUIRED");
  });

  it("limits staff to their permissions", async () => {
    const res = await api().get(`${BASE}/staff`).set(bearer(ops.accessToken));
    expect([res.status, res.body.error.code]).toEqual([403, "FORBIDDEN"]);
  });

  it("grants Super Admin only after a different Super Admin approves", async () => {
    await stepUp(admin);
    const requested = await api()
      .put(`${BASE}/staff/${ops.id}/roles`)
      .set(bearer(admin.accessToken))
      .send({ roleIds: [await roleId("super_admin")], reason: "Ops lead becomes Super Admin" });
    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    const approvalId = requested.body.data.approvalId as string;

    const self = await api()
      .post(`${BASE}/approvals/${approvalId}/approve`)
      .set(bearer(admin.accessToken))
      .send({});
    expect([self.status, self.body.error.code]).toEqual([403, "APPROVAL_SELF"]);

    await stepUp(secondAdmin);
    const approved = await api()
      .post(`${BASE}/approvals/${approvalId}/approve`)
      .set(bearer(secondAdmin.accessToken))
      .send({ note: "verified with HR" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({ status: "approved", decidedBy: secondAdmin.id });

    // The role change bumped the permission version: the old token no longer works.
    expect((await api().get(`${BASE}/me`).set(bearer(ops.accessToken))).status).toBe(401);
    const again = await api()
      .post(`${BASE}/approvals/${approvalId}/approve`)
      .set(bearer(secondAdmin.accessToken))
      .send({});
    expect(again.body.error.code).toBe("APPROVAL_NOT_PENDING");
  });

  it("disables staff immediately and protects one's own account", async () => {
    await stepUp(admin);
    const self = await api()
      .post(`${BASE}/staff/${admin.id}/disable`)
      .set(bearer(admin.accessToken))
      .send({ reason: "trying to disable myself" });
    expect(self.body.error.code).toBe("CANNOT_CHANGE_OWN_ACCOUNT");

    const disabled = await api()
      .post(`${BASE}/staff/${secondAdmin.id}/disable`)
      .set(bearer(admin.accessToken))
      .send({ reason: "left the company" });
    expect(disabled.status).toBe(204);
    expect((await api().get(`${BASE}/me`).set(bearer(secondAdmin.accessToken))).status).toBe(401);
    expect((await login(secondAdmin.email)).status).toBe(401);
  });

  it("keeps custom roles within the editor's own permissions and system roles read-only", async () => {
    await stepUp(admin);
    const created = await api()
      .post(`${BASE}/roles`)
      .set(bearer(admin.accessToken))
      .send({
        name: `Night shift ${randomUUID().slice(0, 4)}`,
        permissions: ["platform.health.view", "platform.tenants.view"],
      });
    expect(created.status).toBe(201);
    const locked = await api()
      .put(`${BASE}/roles/${await roleId("support")}`)
      .set(bearer(admin.accessToken))
      .send({ name: "Support", permissions: [] });
    expect(locked.body.error.code).toBe("SYSTEM_ROLE_LOCKED");
    const unknown = await api()
      .post(`${BASE}/roles`)
      .set(bearer(admin.accessToken))
      .send({ name: "Bad", permissions: ["platform.tenants.delete"] });
    expect(unknown.status).toBe(400);
  });

  it("records every action in the audit log", async () => {
    const res = await api()
      .get(`${BASE}/audit-logs`)
      .query({ actorId: admin.id, limit: 100 })
      .set(bearer(admin.accessToken));
    expect(res.status).toBe(200);
    const actions = (res.body.data as { action: string }[]).map((e) => e.action);
    for (const action of [
      "staff.invited",
      "staff.stepped_up",
      "approval.requested",
      "staff.disabled",
      "staff_role.created",
    ]) {
      expect(actions, action).toContain(action);
    }
  });
});

describe("console and tenant credentials never mix (audit C2)", () => {
  it("rejects tenant tokens on console routes and console tokens on tenant routes", async () => {
    const tenant = await new TenantFixtures(container).create();
    const tenantToken = await tenant.accessToken();
    expect((await api().get(`${BASE}/me`).set(bearer(tenantToken))).status).toBe(401);

    const admin = await bootstrapSuperAdmin();
    expect((await api().get("/api/v1/me").set(bearer(admin.accessToken))).status).toBe(401);
  });

  it("rate-limits credential endpoints", async () => {
    const limited = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "3" });
    try {
      const limitedApp = limited.get<Express>(TYPES.HttpApp);
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push(
          (
            await request(limitedApp)
              .post(`${BASE}/auth/login`)
              .send({ email: "x@example.com", password: "whatever-password" })
          ).status,
        );
      }
      expect(statuses).toEqual([401, 401, 401, 429]);
    } finally {
      await disposeContainer(limited);
    }
  });
});
