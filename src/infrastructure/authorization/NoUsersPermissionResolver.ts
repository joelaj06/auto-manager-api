import type { PermissionGrants } from "../../application/authorization/Principal.js";
import type { IPermissionResolver } from "../../application/ports/IPermissionResolver.js";

/**
 * Placeholder until the identity module (P1-5) creates users, roles and role assignments: no
 * user exists, so every access token is rejected. Replaced by a resolver that reads the tenant's
 * role tables.
 */
export class NoUsersPermissionResolver implements IPermissionResolver {
  resolve(): Promise<PermissionGrants | null> {
    return Promise.resolve(null);
  }

  currentVersion(): Promise<number | null> {
    return Promise.resolve(null);
  }
}
