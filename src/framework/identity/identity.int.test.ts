import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

const PASSWORD = "another strong passphrase";
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

async function lastEmail(to: string, template: string): Promise<string> {
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries where recipient = $1 and template = $2
      order by created_at desc limit 1`,
    [to, template],
  );
  if (rows[0] === undefined) throw new Error(`no ${template} email to ${to}`);
  return rows[0].body_text;
}

async function login(email: string, password: string) {
  return api()
    .post("/api/v1/auth/login")
    .set("X-Tenant", t.slug)
    .send({ identifier: email, password });
}

/** Invites a user as the owner and accepts the invitation; returns their tokens and id. */
async function inviteAndJoin(body: Record<string, unknown>, inviterToken = t.ownerAccessToken) {
  const email = `user-${randomUUID().slice(0, 8)}@example.com`;
  const invited = await api()
    .post("/api/v1/users/invitations")
    .set(as(inviterToken))
    .send({ name: "Team Member", email, ...body });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const token = /#token=([A-Za-z0-9_-]+)/.exec(
    await lastEmail(email, "tenant.user_invitation"),
  )![1]!;
  const accepted = await api()
    .post("/api/v1/auth/invitations/accept")
    .set("X-Tenant", t.slug)
    .send({ token, password: PASSWORD });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  return {
    id: invited.body.data.id as string,
    email,
    accessToken: accepted.body.data.accessToken as string,
  };
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("sign-in and sessions", () => {
  it("signs in, refreshes, lists sessions and signs out", async () => {
    const signedIn = await login(t.ownerEmail, OWNER_PASSWORD);
    expect(signedIn.status).toBe(200);
    const { accessToken, refreshToken, sessionId } = signedIn.body.data;

    const sessions = await api().get("/api/v1/me/sessions").set(as(accessToken));
    expect(
      sessions.body.data.find((s: { id: string; current: boolean }) => s.id === sessionId),
    ).toMatchObject({
      current: true,
    });

    const refreshed = await api()
      .post("/api/v1/auth/refresh")
      .set("X-Tenant", t.slug)
      .send({ refreshToken });
    expect(refreshed.status).toBe(200);

    expect((await api().post("/api/v1/auth/logout").set(as(accessToken))).status).toBe(204);
    const afterLogout = await api()
      .post("/api/v1/auth/refresh")
      .set("X-Tenant", t.slug)
      .send({ refreshToken: refreshed.body.data.refreshToken });
    expect(afterLogout.status).toBe(401);
  });

  it("gives the same answer for unknown accounts and wrong passwords, and locks after repeated failures", async () => {
    const unknown = await login("nobody@example.com", "whatever password");
    const wrong = await login(t.ownerEmail, "whatever password");
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);

    const victim = await inviteAndJoin({ branchIds: [await defaultBranch()] });
    for (let i = 0; i < 4; i++)
      expect((await login(victim.email, "not my password")).status).toBe(401);
    expect((await login(victim.email, "not my password")).status).toBe(429);
    expect((await login(victim.email, PASSWORD)).status).toBe(429);
  });

  it("discovers businesses only for the right password (mobile app)", async () => {
    const found = await api()
      .post("/api/v1/auth/discover")
      .send({ identifier: t.ownerEmail, password: OWNER_PASSWORD });
    expect(found.body.data).toEqual([
      { slug: t.slug, name: expect.stringContaining("Test Fleet") },
    ]);
    const wrong = await api()
      .post("/api/v1/auth/discover")
      .send({ identifier: t.ownerEmail, password: "guess guess" });
    expect(wrong.body.data).toEqual([]);
  });

  it("resets a forgotten password with an emailed code and signs out everywhere", async () => {
    const user = await inviteAndJoin({ branchIds: [await defaultBranch()] });
    const unknown = await api()
      .post("/api/v1/auth/password-reset")
      .set("X-Tenant", t.slug)
      .send({ identifier: "nobody@example.com" });
    expect(unknown.status).toBe(202);

    expect(
      (
        await api()
          .post("/api/v1/auth/password-reset")
          .set("X-Tenant", t.slug)
          .send({ identifier: user.email })
      ).status,
    ).toBe(202);
    const code = /code to reset your password[\s\S]*?(\d{6})/.exec(
      await lastEmail(user.email, "auth.otp_code"),
    )![1]!;
    const bad = await api()
      .post("/api/v1/auth/password-reset/confirm")
      .set("X-Tenant", t.slug)
      .send({
        identifier: user.email,
        code: code === "000000" ? "111111" : "000000",
        newPassword: "brand new passphrase",
      });
    expect(bad.body.error.code).toBe("OTP_INVALID");
    const ok = await api()
      .post("/api/v1/auth/password-reset/confirm")
      .set("X-Tenant", t.slug)
      .send({ identifier: user.email, code, newPassword: "brand new passphrase" });
    expect(ok.status).toBe(204);

    expect((await api().get("/api/v1/me").set(as(user.accessToken))).status).toBe(401);
    expect((await login(user.email, PASSWORD)).status).toBe(401);
    expect((await login(user.email, "brand new passphrase")).status).toBe(200);
  });
});

async function defaultBranch(): Promise<string> {
  const res = await api().get("/api/v1/branches").set(as(t.ownerAccessToken));
  return (res.body.data as { id: string; isDefault: boolean }[]).find((b) => b.isDefault)!.id;
}

describe("custom roles limited to one branch (Phase 1 exit criterion)", () => {
  let kumasi: string;
  let roleId: string;
  let member: Awaited<ReturnType<typeof inviteAndJoin>>;

  it("lets the owner create a branch and a custom role", async () => {
    const branch = await api()
      .post("/api/v1/branches")
      .set(as(t.ownerAccessToken))
      .send({ code: "KSI", name: "Kumasi" });
    expect(branch.status).toBe(201);
    kumasi = branch.body.data.id;

    const role = await api()
      .post("/api/v1/roles")
      .set(as(t.ownerAccessToken))
      .send({
        name: "Kumasi lead",
        grants: [
          { key: "users.list", scope: "branch" },
          { key: "users.view", scope: "branch" },
          { key: "branches.view", scope: "branch" },
        ],
      });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    roleId = role.body.data.id;
  });

  it("invites a user to that branch only, and their access is limited to it", async () => {
    member = await inviteAndJoin({ branchIds: [kumasi], roles: [{ roleId, branchId: kumasi }] });

    const perms = await api().get("/api/v1/me/permissions").set(as(member.accessToken));
    expect(perms.body.data.branchIds).toEqual([kumasi]);
    expect(perms.body.data.permissions).toContainEqual({
      key: "users.list",
      scope: "branch",
      branchIds: [kumasi],
    });

    const users = await api().get("/api/v1/users").set(as(member.accessToken));
    expect(users.body.data.map((u: { id: string }) => u.id)).toEqual([member.id]);
    const owner = (await api().get("/api/v1/users").set(as(t.ownerAccessToken))).body.data.find(
      (u: { isOwner: boolean }) => u.isOwner,
    );
    expect((await api().get(`/api/v1/users/${owner.id}`).set(as(member.accessToken))).status).toBe(
      404,
    );
    expect(
      (
        await api()
          .post("/api/v1/roles")
          .set(as(member.accessToken))
          .send({ name: "x", grants: [] })
      ).status,
    ).toBe(403);
  });

  it("re-evaluates holders at once when the role changes", async () => {
    const updated = await api()
      .put(`/api/v1/roles/${roleId}`)
      .set(as(t.ownerAccessToken))
      .send({ name: "Kumasi lead", grants: [{ key: "users.list", scope: "branch" }] });
    expect(updated.status).toBe(204);
    expect((await api().get("/api/v1/me").set(as(member.accessToken))).status).toBe(401);
    const again = await login(member.email, PASSWORD);
    const perms = await api().get("/api/v1/me/permissions").set(as(again.body.data.accessToken));
    expect(perms.body.data.permissions.map((p: { key: string }) => p.key)).toEqual(["users.list"]);
  });

  it("protects system roles and roles in use", async () => {
    const roles = await api().get("/api/v1/roles").set(as(t.ownerAccessToken));
    const system = roles.body.data.find((r: { systemKey: string }) => r.systemKey === "auditor");
    const locked = await api()
      .put(`/api/v1/roles/${system.id}`)
      .set(as(t.ownerAccessToken))
      .send({ name: "Auditor", grants: [] });
    expect(locked.body.error.code).toBe("SYSTEM_ROLE_LOCKED");
    const inUse = await api().delete(`/api/v1/roles/${roleId}`).set(as(t.ownerAccessToken));
    expect([inUse.status, inUse.body.error.code]).toEqual([409, "ROLE_IN_USE"]);
  });
});

describe("escalation prevention", () => {
  let kumasi: string;
  let manager: Awaited<ReturnType<typeof inviteAndJoin>>;
  let roles: { id: string; systemKey: string | null }[];

  beforeAll(async () => {
    const branch = await api()
      .post("/api/v1/branches")
      .set(as(t.ownerAccessToken))
      .send({ code: "TMA", name: "Tema" });
    kumasi = branch.body.data.id;
    roles = (await api().get("/api/v1/roles").set(as(t.ownerAccessToken))).body.data;
    const branchManager = roles.find((r) => r.systemKey === "branch_manager")!.id;
    manager = await inviteAndJoin({
      branchIds: [kumasi],
      roles: [{ roleId: branchManager, branchId: kumasi }],
    });
  });

  it("stops a branch manager from granting more than they hold or acting outside their branch", async () => {
    const recruit = await inviteAndJoin({ branchIds: [kumasi] }, manager.accessToken);
    const admin = roles.find((r) => r.systemKey === "administrator")!.id;
    const branchManager = roles.find((r) => r.systemKey === "branch_manager")!.id;
    const owner = roles.find((r) => r.systemKey === "owner")!.id;
    const assign = (assignments: unknown) =>
      api()
        .put(`/api/v1/users/${recruit.id}/roles`)
        .set(as(manager.accessToken))
        .send({ assignments });

    expect((await assign([{ roleId: admin, branchId: kumasi }])).body.error.code).toBe(
      "ROLE_EXCEEDS_OWN_PERMISSIONS",
    );
    expect((await assign([{ roleId: branchManager, branchId: null }])).body.error.code).toBe(
      "BRANCH_OUT_OF_SCOPE",
    );
    expect(
      (await assign([{ roleId: branchManager, branchId: await defaultBranch() }])).body.error.code,
    ).toBe("BRANCH_OUT_OF_SCOPE");
    expect((await assign([{ roleId: owner, branchId: kumasi }])).body.error.code).toBe(
      "OWNER_ROLE_PROTECTED",
    );
    expect((await assign([{ roleId: branchManager, branchId: kumasi }])).status).toBe(204);

    const self = await api()
      .put(`/api/v1/users/${manager.id}/roles`)
      .set(as(manager.accessToken))
      .send({ assignments: [] });
    expect(self.body.error.code).toBe("CANNOT_CHANGE_OWN_ACCOUNT");
  });

  it("never lets anyone disable the owner and ends a disabled user's access at once", async () => {
    const admin = roles.find((r) => r.systemKey === "administrator")!.id;
    const administrator = await inviteAndJoin({
      branchIds: [await defaultBranch()],
      roles: [{ roleId: admin, branchId: null }],
    });
    const owner = (await api().get("/api/v1/users").set(as(t.ownerAccessToken))).body.data.find(
      (u: { isOwner: boolean }) => u.isOwner,
    );
    const protectedOwner = await api()
      .post(`/api/v1/users/${owner.id}/disable`)
      .set(as(administrator.accessToken))
      .send({ reason: "testing owner protection" });
    expect(protectedOwner.body.error.code).toBe("OWNER_PROTECTED");

    const disabled = await api()
      .post(`/api/v1/users/${manager.id}/disable`)
      .set(as(administrator.accessToken))
      .send({ reason: "left the company" });
    expect(disabled.status).toBe(204);
    expect((await api().get("/api/v1/me").set(as(manager.accessToken))).status).toBe(401);
    expect((await login(manager.email, PASSWORD)).status).toBe(401);
  });
});

describe("organisation settings", () => {
  it("validates timezones, guards currency changes and stores numbering formats", async () => {
    const bad = await api()
      .patch("/api/v1/organisation")
      .set(as(t.ownerAccessToken))
      .send({ timezone: "Mars/Olympus" });
    expect(bad.body.error.code).toBe("INVALID_TIMEZONE");
    const ok = await api()
      .patch("/api/v1/organisation")
      .set(as(t.ownerAccessToken))
      .send({ legalName: "Test Fleet Ltd", timezone: "Africa/Lagos" });
    expect(ok.body.data).toMatchObject({ legalName: "Test Fleet Ltd", timezone: "Africa/Lagos" });
    // The base currency is changed in the currency settings (P2-1).
    const currency = await api()
      .patch("/api/v1/settings/currency")
      .set(as(t.ownerAccessToken))
      .send({ baseCurrency: "USD" });
    expect(currency.body.data).toMatchObject({
      baseCurrency: "USD",
      enabledCurrencies: ["USD", "GHS"],
    });

    const numbering = { invoice: { prefix: "INV", padding: 6, yearly: true } };
    expect(
      (await api().put("/api/v1/settings/numbering").set(as(t.ownerAccessToken)).send(numbering))
        .status,
    ).toBe(204);
    expect(
      (await api().get("/api/v1/settings/numbering").set(as(t.ownerAccessToken))).body.data,
    ).toMatchObject({ ...numbering, receipt: { prefix: "RCT" } });

    const config = await api().get("/api/v1/public/tenant-config").query({ slug: t.slug });
    expect(config.body.data.currency).toEqual({ base: "USD", symbol: "$" });
  });
});

describe("C3 — sign-up never grants elevated roles (audit regression)", () => {
  it("creates the owner only through provisioning and never hands out the Owner role", async () => {
    const roles = (await api().get("/api/v1/roles").set(as(t.ownerAccessToken))).body.data as {
      id: string;
      systemKey: string | null;
    }[];
    const ownerRole = roles.find((r) => r.systemKey === "owner")!.id;
    const invite = await api()
      .post("/api/v1/users/invitations")
      .set(as(t.ownerAccessToken))
      .send({
        name: "Would-be owner",
        email: `c3-${randomUUID().slice(0, 8)}@example.com`,
        branchIds: [await defaultBranch()],
        roles: [{ roleId: ownerRole, branchId: null }],
      });
    expect([invite.status, invite.body.error.code]).toEqual([422, "OWNER_ROLE_PROTECTED"]);

    const [owners] = await t.tenant.query<{ owners: string; holders: string }>(
      `select (select count(*) from users where is_owner) as owners,
              (select count(*) from user_roles ur join roles r on r.id = ur.role_id where r.system_key = 'owner') as holders`,
    );
    expect(owners).toEqual({ owners: "1", holders: "1" });
  });
});
