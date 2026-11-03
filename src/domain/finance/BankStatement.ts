import { InvalidDecimalError } from "../money/Decimal.js";
import { Money } from "../money/Money.js";
import { FinanceRuleError } from "./Journal.js";

export const STATEMENT_COLUMNS = [
  "date",
  "description",
  "reference",
  "amount",
  "debit",
  "credit",
  "direction",
  "balance",
] as const;
export type StatementColumn = (typeof STATEMENT_COLUMNS)[number];
export type ColumnNames = Readonly<Partial<Record<StatementColumn, string>>>;

/** Headers banks and mobile money statements use, in order of preference. */
const HEADERS: Readonly<Record<StatementColumn, readonly string[]>> = {
  date: [
    "value date",
    "transaction date",
    "trans date",
    "txn date",
    "posting date",
    "post date",
    "booking date",
    "date",
    "date time",
    "timestamp",
  ],
  description: [
    "description",
    "narration",
    "narrative",
    "particulars",
    "details",
    "transaction details",
    "transaction type",
    "remarks",
    "memo",
  ],
  reference: [
    "reference",
    "reference no",
    "reference number",
    "ref",
    "ref no",
    "transaction id",
    "transaction reference",
    "external transaction id",
    "financial transaction id",
    "id",
    "cheque no",
    "cheque number",
  ],
  amount: ["amount", "transaction amount", "amt", "value"],
  debit: ["debit", "debits", "debit amount", "withdrawal", "withdrawals", "money out", "paid out"],
  credit: ["credit", "credits", "credit amount", "deposit", "deposits", "money in", "paid in"],
  direction: ["dr/cr", "cr/dr", "dr cr", "debit/credit", "credit/debit"],
  balance: ["balance", "running balance", "closing balance", "ledger balance", "balance after"],
};

const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const HEADER_SEARCH_ROWS = 30;
export const MAX_STATEMENT_LINES = 5_000;

export type StatementLine = Readonly<{
  /** The row of the file, counted from 1. */
  row: number;
  date: string;
  description: string;
  reference: string | null;
  /** Positive: money in. */
  amountMinor: number;
  balanceMinor: number | null;
}>;

export type ParsedStatement = Readonly<{
  columns: Readonly<Partial<Record<StatementColumn, string>>>;
  /** Oldest first, whichever way the file runs. */
  lines: readonly StatementLine[];
  /** Rows without a date or an amount: balances brought forward, totals, footers. */
  skipped: number;
  errors: readonly Readonly<{ row: number; message: string }>[];
}>;

const normal = (header: string) => header.trim().toLowerCase().replace(/\s+/g, " ");

/** A real calendar date as yyyy-mm-dd, or null. */
function isoDate(year: number, month: number, day: number): string | null {
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return at.toISOString().slice(0, 10);
}

/** ISO, numeric day first (or month first) and named months, with or without a time. */
export function parseStatementDate(text: string, dayFirst: boolean): string | null {
  const value = text.trim();
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/.exec(value);
  if (iso !== null) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?:\D|$)/.exec(value);
  if (numeric !== null) {
    const [first, second] = [Number(numeric[1]), Number(numeric[2])];
    return dayFirst
      ? isoDate(year(numeric[3]!), second, first)
      : isoDate(year(numeric[3]!), first, second);
  }
  const named = /^(\d{1,2})[-/. ]([a-z]{3})[a-z]*[-/., ]+(\d{4}|\d{2})(?:\D|$)/i.exec(value);
  if (named !== null) {
    const month = MONTHS.indexOf(named[2]!.toLowerCase());
    return month < 0 ? null : isoDate(year(named[3]!), month + 1, Number(named[1]));
  }
  return null;
}

/** "1,250.50", "(100.00)", "-5", "300.00 DR", "GHS 20"; null for an empty cell. */
export function parseStatementAmount(text: string, currency: string): number | null {
  let value = text.trim();
  if (value === "" || value === "-") return null;
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  const suffix = /\s*(dr|cr)\.?$/i.exec(value);
  if (suffix !== null) {
    negative = suffix[1]!.toLowerCase() === "dr";
    value = value.slice(0, suffix.index);
  }
  value = value.replace(/[A-Za-z₵\s,]/g, "");
  if (value.startsWith("-")) {
    negative = !negative;
    value = value.slice(1);
  } else if (value.startsWith("+")) value = value.slice(1);
  if (value === "") throw new FinanceRuleError(`"${text}" is not an amount`);
  try {
    const { amountMinor } = Money.parse(value, currency);
    return negative ? -amountMinor : amountMinor;
  } catch (error) {
    if (error instanceof InvalidDecimalError)
      throw new FinanceRuleError(`"${text}" is not an amount`);
    throw error;
  }
}

