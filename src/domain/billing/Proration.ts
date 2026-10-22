import type { BillingDate } from "./Subscription.js";

export type Proration = Readonly<{
  branches: number;
  unitMinor: number;
  /** Days left in the period from the day the branch was added (that day included). */
  days: number;
  periodDays: number;
  amountMinor: number;
  startsOn: BillingDate;
  periodEnd: BillingDate;
}>;

const DAY_MS = 86_400_000;
const days = (from: BillingDate, to: BillingDate) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * The charge for branches added during a paid period (docs/25 §3): the monthly price for the
 * days left, `[from, periodEnd)`, rounded half up to the minor unit. Null when nothing is left
 * of the period.
 */
export function prorate(
  params: Readonly<{
    branches: number;
    unitMinor: number;
    from: BillingDate;
    period: Readonly<{ start: BillingDate; end: BillingDate }>;
  }>,
): Proration | null {
  const left = days(params.from, params.period.end);
  const total = days(params.period.start, params.period.end);
  if (params.branches <= 0 || left <= 0 || total <= 0) return null;
  const used = Math.min(left, total);
  const amountMinor = Math.round((params.branches * params.unitMinor * used) / total);
  if (amountMinor <= 0) return null;
  return {
    branches: params.branches,
    unitMinor: params.unitMinor,
    days: used,
    periodDays: total,
    amountMinor,
    startsOn: params.from,
    periodEnd: params.period.end,
  };
}
