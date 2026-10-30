import { Principal } from "../../authorization/Principal.js";
import type { IPermissionResolver } from "../../ports/IPermissionResolver.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";

/** A user of the business as they are now, for building reports as them (null when disabled or gone). */
export async function reportPrincipal(
  deps: Readonly<{ permissions: IPermissionResolver; tenantContext: ITenantContext }>,
  userId: string,
  session: string,
): Promise<Principal | null> {
  const tenantId = deps.tenantContext.currentTenantId().value;
  const version = await deps.permissions.currentVersion(tenantId, userId);
  if (version === null) return null;
  const grants = await deps.permissions.resolve(tenantId, userId, version);
  return grants === null ? null : new Principal(userId, tenantId, session, grants);
}
