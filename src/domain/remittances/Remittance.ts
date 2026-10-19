import { DomainError } from "../errors/DomainError.js";

export type RemittanceMode = "fixed_target" | "variable";
export const REMITTANCE_STATUSES = [
  "pending",
  "submitted",
  "partially_paid",
  "paid",
  "overdue",
  "waived",
] as const;
export type RemittanceStatus = (typeof REMITTANCE_STATUSES)[number];

export class RemittanceRuleError extends DomainError {
  readonly code = "REMITTANCE_RULE";
  constructor(message: string) {
    super(message);
  }
}

export type RemittanceProps = Readonly<{
  id: string;
  number: string | null;
  assignmentId: string;
  driverId: string;
  vehicleId: string;
  branchId: string;
  mode: RemittanceMode;
  periodStart: string;
  periodEnd: string;
  expectedMinor: number | null;
  receivedMinor: number;
  waivedMinor: number;
  accruedMinor: number;
  status: RemittanceStatus;
  createdAt: Date;
  updatedAt: Date;
}>;

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * A driver's remittance for one period (docs/09 §2). Fixed target: the target falls due as income
 * owed by the driver (accrued once, when the period is over or money is confirmed); confirmed
 * money settles it and what is missing is the shortfall on the driver's ledger, unless waived.
 * Variable: no target — what is confirmed is the period's income.
 */
export class Remittance {
  private constructor(private props: RemittanceProps) {}

