import type { ChargeAmount, ChargeKind } from "./RentalBooking.js";

/** Fees and damage are compensation: invoiced without tax (decisions 336, 347). */
const UNTAXED: ReadonlySet<ChargeKind> = new Set(["cancellation_fee", "no_show_fee", "damage"]);

const LABELS: Readonly<Record<ChargeKind, string>> = {
  rental: "Rental",
  change: "Booking changes",
  extension: "Extensions",
  late_return: "Late return",
  mileage: "Mileage",
  cancellation: "Cancelled booking",
  cancellation_fee: "Late cancellation fee",
  no_show_fee: "No-show fee",
  fuel_refill: "Refuelling",
  cleaning: "Cleaning",
  damage: "Damage",
};

export type InvoiceableCharge = ChargeAmount & Readonly<{ id: string; kind: ChargeKind }>;

export type RentalInvoiceLine = Readonly<{
  kind: ChargeKind;
  description: string;
  /** Before tax, or with tax when the business enters prices with tax (as the charges were). */
  amountMinor: number;
  /** Credits of the same tax treatment (a shorter rental, fewer km) taken off the line. */
  discountMinor: number;
  taxed: boolean;
}>;

export type RentalInvoiceDraft = Readonly<{
  lines: readonly RentalInvoiceLine[];
  /** The charges these lines cover. */
  chargeIds: readonly string[];
  /** Charges left for a later invoice: their group adds up to a credit (no credit notes yet). */
  heldBack: readonly string[];
}>;

/**
 * The invoice lines of a booking's charges not yet invoiced (decision 355): one line per kind,
 * taxed kinds apart from fees and damage; a kind that adds up to a credit is taken off the other
 * lines of its tax treatment as a discount. A group that adds up to a credit waits.
 */
export function rentalInvoiceLines(
  charges: readonly InvoiceableCharge[],
  number: string,
  pricesIncludeTax: boolean,
): RentalInvoiceDraft {
  const lines: RentalInvoiceLine[] = [];
  const chargeIds: string[] = [];
  const heldBack: string[] = [];
  for (const taxed of [true, false]) {
    const group = charges.filter((c) => UNTAXED.has(c.kind) !== taxed);
    if (group.length === 0) continue;
    const amount = (c: ChargeAmount) => (taxed && !pricesIncludeTax ? c.netMinor : c.totalMinor);
    const byKind = new Map<ChargeKind, number>();
    for (const c of group) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + amount(c));
    const positive = [...byKind].filter(([, v]) => v > 0);
    let credit = [...byKind.values()].filter((v) => v < 0).reduce((s, v) => s - v, 0);
    const total = positive.reduce((s, [, v]) => s + v, 0);
    if (total - credit <= 0) {
      // Nothing to bill (or a credit): a kind fully netted out is covered, the rest waits.
      const ids = group.map((c) => c.id);
      if (total - credit === 0) chargeIds.push(...ids);
      else heldBack.push(...ids);
      continue;
    }
    // Credits come off the largest lines first.
    const ordered = positive.sort((a, b) => b[1] - a[1]);
    for (const [kind, value] of ordered) {
      const discount = Math.min(value, credit);
      credit -= discount;
      lines.push({
        kind,
        description: `${LABELS[kind]}, booking ${number}`,
        amountMinor: value,
        discountMinor: discount,
        taxed,
      });
    }
    chargeIds.push(...group.map((c) => c.id));
  }
  return { lines, chargeIds, heldBack };
}
