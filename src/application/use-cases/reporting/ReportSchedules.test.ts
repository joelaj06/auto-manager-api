import { describe, expect, it } from "vitest";
import { nextRunAt } from "./ReportSchedules.js";

describe("next run of a schedule", () => {
  const daily = { frequency: "daily" as const, weekday: null, monthDay: null, hour: 7 };
  const monday = { frequency: "weekly" as const, weekday: 1, monthDay: null, hour: 7 };

  it("is the local hour of the next run day", () => {
    // 2026-10-30 is a Friday; Accra is UTC, Lagos UTC+1.
    expect(nextRunAt(daily, "Africa/Accra", new Date("2026-10-30T06:00:00Z"))).toEqual(
      new Date("2026-10-30T07:00:00Z"),
    );
    expect(nextRunAt(daily, "Africa/Accra", new Date("2026-10-30T07:00:00Z"))).toEqual(
      new Date("2026-10-31T07:00:00Z"),
    );
    expect(nextRunAt(monday, "Africa/Lagos", new Date("2026-10-30T12:00:00Z"))).toEqual(
      new Date("2026-11-02T06:00:00Z"),
    );
    expect(nextRunAt(monday, "Africa/Accra", new Date("2026-11-02T07:30:00Z"))).toEqual(
      new Date("2026-11-09T07:00:00Z"),
    );
  });
});
