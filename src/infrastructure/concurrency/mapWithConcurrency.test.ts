import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./mapWithConcurrency.js";

describe("mapWithConcurrency", () => {
  it("keeps input order in the results", async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await sleep(ms);
      return ms;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it("never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(5);
        running -= 1;
      },
    );
    expect(peak).toBe(3);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 4, () => Promise.resolve(1))).toEqual([]);
  });

  it("rejects an invalid limit", async () => {
    await expect(mapWithConcurrency([1], 0, () => Promise.resolve(1))).rejects.toThrow(
      /positive integer/,
    );
  });
});
