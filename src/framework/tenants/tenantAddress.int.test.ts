import type { Express } from "express";
import type { Container } from "inversify";
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

/**
 * A business's own address: a portal on <slug>.<base domain> needs no X-Tenant header, whether it
 * calls the shared API across origins or is proxied on its own host. The base domain defaults to
 * the host of WEB_APP_URL, so http://<slug>.localhost:5174 here.
 */
let container: Container;
let app: Express;
let t: ProvisionedTenant;
let other: ProvisionedTenant;

const api = () => request(app);
const origin = (tenant: ProvisionedTenant) => `http://${tenant.slug}.localhost:5174`;
const bearer = (tenant: ProvisionedTenant) => ({
  Authorization: `Bearer ${tenant.ownerAccessToken}`,
});

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  const admin = await new StaffFixtures(container).create(["super_admin"]);
  const tenants = new ProvisionedTenants(container, app, admin);
  t = await tenants.create();
  other = await tenants.create();
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("a business's own address", () => {
  it("tells the portal its business from the origin, kept apart in shared caches", async () => {
    const res = await api()
      .get("/api/v1/public/tenant-config")
      .set("Origin", origin(t))
      .expect(200);
    expect(res.body.data.tenant.slug).toBe(t.slug);
    expect(res.headers["access-control-allow-origin"]).toBe(origin(t));
    expect(res.headers.vary).toContain("Origin");
  });

  it("signs in from the origin or the host with no X-Tenant", async () => {
    const credentials = { identifier: t.ownerEmail, password: OWNER_PASSWORD };
    await api().post("/api/v1/auth/login").set("Origin", origin(t)).send(credentials).expect(200);
    await api()
      .post("/api/v1/auth/login")
      .set("Host", `${t.slug}.localhost`)
      .send(credentials)
      .expect(200);
  });

  it("answers signed-in requests from the business's address", async () => {
    await api()
      .get("/api/v1/vehicles")
      .set({ Origin: origin(t), ...bearer(t) })
      .expect(200);
    await api()
      .get("/api/v1/vehicles")
      .set({ Host: `${t.slug}.localhost`, ...bearer(t) })
      .expect(200);
  });

  it("refuses a token on another business's address, and addresses that disagree", async () => {
    const stranger = await api()
      .get("/api/v1/vehicles")
      .set({ Origin: origin(other), ...bearer(t) });
    expect(stranger.body.error.code).toBe("TENANT_MISMATCH");
    const header = await api()
      .get("/api/v1/vehicles")
      .set({ Origin: origin(t), "X-Tenant": other.slug, ...bearer(t) });
    expect(header.body.error.code).toBe("TENANT_MISMATCH");
  });

  it("still takes X-Tenant alone, and an unknown address finds no business", async () => {
    await api()
      .get("/api/v1/vehicles")
      .set({ "X-Tenant": t.slug, ...bearer(t) })
      .expect(200);
    await api()
      .post("/api/v1/auth/login")
      .set("Origin", "http://nobody-here.localhost:5174")
      .send({ identifier: t.ownerEmail, password: OWNER_PASSWORD })
      .expect(404);
  });

  it("leaves requests without an address needing the header", async () => {
    const res = await api()
      .post("/api/v1/auth/login")
      .send({ identifier: t.ownerEmail, password: OWNER_PASSWORD });
    expect(res.body.error.code).toBe("TENANT_REQUIRED");
  });
});
