import type { PayableBucket } from "../../../../domain/finance/Payables.js";
import type { MoneyJson } from "../../../../domain/money/Money.js";
import type { Cell } from "../../../../domain/reporting/Report.js";

/** Money cells are minor units of the report's currency. */
export const minor = (m: MoneyJson) => m.amountMinor;
export const minorOr = (m: MoneyJson | null) => (m === null ? null : m.amountMinor);
/** Percentages arrive as numbers or one-decimal strings. */
export const percent = (p: string | number | null) => (p === null ? null : Number(p));
/** `in_arrears` → "in arrears". */
export const words = (key: string | null) => (key === null ? null : key.replaceAll("_", " "));
export const between = (p: Readonly<{ from: string; to: string }>) => `${p.from} to ${p.to}`;
export const total = <T>(items: readonly T[], pick: (item: T) => number) =>
  items.reduce((sum, item) => sum + pick(item), 0);
/** Share of a whole, to one decimal (null when the whole is zero). */
export const share = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 10;
/** "AB-123 · GR 1234-26". */
export const vehicleName = (v: Readonly<{ code: string; plateNumber: string | null }>) =>
  v.plateNumber === null ? v.code : `${v.code} · ${v.plateNumber}`;
/** A totals row: the label in the first column, the given cells, the rest empty. */
export function totalsRow(
  keys: readonly string[],
  label: string,
  cells: Readonly<Record<string, Cell>>,
): Readonly<Record<string, Cell>> {
  return Object.fromEntries(keys.map((k, i) => [k, i === 0 ? label : (cells[k] ?? null)]));
}

/** Column headers of the ageing buckets. */
export const AGE_HEADERS: Readonly<Record<PayableBucket, string>> = {
  current: "Not yet due",
  days1to30: "1–30 days",
  days31to60: "31–60 days",
  days61to90: "61–90 days",
  over90: "Over 90 days",
};
