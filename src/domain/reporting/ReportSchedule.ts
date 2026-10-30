import { addDays, isoWeek } from "./DateRange.js";
import { ReportRuleError, type FileFormat, type ParamValues } from "./Report.js";

export const SCHEDULE_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

/** The period a scheduled run covers, worked out on the day it runs. */
export const SCHEDULE_PERIODS = [
  "previous_day",
  "previous_week",
  "previous_month",
  "week_to_date",
  "month_to_date",
] as const;
export type SchedulePeriod = (typeof SCHEDULE_PERIODS)[number];

export const SCHEDULE_STATUSES = ["active", "paused"] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

/** Recipients of one schedule, and schedules per business (decision 474). */
export const MAX_RECIPIENTS = 20;
export const MAX_SCHEDULES = 100;

export type ScheduleTiming = Readonly<{
  frequency: ScheduleFrequency;
  /** ISO weekday 1 (Monday) – 7, for weekly runs. */
  weekday: number | null;
  /** 1–28, for monthly runs (every month has it). */
  monthDay: number | null;
  /** Local hour 0–23 of the run. */
  hour: number;
}>;

export type ScheduleDetails = ScheduleTiming &
  Readonly<{
    name: string;
    reportId: string;
    params: ParamValues;
    period: SchedulePeriod | null;
    format: FileFormat;
    recipients: readonly string[];
  }>;

