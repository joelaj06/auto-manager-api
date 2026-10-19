import type { PaymentMethod } from "../../domain/finance/Payment.js";
import type { RemittanceProps, RemittanceStatus } from "../../domain/remittances/Remittance.js";

export type RemittanceSubmission = Readonly<{
  id: string;
  remittanceId: string;
  declaredMinor: number;
  method: PaymentMethod;
  momoNetwork: "mtn" | "telecel" | "at" | null;
  reference: string | null;
  /** Ride-hailing breakdown as reported (uber, bolt, yango, trips …). */
  earnings: Readonly<Record<string, number>> | null;
  notes: string | null;
  status: "submitted" | "approved" | "rejected";
  submittedBy: string | null;
  submittedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  rejectReason: string | null;
  paymentId: string | null;
}>;

export type RemittancePayment = Readonly<{
  id: string;
  remittanceId: string;
  paymentId: string;
  amountMinor: number;
  settledMinor: number;
  releasedAt: Date | null;
  createdAt: Date;
}>;

export type RemittanceListFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId?: string;
  driverId?: string;
  vehicleId?: string;
  statuses?: readonly RemittanceStatus[];
  from?: string;
  to?: string;
  limit: number;
  after?: Readonly<{ periodStart: string; id: string }>;
}>;

/** A fixed-target assignment the expected-row job works through. */
export type TargetAssignment = Readonly<{
  id: string;
  driverId: string;
  vehicleId: string;
  branchId: string;
  startedAt: Date;
  endedAt: Date | null;
  targetMinor: number;
  frequency: "daily" | "weekly" | "monthly";
  daysOff: readonly number[];
  /** The latest period already generated, if any. */
  lastPeriodStart: string | null;
}>;

export interface IRemittanceRecords {
  list(filter: RemittanceListFilter): Promise<RemittanceProps[]>;
  submissions(remittanceId: string): Promise<RemittanceSubmission[]>;
  lockOpenSubmission(remittanceId: string): Promise<RemittanceSubmission | null>;
  saveSubmission(submission: RemittanceSubmission): Promise<void>;
  payments(remittanceId: string): Promise<RemittancePayment[]>;
  paymentFor(paymentId: string): Promise<RemittancePayment | null>;
  savePayment(payment: RemittancePayment): Promise<void>;
  /** Fixed-target assignments open, or ended within the last 60 days. */
  targetAssignments(): Promise<TargetAssignment[]>;
  /** Rows whose status may still change (not paid or waived), locked. */
  lockUnsettled(): Promise<string[]>;
  /** Fixed-target rows of a driver with something still owed. */
  outstanding(driverId: string): Promise<RemittanceProps[]>;
}

export type FleetCounts = Readonly<Record<string, number>>;

export type ShortfallDriver = Readonly<{
  driverId: string;
  name: string;
  code: string;
  periods: number;
  outstandingMinor: number;
}>;

/** The figures of the daily operations board (docs/09 §5). */
export interface IOperationsQueries {
  /** Vehicles in the fleet by status. */
  fleetCounts(branchIds: "all" | readonly string[], branchId: string | null): Promise<FleetCounts>;
  /** Fixed-target remittances due on a day (period ending that day). */
  remittancesDue(
    date: string,
    branchIds: "all" | readonly string[],
    branchId: string | null,
  ): Promise<
    Readonly<{
      count: number;
      expectedMinor: number;
      receivedMinor: number;
      byStatus: Readonly<Record<string, number>>;
    }>
  >;
  /** Drivers with at least `minPeriods` short periods ending since `since`. */
  shortfallDrivers(
    since: string,
    minPeriods: number,
    branchIds: "all" | readonly string[],
    branchId: string | null,
  ): Promise<ShortfallDriver[]>;
}

export type RemittanceSettings = Readonly<{
  /** Days after a period ends before its target is overdue. */
  graceDays: number;
  /** Short periods in the last 14 days that put a driver on the board. */
  shortfallAlertPeriods: number;
}>;

export const DEFAULT_REMITTANCE_SETTINGS: RemittanceSettings = Object.freeze({
  graceDays: 1,
  shortfallAlertPeriods: 3,
});

export interface IRemittanceSettingsStore {
  get(): Promise<RemittanceSettings>;
  set(settings: RemittanceSettings): Promise<void>;
}
