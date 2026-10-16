import request from "supertest";
import { describe, expect, it } from "vitest";
import { defineRoute } from "../../adapters/routes/ApiRoute.js";
import { buildRouter } from "../../adapters/routes/buildRouter.js";
import { access } from "../../adapters/routes/RouteAccess.js";
import {
  buildGuardedApp as buildApp,
  TENANT_A,
  TENANT_B,
  TENANT_OFF,
  USER,
} from "../../testing/guardedApp.js";

describe("access control", () => {
  it("serves public routes without credentials", async () => {
    const res = await request(buildApp().app).get("/api/v1/ping");
    expect(res.status).toBe(200);
  });

  describe("tenant routes", () => {
    it("run inside the addressed tenant's context", async () => {
      const res = await request(buildApp().app).get("/api/v1/tenant-info").set("X-Tenant", "alpha");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ context: TENANT_A, slug: "alpha" });
    });

    it("require a usable tenant", async () => {
      const { app } = buildApp();
      const missing = await request(app).get("/api/v1/tenant-info");
      expect([missing.status, missing.body.error.code]).toEqual([400, "TENANT_REQUIRED"]);
      const unknown = await request(app).get("/api/v1/tenant-info").set("X-Tenant", "nobody");
      expect([unknown.status, unknown.body.error.code]).toEqual([404, "TENANT_NOT_FOUND"]);
      const closed = await request(app).get("/api/v1/tenant-info").set("X-Tenant", "closed");
      expect([closed.status, closed.body.error.code]).toEqual([403, "TENANT_DEACTIVATED"]);
    });
  });

  describe("authenticated routes", () => {
    it("serve a user with the permission, inside the token's tenant", async () => {
      const { app, tokenFor } = buildApp();
      const res = await request(app)
        .post("/api/v1/users/search")
        .set("Authorization", `Bearer ${await tokenFor(TENANT_A)}`)
        .set("X-Tenant", "alpha")
        .send({ name: "Ama" });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        name: "Ama",
        userId: USER,
        tenantId: TENANT_A,
        context: TENANT_A,
      });
    });

    it("take the tenant from the token when no X-Tenant is sent", async () => {
      const { app, tokenFor } = buildApp();
      const res = await request(app)
        .post("/api/v1/users/search")
        .set("Authorization", `Bearer ${await tokenFor(TENANT_B)}`)
        .send({ name: "Kofi" });
      expect(res.status).toBe(200);
      expect(res.body.data.context).toBe(TENANT_B);
    });

    it("reject tenant A's token on tenant B and raise a security alert", async () => {
      const { app, logs, tokenFor } = buildApp();
      const res = await request(app)
        .post("/api/v1/users/search")
        .set("Authorization", `Bearer ${await tokenFor(TENANT_A)}`)
        .set("X-Tenant", "bravo")
        .send({ name: "Ama" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("TENANT_MISMATCH");
      expect(logs.some((l) => l.msg === "SECURITY: request failed")).toBe(true);
    });

    it("require a bearer token, before validating the body", async () => {
      const res = await request(buildApp().app).post("/api/v1/users/search").send({ name: "" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
      expect(res.headers["www-authenticate"]).toBe("Bearer");
    });

    it("reject invalid tokens without saying why", async () => {
      const { app, logs, platformToken, tokenFor } = buildApp();
      for (const token of ["garbage", await platformToken(), `${await tokenFor(TENANT_A)}x`]) {
        const res = await request(app)
          .post("/api/v1/users/search")
          .set("Authorization", `Bearer ${token}`)
          .send({ name: "Ama" });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatchObject({
          code: "INVALID_TOKEN",
          message: "The access token is invalid or has expired",
        });
        expect(res.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
      }
      // The reason is in the logs only.
      expect(logs.map((l) => l.detail)).toEqual(
        expect.arrayContaining(["missing_tenant", "bad_signature"]),
      );
    });

    it("reject unknown users and missing permissions", async () => {
      const { app, tokenFor } = buildApp();
      const stranger = await request(app)
        .post("/api/v1/users/search")
        .set(
          "Authorization",
          `Bearer ${await tokenFor(TENANT_A, "0198f0e0-0000-7000-8000-0000000000ff")}`,
        )
        .send({ name: "Ama" });
      expect(stranger.status).toBe(401);

      const forbidden = await request(app)
        .delete("/api/v1/roles/x")
        .set("Authorization", `Bearer ${await tokenFor(TENANT_A)}`);
      expect([forbidden.status, forbidden.body.error.code]).toEqual([403, "FORBIDDEN"]);
    });

    it("reject tokens of deactivated tenants", async () => {
      const { app, tokenFor } = buildApp();
      const res = await request(app)
        .post("/api/v1/users/search")
        .set("Authorization", `Bearer ${await tokenFor(TENANT_OFF)}`)
        .send({ name: "Ama" });
      expect([res.status, res.body.error.code]).toEqual([403, "TENANT_DEACTIVATED"]);
    });
  });

  it("refuses to mount protected routes without a guard", () => {
    const route = defineRoute({
      method: "get",
      path: "/api/v1/secret",
      summary: "Protected",
      tags: ["test"],
      access: access.signedIn(),
      responses: {},
      handler: () => undefined,
    });
    expect(() => buildRouter([route])).toThrow(/needs an access guard/);
  });
});
