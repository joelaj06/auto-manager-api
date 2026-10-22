import type { AgreementStatus, WorkPayAgreement } from "../../domain/workpay/WorkPayAgreement.js";
import type {
  ChargeState,
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
  chargeId: string | null;
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
      quoteId?: string | null;
    }>,
  ): Promise<string>;
  /** Marks a settlement's discount waivers reversed and returns them. */
  reverseQuoteWaivers(
    quoteId: string,
    now: Date,
  ): Promise<readonly Readonly<{ instalmentId: string; amountMinor: number }>[]>;
  charges(agreementId: string, lock?: boolean): Promise<ChargeState[]>;
  addCharge(
    charge: Readonly<{
      agreementId: string;
      expenseId: string;
      description: string;
      chargedOn: string;
      amountMinor: number;
    }>,
  ): Promise<string>;
  /** The charge an expense became (locked). */
  chargeForExpense(expenseId: string): Promise<(ChargeState & { agreementId: string }) | null>;
  saveCharge(charge: ChargeState): Promise<void>;
}

export type RescheduleRecord = Readonly<{
  id: string;
  agreementId: string;
  kind: "holiday" | "restructure";
  reason: string;
  params: Readonly<Record<string, unknown>>;
  movedMinor: number;
  movedNumbers: readonly number[];
  createdNumbers: readonly number[];
  createdBy: string | null;
  createdAt: Date;
}>;

export type SettlementQuoteRecord = Readonly<{
  id: string;
  agreementId: string;
  quotedOn: string;
  validUntil: string;
  instalmentsMinor: number;
  penaltiesMinor: number;
  chargesMinor: number;
  discountPercent: string;
  discountMinor: number;
  payoffMinor: number;
  paymentId: string | null;
  usedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}>;

export type DowntimeRecord = Readonly<{
  id: string;
  agreementId: string;
  reason: string;
  ownerFault: boolean;
  startedOn: string;
  endedOn: string | null;
  startedBy: string | null;
  endedBy: string | null;
}>;

/** Holidays, restructures, settlement quotes and downtime of agreements (tenant unit of work). */
export interface IWorkPayLifecycleRecords {
  addReschedule(record: Omit<RescheduleRecord, "id" | "createdAt">): Promise<string>;
  reschedules(agreementId: string): Promise<RescheduleRecord[]>;
  addQuote(
    quote: Omit<SettlementQuoteRecord, "id" | "paymentId" | "usedAt" | "createdAt">,
  ): Promise<string>;
  quote(id: string, lock?: boolean): Promise<SettlementQuoteRecord | null>;
  quoteForPayment(paymentId: string): Promise<SettlementQuoteRecord | null>;
  /** Payment null: the settlement payment was reversed. */
  markQuoteUsed(id: string, paymentId: string | null, now: Date | null): Promise<void>;
  openDowntime(agreementId: string): Promise<DowntimeRecord | null>;
  addDowntime(record: Omit<DowntimeRecord, "id" | "endedOn" | "endedBy">): Promise<string>;
  endDowntime(id: string, endedOn: string, endedBy: string): Promise<void>;
  downtimes(agreementId: string): Promise<DowntimeRecord[]>;
}

export type HandedOverItem = Readonly<{ item: string; included: boolean }>;

export type DvlaStatus = "not_started" | "submitted" | "completed";

export type TransferRecord = Readonly<{
  id: string;
  agreementId: string;
  documentId: string;
  odometer: number;
  condition: string | null;
  handedOver: readonly HandedOverItem[];
  ownerSignerId: string;
  issuedBy: string | null;
  issuedAt: Date;
  transferredAt: Date | null;
  dvla: Readonly<{
    status: DvlaStatus;
    submittedOn: string | null;
    completedOn: string | null;
    reference: string | null;
    notes: string | null;
  }>;
}>;

/** Transfer letters and ownership transfers of completed agreements (tenant unit of work). */
export interface IWorkPayTransfers {
  forAgreement(agreementId: string, lock?: boolean): Promise<TransferRecord | null>;
  forDocument(documentId: string, lock?: boolean): Promise<TransferRecord | null>;
  /** Inserts or replaces the agreement's transfer (a corrected letter). */
  save(transfer: TransferRecord): Promise<void>;
  remove(agreementId: string): Promise<void>;
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
  /** An early settlement saves this share of the markup still in the instalments ("0"–"100"). */
  settlementDiscountPercent: string;
  /** Days a settlement quote holds. */
  quoteValidDays: number;
  /** Suggested refund on repossession: this share of the instalments paid. */
  repossessionRefundPercent: string;
  /**
   * Costs a work and pay driver bears: on their driver ledger, or added to the agreement and
   * paid with the instalments.
   */
  driverExpenses: "driver_ledger" | "agreement";
  /** What the transfer letter lists as handed over to the driver. */
  transferItems: readonly string[];
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
  settlementDiscountPercent: "0",
  quoteValidDays: 7,
  repossessionRefundPercent: "0",
  driverExpenses: "driver_ledger",
  transferItems: [
    "Vehicle registration documents",
    "Insurance certificate",
    "Roadworthy certificate",
    "Keys (all sets)",
  ],
});

export interface IWorkPaySettingsStore {
  get(): Promise<WorkPaySettings>;
  set(settings: WorkPaySettings): Promise<void>;
}
