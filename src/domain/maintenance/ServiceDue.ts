import type { ServiceTaskProps } from "./ServicePlan.js";

export const DUE_STATUSES = ["scheduled", "upcoming", "due", "overdue"] as const;
export type DueStatus = (typeof DUE_STATUSES)[number];
/** The statuses that alert, in order. */
export type AlertStatus = Exclude<DueStatus, "scheduled">;

export type DueBase = Readonly<{ km: number | null; on: string }>;

export type DuePoint = Readonly<{ dueKm: number | null; dueOn: string | null }>;

type Intervals = Pick<
  ServiceTaskProps,
  "everyKm" | "everyDays" | "noticeKm" | "noticeDays" | "graceKm" | "graceDays"
>;

/**
 * When a task is due again from its base (the last service, or when the plan started applying):
 * the km and/or the date, whichever comes first. Without an odometer reading only the date
 * counts (decision 376).
 */
export function duePoint(task: Intervals, base: DueBase): DuePoint {
  return {
    dueKm: task.everyKm === null || base.km === null ? null : base.km + task.everyKm,
    dueOn: task.everyDays === null ? null : addDays(base.on, task.everyDays),
  };
}

/**
 * Where the vehicle stands against a due point: `upcoming` within the task's notice, `due` from
 * the km or the date, `overdue` past the grace (decision 376). The furthest along of km and date
 * wins.
 */
export function dueStatus(
  task: Intervals,
  point: DuePoint,
  now: Readonly<{ km: number | null; today: string }>,
): DueStatus {
  const order: DueStatus[] = ["scheduled"];
  if (point.dueKm !== null && now.km !== null) {
    if (now.km >= point.dueKm + task.graceKm) order.push("overdue");
    else if (now.km >= point.dueKm) order.push("due");
    else if (now.km >= point.dueKm - task.noticeKm) order.push("upcoming");
  }
  if (point.dueOn !== null) {
    if (now.today > addDays(point.dueOn, task.graceDays)) order.push("overdue");
    else if (now.today >= point.dueOn) order.push("due");
    else if (now.today >= addDays(point.dueOn, -task.noticeDays)) order.push("upcoming");
  }
  return order.reduce((a, b) => (rank(b) > rank(a) ? b : a));
}

export const rank = (status: DueStatus): number => DUE_STATUSES.indexOf(status);

/**
 * Whether a status needs an alert: it reached a later alerting status than the one last
 * alerted for this due point (once per status).
 */
export function alertFor(status: DueStatus, alerted: AlertStatus | null): AlertStatus | null {
  if (status === "scheduled") return null;
  return alerted !== null && rank(alerted) >= rank(status) ? null : status;
}

/**
 * The base after an odometer replacement: a reading below the base restarts the count from the
 * new odometer (the km already driven since the last service are unknown).
 */
export function rebase(base: DueBase, km: number | null): DueBase {
  return base.km !== null && km !== null && km < base.km ? { km, on: base.on } : base;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
