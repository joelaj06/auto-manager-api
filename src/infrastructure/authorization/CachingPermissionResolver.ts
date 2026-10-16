import type { PermissionGrants } from "../../application/authorization/Principal.js";
import type { IPermissionCache } from "../../application/ports/IPermissionCache.js";
import type { IPermissionResolver } from "../../application/ports/IPermissionResolver.js";
import { TtlCache } from "../cache/TtlCache.js";

export type PermissionCacheOptions = Readonly<{
  /** How long a user's permission version is trusted; bounds how late a disable takes effect. */
  versionTtlMs: number;
  /** Grants are keyed by version, so they can be kept longer. */
  grantsTtlMs: number;
  maxEntries: number;
}>;

const DEFAULTS: PermissionCacheOptions = {
  versionTtlMs: 15_000,
  grantsTtlMs: 300_000,
  maxEntries: 20_000,
};

/**
 * Caches another resolver. The permission version is checked on every request (cached briefly);
 * grants are cached per (tenant, user, version), so a role edit — which bumps the version — is
 * picked up as soon as the version cache expires.
 */
export class CachingPermissionResolver implements IPermissionResolver, IPermissionCache {
  private readonly versions: TtlCache<number | null>;
  private readonly grants: TtlCache<PermissionGrants | null>;

  constructor(
    private readonly inner: IPermissionResolver,
    options: PermissionCacheOptions = DEFAULTS,
  ) {
    this.versions = new TtlCache({ ttlMs: options.versionTtlMs, maxEntries: options.maxEntries });
    this.grants = new TtlCache({ ttlMs: options.grantsTtlMs, maxEntries: options.maxEntries });
  }

  currentVersion(tenantId: string, userId: string): Promise<number | null> {
    return this.versions.getOrLoad(`${tenantId}:${userId}`, () =>
      this.inner.currentVersion(tenantId, userId),
    );
  }

  resolve(
    tenantId: string,
    userId: string,
    permissionVersion: number,
  ): Promise<PermissionGrants | null> {
    return this.grants.getOrLoad(
      `${tenantId}:${userId}:${permissionVersion}`,
      () => this.inner.resolve(tenantId, userId, permissionVersion),
      (grants) => grants !== null,
    );
  }

  forgetTenant(tenantId: string): void {
    this.versions.deleteByPrefix(`${tenantId}:`);
  }

  /** Drops this process's cached version for a user (call after changing their roles). */
  invalidate(tenantId: string, userId: string): void {
    this.versions.delete(`${tenantId}:${userId}`);
  }
}
