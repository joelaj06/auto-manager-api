import { DomainError } from "../errors/DomainError.js";
import { divideHalfEven, parseDecimal, pow10 } from "../money/Decimal.js";
import { Money } from "../money/Money.js";

export class PayablesRuleError extends DomainError {
  readonly code = "PAYABLES_RULE";
  constructor(message: string) {
    super(message);
  }
}

/** The ageing buckets of what is owed, by days past the due date (decision 416). */
export const PAYABLE_BUCKETS = [
  "current",
  "days1to30",
  "days31to60",
  "days61to90",
  "over90",
] as const;
export type PayableBucket = (typeof PAYABLE_BUCKETS)[number];

const DAY_MS = 86_400_000;

/** The due date of a bill: its date plus the supplier's payment terms (none: due at once). */
export function dueOn(billDate: string, termsDays: number | null): string {
  const date = new Date(`${billDate}T00:00:00Z`);
  return new Date(date.getTime() + (termsDays ?? 0) * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days a bill is past its due date on `asOf` (0 while not yet due). */
export function daysOverdue(due: string, asOf: string): number {
  const days = Math.round(
    (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / DAY_MS,
  );
  return Math.max(0, days);
}

export function bucketOf(overdueDays: number): PayableBucket {
  if (overdueDays === 0) return "current";
  if (overdueDays <= 30) return "days1to30";
  if (overdueDays <= 60) return "days31to60";
  if (overdueDays <= 90) return "days61to90";
  return "over90";
}

/** Amounts (base minor units) of bills summed into the ageing buckets. */
export function ageBills(
  bills: readonly Readonly<{ dueOn: string; amountMinor: number }>[],
  asOf: string,
): Record<PayableBucket, number> {
  const buckets: Record<PayableBucket, number> = {
    current: 0,
    days1to30: 0,
    days31to60: 0,
    days61to90: 0,
    over90: 0,
  };
  for (const bill of bills) buckets[bucketOf(daysOverdue(bill.dueOn, asOf))] += bill.amountMinor;
  return buckets;
}

/**
 * Withholding tax on a supplier payment (decision 417): the rate (a percentage, 0–25) of the
 * bills' amounts before VAT, rounded half to even at the currency's minor unit.
 */
export function withholdingOf(netMinor: number, rate: string): number {
  const r = parseDecimal(rate);
  if (r.units < 0n || r.units > 25n * pow10(r.scale))
    throw new PayablesRuleError("A withholding tax rate is between 0 and 25%");
  return Number(divideHalfEven(BigInt(netMinor) * r.units, 100n * pow10(r.scale)));
}

/**
 * What one payment for several bills means for each bill in the base currency (decision 418):
 * the gross paid (payment plus tax withheld) at the payment's rate shared over the bills by their
 * amounts, and each bill's exchange difference — its frozen base amount less its share
 * (positive: less was paid in base than the bill was booked at).
 */
export function settleBills(
  bills: readonly Readonly<{ amountMinor: number; amountBaseMinor: number }>[],
  grossBaseMinor: number,
  base: string,
): readonly Readonly<{ shareBaseMinor: number; differenceMinor: number }>[] {
  const shares = Money.ofMinor(grossBaseMinor, base).allocate(bills.map((b) => b.amountMinor));
  return bills.map((bill, i) => {
    const share = shares[i]!.amountMinor;
    return { shareBaseMinor: share, differenceMinor: bill.amountBaseMinor - share };
  });
}
