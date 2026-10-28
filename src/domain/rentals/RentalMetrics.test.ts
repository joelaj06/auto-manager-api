import { describe, expect, it } from "vitest";
import {
  averageDailyRate,
  percent,
  revenuePerAvailableVehicleDay,
  utilisation,
} from "./RentalMetrics.js";

const DAY = 86_400;

describe("rental metrics", () => {
  it("rounds a percent to one decimal and has none without a whole", () => {
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(0, 0)).toBeNull();
  });

  it("measures utilisation against the hours not blocked for other work", () => {
    // Ten days: one vehicle rented five days, one rented two days with five in maintenance.
    const u = utilisation(
      [
        { rentedSeconds: 5 * DAY, unavailableSeconds: 0 },
        { rentedSeconds: 2 * DAY, unavailableSeconds: 5 * DAY },
      ],
      10 * DAY,
    );
    expect(u).toEqual({ vehicles: 2, rentedHours: 168, availableHours: 360, percent: 46.7 });
  });

  it("never counts more than the period for one vehicle", () => {
    const u = utilisation([{ rentedSeconds: 12 * DAY, unavailableSeconds: 15 * DAY }], 10 * DAY);
    expect(u).toMatchObject({ availableHours: 0, percent: null });
    expect(utilisation([], 10 * DAY).percent).toBeNull();
  });

  it("gives the average daily rate and revenue per available vehicle day", () => {
    expect(averageDailyRate(90_000, 3 * DAY)).toBe(30_000);
    expect(averageDailyRate(45_000, 1.5 * DAY)).toBe(30_000);
    expect(averageDailyRate(10_000, 0)).toBeNull();
    expect(revenuePerAvailableVehicleDay(100_000, 20 * DAY)).toBe(5_000);
    expect(revenuePerAvailableVehicleDay(1, 0)).toBeNull();
  });
});
