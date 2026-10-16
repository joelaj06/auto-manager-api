import type {
  ITenantDirectory,
  TenantStatus,
  TenantSummary,
} from "../../../application/ports/ITenantDirectory.js";
import { TtlCache } from "../../cache/TtlCache.js";
import type { Queryable } from "../postgres/Queryable.js";

const SLUG = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type TenantDirectoryOptions = Readonly<{ cacheTtlMs: number; maxEntries: number }>;

/**
 * Tenant lookups from the platform registry, cached in-process because every tenant request
 * needs one. Status changes (suspension, reactivation) take effect within `cacheTtlMs`. Unknown
 * slugs are not cached so a newly provisioned tenant is usable immediately.
 */
export class PostgresTenantDirectory implements ITenantDirectory {
  private readonly cache: TtlCache<TenantSummary | null>;

  constructor(
    private readonly platform: Queryable,
    options: TenantDirectoryOptions = { cacheTtlMs: 30_000, maxEntries: 10_000 },
  ) {
    this.cache = new TtlCache({ ttlMs: options.cacheTtlMs, maxEntries: options.maxEntries });
  }

  findBySlug(slug: string): Promise<TenantSummary | null> {
    const normalised = slug.trim().toLowerCase();
    if (!SLUG.test(normalised)) return Promise.resolve(null);
    return this.cache.getOrLoad(
      `slug:${normalised}`,
      () => this.query("slug = $1", normalised),
      (tenant) => tenant !== null,
    );
  }

  findById(id: string): Promise<TenantSummary | null> {
    const normalised = id.toLowerCase();
    if (!UUID.test(normalised)) return Promise.resolve(null);
    return this.cache.getOrLoad(
      `id:${normalised}`,
      () => this.query("id = $1", normalised),
      (tenant) => tenant !== null,
    );
  }

  private async query(condition: string, value: string): Promise<TenantSummary | null> {
    const { rows } = await this.platform.query<{ id: string; slug: string; status: TenantStatus }>(
      `select id, slug::text as slug, status from tenants where ${condition}`,
      [value],
    );
    const row = rows[0];
    return row === undefined ? null : { id: row.id, slug: row.slug, status: row.status };
  }
}
