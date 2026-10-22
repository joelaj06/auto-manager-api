import { WorkPayRuleError } from "./WorkPayTerms.js";

export type InstalmentStatus =
  "upcoming" | "due" | "partially_paid" | "paid" | "overdue" | "waived" | "rescheduled";

export type InstalmentState = Readonly<{
  id: string;
  number: number;
  dueOn: string;
  amountMinor: number;
  paidMinor: number;
  waivedMinor: number;
  /** Moved to later instalments by a payment holiday or restructure. */
  rescheduledMinor: number;
  status: InstalmentStatus;
}>;

export type PenaltyState = Readonly<{
  id: string;
  instalmentId: string;
  chargedOn: string;
  amountMinor: number;
  paidMinor: number;
  waivedMinor: number;
}>;

/** A cost the driver bears added to the agreement (an expense charged to them). */
export type ChargeState = Readonly<{
  id: string;
  chargedOn: string;
  description: string;
  amountMinor: number;
  paidMinor: number;
  /** Cancelled (the expense was voided). */
  waivedMinor: number;
}>;

/** Late payment (docs/08 §2): none, a flat fee or a percentage once, or a daily fee (capped). */
export type PenaltyRule =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "flat"; amountMinor: number }>
  | Readonly<{ kind: "percent"; percent: string }>
  | Readonly<{ kind: "daily"; amountMinor: number; capMinor: number | null }>;

export type AllocationLine = Readonly<{
  kind: "penalty" | "charge" | "instalment";
  id: string;
  amountMinor: number;
}>;

export type Allocation = Readonly<{
  lines: readonly AllocationLine[];
  instalmentsMinor: number;
  penaltiesMinor: number;
  chargesMinor: number;
  /** What no instalment or penalty needed: stays the driver's credit. */
  unallocatedMinor: number;
}>;

export type ArrearsPolicy = Readonly<{
  graceDays: number;
  /** Defaulted at this many overdue instalments … */
  defaultAfterOverdue: number;
  /** … or this many days since the oldest overdue instalment fell overdue. */
  defaultAfterDays: number;
}>;

export type AgreementPosition = Readonly<{
  status: "active" | "in_arrears" | "defaulted" | "completed";
  outstandingMinor: number;
  overdueMinor: number;
  overdueCount: number;
  penaltiesOutstandingMinor: number;
  chargesOutstandingMinor: number;
  /** The day the oldest unpaid instalment fell overdue. */
  arrearsSince: string | null;
  nextDue: Readonly<{ number: number; dueOn: string; outstandingMinor: number }> | null;
}>;

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export const outstanding = (
  x: Readonly<{
    amountMinor: number;
    paidMinor: number;
    waivedMinor: number;
    rescheduledMinor?: number;
  }>,
) => x.amountMinor - x.paidMinor - x.waivedMinor - (x.rescheduledMinor ?? 0);

/** The first day an instalment counts as overdue: after its due date and the grace days. */
export const overdueFrom = (dueOn: string, graceDays: number) => addDays(dueOn, graceDays + 1);

/** An instalment's status on `today` from what was paid and waived. */
export function instalmentStatus(
  i: Omit<InstalmentState, "status" | "id" | "number">,
  today: string,
  graceDays: number,
): InstalmentStatus {
  if (outstanding(i) === 0)
    return i.rescheduledMinor > 0
      ? "rescheduled"
      : i.paidMinor === 0 && i.waivedMinor > 0
        ? "waived"
        : "paid";
  if (i.dueOn > today) return "upcoming";
  if (today >= overdueFrom(i.dueOn, graceDays)) return "overdue";
  return i.paidMinor > 0 ? "partially_paid" : "due";
}

/**
 * Splits a payment by the allocation policy (docs/08 §4): unpaid penalties first (oldest
 * first), then costs charged to the agreement, then instalments in order — overdue, then due, then future ones (an advance
 * payment). Whatever is left stays the driver's credit.
 */
