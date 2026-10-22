import type { AgreementStatus, WorkPayAgreement } from "../../domain/workpay/WorkPayAgreement.js";
import type {
  InstalmentState,
  PenaltyRule,
  PenaltyState,
} from "../../domain/workpay/WorkPayCollections.js";
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
  /** Agreements that are running (active, in arrears, defaulted), for the daily job. */
  running(): Promise<string[]>;
}

export type InstalmentRecord = InstalmentState & Readonly<{ agreementId: string }>;

export type AllocationRecord = Readonly<{
  id: string;
  agreementId: string;
  paymentId: string;
  instalmentId: string | null;
  penaltyId: string | null;
  amountMinor: number;
  releasedAt: Date | null;
  createdAt: Date;
}>;

/** The schedule, penalties, allocations and waivers of agreements (tenant unit of work). */
export interface IWorkPaySchedule {
  create(agreementId: string, instalments: readonly Instalment[]): Promise<void>;
  list(agreementId: string, lock?: boolean): Promise<InstalmentRecord[]>;
  saveInstalment(instalment: InstalmentState): Promise<void>;
  penalties(agreementId: string, lock?: boolean): Promise<PenaltyState[]>;
  /** Null when this instalment was already charged on that day. */
  addPenalty(
    penalty: Readonly<{
      agreementId: string;
      instalmentId: string;
      chargedOn: string;
      amountMinor: number;
    }>,
  ): Promise<string | null>;
  savePenalty(penalty: PenaltyState): Promise<void>;
  addAllocation(
    allocation: Omit<AllocationRecord, "id" | "releasedAt" | "createdAt">,
  ): Promise<void>;
  /** The payment's allocations still in force (locked). */
  openAllocations(paymentId: string): Promise<AllocationRecord[]>;
  releaseAllocation(id: string, now: Date): Promise<void>;
  /** Every allocation of an agreement, newest first. */
  allocations(agreementId: string): Promise<AllocationRecord[]>;
  addWaiver(
    waiver: Readonly<{
      agreementId: string;
      instalmentId: string | null;
      penaltyId: string | null;
      amountMinor: number;
      reason: string;
      waivedBy: string;
    }>,
  ): Promise<string>;
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
  /** The late-payment rule new agreements get. */
  defaultPenalty: PenaltyRule;
  /** Defaulted at this many overdue instalments … */
  defaultAfterOverdue: number;
  /** … or this many days in arrears. */
  defaultAfterDays: number;
}>;

export const DEFAULT_WORKPAY_SETTINGS = Object.freeze<WorkPaySettings>({
  defaultFrequency: "weekly",
  defaultGraceDays: 3,
  roundToMinor: 100,
  firstDueAfterDays: 7,
  requireDeposit: true,
  defaultMaintenance: "driver",
  defaultInsurance: "owner",
  defaultPenalty: { kind: "none" },
  defaultAfterOverdue: 4,
  defaultAfterDays: 30,
});

export interface IWorkPaySettingsStore {
  get(): Promise<WorkPaySettings>;
  set(settings: WorkPaySettings): Promise<void>;
}
