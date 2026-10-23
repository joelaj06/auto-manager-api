import { DomainError } from "../errors/DomainError.js";
import type { BillingDate } from "./Subscription.js";

export type NoticeChannel = "email" | "sms" | "in_app" | "push";
export const NOTICE_CHANNELS: readonly NoticeChannel[] = ["email", "sms", "in_app", "push"];

/** The schedule and safeguards of the billing automation (docs/25 §5.1, §5.6), versioned. */
export type DunningPolicy = Readonly<{
  /** Days before the period starts that its invoice is issued (it is due on the start). */
  invoiceLeadDays: number;
  /** Reminders, in days before the due date. */
  reminderDaysBefore: readonly number[];
  /** Overdue reminders, in days after the due date. */
  overdueReminderDays: readonly number[];
  /** Days after the due date the tenant is deactivated (end of grace). */
  graceDays: number;
  /** The optional read-only step, days after the due date; null: off (the default). */
  readOnlyAfterDays: number | null;
  /** Grace days skip Sundays. */
  skipSundays: boolean;
  extension: Readonly<{ maxDays: number; maxPer90Days: number; finalGraceDays: number }>;
  /** Log who would be deactivated (and set read-only) instead of doing it. */
  dryRun: boolean;
  /** A run that would deactivate more than this stops (count, or percent of operating tenants). */
  circuitBreaker: Readonly<{ maxCount: number; maxPercent: number }>;
  /** Tenants with at least this many billed branches are flagged in the review queue. */
  reviewBranchThreshold: number;
  /** More failed webhooks than this in 24 h pauses deactivation. */
  gatewayGuard: Readonly<{ maxFailedWebhooks24h: number }>;
  channels: readonly NoticeChannel[];
}>;

export class DunningRuleError extends DomainError {
  readonly code = "DUNNING_RULE";
  constructor(message: string) {
    super(message);
  }
}

const DAY_MS = 86_400_000;
const whole = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

/** Checks a policy staff save (the extension cap of 10 days is decision 44). */
export function dunningPolicy(input: DunningPolicy): DunningPolicy {
  const days = (list: readonly number[], what: string) => {
    if (list.length > 10 || !list.every((d) => whole(d, 1, 60)))
      throw new DunningRuleError(`${what} are whole days between 1 and 60 (at most 10)`);
    return [...new Set(list)].sort((a, b) => b - a);
  };
  if (!whole(input.invoiceLeadDays, 0, 30))
    throw new DunningRuleError("Invoices are issued 0 to 30 days before they are due");
  if (!whole(input.graceDays, 1, 30))
    throw new DunningRuleError("The grace period is 1 to 30 days");
  const overdue = days(input.overdueReminderDays, "Overdue reminders").reverse();
  if (overdue.some((d) => d >= input.graceDays))
    throw new DunningRuleError("Overdue reminders come before the end of the grace period");
  if (
    input.readOnlyAfterDays !== null &&
    !(whole(input.readOnlyAfterDays, 1, 30) && input.readOnlyAfterDays < input.graceDays)
  )
    throw new DunningRuleError("The read-only step comes before the end of the grace period");
  const { extension, circuitBreaker } = input;
  if (!whole(extension.maxDays, 1, 10))
    throw new DunningRuleError("An extension is at most 10 days");
  if (!whole(extension.maxPer90Days, 0, 10) || !whole(extension.finalGraceDays, 0, 7))
    throw new DunningRuleError("Extension limits are out of range");
  if (!whole(circuitBreaker.maxCount, 1, 10_000) || !whole(circuitBreaker.maxPercent, 1, 100))
    throw new DunningRuleError("The circuit breaker needs a count and a percent (1–100)");
  if (!whole(input.reviewBranchThreshold, 1, 1_000))
    throw new DunningRuleError("The review threshold is a number of branches");
  if (!whole(input.gatewayGuard.maxFailedWebhooks24h, 0, 10_000))
    throw new DunningRuleError("The gateway guard needs a number of failed webhooks");
  if (input.channels.length === 0 || !input.channels.every((c) => NOTICE_CHANNELS.includes(c)))
    throw new DunningRuleError("Choose at least one channel: email, sms, in_app, push");
  return {
    ...input,
    reminderDaysBefore: days(input.reminderDaysBefore, "Reminders"),
    overdueReminderDays: overdue,
    channels: [...new Set(input.channels)],
  };
}

export const addDays = (date: BillingDate, days: number): BillingDate =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export const daysBetween = (from: BillingDate, to: BillingDate): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

const isSunday = (date: BillingDate) => new Date(`${date}T00:00:00Z`).getUTCDay() === 0;

