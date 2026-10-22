/** One invariant of a tenant's books and what was found. */
export type IntegrityCheck = Readonly<{
  name: string;
  description: string;
  passed: boolean;
  /** Rows that break it (0 when it passed). */
  problems: number;
  /** The first few offenders, or the two figures that should agree. */
  detail: string | null;
}>;

/**
 * The invariants of a tenant's money (docs/26 §7): the ledger balances, allocations add up, and
 * the sub-ledgers (work and pay receivables and unearned income) agree with their ledger
 * accounts. Runs in a tenant unit of work, or against a restored database.
 */
export interface IIntegrityChecks {
  run(): Promise<IntegrityCheck[]>;
}
