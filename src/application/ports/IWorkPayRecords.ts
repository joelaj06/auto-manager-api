import type { AgreementStatus, WorkPayAgreement } from "../../domain/workpay/WorkPayAgreement.js";
import type { Instalment, WorkPayFrequency } from "../../domain/workpay/WorkPayTerms.js";

export type AgreementListFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId?: string;
  statuses?: readonly AgreementStatus[];
  driverId?: string;
  vehicleId?: string;
  limit: number;
  afterId?: string;
}>;

/** Work & Pay agreements (tenant unit of work). */
export interface IWorkPayAgreementRepository {
  findById(id: string): Promise<WorkPayAgreement | null>;
  lockById(id: string): Promise<WorkPayAgreement | null>;
  /** Saves the agreement and replaces its guarantors. */
  save(agreement: WorkPayAgreement): Promise<void>;
  list(filter: AgreementListFilter): Promise<WorkPayAgreement[]>;
  /** The live agreement (out for signature or running) of a vehicle or a driver, if any. */
  liveFor(
    party: Readonly<{ vehicleId?: string; driverId?: string }>,
  ): Promise<WorkPayAgreement | null>;
  /** The agreement whose document this is. */
  byDocument(documentId: string): Promise<WorkPayAgreement | null>;
}

export type InstalmentRecord = Instalment &
  Readonly<{
    id: string;
    agreementId: string;
    paidMinor: number;
    waivedMinor: number;
    status: "upcoming" | "due" | "partially_paid" | "paid" | "overdue" | "waived";
  }>;

/** The instalment schedule of active agreements (tenant unit of work). */
export interface IWorkPaySchedule {
  create(agreementId: string, instalments: readonly Instalment[]): Promise<void>;
  list(agreementId: string): Promise<InstalmentRecord[]>;
}

export type WorkPaySettings = Readonly<{
  defaultFrequency: WorkPayFrequency;
  defaultGraceDays: number;
  /** Instalments rounded down to a multiple of this (minor units); the last takes the rest. */
  roundToMinor: number;
  /** Days from today to the first instalment when none is given. */
  firstDueAfterDays: number;
  /** The agreement starts only once the deposit is paid in full. */
  requireDeposit: boolean;
  defaultMaintenance: "driver" | "owner" | "shared";
  defaultInsurance: "driver" | "owner" | "shared";
}>;

export const DEFAULT_WORKPAY_SETTINGS: WorkPaySettings = Object.freeze({
  defaultFrequency: "weekly",
  defaultGraceDays: 3,
  roundToMinor: 100,
  firstDueAfterDays: 7,
  requireDeposit: true,
  defaultMaintenance: "driver",
  defaultInsurance: "owner",
});

export interface IWorkPaySettingsStore {
  get(): Promise<WorkPaySettings>;
  set(settings: WorkPaySettings): Promise<void>;
}
