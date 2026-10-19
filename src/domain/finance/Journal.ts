import { DomainError } from "../errors/DomainError.js";

export class FinanceRuleError extends DomainError {
  readonly code = "FINANCE_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type LedgerPartyType = "customer" | "driver" | "supplier";

/** Accounts postings use by role (seeded per tenant, migration 0013). */
export type SystemAccountKey =
  | "cash"
  | "momo"
  | "bank"
  | "undeposited"
  | "receivables"
  | "driver_receivables"
  | "input_tax"
  | "payables"
  | "party_credit"
  | "other_income"
  | "other_expenses"
  | "vehicle_expenses"
  | "fx_difference"
  | "cash_over_short"
  | `tax_payable:${string}`;

/** The payable account of a tax component (VAT, NHIL, GETFund; anything else: other). */
export function taxPayableKey(componentKey: string): SystemAccountKey {
  return ["vat", "nhil", "getfund"].includes(componentKey)
    ? `tax_payable:${componentKey}`
    : "tax_payable:other";
}

export type JournalLine = Readonly<{
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  branchId: string | null;
  vehicleId: string | null;
  party: Readonly<{ type: LedgerPartyType; id: string }> | null;
  memo: string | null;
}>;

/** A balanced journal entry about to be posted (docs/13 §2.4), in base-currency minor units. */
export type JournalDraft = Readonly<{
  date: string;
  description: string;
  source: Readonly<{ type: string; id: string }>;
  lines: readonly JournalLine[];
  /** The entry this one cancels. */
  reversesId: string | null;
}>;

type LineInput = Omit<
  JournalLine,
  "debitMinor" | "creditMinor" | "branchId" | "vehicleId" | "party" | "memo"
> &
  Partial<Pick<JournalLine, "branchId" | "vehicleId" | "party" | "memo">>;

export const debit = (amountMinor: number, line: LineInput): JournalLine => ({
  branchId: null,
  vehicleId: null,
  party: null,
  memo: null,
  ...line,
  debitMinor: amountMinor,
  creditMinor: 0,
});

export const credit = (amountMinor: number, line: LineInput): JournalLine => ({
  branchId: null,
  vehicleId: null,
  party: null,
  memo: null,
  ...line,
  debitMinor: 0,
  creditMinor: amountMinor,
});

/**
 * Checks and tidies an entry: zero lines dropped, lines on the same account, side and tags
 * merged, whole positive amounts, debits equal credits. The database checks the balance again
 * at commit.
 */
export function journal(draft: JournalDraft): JournalDraft {
  const merged = new Map<string, JournalLine>();
  for (const line of draft.lines) {
    for (const amount of [line.debitMinor, line.creditMinor])
      if (!Number.isSafeInteger(amount) || amount < 0)
        throw new FinanceRuleError("Journal amounts are whole, non-negative minor units");
    if (line.debitMinor > 0 && line.creditMinor > 0)
      throw new FinanceRuleError("A journal line is either a debit or a credit");
    if (line.debitMinor === 0 && line.creditMinor === 0) continue;
    const side = line.debitMinor > 0 ? "d" : "c";
    const key = [
      side,
      line.accountId,
      line.branchId,
      line.vehicleId,
      line.party?.type,
      line.party?.id,
      line.memo,
    ].join("|");
    const existing = merged.get(key);
    merged.set(
      key,
      existing === undefined
        ? line
        : {
            ...existing,
            debitMinor: existing.debitMinor + line.debitMinor,
            creditMinor: existing.creditMinor + line.creditMinor,
          },
    );
  }
  const lines = [...merged.values()];
  const debits = lines.reduce((sum, l) => sum + l.debitMinor, 0);
  const credits = lines.reduce((sum, l) => sum + l.creditMinor, 0);
  if (lines.length < 2 || debits !== credits || debits === 0)
    throw new FinanceRuleError(`An entry must balance (debits ${debits}, credits ${credits})`);
  return { ...draft, lines };
}

/** The entry that cancels `original`, dated `date` (an open period). */
export function reversal(
  original: JournalDraft & Readonly<{ id: string }>,
  date: string,
  description: string,
): JournalDraft {
  return journal({
    date,
    description,
    source: original.source,
    reversesId: original.id,
    lines: original.lines.map((l) => ({
      ...l,
      debitMinor: l.creditMinor,
      creditMinor: l.debitMinor,
    })),
  });
}
