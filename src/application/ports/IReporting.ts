import type { DayClass } from "../../domain/reporting/VehicleProfit.js";
import type { VehicleStatus } from "../../domain/vehicles/VehicleStatus.js";
import type { DepreciableAsset } from "../../domain/vehicles/Vehicle.js";

/** Which branches a figure may come from: the caller's scope and an optional single branch. */
export type BranchFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId: string | null;
}>;

export type StatsState = Readonly<{
  builtThrough: string | null;
  /** Earliest stale day marked since the last build, and the last mark seen. */
  dirtyFrom: string | null;
  lastMarkId: number | null;
}>;

/** The daily vehicle stats read model (tenant unit of work). */
export interface IVehicleStatsStore {
  /** Serialises builders within the transaction. */
  lock(): Promise<void>;
  state(): Promise<StatsState>;
  /** First day anything happened to a vehicle (null: no vehicles yet). */
  earliestActivity(timezone: string): Promise<string | null>;
  /** Replaces the rows of `from`–`to`; returns how many were written. */
  rebuild(from: string, to: string, timezone: string): Promise<number>;
  built(through: string, lastMarkId: number | null): Promise<void>;
}

export type VehicleStatsRow = Readonly<{
  vehicleId: string;
  code: string;
  plateNumber: string | null;
  make: string;
  model: string;
  branchId: string;
  mileageUnit: "km" | "mi";
  asset: DepreciableAsset;
  remittanceIncomeMinor: number;
  rentalIncomeMinor: number;
  workpayIncomeMinor: number;
  salesIncomeMinor: number;
  otherIncomeMinor: number;
  costMinor: number;
  financeCostMinor: number;
  distance: number;
  fuelLitres: number;
  fuelCostMinor: number;
  days: Readonly<Record<DayClass, number>>;
}>;

export type VehicleStatsDay = Readonly<{
  date: string;
  status: VehicleStatus;
  driverId: string | null;
  remittanceIncomeMinor: number;
  rentalIncomeMinor: number;
  workpayIncomeMinor: number;
  salesIncomeMinor: number;
  otherIncomeMinor: number;
  costMinor: number;
  financeCostMinor: number;
  distance: number;
  fuelLitres: number;
}>;

export type IncomeSource = "remittances" | "rentals" | "workpay" | "sales" | "other";

export type LedgerDay = Readonly<{
  date: string;
  source: IncomeSource | null;
  incomeMinor: number;
  costMinor: number;
}>;

export type AccountTotal = Readonly<{
  accountId: string;
  code: string;
  name: string;
  amountMinor: number;
}>;

export type CashDay = Readonly<{ date: string; inMinor: number; outMinor: number }>;

export type RemittanceDay = Readonly<{
  date: string;
  status: string;
  mode: "fixed_target" | "variable";
  count: number;
  expectedMinor: number;
  receivedMinor: number;
  waivedMinor: number;
  outstandingMinor: number;
}>;

export type DriverShortfall = Readonly<{
  driverId: string;
  code: string;
  name: string;
  periods: number;
  expectedMinor: number;
  receivedMinor: number;
  outstandingMinor: number;
}>;

export type ExpenseDay = Readonly<{
  date: string;
  categoryId: string;
  categoryName: string;
  count: number;
  amountMinor: number;
  netMinor: number;
  taxMinor: number;
}>;

export type VehicleSpend = Readonly<{
  vehicleId: string;
  code: string;
  plateNumber: string | null;
  amountMinor: number;
}>;

/** Live aggregations over business dates (tenant unit of work). */
export interface IDashboardQueries {
  vehicleTotals(
    from: string,
    to: string,
    filter: BranchFilter & Readonly<{ vehicleId?: string; groupId?: string }>,
  ): Promise<VehicleStatsRow[]>;
  vehicleDays(vehicleId: string, from: string, to: string): Promise<VehicleStatsDay[]>;
  /** Income and expense account movements per entry date and income source. */
  ledgerDays(from: string, to: string, filter: BranchFilter): Promise<LedgerDay[]>;
  /** Expense accounts by amount over the range. */
  costsByAccount(from: string, to: string, filter: BranchFilter): Promise<AccountTotal[]>;
  /** Recorded (not reversed) payments in and out per payment date. */
  cashDays(from: string, to: string, filter: BranchFilter): Promise<CashDay[]>;
  /** Remittance periods by end date and status. */
  remittanceDays(from: string, to: string, filter: BranchFilter): Promise<RemittanceDay[]>;
  /** Drivers with an outstanding balance on periods ending in the range (largest first). */
  driverShortfalls(
    from: string,
    to: string,
    filter: BranchFilter,
    limit: number,
  ): Promise<DriverShortfall[]>;
  /** Approved and paid expenses per expense date and category. */
  expenseDays(from: string, to: string, filter: BranchFilter): Promise<ExpenseDay[]>;
  /** Approved and paid spending per vehicle (expense lines), largest first. */
  vehicleSpend(
    from: string,
    to: string,
    filter: BranchFilter,
    limit: number,
  ): Promise<VehicleSpend[]>;
  /** Expenses waiting for approval. */
  pendingExpenses(filter: BranchFilter): Promise<Readonly<{ count: number; amountMinor: number }>>;
}
