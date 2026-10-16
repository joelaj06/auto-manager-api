import { assertTenantUsable } from "../../authorization/TenantAccessRules.js";
import { Principal } from "../../authorization/Principal.js";
import { InvalidAccessTokenError } from "../../errors/AuthErrors.js";
import {
  BranchDeactivatedError,
  TenantMismatchError,
  TenantNotFoundError,
} from "../../errors/TenantErrors.js";
import type { IAccessTokenService } from "../../ports/IAccessTokenService.js";
import type { IPermissionResolver } from "../../ports/IPermissionResolver.js";
import type { ITenantDirectory, TenantSummary } from "../../ports/ITenantDirectory.js";

export type AuthenticateTenantRequestQuery = Readonly<{
  accessToken: string;
  /** Tenant the client addressed (X-Tenant header), if any. It must match the token. */
  tenantSlug?: string | null;
}>;

export type AuthenticatedTenantRequest = Readonly<{ tenant: TenantSummary; principal: Principal }>;

/**
 * Turns a bearer token into the tenant and principal of a request:
 * 1. verify the token (signature with the tenant's key, issuer, audience, expiry);
 * 2. if the client named a tenant, it must be the token's tenant (else TENANT_MISMATCH);
 * 3. the tenant must be usable (not deactivated);
 * 4. the token's permission version must still be current — role changes and disabled users
 *    take effect immediately, not when the token expires;
 * 5. load the user's permission grants (cached by the resolver).
 */
export class AuthenticateTenantRequest {
  constructor(
    private readonly deps: Readonly<{
      accessTokens: IAccessTokenService;
      tenants: ITenantDirectory;
      permissions: IPermissionResolver;
    }>,
  ) {}

  async execute(query: AuthenticateTenantRequestQuery): Promise<AuthenticatedTenantRequest> {
    const { deps } = this;
    const subject = await deps.accessTokens.verify(query.accessToken, "tenant");

    let tenant: TenantSummary | null;
    if (query.tenantSlug !== undefined && query.tenantSlug !== null) {
      tenant = await deps.tenants.findBySlug(query.tenantSlug);
      if (tenant === null) throw new TenantNotFoundError();
      if (tenant.id !== subject.tenantId) throw new TenantMismatchError();
    } else {
      tenant = await deps.tenants.findById(subject.tenantId);
      if (tenant === null) throw new InvalidAccessTokenError("unknown_tenant");
    }
    assertTenantUsable(tenant);

    const version = await deps.permissions.currentVersion(tenant.id, subject.userId);
    if (version === null) throw new InvalidAccessTokenError("user_unavailable");
    if (version !== subject.permissionVersion)
      throw new InvalidAccessTokenError("stale_permissions");

    const grants = await deps.permissions.resolve(tenant.id, subject.userId, version);
    if (grants === null) throw new InvalidAccessTokenError("user_unavailable");
    // Every branch of this user is deactivated: the tenant works, this user does not (docs/27 §3.5).
    if (grants.allBranchesInactive === true) throw new BranchDeactivatedError();

    return {
      tenant,
      principal: new Principal(subject.userId, tenant.id, subject.sessionId, grants),
    };
  }
}
