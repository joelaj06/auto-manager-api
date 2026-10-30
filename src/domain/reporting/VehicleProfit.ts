import type { VehicleStatus } from "../vehicles/VehicleStatus.js";

/** How a day counts for utilisation, by the vehicle's status at the end of it. */
export type DayClass = "working" | "idle" | "off_road" | "other";

/** Statuses of a vehicle out earning (with a driver, a renter or on work and pay). */
export const WORKING_STATUSES: readonly VehicleStatus[] = ["assigned", "on_rent", "on_workpay"];
/** Ready to work but unused. */
export const IDLE_STATUSES: readonly VehicleStatus[] = ["available", "reserved_rental"];
/** Off the road: in the workshop, being prepared, after an accident, impounded. */
export const OFF_ROAD_STATUSES: readonly VehicleStatus[] = [
  "in_maintenance",
  "reconditioning",
  "accident",
  "impounded",
];

/** Out earning, ready but unused, off the road, or not part of the working fleet (stock, sold …). */
export function dayClass(status: VehicleStatus): DayClass {
  if (WORKING_STATUSES.includes(status)) return "working";
  if (IDLE_STATUSES.includes(status)) return "idle";
  if (OFF_ROAD_STATUSES.includes(status)) return "off_road";
  return "other";
}

/** A vehicle's figures over a period (sums of its daily stats), in base minor units. */
export type VehicleTotals = Readonly<{
  remittanceIncomeMinor: number;
  rentalIncomeMinor: number;
  workpayIncomeMinor: number;
  /** The vehicle's sale (and instalment charges on it). */
  salesIncomeMinor: number;
  otherIncomeMinor: number;
  /** Direct costs: every expense on the vehicle but depreciation and finance costs. */
  costMinor: number;
  /** Loan interest and finance charges. */
  financeCostMinor: number;
  distance: number;
  fuelLitres: number;
  fuelCostMinor: number;
  days: Readonly<Record<DayClass, number>>;
}>;

export type VehicleProfitFigures = Readonly<{
  incomeMinor: number;
  costMinor: number;
  depreciationMinor: number;
  financeCostMinor: number;
  profitMinor: number;
  /** Profit of the period over a year, against what the vehicle cost, in percent; null without a cost. */
  roiPercent: number | null;
  /** Months of profit at the period's rate to earn back what the vehicle cost; null without profit. */
  paybackMonths: number | null;
  /** Costs, depreciation and finance costs per km (or mile); null without distance. */
  costPerDistanceMinor: number | null;
  /** Distance per litre; null without fuel. */
  distancePerLitre: number | null;
  /** Working days over days in the working fleet (working, idle, off-road), 0–100. */
  utilisationPercent: number | null;
}>;

/** What the vehicle cost and the days of the period, for ROI and payback. */
export type Investment = Readonly<{ costMinor: number | null; days: number }>;

const DAYS_PER_MONTH = 365.25 / 12;

/**
 * The vehicle P&L (docs/14 §3): income by source (remittances, rentals, Work & Pay, its sale,
 * other) − direct costs − depreciation − finance costs = profit; cost per distance, fuel
 * efficiency, utilisation, return on investment (annualised) and payback months.
 */
export function vehicleProfit(
  totals: VehicleTotals,
  depreciationMinor: number,
  investment: Investment | null = null,
): VehicleProfitFigures {
  const incomeMinor =
    totals.remittanceIncomeMinor +
    totals.rentalIncomeMinor +
    totals.workpayIncomeMinor +
    totals.salesIncomeMinor +
    totals.otherIncomeMinor;
  const allCosts = totals.costMinor + depreciationMinor + totals.financeCostMinor;
  const profitMinor = incomeMinor - allCosts;
  const fleetDays = totals.days.working + totals.days.idle + totals.days.off_road;
  const cost = investment?.costMinor ?? null;
  const perDay = investment === null || investment.days <= 0 ? null : profitMinor / investment.days;
  return {
    incomeMinor,
    costMinor: totals.costMinor,
    depreciationMinor,
    financeCostMinor: totals.financeCostMinor,
    profitMinor,
    roiPercent:
      cost === null || cost <= 0 || perDay === null
        ? null
        : Math.round(((perDay * 365) / cost) * 1000) / 10,
    paybackMonths:
      cost === null || cost <= 0 || perDay === null || perDay <= 0
        ? null
        : Math.round((cost / (perDay * DAYS_PER_MONTH)) * 10) / 10,
    costPerDistanceMinor: totals.distance > 0 ? Math.round(allCosts / totals.distance) : null,
    distancePerLitre:
      totals.fuelLitres > 0 ? Math.round((totals.distance / totals.fuelLitres) * 100) / 100 : null,
    utilisationPercent:
      fleetDays > 0 ? Math.round((totals.days.working / fleetDays) * 1000) / 10 : null,
  };
}

/** Received over expected as a percentage (one decimal); null when nothing was expected. */
export function collectionRate(receivedMinor: number, expectedMinor: number): number | null {
  return expectedMinor > 0 ? Math.round((receivedMinor / expectedMinor) * 1000) / 10 : null;
}
