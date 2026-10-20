import { describe, expect, it } from "vitest";
import { bucketKey, DateRange, isoWeek, series } from "./DateRange.js";

describe("DateRange", () => {
  it("defaults to the month of the end date up to that day", () => {
    const range = DateRange.of(undefined, undefined, "2026-10-20");
    expect([range.from, range.to, range.days]).toEqual(["2026-10-01", "2026-10-20", 20]);
    expect(DateRange.of(undefined, "2026-02-28", "2026-10-20").from).toBe("2026-02-01");
  });

  it("refuses an inverted or too long range", () => {
    expect(() => DateRange.of("2026-10-02", "2026-10-01", "2026-10-20")).toThrow(/after/);
    expect(() => DateRange.of("2024-01-01", "2026-10-01", "2026-10-20")).toThrow(/at most/);
  });

  it("compares with the same number of days just before", () => {
    const previous = DateRange.of("2026-10-01", "2026-10-31", "2026-10-31").previous();
    expect([previous.from, previous.to]).toEqual(["2026-08-31", "2026-09-30"]);
  });

  // Audit H12: days 29–31 fell into a "week 5" that had no slot.
  it("covers every day of a month with real ISO weeks", () => {
    const weeks = DateRange.of("2026-08-01", "2026-08-31", "2026-10-20").buckets("week");
    expect(weeks.map((w) => [w.key, w.from, w.to])).toEqual([
      ["2026-W31", "2026-08-01", "2026-08-02"],
      ["2026-W32", "2026-08-03", "2026-08-09"],
      ["2026-W33", "2026-08-10", "2026-08-16"],
      ["2026-W34", "2026-08-17", "2026-08-23"],
      ["2026-W35", "2026-08-24", "2026-08-30"],
      ["2026-W36", "2026-08-31", "2026-08-31"],
    ]);
    const covered = weeks.reduce((days, w) => days + DateRange.of(w.from, w.to, w.to).days, 0);
    expect(covered).toBe(31);
  });

  it("buckets months with their real lengths, leap years included", () => {
    expect(
      DateRange.of("2028-01-15", "2028-03-10", "2028-03-10")
        .buckets("month")
        .map((b) => [b.key, b.from, b.to]),
    ).toEqual([
      ["2028-01", "2028-01-15", "2028-01-31"],
      ["2028-02", "2028-02-01", "2028-02-29"],
      ["2028-03", "2028-03-01", "2028-03-10"],
    ]);
  });

  it("chooses days, weeks or months by length", () => {
    expect(DateRange.of("2026-10-01", "2026-10-31", "x").defaultGranularity()).toBe("day");
    expect(DateRange.of("2026-08-01", "2026-10-31", "x").defaultGranularity()).toBe("week");
    expect(DateRange.of("2026-01-01", "2026-10-31", "x").defaultGranularity()).toBe("month");
  });
});

describe("ISO weeks", () => {
  it("belong to the year of their Thursday", () => {
    expect(isoWeek("2027-01-01")).toEqual({ year: 2026, week: 53, monday: "2026-12-28" });
    expect(isoWeek("2025-12-29")).toEqual({ year: 2026, week: 1, monday: "2025-12-29" });
    expect(bucketKey("2026-10-19", "week")).toBe("2026-W43");
    expect(bucketKey("2026-10-25", "week")).toBe("2026-W43"); // Sunday
  });
});

describe("series", () => {
  it("sums rows into every bucket and ignores rows outside the range", () => {
    const range = DateRange.of("2026-10-01", "2026-10-03", "2026-10-03");
    expect(
      series(
        range,
        "day",
        [
          { date: "2026-10-01", amount: 5 },
          { date: "2026-10-01", amount: 7 },
          { date: "2026-10-03", amount: 1 },
          { date: "2026-10-04", amount: 100 },
        ],
        ["amount"],
      ).map((p) => [p.key, p.amount]),
    ).toEqual([
      ["2026-10-01", 12],
      ["2026-10-02", 0],
      ["2026-10-03", 1],
    ]);
  });
});
