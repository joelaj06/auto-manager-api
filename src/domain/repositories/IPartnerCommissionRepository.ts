import type {
  CommissionTerms,
  CommissionTermsInput,
  CommissionType,
  PayoutMethod,
} from "../partners/Commissions.js";

/** A tenant's tie to its reseller, as commissions need it. */
export type CommissionAttribution = Readonly<{
  tenantId: string;
  partnerId: string;
  partnerStatus: string;
  termsId: string | null;
  overridePercent: string | null;
  overrideReason: string | null;
  /** The first licence purchase (the invoice that earns commission), once paid. */
  commissionInvoiceId: string | null;
}>;

export type EntryStatus = "accrued" | "payable" | "paid";

export type CommissionEntry = Readonly<{
  id: string;
  partnerId: string;
  tenantId: string | null;
  kind: "commission" | "clawback" | "adjustment";
  invoiceId: string | null;
  sourcePaymentId: string | null;
  sourceRefundId: string | null;
  commissionType: CommissionType | null;
  termsId: string | null;
  baseMinor: number | null;
  ratePercent: string | null;
  amountMinor: number;
  currency: string;
  status: EntryStatus;
  releaseAt: Date | null;
  reason: string | null;
  createdBy: string | null;
  payoutId: string | null;
  createdAt: Date;
}>;

export type PayoutStatus = "awaiting_approval" | "paid" | "reversed";

export type PayoutRecord = Readonly<{
  id: string;
  code: string;
  partnerId: string;
  totalMinor: number;
  currency: string;
  method: PayoutMethod;
  reference: string | null;
  details: Readonly<Record<string, string>>;
  proofFileIds: readonly string[];
  notes: string | null;
  status: PayoutStatus;
  paidAt: Date;
  recordedBy: string;
  recordedAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  reversedBy: string | null;
  reversedAt: Date | null;
  reversalReason: string | null;
}>;

/** One reseller's line in the "commissions payable now" queue and the liability report. */
export type PartnerBalance = Readonly<{
  partnerId: string;
  partnerName: string;
  currency: string;
  /** Payable now, not in a payout yet (clawbacks and adjustments netted). */
  payableMinor: number;
  /** Waiting for its hold period. */
  accruedMinor: number;
  /** In a cash payout waiting for its second approver. */
  awaitingApprovalMinor: number;
  minPayoutMinor: number;
}>;

export type EntryFilter = Readonly<{
  partnerId?: string;
  tenantId?: string;
  status?: EntryStatus;
  type?: CommissionType;
  from?: Date;
  to?: Date;
  limit: number;
}>;

/** Reseller commission terms, ledger and payouts (platform database, platform unit of work). */
export interface IPartnerCommissionRepository {
  latestTerms(partnerId: string): Promise<CommissionTerms | null>;
  termsById(id: string): Promise<CommissionTerms | null>;
  termsHistory(partnerId: string): Promise<CommissionTerms[]>;
  addTerms(
    partnerId: string,
    terms: CommissionTermsInput,
    reason: string,
    staffId: string,
  ): Promise<CommissionTerms>;
  /** Binds the partner's tenants to `termsId` (apply new terms to existing tenants). */
  rebindTenants(partnerId: string, termsId: string): Promise<number>;

  attribution(tenantId: string, lock?: boolean): Promise<CommissionAttribution | null>;
  bindTerms(tenantId: string, termsId: string): Promise<void>;
  setOverride(tenantId: string, percent: string | null, reason: string | null): Promise<boolean>;
  setCommissionInvoice(tenantId: string, invoiceId: string | null): Promise<void>;

  addEntry(entry: Omit<CommissionEntry, "createdAt" | "payoutId">): Promise<void>;
  /** The commission a payment earned, with what refunds took back of it. */
  forPayment(paymentId: string): Promise<CommissionEntry[]>;
  /** Net commission already earned from a tenant (for the cap). */
  tenantTotal(tenantId: string): Promise<number>;
  entries(filter: EntryFilter): Promise<CommissionEntry[]>;
  /** Accrued entries whose hold ended become payable; returns how many. */
  releaseDue(now: Date): Promise<number>;
  /** Payable entries of a partner not in a payout (locked). */
  openPayable(partnerId: string): Promise<CommissionEntry[]>;
  balances(partnerId?: string): Promise<PartnerBalance[]>;
  /** What was owed to the partner at `at`: entries before it less payouts paid before it. */
  balanceAt(partnerId: string, at: Date): Promise<number>;

  nextPayoutCode(year: number): Promise<string>;
  insertPayout(payout: PayoutRecord, entryIds: readonly string[]): Promise<void>;
  payout(id: string, lock?: boolean): Promise<PayoutRecord | null>;
  savePayout(payout: PayoutRecord): Promise<void>;
  payouts(
    filter: Readonly<{
      partnerId?: string;
      status?: PayoutStatus;
      unacknowledged?: boolean;
      limit: number;
    }>,
  ): Promise<PayoutRecord[]>;
  payoutEntries(payoutId: string): Promise<CommissionEntry[]>;
  /** Paid out: the payout's entries are paid. */
  markEntriesPaid(payoutId: string): Promise<void>;
  /** A reversed payout gives its entries back (payable again). */
  releaseEntries(payoutId: string): Promise<void>;
}
