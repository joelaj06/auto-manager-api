export const EXPORT_FORMATS = ["quickbooks", "xero", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_TARGETS = ["quickbooks", "xero"] as const;
export type ExportTarget = (typeof EXPORT_TARGETS)[number];
export const EXPORT_DETAILS = ["entry", "day", "month"] as const;
export type ExportDetail = (typeof EXPORT_DETAILS)[number];

/** One line of a journal on its way out, in minor units of the base currency. */
export type ExportLine = Readonly<{
  journalNumber: string;
  date: string;
  description: string;
  sourceType: string | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitMinor: number;
  creditMinor: number;
  branch: string | null;
  vehicle: string | null;
  partyType: string | null;
  partyName: string | null;
  memo: string | null;
}>;

/**
 * Journals netted per account and day or month (decision 511): packages take a few hundred lines
 * in one import, and a period's detail stays in the books here. Each period still balances,
 * because every entry in it does.
 */
export function summarise(lines: readonly ExportLine[], detail: ExportDetail): ExportLine[] {
  if (detail === "entry") return [...lines];
  const groups = new Map<
    string,
    { period: string; line: ExportLine; netMinor: number; lastDate: string }
  >();
  for (const line of lines) {
    const period = detail === "day" ? line.date : line.date.slice(0, 7);
    const key = `${period}|${line.accountId}`;
    const group = groups.get(key) ?? { period, line, netMinor: 0, lastDate: line.date };
    group.netMinor += line.debitMinor - line.creditMinor;
    if (line.date > group.lastDate) group.lastDate = line.date;
    groups.set(key, group);
  }
  const lastByPeriod = new Map<string, string>();
  for (const { period, lastDate } of groups.values())
    if (lastDate > (lastByPeriod.get(period) ?? "")) lastByPeriod.set(period, lastDate);
  return [...groups.values()]
    .filter((g) => g.netMinor !== 0)
    .sort(
      (a, b) =>
        a.period.localeCompare(b.period) || a.line.accountCode.localeCompare(b.line.accountCode),
    )
    .map(({ period, line, netMinor }) => ({
      journalNumber: `AF-${period}`,
      date: lastByPeriod.get(period)!,
      description: `Autoforce summary ${period}`,
      sourceType: null,
      accountId: line.accountId,
      accountCode: line.accountCode,
      accountName: line.accountName,
      debitMinor: Math.max(netMinor, 0),
      creditMinor: Math.max(-netMinor, 0),
      branch: null,
      vehicle: null,
      partyType: null,
      partyName: null,
      memo: null,
    }));
}
