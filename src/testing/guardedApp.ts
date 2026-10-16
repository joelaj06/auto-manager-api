import { z } from "zod";
import { AccessGuard, principalOf, tenantOf } from "../adapters/middleware/AccessGuard.js";
import { defineRoute, type ApiRoute } from "../adapters/routes/ApiRoute.js";
import { access } from "../adapters/routes/RouteAccess.js";
import { AuthorizationPolicy } from "../application/authorization/AuthorizationPolicy.js";
import type { PermissionGrants } from "../application/authorization/Principal.js";
import type { IPermissionResolver } from "../application/ports/IPermissionResolver.js";
import type { ITenantDirectory, TenantSummary } from "../application/ports/ITenantDirectory.js";
import { AuthenticateTenantRequest } from "../application/use-cases/auth/AuthenticateTenantRequest.js";
import { ResolveTenant } from "../application/use-cases/auth/ResolveTenant.js";
import type { StaffSessions } from "../application/use-cases/platform/StaffSessions.js";
import { createApp } from "../framework/express/createApp.js";
import { JsonLogger, type LogEntry } from "../framework/logger/JsonLogger.js";
import type { HttpConfig } from "../infrastructure/config/config.js";
import { AsyncLocalRequestContext } from "../infrastructure/context/AsyncLocalRequestContext.js";
import { AsyncLocalTenantContext } from "../infrastructure/context/AsyncLocalTenantContext.js";
import { JwtAccessTokenService } from "../infrastructure/security/JwtAccessTokenService.js";
import { SystemClock } from "../infrastructure/time/SystemClock.js";

/**
 * A fully guarded HTTP app without databases, for access-control and security regression tests:
 * real JWT service and AccessGuard, an in-memory tenant directory (alpha, bravo, a deactivated
 * one) and one user (USER) who holds only `users.list`.
 */
export const TENANT_A = "0198f0e0-0000-7000-8000-00000000000a";
export const TENANT_B = "0198f0e0-0000-7000-8000-00000000000b";
export const TENANT_OFF = "0198f0e0-0000-7000-8000-00000000000c";
export const USER = "0198f0e0-0000-7000-8000-000000000001";
export const SESSION = "0198f0e0-0000-7000-8000-000000000002";

const http: HttpConfig = {
  trustProxyHops: 0,
  corsAllowedOrigins: [],
  rateLimit: { windowMs: 60_000, max: 1_000 },
  authRateLimitMax: 1_000,
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
  invalidate: () => undefined,
};

/** USER exists in every tenant and may list users only. */
function permissionsFor(versions: Map<string, number>): IPermissionResolver {
  return {
    currentVersion: (_tenantId, userId) => Promise.resolve(versions.get(userId) ?? null),
    resolve: (_tenantId, userId): Promise<PermissionGrants | null> =>
      Promise.resolve(
        userId === USER
          ? { permissions: new Map([["users.list", { scope: "all" }]]), branchIds: [] }
          : null,
      ),
  };
}

export type GuardedAppOptions = Readonly<{
  /** More routes, built with the app's tenant context (e.g. one that throws). */
  extraRoutes?: readonly ApiRoute[];
}>;

export function buildGuardedApp(options: GuardedAppOptions = {}) {
  const logs: LogEntry[] = [];
  /** Current permission version per user; bump or delete to simulate role edits / disabling. */
  const userVersions = new Map<string, number>([[USER, 1]]);
  const permissions = permissionsFor(userVersions);
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
    // Console routes are not part of this harness.
    staffSessions: {
      settings: { idleMs: 3_600_000, maxMs: 43_200_000, stepUpMs: 600_000 },
      authenticate: () => Promise.reject(new Error("no console in this harness")),
    } as unknown as StaffSessions,
    clock: new SystemClock(),
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
    ...(options.extraRoutes ?? []),
  ];

  const requestContext = new AsyncLocalRequestContext();
  const logger = new JsonLogger({ level: "debug", sink: (entry) => logs.push(entry) });
  const app = createApp({ http, logger, requestContext, routes, accessGuard: guard });

  const tokenFor = async (tenantId: string, userId = USER, permissionVersion = 1) =>
    (
      await tokens.issue({
        audience: "tenant",
        tenantId,
        userId,
        sessionId: SESSION,
        permissionVersion,
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
  return { app, logs, tokens, userVersions, tokenFor, platformToken };
}
