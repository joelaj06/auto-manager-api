/**
 * Small in-process cache with a time-to-live per entry and a size bound (oldest entries are
 * evicted first). Concurrent misses for the same key share one load.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly loading = new Map<string, Promise<V>>();

  constructor(
    private readonly options: Readonly<{ ttlMs: number; maxEntries: number; now?: () => number }>,
  ) {}

  /**
   * The cached value, or the result of `load`. Results for which `cacheable` returns false
   * (e.g. "not found") are returned but not stored.
   */
  async getOrLoad(
    key: string,
    load: () => Promise<V>,
    cacheable: (value: V) => boolean = () => true,
  ): Promise<V> {
    const now = this.now();
    const hit = this.entries.get(key);
    if (hit !== undefined && hit.expiresAt > now) return hit.value;

    const pending = this.loading.get(key);
    if (pending !== undefined) return pending;

    const promise = load()
      .then((value) => {
        if (cacheable(value)) this.set(key, value);
        return value;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, promise);
    return promise;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Removes every entry whose key starts with `prefix`. */
  deleteByPrefix(prefix: string): void {
    for (const key of [...this.entries.keys()])
      if (key.startsWith(prefix)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private set(key: string, value: V): void {
    this.entries.delete(key);
    while (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.options.ttlMs });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
