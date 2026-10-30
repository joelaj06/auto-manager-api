import type { Request, Response } from "express";
import type { AuthorizationPolicy } from "../../application/authorization/AuthorizationPolicy.js";
import { PLATFORM_PERMISSION_CATALOG } from "../../application/authorization/platformPermissionCatalog.js";
import type { PlatformPrincipal } from "../../application/authorization/PlatformPrincipal.js";
import type { Principal, SupportActor } from "../../application/authorization/Principal.js";
import {
  AuthenticationRequiredError,
  PermissionDeniedError,
} from "../../application/errors/AuthErrors.js";
import { StepUpRequiredError } from "../../application/errors/StaffErrors.js";
import {
  FeatureDisabledError,
  MaintenanceReadOnlyError,
  SupportAccessError,
  TenantBillingOnlyError,
  TenantReadOnlyError,
} from "../../application/errors/TenantErrors.js";
import type {
  IFeatureGate,
  IMaintenanceState,
  IUsageMeter,
} from "../../application/ports/IOperationsGates.js";
import type { IRequestContext } from "../../application/ports/IRequestContext.js";
import type { ISupportAccess } from "../../application/ports/ISupportAccess.js";
import type { IClock } from "../../application/ports/IClock.js";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { TenantSummary } from "../../application/ports/ITenantDirectory.js";
import type { AuthenticateTenantRequest } from "../../application/use-cases/auth/AuthenticateTenantRequest.js";
import type { ResolveTenant } from "../../application/use-cases/auth/ResolveTenant.js";
import type { StaffSessions } from "../../application/use-cases/platform/StaffSessions.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import type { RouteAccess } from "../routes/RouteAccess.js";
import { maskSensitive, supportVerdict } from "./supportMode.js";

export const TENANT_HEADER = "x-tenant";
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;
const MAX_TOKEN_LENGTH = 4_096;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** What a tenant deactivated by billing can still reach (docs/25 §5.4). */
const SESSION_PATHS = /^\/api\/v1\/auth\//;
const BILLING_PATHS = /^\/api\/v1\/billing(\/|$)/;
const BILLING_ONLY_PATHS =
  /^\/api\/v1\/(billing(\/|$)|me(\/(permissions|password|push-devices(\/[a-z-]+)?))?\/?$)/;

type Locals = { tenant?: TenantSummary; principal?: Principal; staff?: PlatformPrincipal };

