import type { Request, Response } from "express";
import type { AuthorizationPolicy } from "../../application/authorization/AuthorizationPolicy.js";
import { PLATFORM_PERMISSION_CATALOG } from "../../application/authorization/platformPermissionCatalog.js";
import type { PlatformPrincipal } from "../../application/authorization/PlatformPrincipal.js";
import type { Principal } from "../../application/authorization/Principal.js";
import {
  AuthenticationRequiredError,
  PermissionDeniedError,
} from "../../application/errors/AuthErrors.js";
import { StepUpRequiredError } from "../../application/errors/StaffErrors.js";
import { TenantReadOnlyError } from "../../application/errors/TenantErrors.js";
import type { IClock } from "../../application/ports/IClock.js";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { TenantSummary } from "../../application/ports/ITenantDirectory.js";
import type { AuthenticateTenantRequest } from "../../application/use-cases/auth/AuthenticateTenantRequest.js";
import type { ResolveTenant } from "../../application/use-cases/auth/ResolveTenant.js";
import type { StaffSessions } from "../../application/use-cases/platform/StaffSessions.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import type { RouteAccess } from "../routes/RouteAccess.js";

export const TENANT_HEADER = "x-tenant";
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;
const MAX_TOKEN_LENGTH = 4_096;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type Locals = { tenant?: TenantSummary; principal?: Principal; staff?: PlatformPrincipal };

/**
 * Enforces a route's declared access before its handler runs, then runs the handler inside the
 * tenant context so the unit of work reaches that tenant's database (and no other):
 * - `tenant`: resolve the X-Tenant slug;
 * - `authenticated`: verify the bearer token, check it belongs to the addressed tenant, check
 *   the permission.
 * - `platform`: verify the console token and session, check the platform permission and, for
 *   sensitive permissions, a recent step-up. No tenant context: console routes never reach
 *   tenant data directly.
 */
export class AccessGuard {
  constructor(
    private readonly deps: Readonly<{
      authenticate: AuthenticateTenantRequest;
      resolveTenant: ResolveTenant;
      authorization: AuthorizationPolicy;
      tenantContext: ITenantContext;
      staffSessions: StaffSessions;
      clock: IClock;
    }>,
  ) {}

  async run(
    access: RouteAccess,
    req: Request,
    res: Response,
    handler: () => Promise<void>,
  ): Promise<void> {
    const locals = res.locals as Locals;
    switch (access.kind) {
      case "public":
        return handler();

      case "tenant": {
        const tenant = await this.deps.resolveTenant.execute(tenantSlugOf(req));
        locals.tenant = tenant;
        return this.deps.tenantContext.runAs(TenantId.from(tenant.id), handler);
      }

      case "authenticated": {
        const accessToken = bearerTokenOf(req);
        if (accessToken === null) throw new AuthenticationRequiredError();
        const { tenant, principal } = await this.deps.authenticate.execute({
          accessToken,
          tenantSlug: tenantSlugOf(req),
        });
        if (access.permission !== null) {
          this.deps.authorization.require(principal, access.permission);
        }
        // Read-only tenants: reads only (docs/27 §3.3); sign-in routes are `tenant` routes.
        if (
          tenant.status === "read_only" &&
          !SAFE_METHODS.has(req.method) &&
          access.allowWhenReadOnly !== true
        ) {
          throw new TenantReadOnlyError();
        }
        locals.tenant = tenant;
        locals.principal = principal;
        return this.deps.tenantContext.runAs(TenantId.from(tenant.id), handler);
      }

      case "platform": {
        const accessToken = bearerTokenOf(req);
        if (accessToken === null) throw new AuthenticationRequiredError();
        const staff = await this.deps.staffSessions.authenticate(accessToken);
        if (access.permission !== null) {
          if (!staff.has(access.permission)) throw new PermissionDeniedError(access.permission);
          const sensitive = PLATFORM_PERMISSION_CATALOG[access.permission].sensitive === true;
          const window = this.deps.staffSessions.settings.stepUpMs;
          if (sensitive && !staff.hasRecentStepUp(this.deps.clock.now(), window)) {
            throw new StepUpRequiredError();
          }
        }
        locals.staff = staff;
        return handler();
      }
    }
  }
}

/** The signed-in user of an `authenticated` route. */
export function principalOf(res: Response): Principal {
  const principal = (res.locals as Locals).principal;
  if (principal === undefined) throw new AuthenticationRequiredError();
  return principal;
}

/** The staff member of a `platform` route. */
export function staffOf(res: Response): PlatformPrincipal {
  const staff = (res.locals as Locals).staff;
  if (staff === undefined) throw new AuthenticationRequiredError();
  return staff;
}

/** The tenant of a `tenant` or `authenticated` route. */
export function tenantOf(res: Response): TenantSummary {
  const tenant = (res.locals as Locals).tenant;
  if (tenant === undefined) throw new Error("tenantOf() used on a route without tenant access");
  return tenant;
}

function tenantSlugOf(req: Request): string | null {
  const value = req.get(TENANT_HEADER);
  return value === undefined || value.trim() === "" ? null : value.trim();
}

function bearerTokenOf(req: Request): string | null {
  const header = req.get("authorization");
  if (header === undefined || header.length > MAX_TOKEN_LENGTH + 7) return null;
  return BEARER.exec(header)?.[1] ?? null;
}
