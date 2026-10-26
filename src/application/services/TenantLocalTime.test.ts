import { describe, expect, it } from "vitest";
import { localDateTime, localMidnight } from "./TenantLocalTime.js";

describe("local time", () => {
  it("finds the instant a local date starts", () => {
    expect(localMidnight("2026-11-02", "Africa/Accra")).toEqual(new Date("2026-11-02T00:00:00Z"));
    expect(localMidnight("2026-11-02", "Africa/Lagos")).toEqual(new Date("2026-11-01T23:00:00Z"));
    expect(localMidnight("2026-11-02", "America/New_York")).toEqual(
      new Date("2026-11-02T05:00:00Z"),
    );
    // The day New York leaves summer time starts on the summer offset.
    expect(localMidnight("2026-11-01", "America/New_York")).toEqual(
      new Date("2026-11-01T04:00:00Z"),
    );
    expect(
      localDateTime(localMidnight("2026-03-08", "America/New_York"), "America/New_York"),
    ).toEqual({ date: "2026-03-08", hour: 0, minute: 0 });
  });
});