function findColumns(
  header: readonly string[],
  named: ColumnNames | undefined,
): Partial<Record<StatementColumn, number>> {
  const cells = header.map(normal);
  const found: Partial<Record<StatementColumn, number>> = {};
  for (const column of STATEMENT_COLUMNS) {
    const asked = named?.[column];
    if (asked !== undefined) {
      const at = cells.indexOf(normal(asked));
      if (at >= 0) found[column] = at;
      continue;
    }
    for (const name of HEADERS[column]) {
      const at = cells.indexOf(name);
      if (at >= 0) {
        found[column] = at;
        break;
      }
    }
  }
  return found;
}

const usable = (found: Partial<Record<StatementColumn, number>>) =>
  found.date !== undefined &&
  (found.amount !== undefined || found.debit !== undefined || found.credit !== undefined);

/**
 * Reads a statement from its CSV rows (docs/13 §4, decision 512): the header is found below any
 * lines the bank puts above it and its columns are recognised by name or named by the user; one
 * signed amount, an amount with a Dr/Cr column, or separate debit and credit columns. A row with
 * no date or no amount is skipped; a date or amount that cannot be read is an error of its row.
 */
export function parseStatement(
  rows: readonly (readonly string[])[],
  options: Readonly<{ currency: string; dayFirst: boolean; columns?: ColumnNames }>,
): ParsedStatement {
  let headerAt = -1;
  let found: Partial<Record<StatementColumn, number>> = {};
  for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH_ROWS) && headerAt < 0; i++) {
    found = findColumns(rows[i]!, options.columns);
    if (usable(found)) headerAt = i;
  }
  if (headerAt < 0)
    throw new FinanceRuleError(
      "No header with a date and an amount was found: name the columns of this statement",
    );
  const header = rows[headerAt]!;
  const columns = Object.fromEntries(
    Object.entries(found).map(([column, at]) => [column, header[at]!.trim()]),
  );
  const cell = (row: readonly string[], column: StatementColumn) => {
    const at = found[column];
    return at === undefined ? "" : (row[at] ?? "").trim();
  };

  const lines: StatementLine[] = [];
  const errors: { row: number; message: string }[] = [];
  let skipped = 0;
  rows.slice(headerAt + 1).forEach((row, index) => {
    const rowNumber = headerAt + index + 2;
    const dateText = cell(row, "date");
    if (dateText === "") {
      skipped += 1;
      return;
    }
    try {
      const amount = (column: "amount" | "debit" | "credit") =>
        parseStatementAmount(cell(row, column), options.currency);
      let amountMinor: number | null;
      if (found.amount !== undefined) {
        amountMinor = amount("amount");
        const direction = cell(row, "direction").toLowerCase();
        if (amountMinor !== null && direction !== "")
          amountMinor = direction.startsWith("d") ? -Math.abs(amountMinor) : Math.abs(amountMinor);
      } else {
        const out = amount("debit");
        const into = amount("credit");
        amountMinor =
          out === null && into === null ? null : Math.abs(into ?? 0) - Math.abs(out ?? 0);
      }
      if (amountMinor === null || amountMinor === 0) {
        skipped += 1;
        return;
      }
      const date = parseStatementDate(dateText, options.dayFirst);
      if (date === null) {
        errors.push({ row: rowNumber, message: `"${dateText}" is not a date` });
        return;
      }
      lines.push({
        row: rowNumber,
        date,
        description: cell(row, "description").slice(0, 500),
        reference: cell(row, "reference").slice(0, 120) || null,
        amountMinor,
        balanceMinor: parseStatementAmount(cell(row, "balance"), options.currency),
      });
    } catch (error) {
      if (!(error instanceof FinanceRuleError)) throw error;
      errors.push({ row: rowNumber, message: error.message });
    }
  });
  if (lines.length > MAX_STATEMENT_LINES)
    throw new FinanceRuleError(`A statement has at most ${MAX_STATEMENT_LINES} lines`);
  const newestFirst = lines.length > 1 && lines[0]!.date > lines.at(-1)!.date;
  return { columns, lines: newestFirst ? lines.reverse() : lines, skipped, errors };
}

/** What identifies a line across statements; `occurrence` tells identical lines of a day apart. */
export function statementLineKey(line: StatementLine, occurrence: number): string {
  const text = (line.description + (line.reference ?? "")).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return [line.date, line.amountMinor, text, occurrence].join("|");
}
