import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "./TtlCache.js";

describe("TtlCache", () => {
  it("caches until the TTL passes", async () => {
    let now = 0;
    const cache = new TtlCache<number>({ ttlMs: 100, maxEntries: 10, now: () => now });
    const load = vi.fn(() => Promise.resolve(42));

    await cache.getOrLoad("k", load);
    now = 99;
    await cache.getOrLoad("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    now = 100;
    await cache.getOrLoad("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares concurrent loads and skips uncacheable values", async () => {
    const cache = new TtlCache<number | null>({ ttlMs: 1_000, maxEntries: 10 });
    const load = vi.fn(() => Promise.resolve(null));
    await Promise.all([cache.getOrLoad("k", load), cache.getOrLoad("k", load)]);
    expect(load).toHaveBeenCalledTimes(1);

    await cache.getOrLoad("other", load, (v) => v !== null);
    await cache.getOrLoad("other", load, (v) => v !== null);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("does not cache failures", async () => {
    const cache = new TtlCache<number>({ ttlMs: 1_000, maxEntries: 10 });
    await expect(cache.getOrLoad("k", () => Promise.reject(new Error("down")))).rejects.toThrow();
    await expect(cache.getOrLoad("k", () => Promise.resolve(1))).resolves.toBe(1);
  });

  it("evicts the oldest entries beyond the bound", async () => {
    const cache = new TtlCache<string>({ ttlMs: 1_000, maxEntries: 2 });
    for (const key of ["a", "b", "c"]) await cache.getOrLoad(key, () => Promise.resolve(key));
    const load = vi.fn(() => Promise.resolve("reloaded"));
    await expect(cache.getOrLoad("a", load)).resolves.toBe("reloaded");
    await expect(cache.getOrLoad("c", load)).resolves.toBe("c");
  });
});
