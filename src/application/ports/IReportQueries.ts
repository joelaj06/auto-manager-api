import type { BranchFilter } from "./IReporting.js";

/** Money in these rows is in minor units of the base currency unless a row says otherwise. */

export type FleetRegisterRow = Readonly<{
  vehicleId: string;
  code: string;
  plateNumber: string | null;
  make: string;
  model: string;
  year: number | null;
  status: string;
  usage: string;
  ownership: string;
  branchName: string;
  driverName: string | null;
  odometer: number | null;
  mileageUnit: "km" | "mi";
  /** The next document to expire, or the longest expired. */
  nextDocument: Readonly<{ type: string; expiresOn: string }> | null;
  documentsExpired: number;
}>;

export type FuelAnomalyCount = Readonly<{ vehicleId: string; anomalies: number }>;

export type IncidentRegisterRow = Readonly<{
  date: string;
  kind: "incident" | "offence" | "claim";
  reference: string | null;
  type: string;
  vehicle: string;
  driverName: string | null;
  branchName: string;
  status: string;
  amountMinor: number | null;
  detail: string | null;
}>;

export type DriverRemittanceRow = Readonly<{
  driverId: string;
  code: string;
  name: string;
  vehicles: number;
  periods: number;
  /** Fixed-target periods that ended short. */
  shortPeriods: number;
  expectedMinor: number;
  receivedMinor: number;
  waivedMinor: number;
  outstandingMinor: number;
  /** Paid on variable periods (no target). */
  variableReceivedMinor: number;
}>;

export type DriverPerformanceRow = Readonly<{
  driverId: string;
  code: string;
  name: string;
  status: string;
  workingDays: number;
  distance: number;
  expectedMinor: number;
  receivedMinor: number;
  waivedMinor: number;
  incidents: number;
  offences: number;
  finesMinor: number;
}>;

export type RentalBookingRow = Readonly<{
  number: string;
  status: string;
  branchName: string;
  customerName: string;
  customerType: string;
  className: string | null;
  vehicle: string | null;
  pickupAt: Date;
  returnAt: Date;
  /** Booking charges before tax, in the booking's currency. */
  chargesMinor: number;
  currency: string;
}>;

export type ExpenseApprovalRow = Readonly<{
  number: string | null;
  expenseDate: string;
  status: string;
  category: string;
  description: string;
  branchName: string;
  payeeName: string | null;
  amountBaseMinor: number;
  submittedBy: string | null;
  submittedAt: Date | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  rejectionReason: string | null;
}>;

export type CashDayRow = Readonly<{
  date: string;
  method: string;
  direction: "in" | "out";
  payments: number;
  amountMinor: number;
}>;

export type ExpectedInflows = Readonly<{
  invoicesMinor: number;
  workpayMinor: number;
}>;

export type OpenInvoiceRow = Readonly<{
  partyType: "customer" | "driver";
  partyId: string;
  partyName: string;
  dueDate: string;
  /** What is still owed, in the base currency. */
  outstandingMinor: number;
}>;

export type PaymentRegisterRow = Readonly<{
  paidOn: string;
  number: string;
  partyName: string;
  method: string;
  reference: string | null;
  branchName: string;
  currency: string;
  amountMinor: number;
  amountBaseMinor: number;
  status: string;
  recordedBy: string | null;
}>;

export type CashSessionRow = Readonly<{
  branchName: string;
  cashierName: string;
  openedAt: Date;
  closedAt: Date;
  openingMinor: number;
  cashInMinor: number;
  cashOutMinor: number;
  countedMinor: number;
  varianceMinor: number;
  notes: string | null;
}>;

export type TaxAccountRow = Readonly<{
  code: string;
  name: string;
  systemKey: string;
  debitMinor: number;
  creditMinor: number;
}>;

export type DayBookRow = Readonly<{
  date: string;
  entryNumber: string;
  description: string;
  sourceType: string;
  accountCode: string;
  accountName: string;
  branchName: string | null;
  debitMinor: number;
  creditMinor: number;
}>;

/**
 * Read queries behind the report catalogue (docs/14 §3) where no dashboard already holds the
 * figures; all in the tenant's unit of work, limited to the branches in the filter.
 */
export interface IReportQueries {
  branchNames(): Promise<Readonly<Record<string, string>>>;
  userNames(ids: readonly string[]): Promise<Readonly<Record<string, string>>>;
  fleetRegister(filter: BranchFilter, today: string): Promise<FleetRegisterRow[]>;
  fuelAnomalies(filter: BranchFilter, from: Date, until: Date): Promise<FuelAnomalyCount[]>;
  incidents(
    filter: BranchFilter,
    period: Readonly<{ from: string; to: string; fromAt: Date; untilAt: Date }>,
  ): Promise<IncidentRegisterRow[]>;
  remittancesByDriver(
    filter: BranchFilter,
    from: string,
    to: string,
  ): Promise<DriverRemittanceRow[]>;
  driverPerformance(
    filter: BranchFilter,
    period: Readonly<{ from: string; to: string; fromAt: Date; untilAt: Date }>,
  ): Promise<DriverPerformanceRow[]>;
  rentalBookings(filter: BranchFilter, from: Date, until: Date): Promise<RentalBookingRow[]>;
  expenseApprovals(filter: BranchFilter, from: string, to: string): Promise<ExpenseApprovalRow[]>;
  cashDays(filter: BranchFilter, from: string, to: string): Promise<CashDayRow[]>;
  expectedInflows(filter: BranchFilter, from: string, to: string): Promise<ExpectedInflows>;
  openInvoices(filter: BranchFilter, asOf: string): Promise<OpenInvoiceRow[]>;
  payments(
    filter: BranchFilter,
    query: Readonly<{ from: string; to: string; direction: "in" | "out" | null }>,
  ): Promise<PaymentRegisterRow[]>;
  cashSessions(filter: BranchFilter, from: Date, until: Date): Promise<CashSessionRow[]>;
  taxAccounts(filter: BranchFilter, from: string, to: string): Promise<TaxAccountRow[]>;
  dayBook(filter: BranchFilter, from: string, to: string, limit: number): Promise<DayBookRow[]>;
}