export function allocate(
  amountMinor: number,
  instalments: readonly InstalmentState[],
  penalties: readonly PenaltyState[],
  charges: readonly ChargeState[] = [],
): Allocation {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
    throw new WorkPayRuleError("A payment must be above zero");
  let left = amountMinor;
  const lines: AllocationLine[] = [];
  const take = (kind: AllocationLine["kind"], id: string, owed: number) => {
    const amount = Math.min(left, owed);
    if (amount <= 0) return 0;
    lines.push({ kind, id, amountMinor: amount });
    left -= amount;
    return amount;
  };
  let penaltiesMinor = 0;
  for (const p of [...penalties].sort(
    (a, b) => a.chargedOn.localeCompare(b.chargedOn) || a.id.localeCompare(b.id),
  ))
    penaltiesMinor += take("penalty", p.id, outstanding(p));
  let chargesMinor = 0;
  for (const c of [...charges].sort(
    (a, b) => a.chargedOn.localeCompare(b.chargedOn) || a.id.localeCompare(b.id),
  ))
    chargesMinor += take("charge", c.id, outstanding(c));
  let instalmentsMinor = 0;
  for (const i of [...instalments].sort((a, b) => a.number - b.number))
    instalmentsMinor += take("instalment", i.id, outstanding(i));
  return { lines, instalmentsMinor, penaltiesMinor, chargesMinor, unallocatedMinor: left };
}

/**
 * Penalties to charge on `today` for instalments that are overdue: a flat fee or a percentage of
 * what was overdue, once; or a daily fee for every overdue day not yet charged (missed days are
 * caught up), up to the cap per instalment.
 */
export function penaltiesToCharge(
  instalments: readonly InstalmentState[],
  existing: readonly PenaltyState[],
  rule: PenaltyRule,
  today: string,
  graceDays: number,
): readonly Readonly<{ instalmentId: string; chargedOn: string; amountMinor: number }>[] {
  if (rule.kind === "none") return [];
  const charges: { instalmentId: string; chargedOn: string; amountMinor: number }[] = [];
  for (const i of instalments) {
    const owed = outstanding(i);
    const from = overdueFrom(i.dueOn, graceDays);
    if (owed <= 0 || today < from) continue;
    const mine = existing.filter((p) => p.instalmentId === i.id);
    if (rule.kind === "flat" || rule.kind === "percent") {
      if (mine.length > 0) continue;
      const amountMinor =
        rule.kind === "flat" ? rule.amountMinor : Math.round((owed * Number(rule.percent)) / 100);
      if (amountMinor > 0) charges.push({ instalmentId: i.id, chargedOn: from, amountMinor });
      continue;
    }
    const charged = new Set(mine.map((p) => p.chargedOn));
    let total = mine.reduce((sum, p) => sum + p.amountMinor, 0);
    for (let d = 0; d <= daysBetween(from, today); d += 1) {
      const day = addDays(from, d);
      if (charged.has(day)) continue;
      const room =
        rule.capMinor === null
          ? rule.amountMinor
          : Math.min(rule.amountMinor, rule.capMinor - total);
      if (room <= 0) break;
      charges.push({ instalmentId: i.id, chargedOn: day, amountMinor: room });
      total += room;
    }
  }
  return charges;
}

/** Where an agreement stands on `today`: completed, active, in arrears or defaulted. */
export function position(
  instalments: readonly InstalmentState[],
  penalties: readonly PenaltyState[],
  today: string,
  policy: ArrearsPolicy,
  charges: readonly ChargeState[] = [],
): AgreementPosition {
  const sorted = [...instalments].sort((a, b) => a.number - b.number);
  const overdue = sorted.filter(
    (i) => outstanding(i) > 0 && today >= overdueFrom(i.dueOn, policy.graceDays),
  );
  const outstandingMinor = sorted.reduce((sum, i) => sum + outstanding(i), 0);
  const penaltiesOutstandingMinor = penalties.reduce((sum, p) => sum + outstanding(p), 0);
  const chargesOutstandingMinor = charges.reduce((sum, c) => sum + outstanding(c), 0);
  const overdueMinor = overdue.reduce((sum, i) => sum + outstanding(i), 0);
  const arrearsSince =
    overdue[0] === undefined ? null : overdueFrom(overdue[0].dueOn, policy.graceDays);
  const next = sorted.find((i) => outstanding(i) > 0);
  const status: AgreementPosition["status"] =
    outstandingMinor === 0 &&
    penaltiesOutstandingMinor === 0 &&
    chargesOutstandingMinor === 0 &&
    sorted.length > 0
      ? "completed"
      : overdue.length === 0
        ? "active"
        : overdue.length >= policy.defaultAfterOverdue ||
            daysBetween(arrearsSince!, today) >= policy.defaultAfterDays
          ? "defaulted"
          : "in_arrears";
  return {
    status,
    outstandingMinor,
    overdueMinor,
    overdueCount: overdue.length,
    penaltiesOutstandingMinor,
    chargesOutstandingMinor,
    arrearsSince,
    nextDue:
      next === undefined
        ? null
        : { number: next.number, dueOn: next.dueOn, outstandingMinor: outstanding(next) },
  };
}