/**
 * Enforces a route's declared access before its handler runs, then runs the handler inside the
 * tenant context so the unit of work reaches that tenant's database (and no other):
 * - `tenant`: resolve the X-Tenant slug;
 * - `authenticated`: verify the bearer token, check it belongs to the addressed tenant, check
 *   the permission. A tenant deactivated by billing reaches only its session routes and, for
 *   users with billing access, billing and their profile.
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
      /** Console operations (P4-7): support-access trail, maintenance, flags, usage. */
      requestContext?: IRequestContext;
      support?: ISupportAccess;
      maintenance?: IMaintenanceState;
      features?: IFeatureGate;
      usage?: IUsageMeter;
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
      case "public": {
        // A kill switch also closes public routes (e.g. guest signing links).
        const flag = await this.deps.features?.disabledBy(null, pathOf(req));
        if (flag !== undefined && flag !== null) throw new FeatureDisabledError(flag);
        return handler();
      }

      case "tenant": {
        const tenant = await this.deps.resolveTenant.execute(tenantSlugOf(req));
        const flag = await this.deps.features?.disabledBy(tenant.id, pathOf(req));
        if (flag !== undefined && flag !== null) throw new FeatureDisabledError(flag);
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
        const path = pathOf(req);
        if (principal.support !== null) this.trail(req, res, principal.support);
        if (tenant.billingOnly === true) this.assertBillingOnly(req, principal);
        if (access.permission !== null) {
          this.deps.authorization.require(principal, access.permission);
        }
        if (principal.support !== null) assertSupportAllows(req.method, path, principal.support);
        const flag = await this.deps.features?.disabledBy(tenant.id, path);
        if (flag !== undefined && flag !== null) throw new FeatureDisabledError(flag);
        // Maintenance: every tenant reads only, sign-in and paying aside (docs/27 §3.12).
        if (!SAFE_METHODS.has(req.method) && access.allowWhenReadOnly !== true) {
          const window = await this.deps.maintenance?.readOnlyNow();
          if (window !== undefined && window !== null && !BILLING_PATHS.test(path))
            throw new MaintenanceReadOnlyError(window.title, window.endsAt);
        }
        this.deps.usage?.count(tenant.id);
        const usage = this.deps.usage;
        if (usage !== undefined)
          res.once("finish", () => {
            if (res.statusCode >= 500) usage.failed(tenant.id);
          });
        // Read-only tenants: reads only (docs/27 §3.3) — and paying; sign-in routes are
        // `tenant` routes.
        if (
          tenant.status === "read_only" &&
          !SAFE_METHODS.has(req.method) &&
          access.allowWhenReadOnly !== true &&
          !BILLING_PATHS.test(pathOf(req))
        ) {
          throw new TenantReadOnlyError();
        }
        locals.tenant = tenant;
        locals.principal = principal;
        const run = () => this.deps.tenantContext.runAs(TenantId.from(tenant.id), handler);
        if (principal.support === null) return run();
        // Support access: staff named in the tenant's audit log, sensitive values masked.
        const support = principal.support;
        const json = res.json.bind(res);
        res.json = (body: unknown) => json(maskSensitive(body));
        const requests = this.deps.requestContext;
        const context = requests?.current();
        return requests === undefined || context === undefined
          ? run()
          : requests.run({ ...context, support }, run);
      }

      case "platform": {
        const accessToken = bearerTokenOf(req);
        if (accessToken === null) throw new AuthenticationRequiredError();
        const staff = await this.deps.staffSessions.authenticate(accessToken);
        // Reseller users only reach partner routes and their own session routes.
        if (staff.partnerId !== null && access.partnerUsers !== true)
          throw new PermissionDeniedError(access.permission ?? "platform.staff");
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

      case "partner": {
        const accessToken = bearerTokenOf(req);
        if (accessToken === null) throw new AuthenticationRequiredError();
        const user = await this.deps.staffSessions.authenticate(accessToken);
        if (user.partnerId === null) throw new PermissionDeniedError("platform.partner");
        if (access.permission !== null && !user.has(access.permission))
          throw new PermissionDeniedError(access.permission);
        locals.staff = user;
        return handler();
      }
    }
  }

  /** Every request of a support session goes to its trail once answered (blocked ones too). */
  private trail(req: Request, res: Response, support: SupportActor): void {
    const recorder = this.deps.support;
    if (recorder === undefined) return;
    const requestId = this.deps.requestContext?.current()?.requestId ?? null;
    res.on("finish", () => {
      void recorder.record(support.sessionId, {
        method: req.method,
        path: pathOf(req),
        statusCode: res.statusCode,
        requestId,
      });
    });
  }

  private assertBillingOnly(req: Request, principal: Principal): void {
    const path = pathOf(req);
    if (SESSION_PATHS.test(path)) return;
    const billingUser =
      this.deps.authorization.decide(principal, "billing.view").allowed ||
      this.deps.authorization.decide(principal, "billing.manage").allowed;
    if (!billingUser || !BILLING_ONLY_PATHS.test(path)) throw new TenantBillingOnlyError();
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

const pathOf = (req: Request): string => req.originalUrl.split("?")[0] ?? "";

function assertSupportAllows(method: string, path: string, support: SupportActor): void {
  const verdict = supportVerdict(method, path, support.mode);
  if (verdict === "read_only")
    throw new SupportAccessError("SUPPORT_READ_ONLY", "Support access is read-only");
  if (verdict === "blocked")
    throw new SupportAccessError(
      "SUPPORT_ACTION_BLOCKED",
      "Support access cannot sign in or out, change passwords, pay, download or export",
    );
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
