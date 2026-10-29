import type {
  Commission,
  CommissionPlan,
  CommissionStatus,
} from "../../domain/dealer/Commission.js";

/** Commission payouts journal under this source. */
export const COMMISSION_SOURCE = "dealer_commission";
export const PAYOUT_SOURCE = "dealer_commission_payout";
/** The cost of a sold vehicle leaves the books under this source (the deal's id). */
export const COST_OF_SALE_SOURCE = "dealer_cost_of_sale";

export type CommissionFilter = Readonly<{
  /** Whose: one seller, or the sellers in these branches. */
  userId?: string;
  branchIds: "all" | readonly string[];
  period?: string;
  statuses?: readonly CommissionStatus[];
  dealId?: string;
}>;

/** A commission with what the statement shows about its sale. */
export type CommissionLine = Readonly<{
  commission: Commission;
  dealNumber: string;
  vehicle: string;
  deliveredOn: string | null;
  userName: string;
}>;

export type PayoutRecord = Readonly<{
  id: string;
  number: string;
  userId: string;
  branchId: string;
  period: string;
  amountMinor: number;
  method: "cash" | "momo" | "bank_transfer";
  paidOn: string;
  reference: string | null;
  journalId: string;
  paidBy: string | null;
  createdAt: Date;
}>;

export interface ICommissions {
  insertPlan(plan: CommissionPlan): Promise<void>;
  updatePlan(plan: CommissionPlan): Promise<void>;
  plan(id: string): Promise<CommissionPlan | null>;
  plans(activeOnly: boolean): Promise<CommissionPlan[]>;
  /** The seller's own active plan, else the active plan for everyone. */
  planFor(userId: string): Promise<CommissionPlan | null>;
  insert(commission: Commission): Promise<void>;
  update(commission: Commission): Promise<void>;
  lock(id: string): Promise<Commission | null>;
  list(filter: CommissionFilter): Promise<CommissionLine[]>;
  /** Vehicles the seller has earned on in the month (not clawed back). */
  unitsIn(userId: string, period: string): Promise<number>;
  /** Accrued commissions whose sale's invoices are paid in full. */
  paidUp(): Promise<string[]>;
  /** Payable commissions of a seller in a month, locked. */
  payable(userId: string, period: string): Promise<Commission[]>;
  insertPayout(payout: PayoutRecord): Promise<void>;
  payouts(
    filter: Readonly<{ userId?: string; branchIds: "all" | readonly string[]; period?: string }>,
  ): Promise<PayoutRecord[]>;
}

/** A vehicle depreciated in the books, with what was posted so far. */
export type DepreciatingVehicle = Readonly<{
  id: string;
  branchId: string;
  acquisitionCostMinor: number;
  residualValueMinor: number | null;
  acquisitionDate: string;
  usefulLifeMonths: number;
  postedMinor: number;
}>;

export interface IDepreciationLedger {
  /** Straight-line vehicles not sold or removed (or the one vehicle), with what was posted. */
  vehicles(vehicleId?: string): Promise<DepreciatingVehicle[]>;
  posted(vehicleId: string): Promise<number>;
  record(
    entry: Readonly<{ vehicleId: string; period: string; amountMinor: number; journalId: string }>,
  ): Promise<void>;
}
