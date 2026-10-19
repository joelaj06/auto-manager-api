import type { CashSessionProps } from "../../domain/finance/CashSession.js";
import type { InvoiceProps, InvoiceStatus } from "../../domain/finance/Invoice.js";
import type {
  AccountType,
  JournalDraft,
  LedgerPartyType,
  SystemAccountKey,
} from "../../domain/finance/Journal.js";
import type { PaymentDirection, PaymentProps } from "../../domain/finance/Payment.js";

export type LedgerAccount = Readonly<{
  id: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: SystemAccountKey | null;
  active: boolean;
}>;

export type PostedEntry = JournalDraft &
  Readonly<{ id: string; number: string; createdBy: string | null; createdAt: Date }>;

export type AccountBalance = LedgerAccount &
  Readonly<{ debitMinor: number; creditMinor: number; balanceMinor: number }>;

export type LedgerLineView = Readonly<{
  id: string;
  entryId: string;
  number: string;
  date: string;
  description: string;
  sourceType: string;
  sourceId: string;
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  branchId: string | null;
  vehicleId: string | null;
  partyType: LedgerPartyType | null;
  partyId: string | null;
  memo: string | null;
  createdAt: Date;
}>;

export type LedgerLineFilter = Readonly<{
  accountId?: string;
  party?: Readonly<{ type: LedgerPartyType; id: string }>;
  vehicleId?: string;
  branchId?: string;
  from?: string;
  to?: string;
  limit: number;
  /** Keyset cursor: entry date, created-at and line id of the last line of the previous page. */
  after?: Readonly<{ date: string; createdAt: string; id: string }>;
}>;

/** The ledger (tenant unit of work): accounts, posting, balances, period lock. */
export interface ILedger {
  accounts(): Promise<LedgerAccount[]>;
  createAccount(account: Omit<LedgerAccount, "systemKey" | "active">): Promise<void>;
  accountCodeTaken(code: string): Promise<boolean>;
  post(entry: JournalDraft, number: string, createdBy: string | null): Promise<string>;
  /** Entries of a source not cancelled by a reversal (newest first). */
  openEntries(sourceType: string, sourceId: string): Promise<PostedEntry[]>;
  balances(asOf: string | null): Promise<AccountBalance[]>;
  lines(filter: LedgerLineFilter): Promise<LedgerLineView[]>;
  /** Σ(debit − credit) for a party on an account, in base minor units. */
  partyBalance(
    accountId: string,
    party: Readonly<{ type: LedgerPartyType; id: string }>,
  ): Promise<number>;
  booksLockedUntil(): Promise<string | null>;
  setBooksLockedUntil(date: string | null): Promise<void>;
  /** Fixes the base currency at the first financial transaction (docs/20 §3). */
  lockBaseCurrency(now: Date): Promise<void>;
}

export type InvoiceListFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId?: string;
  statuses?: readonly InvoiceStatus[];
  party?: Readonly<{ type: "customer" | "driver"; id: string }>;
  from?: string;
  to?: string;
  /** Issued and not fully paid with a due date before this day. */
  overdueOn?: string;
  limit: number;
  after?: Readonly<{ createdAt: string; id: string }>;
}>;

export type PaymentListFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId?: string;
  direction?: PaymentDirection;
  party?: Readonly<{ type: LedgerPartyType; id: string }>;
  cashSessionId?: string;
  from?: string;
  to?: string;
  /** Recorded money in with an unallocated remainder. */
  withCredit?: boolean;
  limit: number;
  after?: Readonly<{ recordedAt: string; id: string }>;
}>;

export type CashSessionListFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId?: string;
  cashierId?: string;
  status?: "open" | "closed";
  limit: number;
}>;

/** Reads over financial documents (tenant unit of work). */
export interface IFinanceQueries {
  invoices(filter: InvoiceListFilter): Promise<InvoiceProps[]>;
  payments(filter: PaymentListFilter): Promise<PaymentProps[]>;
  cashSessions(filter: CashSessionListFilter): Promise<CashSessionProps[]>;
}

/** Who a document is for: the party's display name and branch (drivers), if it exists. */
export interface IPartyDirectory {
  find(
    type: LedgerPartyType,
    id: string,
  ): Promise<Readonly<{ name: string; branchId: string | null }> | null>;
}

export type FinanceSettings = Readonly<{
  /** Cash in or out needs the cashier's open cash session. */
  requireCashSession: boolean;
  /** Days between issue and due date when none is given (0: due on receipt). */
  defaultDueDays: number;
}>;

export const DEFAULT_FINANCE_SETTINGS: FinanceSettings = Object.freeze({
  requireCashSession: true,
  defaultDueDays: 0,
});

export interface IFinanceSettingsStore {
  get(): Promise<FinanceSettings>;
  set(settings: FinanceSettings): Promise<void>;
}

/** A module that must react when a payment it caused is reversed (reopening an expense …). */
export interface IPaymentReversalListener {
  readonly sourceType: string;
  /** Called inside the reversal's unit of work. */
  paymentReversed(sourceId: string, paymentId: string): Promise<void>;
}
