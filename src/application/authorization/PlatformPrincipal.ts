import type { PlatformPermissionKey } from "./platformPermissionCatalog.js";

/** The authenticated staff member behind a console request. */
export class PlatformPrincipal {
  constructor(
    readonly userId: string,
    readonly sessionId: string,
    readonly email: string,
    readonly name: string,
    readonly systemRoles: ReadonlySet<string>,
    private readonly permissions: ReadonlySet<PlatformPermissionKey>,
    /** Last re-authentication in this session (null: none). */
    readonly stepUpAt: Date | null,
  ) {}

  has(permission: PlatformPermissionKey): boolean {
    return this.permissions.has(permission);
  }

  hasAll(permissions: Iterable<PlatformPermissionKey>): boolean {
    for (const permission of permissions) if (!this.permissions.has(permission)) return false;
    return true;
  }

  get permissionKeys(): readonly PlatformPermissionKey[] {
    return [...this.permissions].sort();
  }

  hasRecentStepUp(now: Date, windowMs: number): boolean {
    return this.stepUpAt !== null && now.getTime() - this.stepUpAt.getTime() < windowMs;
  }
}
