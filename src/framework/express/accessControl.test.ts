import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AccessGuard, principalOf, tenantOf } from "../../adapters/middleware/AccessGuard.js";
import { defineRoute, type ApiRoute } from "../../adapters/routes/ApiRoute.js";
import { buildRouter } from "../../adapters/routes/buildRouter.js";
import { access } from "../../adapters/routes/RouteAccess.js";
import { AuthorizationPolicy } from "../../application/authorization/AuthorizationPolicy.js";
import type { PermissionGrants } from "../../application/authorization/Principal.js";
import type { IPermissionResolver } from "../../application/ports/IPermissionResolver.js";
import type { ITenantDirectory, TenantSummary } from "../../application/ports/ITenantDirectory.js";
import { AuthenticateTenantRequest } from "../../application/use-cases/auth/AuthenticateTenantRequest.js";
import { ResolveTenant } from "../../application/use-cases/auth/ResolveTenant.js";
import type { HttpConfig } from "../../infrastructure/config/config.js";
import { AsyncLocalRequestContext } from "../../infrastructure/context/AsyncLocalRequestContext.js";
import { AsyncLocalTenantContext } from "../../infrastructure/context/AsyncLocalTenantContext.js";
import { JwtAccessTokenService } from "../../infrastructure/security/JwtAccessTokenService.js";
import { SystemClock } from "../../infrastructure/time/SystemClock.js";
import { JsonLogger, type LogEntry } from "../logger/JsonLogger.js";
import { createApp } from "./createApp.js";

const TENANT_A = "0198f0e0-0000-7000-8000-00000000000a";
const TENANT_B = "0198f0e0-0000-7000-8000-00000000000b";
const TENANT_OFF = "0198f0e0-0000-7000-8000-00000000000c";
const USER = "0198f0e0-0000-7000-8000-000000000001";
const SESSION = "0198f0e0-0000-7000-8000-000000000002";

const http: HttpConfig = {
  trustProxyHops: 0,
  corsAllowedOrigins: [],
  rateLimit: { windowMs: 60_000, max: 1_000 },
  bodyLimitKb: 16,
  exposeOpenApi: false,
};

const tenants: TenantSummary[] = [
  { id: TENANT_A, slug: "alpha", status: "active" },
  { id: TENANT_B, slug: "bravo", status: "active" },
  { id: TENANT_OFF, slug: "closed", status: "deactivated" },
];

const directory: ITenantDirectory = {
  findBySlug: (slug) => Promise.resolve(tenants.find((t) => t.slug === slug) ?? null),
  findById: (id) => Promise.resolve(tenants.find((t) => t.id === id) ?? null),
};

/** USER exists in every tenant with permission version 1 and may list users only. */
const permissions: IPermissionResolver = {
  currentVersion: (_tenantId, userId) => Promise.resolve(userId === USER ? 1 : null),
  resolve: (_tenantId, userId): Promise<PermissionGrants | null> =>
    Promise.resolve(
      userId === USER
        ? { permissions: new Map([["users.list", { scope: "all" }]]), branchIds: [] }
        : null,
    ),
};

function buildApp() {
  const logs: LogEntry[] = [];
  const tenantContext = new AsyncLocalTenantContext();
  const tokens = new JwtAccessTokenService(
    {
      tenantSecret: "tenant-secret-tenant-secret-tenant-secret",
      platformSecret: "platform-secret-platform-secret-platform",
      issuer: "autoforce-test",
      ttlSeconds: 900,
    },
    new SystemClock(),
  );
  const guard = new AccessGuard({
    authenticate: new AuthenticateTenantRequest({
      accessTokens: tokens,
      tenants: directory,
      permissions,
    }),
    resolveTenant: new ResolveTenant(directory),
    authorization: new AuthorizationPolicy(),
    tenantContext,
  });

  const routes: ApiRoute[] = [
    defineRoute({
      method: "get",
      path: "/api/v1/ping",
      summary: "Public",
      tags: ["test"],
      access: access.public(),
      responses: { 200: { description: "ok" } },
      handler: (_input, _req, res) => {
        res.json({ data: "pong" });
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/tenant-info",
      summary: "Tenant-scoped, anonymous",
      tags: ["test"],
      access: access.tenant(),
      responses: { 200: { description: "ok" } },
      handler: (_input, _req, res) => {
        res.json({
          data: { context: tenantContext.currentTenantId().value, slug: tenantOf(res).slug },
        });
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/users/search",
      summary: "Needs users.list",
      tags: ["test"],
      access: access.permission("users.list"),
      request: { body: z.object({ name: z.string().min(2) }) },
      responses: { 200: { description: "ok" } },
      handler: (input, _req, res) => {
        const principal = principalOf(res);
        res.json({
          data: {
            name: input.body.name,
            userId: principal.userId,
            tenantId: principal.tenantId,
            context: tenantContext.currentTenantId().value,
          },
        });
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/roles/:id",
      summary: "Needs roles.delete",
      tags: ["test"],
      access: access.permission("roles.delete"),
      responses: { 204: { description: "deleted" } },
      handler: (_input, _req, res) => {
        res.status(204).end();
      },
    }),
  ];

  const requestContext = new AsyncLocalRequestContext();
  const logger = new JsonLogger({ level: "debug", sink: (entry) => logs.push(entry) });
  const app = createApp({ http, logger, requestContext, routes, accessGuard: guard });

  const tokenFor = async (tenantId: string, userId = USER) =>
    (
      await tokens.issue({
        audience: "tenant",
        tenantId,
        userId,
        sessionId: SESSION,
        permissionVersion: 1,
      })
    ).token;
  const platformToken = async () =>
    (
      await tokens.issue({
        audience: "platform",
        userId: USER,
        sessionId: SESSION,
        permissionVersion: 1,
      })
    ).token;
  return { app, logs, tokenFor, platformToken };
}

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
