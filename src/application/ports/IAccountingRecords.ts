import type {
  ExportDetail,
  ExportFormat,
  ExportLine,
  ExportTarget,
} from "../../domain/finance/AccountingExport.js";
import type { MatchCandidate } from "../../domain/finance/StatementMatcher.js";

export type AccountMapping = Readonly<{
  accountId: string;
  code: string;
  name: string;
  external: string | null;
}>;

export type AccountingExportRecord = Readonly<{
  id: string;
  format: ExportFormat;
  detail: ExportDetail;
  from: string;
  to: string;
  entries: number;
  lines: number;
  totalDebitMinor: number;
  exportedBy: string | null;
  exportedAt: Date;
  /** Entries dated in the period and posted after this export. */
  postedSince: number;
}>;

export interface IAccountingExports {
  /** The lines of entries dated in the period, in date and journal order; `limit` at most. */
  lines(from: string, to: string, limit: number): Promise<ExportLine[]>;
  mappings(target: ExportTarget): Promise<AccountMapping[]>;
  saveMappings(
    target: ExportTarget,
    mappings: readonly Readonly<{ accountId: string; external: string | null }>[],
    by: string,
    at: Date,
  ): Promise<void>;
  /** Earlier exports in this format overlapping the period. */
  overlaps(format: ExportFormat, from: string, to: string): Promise<number>;
  record(
    entry: Omit<AccountingExportRecord, "postedSince" | "exportedBy"> & { exportedBy: string },
  ): Promise<void>;
  history(limit: number): Promise<AccountingExportRecord[]>;
}

export type StatementLineStatus = "unmatched" | "matched" | "ignored";
export const STATEMENT_LINE_STATUSES = ["unmatched", "matched", "ignored"] as const;
export type MatchKind = "auto" | "manual" | "posted";

export type StatementImport = Readonly<{
  id: string;
  accountId: string;
  fileName: string;
  from: string;
  to: string;
  lines: number;
  duplicates: number;
  autoMatched: number;
  status: "active" | "voided";
  importedBy: string | null;
  importedAt: Date;
}>;

export type StatementLineRecord = Readonly<{
  id: string;
  importId: string;
  accountId: string;
  lineNo: number;
  date: string;
  description: string;
  reference: string | null;
  amountMinor: number;
  balanceMinor: number | null;
  status: StatementLineStatus;
  matchKind: MatchKind | null;
  journalEntryId: string | null;
  note: string | null;
  matchedBy: string | null;
  matchedAt: Date | null;
}>;

export type NewStatementLine = Pick<
  StatementLineRecord,
  | "id"
  | "importId"
  | "accountId"
  | "lineNo"
  | "date"
  | "description"
  | "reference"
  | "amountMinor"
  | "balanceMinor"
> &
  Readonly<{ fingerprint: string }>;

export type LedgerCandidate = MatchCandidate &
  Readonly<{
    entryId: string;
    entryNumber: string;
    description: string;
    sourceType: string;
    memo: string | null;
  }>;

export type StatementLineFilter = Readonly<{
  accountId: string;
  status: StatementLineStatus;
  from?: string;
  to?: string;
  limit: number;
  after?: Readonly<{ date: string; id: string }>;
}>;

export type ReconciliationFigures = Readonly<{
  /** The last balance a statement printed up to the date. */
  statementBalanceMinor: number | null;
  firstStatementDate: string | null;
  unmatchedStatementInMinor: number;
  unmatchedStatementOutMinor: number;
  unmatchedStatementLines: number;
  ignoredMinor: number;
  ignoredLines: number;
  unmatchedLedgerInMinor: number;
  unmatchedLedgerOutMinor: number;
  unmatchedLedgerLines: number;
  /** Lines matched to an entry reversed since: the statement says the money moved. */
  matchedThenReversed: number;
}>;

export interface IReconciliation {
  /** Serialises changes to one account's reconciliation until the transaction ends. */
  lockAccount(accountId: string): Promise<void>;
  /** Which of these fingerprints the account already has. */
  knownFingerprints(accountId: string, fingerprints: readonly string[]): Promise<Set<string>>;
  addImport(
    entry: Omit<StatementImport, "status" | "importedBy"> & { importedBy: string },
  ): Promise<void>;
  addLines(lines: readonly NewStatementLine[]): Promise<void>;
  setAutoMatched(importId: string, count: number): Promise<void>;
  imports(accountId: string | null, limit: number): Promise<StatementImport[]>;
  importById(id: string): Promise<StatementImport | null>;
  countPostedLines(importId: string): Promise<number>;
  /** Removes the file's lines and their matches, so that it can be imported again. */
  voidImport(id: string, by: string, at: Date): Promise<void>;
  line(id: string, lock?: boolean): Promise<StatementLineRecord | null>;
  lines(filter: StatementLineFilter): Promise<StatementLineRecord[]>;
  /** Unmatched statement lines of the account, oldest first. */
  unmatched(accountId: string): Promise<StatementLineRecord[]>;
  /** Unmatched ledger lines of the account between the dates. */
  candidates(accountId: string, from: string, to: string): Promise<LedgerCandidate[]>;
  /** The account's unmatched ledger lines from among these. */
  candidatesByIds(accountId: string, ids: readonly string[]): Promise<LedgerCandidate[]>;
  /** The account's line of an entry just posted. */
  ledgerLineOf(entryId: string, accountId: string): Promise<string>;
  match(
    lineId: string,
    ledgerLineIds: readonly string[],
    kind: MatchKind,
    journalEntryId: string | null,
    by: string | null,
    at: Date,
  ): Promise<void>;
  /** Back to unmatched, its matches and note gone. */
  release(lineId: string): Promise<void>;
  ignore(lineId: string, note: string, by: string, at: Date): Promise<void>;
  figures(accountId: string, asOf: string): Promise<ReconciliationFigures>;
}
