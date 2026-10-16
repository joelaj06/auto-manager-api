import type { PermissionKey } from "../../application/authorization/permissionCatalog.js";

/**
 * Who may call a route. Every route must declare one (it is a required field of ApiRoute):
 * - `public`: anyone; no tenant (health probes, API docs, platform sign-up).
 * - `tenant`: anyone, for the tenant named in the X-Tenant header (sign-in, password reset).
 * - `authenticated`: a signed-in tenant user holding `permission` (null: any signed-in user,
 *   e.g. "my profile"). Scope checks against a specific record happen in the use case.
 */
export type RouteAccess =
  | Readonly<{ kind: "public" }>
  | Readonly<{ kind: "tenant" }>
  | Readonly<{ kind: "authenticated"; permission: PermissionKey | null }>;

export const access = Object.freeze({
  public: (): RouteAccess => ({ kind: "public" }),
  tenant: (): RouteAccess => ({ kind: "tenant" }),
  signedIn: (): RouteAccess => ({ kind: "authenticated", permission: null }),
  permission: (permission: PermissionKey): RouteAccess => ({ kind: "authenticated", permission }),
});
