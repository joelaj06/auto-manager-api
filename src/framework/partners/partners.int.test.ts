import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProvisionedTenants } from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { TotpService } from "../../infrastructure/security/TotpService.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

const BASE = "/api/platform/v1";
let container: Container;
let app: Express;
let platform: pg.Pool;
let staffFixtures: StaffFixtures;
let admin: TestStaff;
let sales: TestStaff;
let tenants: ProvisionedTenants;

type Session = { id: string; accessToken: string; refreshToken: string };

const api = () => request(app);
const bearer = (who: { accessToken: string }) => ({ Authorization: `Bearer ${who.accessToken}` });
const unique = () => randomUUID().slice(0, 8);
const phone = () => `+23324${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;

async function createPartner(name = `Partner ${unique()}`, by: TestStaff = admin) {
  const res = await api()
    .post(`${BASE}/partners`)
    .set(bearer(by))
    .send({
      name,
      kind: "company",
      contactName: "Ama Mensah",
      email: `partner-${unique()}@example.com`,
      phone: phone(),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as {
    id: string;
    referralCode: string;
    profile: { email: string; phone: string };
    capabilities: { key: string; granted: boolean }[];
  };
}

/** Invites a partner user through the console and activates the account (password + TOTP). */
async function partnerUser(partnerId: string): Promise<Session> {
  const email = `pu-${unique()}@example.com`;
  const invited = await api()
    .post(`${BASE}/partners/${partnerId}/users/invitations`)
    .set(bearer(admin))
    .send({ email, name: "Partner User" });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries
      where recipient = $1 and template = 'platform.staff_invitation'
      order by created_at desc limit 1`,
    [email],
  );
  const token = /#token=([A-Za-z0-9_-]+)/.exec(rows[0]!.body_text)![1]!;
  const user = await staffFixtures.activate(token, invited.body.data.userId as string, email);
  return { id: user.id, accessToken: user.accessToken, refreshToken: user.refreshToken };
}

async function renew(session: Session): Promise<void> {
  const res = await api().post(`${BASE}/auth/refresh`).send({ refreshToken: session.refreshToken });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  session.accessToken = res.body.data.accessToken;
  session.refreshToken = res.body.data.refreshToken;
}

