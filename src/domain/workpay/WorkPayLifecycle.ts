import {
  outstanding,
  type ChargeState,
  type InstalmentState,
  type PenaltyState,
} from "./WorkPayCollections.js";
import { dueDates, WorkPayRuleError, type WorkPayFrequency } from "./WorkPayTerms.js";

/**
 * A change to the schedule: what is left of some instalments moves to new ones. The old rows stay
 * (with the moved amount as "rescheduled") so every payment and late fee keeps its instalment.
 */
export type ReschedulePlan = Readonly<{
  moves: readonly Readonly<{ id: string; rescheduledMinor: number }>[];
  creates: readonly Readonly<{ number: number; dueOn: string; amountMinor: number }>[];
}>;

export type SettlementFigures = Readonly<{
  instalmentsMinor: number;
  penaltiesMinor: number;
  chargesMinor: number;
  /** The share of the outstanding instalments that is markup (the price over the value). */
  markupMinor: number;
  discountMinor: number;
  /** What settles the agreement today. */
  payoffMinor: number;
}>;

const percentOf = (amountMinor: number, percent: string) =>
  Math.round((amountMinor * Number(percent)) / 100);

const nextNumber = (instalments: readonly InstalmentState[]) =>
  instalments.reduce((max, i) => Math.max(max, i.number), 0) + 1;

/** Equal amounts rounded down to `roundToMinor`, the last one taking the rest. */
export function splitAmount(totalMinor: number, periods: number, roundToMinor: number): number[] {
  if (!Number.isInteger(periods) || periods < 1 || periods > 2_000)
    throw new WorkPayRuleError("Give 1 to 2000 instalments");
  const each = Math.floor(totalMinor / periods / roundToMinor) * roundToMinor;
  if (each <= 0) throw new WorkPayRuleError("Too many instalments: each would be zero");
  return [...Array<number>(periods - 1).fill(each), totalMinor - each * (periods - 1)];
}

/**
 * A payment holiday (docs/08 §5): every instalment due from `from` with something left moves
 * `periods` instalment periods later (the term gets longer, the amounts stay).
 */
export function holidayPlan(
  instalments: readonly InstalmentState[],
  params: Readonly<{
    from: string;
    periods: number;
    frequency: WorkPayFrequency;
    daysOff: readonly number[];
  }>,
): ReschedulePlan {
  if (!Number.isInteger(params.periods) || params.periods < 1 || params.periods > 60)
    throw new WorkPayRuleError("A payment holiday is 1 to 60 instalment periods");
  const affected = [...instalments]
    .sort((a, b) => a.number - b.number)
    .filter((i) => i.dueOn >= params.from && outstanding(i) > 0);
  if (affected.length === 0)
    throw new WorkPayRuleError("No instalment with something left is due from that date");
  let number = nextNumber(instalments);
  return {
    moves: affected.map((i) => ({ id: i.id, rescheduledMinor: outstanding(i) })),
    creates: affected.map((i) => ({
      number: number++,
      dueOn: dueDates(i.dueOn, params.frequency, params.periods + 1, params.daysOff).at(-1)!,
      amountMinor: outstanding(i),
    })),
  };
}

/**
 * A restructure (docs/08 §5): everything still owed on instalments — arrears included — is spread
 * over a new schedule (frequency, number of instalments, first due date). Late fees and charges
 * stay as they are.
 */
export function restructurePlan(
  instalments: readonly InstalmentState[],
  params: Readonly<{
    frequency: WorkPayFrequency;
    periods: number;
    firstDueOn: string;
    daysOff: readonly number[];
    roundToMinor: number;
    today: string;
  }>,
): ReschedulePlan {
  if (params.firstDueOn < params.today)
    throw new WorkPayRuleError("The new schedule starts today or later");
  const open = instalments.filter((i) => outstanding(i) > 0);
  const total = open.reduce((sum, i) => sum + outstanding(i), 0);
  if (total === 0) throw new WorkPayRuleError("Nothing is left to restructure");
  const amounts = splitAmount(total, params.periods, params.roundToMinor);
  const dates = dueDates(params.firstDueOn, params.frequency, params.periods, params.daysOff);
  const first = nextNumber(instalments);
  return {
    moves: open.map((i) => ({ id: i.id, rescheduledMinor: outstanding(i) })),
    creates: amounts.map((amountMinor, k) => ({
      number: first + k,
      dueOn: dates[k]!,
      amountMinor,
    })),
  };
}

/**
 * What settles the agreement now (docs/08 §5): what is left of the instalments, less an
 * optional discount on the markup still in them, plus unpaid late fees and charges.
 */
export function settlementFigures(
  instalments: readonly InstalmentState[],
  penalties: readonly PenaltyState[],
  charges: readonly ChargeState[],
  terms: Readonly<{ totalPriceMinor: number; markupMinor: number }>,
  discountPercent: string,
): SettlementFigures {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(discountPercent) || Number(discountPercent) > 100)
    throw new WorkPayRuleError("A settlement discount is 0 to 100% of the markup");
  const instalmentsMinor = instalments.reduce((sum, i) => sum + outstanding(i), 0);
  const penaltiesMinor = penalties.reduce((sum, p) => sum + outstanding(p), 0);
  const chargesMinor = charges.reduce((sum, c) => sum + outstanding(c), 0);
  const markupMinor =
    terms.totalPriceMinor === 0
      ? 0
      : Math.round((instalmentsMinor * terms.markupMinor) / terms.totalPriceMinor);
  const discountMinor = Math.min(percentOf(markupMinor, discountPercent), instalmentsMinor);
  return {
    instalmentsMinor,
    penaltiesMinor,
    chargesMinor,
    markupMinor,
    discountMinor,
    payoffMinor: instalmentsMinor - discountMinor + penaltiesMinor + chargesMinor,
  };
}

/** What a repossession refund policy suggests: a share of the instalments paid. */
export const suggestedRefund = (instalmentsPaidMinor: number, refundPercent: string) =>
  percentOf(instalmentsPaidMinor, refundPercent);

/**
 * The payment holiday a vehicle's time off the road suggests: the whole instalment periods it
 * covered (working days for a daily schedule).
 */
export function holidayPeriodsFor(
  from: string,
  to: string,
  frequency: WorkPayFrequency,
  daysOff: readonly number[],
): number {
  const DAY_MS = 86_400_000;
  const start = Date.parse(`${from}T00:00:00Z`);
  const days = Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - start) / DAY_MS));
  if (frequency === "weekly") return Math.floor(days / 7);
  if (frequency === "monthly") return Math.floor(days / 30);
  let working = 0;
  for (let d = 0; d < days; d += 1)
    if (!daysOff.includes(new Date(start + d * DAY_MS).getUTCDay())) working += 1;
  return working;
}