/** `days` grace days after `from`, not counting Sundays when the policy says so. */
function graceEnd(from: BillingDate, days: number, skipSundays: boolean): BillingDate {
  if (!skipSundays) return addDays(from, days);
  let date = from;
  for (let left = days; left > 0;) {
    date = addDays(date, 1);
    if (!isSunday(date)) left--;
  }
  return date;
}

/** The day the tenant is deactivated if the invoice is still unpaid. */
export function deactivationDate(
  dueOn: BillingDate,
  policy: DunningPolicy,
  extendedUntil: BillingDate | null,
): BillingDate {
  const normal = graceEnd(dueOn, policy.graceDays, policy.skipSundays);
  if (extendedUntil === null) return normal;
  const extended = graceEnd(extendedUntil, policy.extension.finalGraceDays, policy.skipSundays);
  return extended > normal ? extended : normal;
}

/** What the automation does today for one unpaid invoice. Notices are steps, sent once. */
export type DunningPlan = Readonly<{
  notices: readonly string[];
  /** Try the default saved card (due day, and once more the day after). */
  charge: boolean;
  pastDue: boolean;
  readOnly: boolean;
  deactivate: boolean;
  deactivateOn: BillingDate;
}>;

/**
 * The schedule (docs/25 §5.1) for an unpaid invoice due on `dueOn`, as of `today`:
 * reminders −7/−3/−1, due-day charge and notice, past due from +1 with overdue reminders
 * +1/+3/+5, a final notice the day before deactivation and deactivation at the end of grace.
 * An approved extension moves the deadline (reminders −3/−1 before its date, then a short final
 * grace). State changes catch up when a run was missed; reminders do not.
 */
export function planDunning(
  dueOn: BillingDate,
  today: BillingDate,
  policy: DunningPolicy,
  extendedUntil: BillingDate | null,
): DunningPlan {
  const deactivateOn = deactivationDate(dueOn, policy, extendedUntil);
  const toDue = daysBetween(today, dueOn);
  const overdue = -toDue;
  const notices: string[] = [];
  if (policy.reminderDaysBefore.includes(toDue)) notices.push(`reminder_${toDue}`);
  if (toDue === 0) notices.push("due");
  if (policy.overdueReminderDays.includes(overdue)) notices.push(`overdue_${overdue}`);
  if (extendedUntil !== null) {
    const toExtended = daysBetween(today, extendedUntil);
    if (toExtended === 3 || toExtended === 1) notices.push(`extension_reminder_${toExtended}`);
  }
  if (daysBetween(today, deactivateOn) === 1) notices.push("final_notice");
  const deactivate = today >= deactivateOn;
  return {
    notices: deactivate ? [] : notices,
    charge: toDue === 0 || overdue === 1,
    pastDue: overdue >= 1,
    readOnly:
      !deactivate &&
      policy.readOnlyAfterDays !== null &&
      overdue >= policy.readOnlyAfterDays &&
      (extendedUntil === null || today > extendedUntil),
    deactivate,
    deactivateOn,
  };
}

/**
 * A tenant asking for more time (docs/25 §5.4): at most `maxDays` after the due date, in the
 * future, and within the rolling 90-day count — over it, only a Super Admin may approve.
 */
export function checkExtension(
  params: Readonly<{
    dueOn: BillingDate;
    until: BillingDate;
    today: BillingDate;
    policy: DunningPolicy;
    approvedInLast90Days: number;
  }>,
): Readonly<{ overLimit: boolean }> {
  const { dueOn, until, today, policy } = params;
  if (until <= today) throw new DunningRuleError("Ask for a date in the future");
  if (daysBetween(dueOn, until) > policy.extension.maxDays)
    throw new DunningRuleError(
      `An extension is at most ${policy.extension.maxDays} days after the due date`,
    );
  return { overLimit: params.approvedInLast90Days >= policy.extension.maxPer90Days };
}

/** Below this many operating tenants only the count limit applies (one tenant is not 10 %). */
const PERCENT_MIN_TENANTS = 50;

/** The circuit breaker: too many deactivations in one run stops it (docs/25 §5.6). */
export function circuitBreakerTrips(
  deactivations: number,
  operatingTenants: number,
  policy: DunningPolicy,
): boolean {
  if (deactivations === 0) return false;
  if (deactivations > policy.circuitBreaker.maxCount) return true;
  return (
    operatingTenants >= PERCENT_MIN_TENANTS &&
    deactivations * 100 > policy.circuitBreaker.maxPercent * operatingTenants
  );
}
