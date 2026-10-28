import type {
  PriceChange,
  StockSource,
  StockStatus,
  StockUnit,
} from "../../domain/dealer/StockUnit.js";
import type { OwnershipType } from "../../domain/vehicles/Vehicle.js";
import type { VehicleStatus } from "../../domain/vehicles/VehicleStatus.js";

export type StockFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId?: string;
  statuses?: readonly StockStatus[];
  sources?: readonly StockSource[];
  make?: string;
  model?: string;
  yearFrom?: number;
  yearTo?: number;
  /** Asking price range (base currency, minor units). */
  priceFromMinor?: number;
  priceToMinor?: number;
  /** In stock since this day or earlier (days-in-stock filter). */
  stockedOnOrBefore?: string;
  consignorId?: string;
  limit: number;
  /** Oldest stock first: rows after this vehicle. */
  afterVehicleId?: string;
}>;

/** The vehicle behind a stock unit, as the stock list shows it. */
export type StockVehicle = Readonly<{
  code: string;
  plateNumber: string | null;
  vin: string | null;
  make: string;
  model: string;
  year: number | null;
  colour: string | null;
  odometer: number | null;
  status: VehicleStatus;
  ownershipType: OwnershipType;
  branchId: string;
  acquisitionCostMinor: number | null;
}>;

export type StockRecord = Readonly<{
  unit: StockUnit;
  vehicle: StockVehicle;
  consignorName: string | null;
}>;

/** What was spent on a vehicle since it entered stock (approved or paid expenses). */
export type StockSpend = Readonly<{ amountBaseMinor: number; netBaseMinor: number }>;

export type PriceChangeRecord = PriceChange &
  Readonly<{
    id: string;
    vehicleId: string;
    reason: string | null;
    changedBy: string | null;
    changedAt: Date;
  }>;

export type StockTransfer = Readonly<{
  id: string;
  vehicleId: string;
  fromBranchId: string;
  toBranchId: string;
  transferredOn: string;
  reason: string;
  transferredBy: string | null;
  createdAt: Date;
}>;

/** A unit on the lot since a given day: what the aged-stock alert looks at. */
export type AgedStock = Readonly<{
  vehicleId: string;
  branchId: string;
  code: string;
  plateNumber: string | null;
  make: string;
  model: string;
  stockedOn: string;
}>;

/** Dealer stock, its price history and transfers (tenant unit of work), docs/10 §2. */
export interface IDealerStock {
  insert(unit: StockUnit): Promise<void>;
  update(unit: StockUnit): Promise<void>;
  get(vehicleId: string): Promise<StockUnit | null>;
  lock(vehicleId: string): Promise<StockUnit | null>;
  record(vehicleId: string): Promise<StockRecord | null>;
  list(filter: StockFilter): Promise<StockRecord[]>;
  /** Expenses on the vehicles (their lines) dated on or after each one's stock date. */
  spend(vehicleIds: readonly string[]): Promise<Map<string, StockSpend>>;
  addPriceChange(change: PriceChangeRecord): Promise<void>;
  priceChanges(vehicleId: string): Promise<PriceChangeRecord[]>;
  addTransfer(transfer: StockTransfer): Promise<void>;
  transfers(vehicleId: string): Promise<StockTransfer[]>;
  /** Units still on the lot that entered stock on or before the day. */
  agedStock(stockedOnOrBefore: string): Promise<AgedStock[]>;
  consignorExists(customerId: string): Promise<boolean>;
}
