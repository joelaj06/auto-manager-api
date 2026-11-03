import type { ExportFormat, ExportLine } from "../../domain/finance/AccountingExport.js";
import { Money } from "../../domain/money/Money.js";
import { csvCell, toCsv } from "./Csv.js";

export type AccountingFileOptions = Readonly<{
  currency: string;
  /** The package's name or code of an account, if mapped. */
  external: (accountId: string) => string | null;
  /** Xero's name for no tax: the taxes are already their own lines. */
  xeroTaxRate: string;
}>;

const dayFirst = (date: string) => date.split("-").reverse().join("/");
const decimal = (minor: number, currency: string) =>
  Money.ofMinor(minor, currency).toDecimalString();
const side = (minor: number, currency: string) => (minor === 0 ? "" : decimal(minor, currency));

/** QuickBooks Online's journal entry import; the file's Location is the branch. */
function quickbooks(lines: readonly ExportLine[], options: AccountingFileOptions): string {
  const columns = [
    "Journal No",
    "Journal Date",
    "Account Name",
    "Debits",
    "Credits",
    "Description",
    "Name",
    "Location",
  ];
  return toCsv(
    columns,
    lines.map((l) => ({
      "Journal No": l.journalNumber,
      "Journal Date": dayFirst(l.date),
      "Account Name": options.external(l.accountId) ?? l.accountName,
      Debits: side(l.debitMinor, options.currency),
      Credits: side(l.creditMinor, options.currency),
      Description: l.memo ?? l.description,
      Name: l.partyName,
      Location: l.branch,
    })),
  );
}

/**
 * Xero's manual journal import. Written by hand because its amounts are signed: a credit is
 * negative, which the formula guard of our other CSV files would quote and break.
 */
function xero(lines: readonly ExportLine[], options: AccountingFileOptions): string {
  const columns = ["*Narration", "*Date", "Description", "*AccountCode", "*TaxRate", "*Amount"];
  const rows = lines.map((l) =>
    [
      csvCell(`${l.journalNumber} ${l.description}`),
      dayFirst(l.date),
      csvCell(l.memo ?? l.description),
      csvCell(options.external(l.accountId) ?? l.accountCode),
      csvCell(options.xeroTaxRate),
      decimal(l.debitMinor - l.creditMinor, options.currency),
    ].join(","),
  );
  return `${[columns.join(","), ...rows].join("\r\n")}\r\n`;
}

function plain(lines: readonly ExportLine[], options: AccountingFileOptions): string {
  const columns = [
    "journal",
    "date",
    "description",
    "source",
    "account_code",
    "account_name",
    "debit",
    "credit",
    "currency",
    "branch",
    "vehicle",
    "party_type",
    "party",
    "memo",
  ];
  return toCsv(
    columns,
    lines.map((l) => ({
      journal: l.journalNumber,
      date: l.date,
      description: l.description,
      source: l.sourceType,
      account_code: l.accountCode,
      account_name: l.accountName,
      debit: side(l.debitMinor, options.currency),
      credit: side(l.creditMinor, options.currency),
      currency: options.currency,
      branch: l.branch,
      vehicle: l.vehicle,
      party_type: l.partyType,
      party: l.partyName,
      memo: l.memo,
    })),
  );
}

/** The journals as the file a package imports (docs/13 §2.4, decision 510). */
export function accountingFile(
  format: ExportFormat,
  lines: readonly ExportLine[],
  options: AccountingFileOptions,
): string {
  if (format === "quickbooks") return quickbooks(lines, options);
  return format === "xero" ? xero(lines, options) : plain(lines, options);
}