export type ReportScheduleProps = ScheduleDetails &
  Readonly<{
    id: string;
    status: ScheduleStatus;
    /** Who the report runs as: the schedule's owner. */
    ownerId: string;
    nextRunAt: Date;
    lastRunAt: Date | null;
    lastJobId: string | null;
    /** Why the last run could not start, or why the schedule was paused. */
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;

/** The days a period covers when the run is on `today` (local dates). */
export function periodDates(
  period: SchedulePeriod,
  today: string,
): Readonly<{ from: string; to: string }> {
  const yesterday = addDays(today, -1);
  const monday = isoWeek(today).monday;
  switch (period) {
    case "previous_day":
      return { from: yesterday, to: yesterday };
    case "previous_week":
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case "previous_month": {
      const first = `${today.slice(0, 7)}-01`;
      const last = addDays(first, -1);
      return { from: `${last.slice(0, 7)}-01`, to: last };
    }
    case "week_to_date":
      return { from: monday, to: today };
    case "month_to_date":
      return { from: `${today.slice(0, 7)}-01`, to: today };
  }
}

/**
 * The parameters of a run: the schedule's own, with the period put into the report's period
 * parameters — `from` and `to`, an `asOf` date at its end, a `month` it ends in.
 */
export function runParams(
  details: Pick<ScheduleDetails, "params" | "period">,
  paramKeys: readonly string[],
  today: string,
): ParamValues {
  if (details.period === null) return details.params;
  const { from, to } = periodDates(details.period, today);
  return {
    ...details.params,
    ...(paramKeys.includes("from") ? { from } : {}),
    ...(paramKeys.includes("to") ? { to } : {}),
    ...(paramKeys.includes("asOf") ? { asOf: to } : {}),
    ...(paramKeys.includes("month") ? { month: to.slice(0, 7) } : {}),
  };
}

/** Whether a local date is a run day. */
export function runsOn(timing: ScheduleTiming, date: string): boolean {
  if (timing.frequency === "daily") return true;
  if (timing.frequency === "weekly") {
    const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    return weekday === timing.weekday;
  }
  return Number(date.slice(8, 10)) === timing.monthDay;
}

/** The first run day on or after `date` (the timing checked first). */
export function nextRunDay(timing: ScheduleTiming, date: string): string {
  checkTiming(timing);
  let day = date;
  while (!runsOn(timing, day)) day = addDays(day, 1);
  return day;
}

export function checkTiming(t: ScheduleTiming): ScheduleTiming {
  if (!SCHEDULE_FREQUENCIES.includes(t.frequency))
    throw new ReportRuleError("A schedule runs daily, weekly or monthly");
  if (!Number.isInteger(t.hour) || t.hour < 0 || t.hour > 23)
    throw new ReportRuleError("The hour is 0 to 23");
  if (t.frequency === "weekly") {
    if (t.weekday === null || !Number.isInteger(t.weekday) || t.weekday < 1 || t.weekday > 7)
      throw new ReportRuleError("A weekly schedule needs a weekday from 1 (Monday) to 7 (Sunday)");
  } else if (t.weekday !== null) throw new ReportRuleError("Only a weekly schedule has a weekday");
  if (t.frequency === "monthly") {
    if (t.monthDay === null || !Number.isInteger(t.monthDay) || t.monthDay < 1 || t.monthDay > 28)
      throw new ReportRuleError("A monthly schedule needs a day of the month from 1 to 28");
  } else if (t.monthDay !== null)
    throw new ReportRuleError("Only a monthly schedule has a day of the month");
  return t;
}

function checkDetails(d: ScheduleDetails): ScheduleDetails {
  const name = d.name.trim();
  if (name.length < 1 || name.length > 120)
    throw new ReportRuleError("A schedule's name is 1 to 120 characters");
  if (d.period !== null && !SCHEDULE_PERIODS.includes(d.period))
    throw new ReportRuleError(`The period is one of ${SCHEDULE_PERIODS.join(", ")}`);
  const recipients = [...new Set(d.recipients)];
  if (recipients.length < 1 || recipients.length > MAX_RECIPIENTS)
    throw new ReportRuleError(`A schedule goes to 1 to ${MAX_RECIPIENTS} users`);
  checkTiming(d);
  return { ...d, name, recipients };
}

/**
 * A report sent on a schedule (docs/14 §7): a report with its parameters and a period worked
 * out on the run day, built as a file daily, weekly or monthly at a local hour as the schedule's
 * owner, and sent to users of the business; paused by hand, or when the owner may no longer run it.
 */
export class ReportSchedule {
  private constructor(private props: ReportScheduleProps) {}

  static create(
    input: ScheduleDetails & Readonly<{ id: string; ownerId: string; nextRunAt: Date; now: Date }>,
  ): ReportSchedule {
    const { now, id, ownerId, nextRunAt, ...details } = input;
    return new ReportSchedule({
      ...checkDetails(details),
      id,
      ownerId,
      status: "active",
      nextRunAt,
      lastRunAt: null,
      lastJobId: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: ReportScheduleProps): ReportSchedule {
    return new ReportSchedule(props);
  }

  get id(): string {
    return this.props.id;
  }

  get status(): ScheduleStatus {
    return this.props.status;
  }

  snapshot(): ReportScheduleProps {
    return this.props;
  }

  change(details: ScheduleDetails, nextRunAt: Date, now: Date): void {
    this.props = {
      ...this.props,
      ...checkDetails(details),
      nextRunAt,
      lastError: null,
      updatedAt: now,
    };
  }

  /** A run was queued as `jobId`; the next one is at `nextRunAt`. */
  ran(jobId: string, nextRunAt: Date, now: Date): void {
    if (this.props.status !== "active") throw new ReportRuleError("The schedule is paused");
    this.props = {
      ...this.props,
      lastRunAt: now,
      lastJobId: jobId,
      lastError: null,
      nextRunAt,
      updatedAt: now,
    };
  }

  /** The run could not start (no room, bad parameters): it is tried at `nextRunAt`. */
  missed(reason: string, nextRunAt: Date, now: Date): void {
    this.props = { ...this.props, lastError: reason.slice(0, 500), nextRunAt, updatedAt: now };
  }

  pause(reason: string | null, now: Date): void {
    if (this.props.status === "paused") return;
    this.props = {
      ...this.props,
      status: "paused",
      lastError: reason === null ? this.props.lastError : reason.slice(0, 500),
      updatedAt: now,
    };
  }

  resume(nextRunAt: Date, now: Date): void {
    if (this.props.status === "active") return;
    this.props = { ...this.props, status: "active", nextRunAt, lastError: null, updatedAt: now };
  }
}