  static expected(
    params: Readonly<{
      id: string;
      assignmentId: string;
      driverId: string;
      vehicleId: string;
      branchId: string;
      periodStart: string;
      periodEnd: string;
      expectedMinor: number;
      now: Date;
    }>,
  ): Remittance {
    if (!Number.isSafeInteger(params.expectedMinor) || params.expectedMinor <= 0)
      throw new RemittanceRuleError("A target is above zero");
    return new Remittance({
      ...params,
      number: null,
      mode: "fixed_target",
      receivedMinor: 0,
      waivedMinor: 0,
      accruedMinor: 0,
      status: "pending",
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static variable(
    params: Readonly<{
      id: string;
      assignmentId: string;
      driverId: string;
      vehicleId: string;
      branchId: string;
      periodStart: string;
      periodEnd: string;
      now: Date;
    }>,
  ): Remittance {
    if (params.periodEnd < params.periodStart)
      throw new RemittanceRuleError("A period ends after it starts");
    return new Remittance({
      ...params,
      number: null,
      mode: "variable",
      expectedMinor: null,
      receivedMinor: 0,
      waivedMinor: 0,
      accruedMinor: 0,
      status: "pending",
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static restore(props: RemittanceProps): Remittance {
    return new Remittance(props);
  }

  get id(): string {
    return this.props.id;
  }

  snapshot(): RemittanceProps {
    return this.props;
  }

  /** Still owed for the period (fixed target only). */
  get outstandingMinor(): number {
    const p = this.props;
    return p.expectedMinor === null
      ? 0
      : Math.max(0, p.expectedMinor - p.receivedMinor - p.waivedMinor);
  }

  numbered(number: string): void {
    if (this.props.number === null) this.props = { ...this.props, number };
  }

  /** Fixed target: the income not yet posted (the whole target, once). */
  accrueTarget(now: Date): number {
    const p = this.props;
    if (p.expectedMinor === null) return 0;
    const due = p.expectedMinor - p.accruedMinor;
    if (due <= 0) return 0;
    this.props = { ...p, accruedMinor: p.expectedMinor, updatedAt: now };
    return due;
  }

  /**
   * Confirmed money: returns how much of it settles what the driver owes for this period (the
   * rest stays as the driver's credit). Variable periods: the money is the income, all settled.
   */
  receive(amountMinor: number, now: Date): Readonly<{ settled: number; income: number }> {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
      throw new RemittanceRuleError("Confirm an amount above zero");
    const p = this.props;
    if (p.mode === "variable") {
      this.props = {
        ...p,
        receivedMinor: p.receivedMinor + amountMinor,
        accruedMinor: p.accruedMinor + amountMinor,
        updatedAt: now,
      };
      return { settled: amountMinor, income: amountMinor };
    }
    const settled = Math.min(amountMinor, this.outstandingMinor);
    this.props = { ...p, receivedMinor: p.receivedMinor + amountMinor, updatedAt: now };
    return { settled, income: 0 };
  }

  /** A confirmed payment was reversed. */
  release(amountMinor: number, income: number, now: Date): void {
    const p = this.props;
    this.props = {
      ...p,
      receivedMinor: Math.max(0, p.receivedMinor - amountMinor),
      accruedMinor: Math.max(0, p.accruedMinor - income),
      updatedAt: now,
    };
  }

  /** Forgives (part of) the shortfall; returns the amount waived. */
  waive(amountMinor: number | null, reason: string, now: Date): number {
    if (this.props.mode !== "fixed_target")
      throw new RemittanceRuleError("Only a target can be waived");
    if (reason.trim().length < 3) throw new RemittanceRuleError("Give a reason for waiving it");
    const amount = amountMinor ?? this.outstandingMinor;
    if (amount <= 0 || amount > this.outstandingMinor)
      throw new RemittanceRuleError("Waive at most what is still owed for the period");
    this.props = { ...this.props, waivedMinor: this.props.waivedMinor + amount, updatedAt: now };
    return amount;
  }

  /** Recomputes the status for `today` (overdue once the period plus the grace days has passed). */
  refresh(today: string, graceDays: number, openSubmission: boolean, now: Date): void {
    const p = this.props;
    let status: RemittanceStatus;
    if (p.mode === "variable")
      status = p.receivedMinor > 0 ? "paid" : openSubmission ? "submitted" : "pending";
    else if (this.outstandingMinor === 0)
      status = p.receivedMinor >= p.expectedMinor! ? "paid" : "waived";
    else if (openSubmission) status = "submitted";
    else if (addDays(p.periodEnd, graceDays) < today) status = "overdue";
    else if (p.receivedMinor > 0) status = "partially_paid";
    else status = "pending";
    if (status !== p.status) this.props = { ...p, status, updatedAt: now };
  }

  /** The period's target is due as income: the period (plus grace) has passed. */
  isDue(today: string, graceDays: number): boolean {
    return addDays(this.props.periodEnd, graceDays) < today;
  }
}

export type PeriodTerms = Readonly<{
  frequency: "daily" | "weekly" | "monthly";
  /** 0 = Sunday … 6 = Saturday (daily targets). */
  daysOff: readonly number[];
}>;

/**
 * The target periods of an assignment between `from` and `upTo` (inclusive), anchored on the
 * assignment's first day: every working day, every 7 days, or every month on the start day.
 * Periods never run past the assignment's last day; a period that began is due in full.
 */
export function targetPeriods(
  terms: PeriodTerms,
  assignmentStart: string,
  assignmentEnd: string | null,
  from: string,
  upTo: string,
): { start: string; end: string }[] {
  const last = assignmentEnd !== null && assignmentEnd < upTo ? assignmentEnd : upTo;
  const periods: { start: string; end: string }[] = [];
  const startDay = Number(assignmentStart.slice(8, 10));
  for (let k = 0; periods.length < 1_000; k += 1) {
    let start: string;
    let next: string;
    if (terms.frequency === "daily") {
      start = addDays(assignmentStart, k);
      next = addDays(start, 1);
    } else if (terms.frequency === "weekly") {
      start = addDays(assignmentStart, 7 * k);
      next = addDays(start, 7);
    } else {
      start = monthAnchor(assignmentStart, k, startDay);
      next = monthAnchor(assignmentStart, k + 1, startDay);
    }
    if (start > last) break;
    if (start < from) continue;
    if (
      terms.frequency === "daily" &&
      terms.daysOff.includes(new Date(`${start}T00:00:00Z`).getUTCDay())
    )
      continue;
    const end = addDays(next, -1);
    periods.push({
      start,
      end: assignmentEnd !== null && end > assignmentEnd ? assignmentEnd : end,
    });
  }
  return periods;
}

function monthAnchor(date: string, months: number, day: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

export type ShortfallAgeing = Readonly<{
  /** Owed for periods that ended 0–7, 8–30 and more than 30 days ago. */
  days0to7: number;
  days8to30: number;
  over30: number;
}>;

export function ageShortfalls(
  rows: readonly Readonly<{ periodEnd: string; outstandingMinor: number }>[],
  today: string,
): ShortfallAgeing {
  const ageing = { days0to7: 0, days8to30: 0, over30: 0 };
  for (const row of rows) {
    const age = Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.periodEnd}T00:00:00Z`)) / DAY_MS,
    );
    if (age > 30) ageing.over30 += row.outstandingMinor;
    else if (age > 7) ageing.days8to30 += row.outstandingMinor;
    else ageing.days0to7 += row.outstandingMinor;
  }
  return ageing;
}
