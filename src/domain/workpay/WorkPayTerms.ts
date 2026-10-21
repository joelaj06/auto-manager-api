import { DomainError } from "../errors/DomainError.js";

export class WorkPayRuleError extends DomainError {
  readonly code = "WORKPAY_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type WorkPayFrequency = (typeof FREQUENCIES)[number];

/** How the price is set from the vehicle's value (docs/08 §2). */
export type Pricing =
  | Readonly<{ kind: "multiplier"; multiplier: string }>
  | Readonly<{ kind: "markup_percent"; percent: string }>
  | Readonly<{ kind: "total"; totalMinor: number }>;

export type TermsInput = Readonly<{
  vehicleValueMinor: number;
  pricing: Pricing;
  depositMinor: number;
  frequency: WorkPayFrequency;
  /** Number of instalments, or a duration in months converted to instalments. */
  periods?: number;
  months?: number;
  firstDueOn: string;
  /** Daily instalments: weekdays without one (0 = Sunday … 6 = Saturday). */
  daysOff?: readonly number[];
  /** Instalments are a multiple of this (100 = whole cedis); the last one takes the rest. */
  roundToMinor?: number;
}>;

export type Instalment = Readonly<{ number: number; dueOn: string; amountMinor: number }>;

export type WorkPayTerms = Readonly<{
  vehicleValueMinor: number;
  pricing: Pricing;
  totalPriceMinor: number;
  /** What the driver pays over the vehicle's value. */
  markupMinor: number;
  depositMinor: number;
  /** Paid in instalments: price − deposit. */
  financedMinor: number;
  frequency: WorkPayFrequency;
  periods: number;
  instalmentMinor: number;
  /** The last instalment takes the rounding remainder. */
  lastInstalmentMinor: number;
  firstDueOn: string;
  lastDueOn: string;
  daysOff: readonly number[];
  roundToMinor: number;
  schedule: readonly Instalment[];
}>;

const DECIMAL = /^\d{1,3}(\.\d{1,4})?$/;
const DAY_MS = 86_400_000;
const MAX_PERIODS = 2_000;

const toTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toDate = (time: number) => new Date(time).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => toDate(toTime(date) + days * DAY_MS);

/** `value × factor ÷ divisor` for a decimal factor written as text ("2.25"), rounded half up. */
function times(valueMinor: number, factor: string, divisor = 1n): number {
  const [whole, fraction = ""] = factor.split(".");
  const scale = 10n ** BigInt(fraction.length) * divisor;
  const numerator = BigInt(valueMinor) * BigInt(`${whole}${fraction}`);
  return Number((numerator * 2n + scale) / (2n * scale));
}

function priceOf(valueMinor: number, pricing: Pricing): number {
  switch (pricing.kind) {
    case "multiplier": {
      if (!DECIMAL.test(pricing.multiplier))
        throw new WorkPayRuleError('A multiplier is a number like "2" or "1.75"');
      const m = Number(pricing.multiplier);
      if (m < 1 || m > 10) throw new WorkPayRuleError("A multiplier is between 1 and 10");
      return times(valueMinor, pricing.multiplier);
    }
    case "markup_percent": {
      if (!DECIMAL.test(pricing.percent))
        throw new WorkPayRuleError('A markup is a percentage like "80" or "62.5"');
      const p = Number(pricing.percent);
      if (p < 0 || p > 900) throw new WorkPayRuleError("A markup is 0% to 900%");
      return valueMinor + times(valueMinor, pricing.percent, 100n);
    }
    case "total":
      if (!Number.isInteger(pricing.totalMinor) || pricing.totalMinor <= 0)
        throw new WorkPayRuleError("The total price must be above zero");
      return pricing.totalMinor;
  }
}

/** Due dates: every working day, every 7 days, or the same day each month (clamped to its end). */
export function dueDates(
  firstDueOn: string,
  frequency: WorkPayFrequency,
  periods: number,
  daysOff: readonly number[],
): string[] {
  const dates: string[] = [];
  if (frequency === "daily") {
    if (daysOff.length >= 7) throw new WorkPayRuleError("A daily schedule needs a working day");
    let day = firstDueOn;
    while (dates.length < periods) {
      if (!daysOff.includes(new Date(toTime(day)).getUTCDay())) dates.push(day);
      day = addDays(day, 1);
    }
    return dates;
  }
  if (frequency === "weekly") {
    for (let i = 0; i < periods; i += 1) dates.push(addDays(firstDueOn, 7 * i));
    return dates;
  }
  const [y, m, d] = firstDueOn.split("-").map(Number) as [number, number, number];
  for (let i = 0; i < periods; i += 1) {
    const last = new Date(Date.UTC(y, m - 1 + i + 1, 0)).getUTCDate();
    dates.push(toDate(Date.UTC(y, m - 1 + i, Math.min(d, last))));
  }
  return dates;
}

/** Instalments in a duration: months, weeks (52 a year) or the working days in it. */
function periodsIn(
  months: number,
  frequency: WorkPayFrequency,
  firstDueOn: string,
  daysOff: readonly number[],
): number {
  if (frequency === "monthly") return months;
  if (frequency === "weekly") return Math.round((months * 52) / 12);
  const [y, m, d] = firstDueOn.split("-").map(Number) as [number, number, number];
  const end = toTime(toDate(Date.UTC(y, m - 1 + months, d)));
  let count = 0;
  for (let t = toTime(firstDueOn); t < end; t += DAY_MS)
    if (!daysOff.includes(new Date(t).getUTCDay())) count += 1;
  return count;
}

/**
 * Work & Pay terms (docs/08 §2–3): the price from the vehicle's value (multiplier, markup or a
 * total), less the deposit, paid in equal instalments rounded down to `roundToMinor` — the
 * remainder goes on the last instalment, never spread by rounding up — on working days, weekly
 * or monthly from the first due date.
 */
export function workPayTerms(input: TermsInput): WorkPayTerms {
  if (!Number.isInteger(input.vehicleValueMinor) || input.vehicleValueMinor <= 0)
    throw new WorkPayRuleError("The vehicle's value must be above zero");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.firstDueOn) || Number.isNaN(toTime(input.firstDueOn)))
    throw new WorkPayRuleError("The first due date is YYYY-MM-DD");
  const daysOff = [...new Set(input.frequency === "daily" ? (input.daysOff ?? []) : [])].sort();
  if (daysOff.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
    throw new WorkPayRuleError("Days off are 0 (Sunday) to 6 (Saturday)");
  const roundToMinor = input.roundToMinor ?? 1;
  if (![1, 10, 50, 100, 500, 1_000].includes(roundToMinor))
    throw new WorkPayRuleError("Round instalments to 1, 10, 50, 100, 500 or 1000 minor units");
  const totalPriceMinor = priceOf(input.vehicleValueMinor, input.pricing);
  if (!Number.isInteger(input.depositMinor) || input.depositMinor < 0)
    throw new WorkPayRuleError("The deposit cannot be negative");
  const financedMinor = totalPriceMinor - input.depositMinor;
  if (financedMinor <= 0) throw new WorkPayRuleError("The deposit must be less than the price");
  if ((input.periods === undefined) === (input.months === undefined))
    throw new WorkPayRuleError("Give either the number of instalments or the months");
  if (
    input.months !== undefined &&
    (!Number.isInteger(input.months) || input.months < 1 || input.months > 120)
  )
    throw new WorkPayRuleError("A term is 1 to 120 months");
  const periods =
    input.periods ?? periodsIn(input.months!, input.frequency, input.firstDueOn, daysOff);
  if (!Number.isInteger(periods) || periods < 1 || periods > MAX_PERIODS)
    throw new WorkPayRuleError(`A schedule has 1 to ${MAX_PERIODS} instalments`);
  const instalmentMinor = Math.floor(financedMinor / periods / roundToMinor) * roundToMinor;
  if (instalmentMinor <= 0)
    throw new WorkPayRuleError(
      "The instalments would be zero: fewer instalments or a smaller rounding",
    );
  const lastInstalmentMinor = financedMinor - instalmentMinor * (periods - 1);
  const dates = dueDates(input.firstDueOn, input.frequency, periods, daysOff);
  return {
    vehicleValueMinor: input.vehicleValueMinor,
    pricing: input.pricing,
    totalPriceMinor,
    markupMinor: totalPriceMinor - input.vehicleValueMinor,
    depositMinor: input.depositMinor,
    financedMinor,
    frequency: input.frequency,
    periods,
    instalmentMinor,
    lastInstalmentMinor,
    firstDueOn: input.firstDueOn,
    lastDueOn: dates.at(-1)!,
    daysOff,
    roundToMinor,
    schedule: dates.map((dueOn, i) => ({
      number: i + 1,
      dueOn,
      amountMinor: i === periods - 1 ? lastInstalmentMinor : instalmentMinor,
    })),
  };
}
