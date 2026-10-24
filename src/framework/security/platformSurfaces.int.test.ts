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
 * Security review of the phase 4 surfaces (docs/32 §5): support tokens are bound to their tenant
 * and session, exports and quotes never cross tenants, reseller users never reach staff
 * commission routes, and tenant tokens never reach the console.
 */
const BASE = "/api/platform/v1";
let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;
let a: ProvisionedTenant;
let b: ProvisionedTenant;

const api = () => request(app);
const as = (who: { accessToken: string }) => ({ Authorization: `Bearer ${who.accessToken}` });
const unique = () => randomUUID().slice(0, 8);

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  admin = await new StaffFixtures(container).create(["super_admin"]);
  const code = new TotpService().codeAt(admin.totpSecret, new Date(Date.now() + 30_000));
  await api()
    .post(`${BASE}/auth/step-up`)
    .set(as(admin))
    .send({ password: admin.password, code })
    .expect(204);
  const tenants = new ProvisionedTenants(container, app, admin);
  a = await tenants.create();
  b = await tenants.create();
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("phase 4 surfaces", () => {
  it("binds a support token to its tenant", async () => {
    const session = await api()
      .post(`${BASE}/tenants/${a.tenantId}/support-sessions`)
      .set(as(admin))
      .send({ reason: "Security review of support tokens" });
    const token = (
      await api().post(`${BASE}/support-sessions/${session.body.data.id}/token`).set(as(admin))
    ).body.data.accessToken as string;
    const other = await api()
      .get("/api/v1/vehicles")
      .set({ Authorization: `Bearer ${token}`, "X-Tenant": b.slug });
    expect(other.status).toBe(401);
    expect(other.body.error.code).toBe("TENANT_MISMATCH");
    // A tenant token is never a console token.
    expect(
      (
        await api()
          .get(`${BASE}/me`)
          .set({ Authorization: `Bearer ${token}` })
      ).status,
    ).toBe(401);
    await api()
      .post(`${BASE}/support-sessions/${session.body.data.id}/end`)
      .set(as(admin))
      .expect(200);
  });

  it("never lets one tenant download another's export", async () => {
    const asked = await api()
      .post("/api/v1/data-exports")
      .set(as({ accessToken: a.ownerAccessToken }));
    expect(asked.status).toBe(202);
    const stolen = await api()
      .post(`/api/v1/data-exports/${asked.body.data.id}/download`)
      .set(as({ accessToken: b.ownerAccessToken }));
    expect(stolen.status).toBe(404);
  });

  it("keeps reseller users out of staff commission routes", async () => {
    const partner = await api()
      .post(`${BASE}/partners`)
      .set(as(admin))
      .send({
        name: `Reseller ${unique()}`,
        kind: "company",
        contactName: "Ama Mensah",
        email: `reseller-${unique()}@example.com`,
        phone: `+23324${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
      });
    const email = `pu-${unique()}@example.com`;
    const invited = await api()
      .post(`${BASE}/partners/${partner.body.data.id}/users/invitations`)
      .set(as(admin))
      .send({ email, name: "Partner User" });
    const { rows } = await platform.query<{ body_text: string }>(
      `select body_text from email_deliveries where recipient = $1
        and template = 'platform.staff_invitation' order by created_at desc limit 1`,
      [email],
    );
    const token = /#token=([A-Za-z0-9_-]+)/.exec(rows[0]!.body_text)![1]!;
    const user = await new StaffFixtures(container).activate(
      token,
      invited.body.data.userId as string,
      email,
    );
    for (const path of [
      `/partners/${partner.body.data.id}/commissions`,
      "/partners/commissions/payable",
      "/partner-payouts",
      "/launch/readiness",
    ])
      expect((await api().get(`${BASE}${path}`).set(as(user))).status, path).toBe(403);
    expect((await api().get(`${BASE}/partner/commissions`).set(as(user))).status).toBe(200);
  });
});
