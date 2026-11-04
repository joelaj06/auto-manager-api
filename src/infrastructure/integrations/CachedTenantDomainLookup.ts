import type {
  ITenantDomainLookup,
  ITenantDomains,
} from "../../application/ports/ITenantDomains.js";
import { TtlCache } from "../cache/TtlCache.js";

/**
 * Every live domain in memory, read again every half minute. A request's Host is only looked up
 * in this map, so nonsense host names cost nothing and cannot fill a cache or reach the database.
 */
export class CachedTenantDomainLookup implements ITenantDomainLookup {
  private readonly cache = new TtlCache<ReadonlyMap<string, string>>({
    ttlMs: 30_000,
    maxEntries: 1,
  });

  constructor(private readonly domains: Pick<ITenantDomains, "active">) {}

  async slugOf(hostname: string): Promise<string | null> {
    const all = await this.cache.getOrLoad("all", async () => {
      const rows = await this.domains.active();
      return new Map(rows.map((r) => [r.domain, r.slug]));
    });
    return all.get(hostname.toLowerCase()) ?? null;
  }

  forget(): void {
    this.cache.clear();
  }
}