async function setCapabilities(partnerId: string, capabilities: string[]) {
  const res = await api()
    .put(`${BASE}/partners/${partnerId}/capabilities`)
    .set(bearer(admin))
    .send({ capabilities, reason: "Agreed in partner review" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const DEFAULTS = [
  "platform.partner.applications.create",
  "platform.partner.applications.respond",
  "platform.partner.commissions.view",
  "platform.partner.referral_tools.view",
  "platform.partner.terms.view",
  "platform.partner.tenants.view",
].sort();

const signupBody = (overrides: Record<string, unknown> = {}) => ({
  businessName: `Client Fleet ${unique()}`,
  businessType: "fleet",
  desiredSlug: `client-${unique()}`,
  contactName: "Kwame Owusu",
  contactEmail: `client-${unique()}@example.com`,
  contactPhone: phone(),
  expectedBranches: 1,
  expectedVehicles: 5,
  acceptTerms: true,
  ...overrides,
});

const applicationRow = async (id: string) =>
  (
    await platform.query<{
      partner_id: string | null;
      source: string;
      created_by_staff_id: string | null;
      risk_signals: { code: string }[];
    }>(
      "select partner_id, source, created_by_staff_id, risk_signals from tenant_applications where id = $1",
      [id],
    )
  ).rows[0]!;

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  staffFixtures = new StaffFixtures(container);
  admin = await staffFixtures.create(["super_admin"]);
  sales = await staffFixtures.create(["sales"]);
  tenants = new ProvisionedTenants(container, app, admin);
  const code = new TotpService().codeAt(admin.totpSecret, new Date(Date.now() + 30_000));
  const stepUp = await api()
    .post(`${BASE}/auth/step-up`)
    .set(bearer(admin))
    .send({ password: admin.password, code });
  expect(stepUp.status, JSON.stringify(stepUp.body)).toBe(204);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("partner profiles (staff)", () => {
  it("creates partners with default capabilities and a generated referral code", async () => {
    const partner = await createPartner("Kofi Agencies");
    expect(partner.referralCode).toMatch(/^KOFI[A-Z2-9]{4}$/);
    expect(
      partner.capabilities
        .filter((c) => c.granted)
        .map((c) => c.key)
        .sort(),
    ).toEqual(DEFAULTS);

    const duplicate = await api().post(`${BASE}/partners`).set(bearer(admin)).send({
      name: "Copy",
      kind: "individual",
      contactName: "Copy Cat",
      email: partner.profile.email,
      phone: phone(),
    });
    expect([duplicate.status, duplicate.body.error.code]).toEqual([409, "PARTNER_EMAIL_TAKEN"]);

    const list = await api().get(`${BASE}/partners?q=Kofi Agencies`).set(bearer(sales));
    expect(list.status).toBe(200);
    expect(list.body.data.map((p: { id: string }) => p.id)).toContain(partner.id);
  });

  it("lets Sales manage profiles but not grant capabilities", async () => {
    const partner = await createPartner(undefined, sales);
    const grant = await api()
      .put(`${BASE}/partners/${partner.id}/capabilities`)
      .set(bearer(sales))
      .send({ capabilities: DEFAULTS, reason: "Trying to grant" });
    expect(grant.status).toBe(403);
    const unknown = await api()
      .put(`${BASE}/partners/${partner.id}/capabilities`)
      .set(bearer(admin))
      .send({ capabilities: ["platform.tenants.view"], reason: "Staff permission" });
    expect([unknown.status, unknown.body.error.code]).toEqual([400, "UNKNOWN_CAPABILITY"]);
  });
});

describe("partner users", () => {
  it("only reach partner routes and their own session routes", async () => {
    const partner = await createPartner();
    const user = await partnerUser(partner.id);

    const me = await api().get(`${BASE}/me`).set(bearer(user));
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ partnerId: partner.id, systemRoles: [] });
    expect(me.body.data.permissions).toEqual(DEFAULTS);

    for (const path of ["/dashboard", "/tenants", "/applications", "/partners", "/staff"])
      expect((await api().get(`${BASE}${path}`).set(bearer(user))).status, path).toBe(403);
    expect((await api().get(`${BASE}/partner/dashboard`).set(bearer(user))).status).toBe(200);
    // Staff cannot use the partner portal.
    expect((await api().get(`${BASE}/partner/dashboard`).set(bearer(admin))).status).toBe(403);
  });

  it("never get staff roles, and are not listed as staff", async () => {
    const partner = await createPartner();
    const user = await partnerUser(partner.id);
    const { rows } = await platform.query<{ id: string }>(
      "select id from platform_roles where system_key = 'support'",
    );
    const roles = await api()
      .put(`${BASE}/staff/${user.id}/roles`)
      .set(bearer(admin))
      .send({ roleIds: [rows[0]!.id], reason: "Trying to promote a partner" });
    expect([roles.status, roles.body.error.code]).toEqual([422, "PARTNER_USER_NO_ROLES"]);
    const staff = await api().get(`${BASE}/staff`).set(bearer(admin));
    expect(staff.body.data.map((s: { id: string }) => s.id)).not.toContain(user.id);
  });
});

describe("attribution and scoping (Phase 1 exit criterion)", () => {
  it("shows a partner only its own tenants, and omits fields it lacks permission for", async () => {
    const a = await createPartner();
    const b = await createPartner();
    const userA = await partnerUser(a.id);
    const tenantA = await tenants.create({ partnerId: a.id });
    const tenantB = await tenants.create({ partnerId: b.id });

    const list = await api().get(`${BASE}/partner/tenants`).set(bearer(userA));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data.map((t: { id: string }) => t.id)).toEqual([tenantA.tenantId]);
    const row = list.body.data[0];
    expect(row).toMatchObject({ status: "trialing", source: "referral_code" });
    expect(row).not.toHaveProperty("owner");
    expect(row).not.toHaveProperty("deactivationReason");

    const foreign = await api()
      .get(`${BASE}/partner/tenants/${tenantB.tenantId}`)
      .set(bearer(userA));
    expect(foreign.status).toBe(404);

    // Granting owner contact: the user's token is re-issued, then the field appears.
    await setCapabilities(a.id, [...DEFAULTS, "platform.partner.tenants.view_owner_contact"]);
    expect((await api().get(`${BASE}/partner/tenants`).set(bearer(userA))).status).toBe(401);
    await renew(userA);
    const detail = await api()
      .get(`${BASE}/partner/tenants/${tenantA.tenantId}`)
      .set(bearer(userA));
    expect(detail.status).toBe(200);
    expect(detail.body.data.owner).toMatchObject({ email: tenantA.ownerEmail });
    expect(detail.body.data).not.toHaveProperty("deactivationReason");

    const dashboard = await api().get(`${BASE}/partner/dashboard`).set(bearer(userA));
    expect(dashboard.body.data.tenantsByStatus).toEqual({ trialing: 1 });
  });

  it("captures referral codes at signup and flags self-referral", async () => {
    const partner = await createPartner();
    const referred = await api()
      .post("/api/v1/applications")
      .send(signupBody({ referralCode: partner.referralCode.toLowerCase() }));
    expect(referred.status, JSON.stringify(referred.body)).toBe(201);
    const row = await applicationRow(referred.body.data.applicationId as string);
    expect(row.partner_id).toBe(partner.id);
    expect(row.risk_signals.map((s) => s.code)).not.toContain("self_referral");

    const self = await api()
      .post("/api/v1/applications")
      .send(
        signupBody({ referralCode: partner.referralCode, contactPhone: partner.profile.phone }),
      );
    expect(self.status, JSON.stringify(self.body)).toBe(201);
    expect(
      (await applicationRow(self.body.data.applicationId as string)).risk_signals.map(
        (s) => s.code,
      ),
    ).toContain("self_referral");

    const unknown = await api()
      .post("/api/v1/applications")
      .send(signupBody({ referralCode: "NOSUCHCODE" }));
    expect((await applicationRow(unknown.body.data.applicationId as string)).partner_id).toBeNull();
  });

  it("lets staff reassign or remove a tenant's partner, audited", async () => {
    const a = await createPartner();
    const b = await createPartner();
    const tenant = await tenants.create({ partnerId: a.id });
    const move = await api()
      .put(`${BASE}/tenants/${tenant.tenantId}/partner`)
      .set(bearer(admin))
      .send({ partnerId: b.id, reason: "Introduced by partner B" });
    expect(move.status, JSON.stringify(move.body)).toBe(204);
    const ofB = await api().get(`${BASE}/partners/${b.id}/tenants`).set(bearer(admin));
    expect(ofB.body.data).toEqual([
      expect.objectContaining({ tenantId: tenant.tenantId, source: "manual" }),
    ]);
    expect(
      (await api().get(`${BASE}/partners/${a.id}/tenants`).set(bearer(admin))).body.data,
    ).toEqual([]);
    const sales403 = await api()
      .put(`${BASE}/tenants/${tenant.tenantId}/partner`)
      .set(bearer(sales))
      .send({ partnerId: a.id, reason: "Not allowed for sales" });
    expect(sales403.status).toBe(403);
    await api()
      .put(`${BASE}/tenants/${tenant.tenantId}/partner`)
      .set(bearer(admin))
      .send({ partnerId: null, reason: "Attribution disputed" })
      .expect(204);
    const { rows } = await platform.query<{ n: string }>(
      `select count(*) as n from platform_audit_logs
        where action = 'tenant.partner_changed' and target_tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

describe("assisted signup by a partner", () => {
  it("creates, tracks, answers and attributes the client's application", async () => {
    const a = await createPartner();
    const b = await createPartner();
    const userA = await partnerUser(a.id);
    const userB = await partnerUser(b.id);

    const created = await api()
      .post(`${BASE}/partner/applications`)
      .set(bearer(userA))
      .send(signupBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.applicationId as string;
    expect(created.body.data).not.toHaveProperty("accessToken");
    expect(await applicationRow(id)).toMatchObject({
      partner_id: a.id,
      source: "assisted",
      created_by_staff_id: userA.id,
    });

    expect((await api().get(`${BASE}/partner/applications/${id}`).set(bearer(userB))).status).toBe(
      404,
    );
    const mine = await api().get(`${BASE}/partner/applications`).set(bearer(userA));
    expect(mine.body.data.map((x: { id: string }) => x.id)).toEqual([id]);

    // The client verified; staff ask for more information; the partner answers.
    await platform.query(
      `update tenant_applications set email_verified_at = now(), phone_verified_at = now(),
              status = 'pending_review', submitted_at = now() where id = $1`,
      [id],
    );
    await api()
      .post(`${BASE}/applications/${id}/request-info`)
      .set(bearer(admin))
      .send({ message: "Please send the business TIN" })
      .expect(204);
    const foreignReply = await api()
      .post(`${BASE}/partner/applications/${id}/respond`)
      .set(bearer(userB))
      .send({ message: "Not my client", corrections: {} });
    expect(foreignReply.status).toBe(404);
    const reply = await api()
      .post(`${BASE}/partner/applications/${id}/respond`)
      .set(bearer(userA))
      .send({ message: "TIN added below", corrections: { tin: "C0012345678" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.data.status).toBe("pending_review");
    expect(reply.body.data.messages.map((m: { type: string }) => m.type)).toEqual(
      expect.arrayContaining(["info_requested", "applicant_replied"]),
    );

    await api().post(`${BASE}/applications/${id}/approve`).set(bearer(admin)).send({}).expect(204);
    const { rows } = await platform.query<{ partner_id: string; source: string }>(
      `select pa.partner_id, pa.source from partner_tenant_attributions pa
         join tenant_applications a on a.tenant_id = pa.tenant_id where a.id = $1`,
      [id],
    );
    expect(rows).toEqual([{ partner_id: a.id, source: "assisted" }]);
  });

  it("is refused without the capability", async () => {
    const partner = await createPartner();
    const user = await partnerUser(partner.id);
    await setCapabilities(
      partner.id,
      DEFAULTS.filter((k) => k !== "platform.partner.applications.create"),
    );
    await renew(user);
    const res = await api()
      .post(`${BASE}/partner/applications`)
      .set(bearer(user))
      .send(signupBody());
    expect(res.status).toBe(403);
  });
});

describe("partner status", () => {
  it("pausing stops new clients; terminating disables the users and keeps the tenants", async () => {
    const partner = await createPartner();
    const user = await partnerUser(partner.id);
    const tenant = await tenants.create({ partnerId: partner.id });

    await api()
      .post(`${BASE}/partners/${partner.id}/pause`)
      .set(bearer(sales))
      .send({ reason: "Complaints under review" })
      .expect(204);
    const blocked = await api()
      .post(`${BASE}/partner/applications`)
      .set(bearer(user))
      .send(signupBody());
    expect([blocked.status, blocked.body.error.code]).toEqual([409, "PARTNER_INACTIVE"]);
    const referral = await api()
      .post("/api/v1/applications")
      .send(signupBody({ referralCode: partner.referralCode }));
    const row = await applicationRow(referral.body.data.applicationId as string);
    expect(row.partner_id).toBeNull();
    expect(row.risk_signals.map((s) => s.code)).toContain("referral_partner_inactive");
    // Still sees their tenants while paused.
    expect((await api().get(`${BASE}/partner/tenants`).set(bearer(user))).status).toBe(200);

    await api()
      .post(`${BASE}/partners/${partner.id}/terminate`)
      .set(bearer(sales))
      .send({ reason: "Contract ended" })
      .expect(403);
    await api()
      .post(`${BASE}/partners/${partner.id}/terminate`)
      .set(bearer(admin))
      .send({ reason: "Contract ended" })
      .expect(204);
    expect((await api().get(`${BASE}/partner/tenants`).set(bearer(user))).status).toBe(401);
    const login = await api()
      .post(`${BASE}/auth/refresh`)
      .send({ refreshToken: user.refreshToken });
    expect(login.status).toBe(401);
    const kept = await api().get(`${BASE}/partners/${partner.id}/tenants`).set(bearer(admin));
    expect(kept.body.data.map((t: { tenantId: string }) => t.tenantId)).toEqual([tenant.tenantId]);
    const resume = await api()
      .post(`${BASE}/partners/${partner.id}/resume`)
      .set(bearer(admin))
      .send({ reason: "Changed our mind" });
    expect([resume.status, resume.body.error.code]).toEqual([409, "PARTNER_STATE"]);
  });
});

describe("partner user management by the partner", () => {
  it("needs the capability and stays within the partner", async () => {
    const partner = await createPartner();
    const other = await createPartner();
    const lead = await partnerUser(partner.id);
    const colleague = await partnerUser(partner.id);
    const stranger = await partnerUser(other.id);

    expect((await api().get(`${BASE}/partner/users`).set(bearer(lead))).status).toBe(403);
    await setCapabilities(partner.id, [...DEFAULTS, "platform.partner.users.manage"]);
    await renew(lead);

    const users = await api().get(`${BASE}/partner/users`).set(bearer(lead));
    expect(users.body.data.map((u: { id: string }) => u.id).sort()).toEqual(
      [lead.id, colleague.id].sort(),
    );
    const invite = await api()
      .post(`${BASE}/partner/users/invitations`)
      .set(bearer(lead))
      .send({ email: `new-${unique()}@example.com`, name: "New Colleague" });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);

    const self = await api()
      .post(`${BASE}/partner/users/${lead.id}/disable`)
      .set(bearer(lead))
      .send({ reason: "Disabling myself" });
    expect(self.body.error.code).toBe("CANNOT_CHANGE_OWN_ACCOUNT");
    const foreign = await api()
      .post(`${BASE}/partner/users/${stranger.id}/disable`)
      .set(bearer(lead))
      .send({ reason: "Not my colleague" });
    expect(foreign.status).toBe(404);
    await api()
      .post(`${BASE}/partner/users/${colleague.id}/disable`)
      .set(bearer(lead))
      .send({ reason: "Left the company" })
      .expect(204);
    expect((await api().get(`${BASE}/partner/profile`).set(bearer(colleague))).status).toBe(401);
  });

  it("shows the partner its profile and referral link", async () => {
    const partner = await createPartner();
    const user = await partnerUser(partner.id);
    const profile = await api().get(`${BASE}/partner/profile`).set(bearer(user));
    expect(profile.status).toBe(200);
    expect(profile.body.data.referral.code).toBe(partner.referralCode);
    expect(profile.body.data.referral.link).toContain(`/signup?ref=${partner.referralCode}`);
    expect(profile.body.data.commissionTerms).toBeNull();
  });
});
