import { describe, expect, it } from "vitest";
import { previousMonthEnd } from "./VehicleDepreciation.js";

describe("previousMonthEnd", () => {
  it("is the last day of the month before", () => {
    expect(previousMonthEnd("2026-10-29")).toBe("2026-09-30");
    expect(previousMonthEnd("2026-03-01")).toBe("2026-02-28");
    expect(previousMonthEnd("2026-01-15")).toBe("2025-12-31");
  });
});
