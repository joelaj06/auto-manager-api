import type { BranchFilter } from "./IReporting.js";

/** One agreement of the portfolio with its figures today. */
export type PortfolioRow = Readonly<{
  agreementId: string;
  number: string;
  status: string;
  branchId: string;
  driverId: string;
  driverName: string;
  phone: string;
  vehicleId: string;
  plateNumber: string | null;
  vehicleCode: string;
  /** What the instalments add up to now (rescheduled amounts counted once). */
  instalmentsMinor: number;
  paidMinor: number;
  waivedMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  penaltiesOutstandingMinor: number;
  chargesOutstandingMinor: number;
  arrearsSince: string | null;
  nextDueOn: string | null;
}>;

export type AgeingBucket = "1-7" | "8-30" | "31-60" | "61-90" | "over_90";

/** An instalment that is due on a day, with who pays it (for reminders). */
export type InstalmentNoticeRow = Readonly<{
  instalmentId: string;
  agreementId: string;
  number: string;
  instalmentNumber: number;
  dueOn: string;
  outstandingMinor: number;
  driverId: string;
  driverName: string;
  phone: string;
  branchId: string;
  plateNumber: string | null;
}>;

export type ArrearsNoticeRow = Readonly<{
  agreementId: string;
  number: string;
  status: string;
  arrearsSince: string;
  branchId: string;
  driverId: string;
  driverName: string;
  overdueMinor: number;
  guarantors: readonly Readonly<{ name: string; phone: string }>[];
}>;

export type AgreementPaymentRow = Readonly<{
  paymentId: string;
  number: string;
  kind: "deposit" | "instalments";
  paidOn: string;
  method: string;
  amountMinor: number;
  reversed: boolean;
}>;

/** The figures of the Work & Pay portfolio (tenant unit of work). */
export interface IWorkPayReporting {
  /** Agreements that run or ran to completion, in the branches. */
  portfolio(filter: BranchFilter, today: string): Promise<PortfolioRow[]>;
  /** What is overdue by how long it has been overdue. */
  ageing(filter: BranchFilter, today: string): Promise<Readonly<Record<AgeingBucket, number>>>;
  /** What running agreements still owe on instalments due in [from, to], by due date. */
  dueBetween(
    filter: BranchFilter,
    from: string,
    to: string,
  ): Promise<readonly Readonly<{ dueOn: string; outstandingMinor: number }>[]>;
  /** Instalments due in [from, to] and what was paid on them (collection rate). */
  collected(
    filter: BranchFilter,
    from: string,
    to: string,
  ): Promise<Readonly<{ dueMinor: number; paidMinor: number }>>;
  /** Unpaid instalments of running agreements due on these days. */
  instalmentsDueOn(dates: readonly string[]): Promise<InstalmentNoticeRow[]>;
  /** Overdue instalments of running agreements. */
  overdueInstalments(): Promise<InstalmentNoticeRow[]>;
  /** Running agreements in arrears, with their guarantors. */
  inArrears(): Promise<ArrearsNoticeRow[]>;
  /** The deposit and instalment payments of an agreement, oldest first. */
  payments(agreementId: string): Promise<AgreementPaymentRow[]>;
}
