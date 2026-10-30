import { describe, expect, it } from "vitest";
import { depreciationBetween } from "../vehicles/Vehicle.js";
import { collectionRate, dayClass, vehicleProfit } from "./VehicleProfit.js";

describe("vehicle profit", () => {
  it("takes costs and depreciation from income and works out per-km, fuel and utilisation", () => {
    expect(
      vehicleProfit(
        {
          remittanceIncomeMinor: 750_000,
          rentalIncomeMinor: 0,
          workpayIncomeMinor: 0,
          salesIncomeMinor: 0,
          otherIncomeMinor: 50_000,
          costMinor: 200_000,
          financeCostMinor: 0,
          distance: 3_000,
          fuelLitres: 250,
          fuelCostMinor: 150_000,
          days: { working: 26, idle: 2, off_road: 2, other: 1 },
        },
        100_000,
      ),
    ).toEqual({
      incomeMinor: 800_000,
      costMinor: 200_000,
      depreciationMinor: 100_000,
      financeCostMinor: 0,
      profitMinor: 500_000,
      roiPercent: null,
      paybackMonths: null,
      costPerDistanceMinor: 100,
      distancePerLitre: 12,
      utilisationPercent: 86.7,
    });
  });

  it("has no ratios without distance, fuel or fleet days", () => {
    const figures = vehicleProfit(
      {
        remittanceIncomeMinor: 0,
        rentalIncomeMinor: 0,
        workpayIncomeMinor: 0,
        salesIncomeMinor: 0,
        otherIncomeMinor: 0,
        costMinor: 0,
        financeCostMinor: 0,
        distance: 0,
        fuelLitres: 0,
        fuelCostMinor: 0,
        days: { working: 0, idle: 0, off_road: 0, other: 5 },
      },
      0,
    );
    expect([
      figures.costPerDistanceMinor,
      figures.distancePerLitre,
      figures.utilisationPercent,
    ]).toEqual([null, null, null]);
  });

  it("takes finance costs off and works out the annual return and the payback months", () => {
    const totals = {
      remittanceIncomeMinor: 300_000,
      rentalIncomeMinor: 100_000,
      workpayIncomeMinor: 50_000,
      salesIncomeMinor: 0,
      otherIncomeMinor: 0,
      costMinor: 120_000,
      financeCostMinor: 30_000,
      distance: 0,
      fuelLitres: 0,
      fuelCostMinor: 0,
      days: { working: 30, idle: 0, off_road: 0, other: 0 },
    };
    // 450,000 in, 120,000 + 50,000 + 30,000 out: 250,000 profit in 30 days on a 6,000,000 vehicle.
    expect(vehicleProfit(totals, 50_000, { costMinor: 6_000_000, days: 30 })).toMatchObject({
      incomeMinor: 450_000,
      financeCostMinor: 30_000,
      profitMinor: 250_000,
      roiPercent: 50.7,
      paybackMonths: 23.7,
    });
    // A loss never pays back; an unknown cost has no return.
    expect(
      vehicleProfit({ ...totals, costMinor: 1_000_000 }, 0, { costMinor: 6_000_000, days: 30 }),
    ).toMatchObject({ roiPercent: -117.6, paybackMonths: null });
    expect(vehicleProfit(totals, 0, { costMinor: null, days: 30 }).roiPercent).toBeNull();
  });

  it("classes days by the status at the end of the day", () => {
    expect(
      ["assigned", "available", "in_maintenance", "for_sale"].map((s) => dayClass(s as never)),
    ).toEqual(["working", "idle", "off_road", "other"]);
  });

  it("charges the depreciation of whole months within the period", () => {
    const asset = {
      acquisitionCostMinor: 12_000_000,
      residualValueMinor: 0,
      depreciationMethod: "straight_line" as const,
      acquisitionDate: "2026-01-15",
      usefulLifeMonths: 60,
    };
    // 200_000 a month; the month completing on 2026-10-15 falls in October.
    expect(depreciationBetween(asset, "2026-10-01", "2026-10-31")).toBe(200_000);
    expect(depreciationBetween(asset, "2026-10-01", "2026-10-14")).toBe(0);
    expect(
      depreciationBetween({ ...asset, depreciationMethod: "none" }, "2026-01-01", "2026-12-31"),
    ).toBe(0);
  });

  it("rates collection as received over expected", () => {
    expect([collectionRate(20_000, 25_000), collectionRate(5, 0)]).toEqual([80, null]);
  });
});
