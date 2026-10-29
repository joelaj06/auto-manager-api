import type { DealStatus } from "../../domain/dealer/Deal.js";
import type { Financing } from "../../domain/dealer/Quote.js";
import type { StockStatus } from "../../domain/dealer/StockUnit.js";

/** The branches reported on: those the actor reaches, narrowed to one when asked. */
export type DealerReportFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId: string | null;
}>;

/** A local-date period, both ends included. */
export type DatePeriod = Readonly<{ from: string; to: string }>;

/** Instants of the local period: from its first moment, to the moment after its last day. */
export type InstantPeriod = Readonly<{ from: Date; to: Date }>;

/** A cut in a vehicle's asking price. */
export type PriceReductionRow = Readonly<{
  changeId: string;
  vehicleId: string;
  vehicleCode: string;
  plateNumber: string | null;
  make: string;
  model: string;
  year: number | null;
  branchId: string;
  stockStatus: StockStatus;
  stockedOn: string;
  previousAskingMinor: number;
  askingMinor: number;
  reason: string | null;
  changedBy: string | null;
  changedByName: string | null;
  changedAt: Date;
}>;

/** Money received on deals (base currency) by branch and method. */
export type CollectedRow = Readonly<{
  branchId: string;
  /** A payment method, or `trade_in` for a vehicle taken in part exchange. */
  method: string;
  payments: number;
  amountMinor: number;
}>;

/** A sold deal still owed on its invoices. */
export type DealBalanceRow = Readonly<{
  dealId: string;
  number: string;
  status: DealStatus;
  financing: Financing;
  branchId: string;
  customerId: string;
  customerName: string;
  salesExecutiveId: string;
  soldOn: string;
  invoicedMinor: number;
  paidMinor: number;
}>;

/** Payments held on a deal not yet sold (deposits). */
export type DealDepositRow = Readonly<{
  dealId: string;
  number: string;
  status: DealStatus;
  branchId: string;
  customerName: string;
  heldMinor: number;
  holdUntil: string | null;
}>;

export type SalesSummary = Readonly<{
  sold: number;
  /** The sale invoices before tax. */
  revenueMinor: number;
  delivered: number;
  /** Days from stocking to sale, summed over the units sold. */
  daysToSell: number;
}>;

export type StockOnHand = Readonly<{
  count: number;
  askingMinor: number;
  /** In stock for more than 90 days. */
  agedOver90: number;
}>;

export type LeadSummary = Readonly<{ created: number; won: number; lost: number }>;

/** Read-only queries behind the dealer reports (docs/10 §10, docs/14). */
export interface IDealerReporting {
  priceReductions(period: InstantPeriod, filter: DealerReportFilter): Promise<PriceReductionRow[]>;
  collected(period: DatePeriod, filter: DealerReportFilter): Promise<CollectedRow[]>;
  /** Sold or delivered deals whose invoices are not paid in full, oldest sale first. */
  balances(filter: DealerReportFilter): Promise<DealBalanceRow[]>;
  /** Draft or reserved deals holding payments, oldest first. */
  deposits(filter: DealerReportFilter): Promise<DealDepositRow[]>;
  sales(period: DatePeriod, filter: DealerReportFilter): Promise<SalesSummary>;
  stockOnHand(today: string, filter: DealerReportFilter): Promise<StockOnHand>;
  leads(period: InstantPeriod, filter: DealerReportFilter): Promise<LeadSummary>;
}
