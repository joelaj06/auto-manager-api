import { DomainError } from "../errors/DomainError.js";

export class ReportRangeError extends DomainError {
  readonly code = "REPORT_RANGE";
  constructor(message: string) {
    super(message);
  }
}

export const GRANULARITIES = ["day", "week", "month"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** One point of a chart: a calendar day, ISO week (Mon–Sun) or month, cut to the range. */
export type Bucket = Readonly<{
  /** `2026-10-19`, `2026-W43` or `2026-10`. */
  key: string;
  from: string;
  to: string;
}>;

/** The longest range a dashboard covers (two years and a day). */
export const MAX_RANGE_DAYS = 731;

const DAY_MS = 86_400_000;
const toTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toDate = (time: number) => new Date(time).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  return toDate(toTime(date) + days * DAY_MS);
}

/** ISO 8601 week of a date: weeks start on Monday and belong to the year of their Thursday. */
export function isoWeek(date: string): Readonly<{ year: number; week: number; monday: string }> {
  const time = toTime(date);
  const weekday = (new Date(time).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  const monday = time - weekday * DAY_MS;
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return { year, week, monday: toDate(monday) };
}

/** The bucket key of a date. */
export function bucketKey(date: string, granularity: Granularity): string {
  if (granularity === "day") return date;
  if (granularity === "month") return date.slice(0, 7);
  const { year, week } = isoWeek(date);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * A reporting period on business dates (docs/14 §5, audit H12–H13): whole days in the tenant's
 * calendar, both ends included. Charts get one bucket per calendar day, ISO week or month that
 * touches the range — never a fixed number of slots.
 */
export class DateRange {
  private constructor(
    readonly from: string,
    readonly to: string,
  ) {}

  /** The range asked for; without `from`, the month of `to` (or of today) up to that day. */
  static of(from: string | undefined, to: string | undefined, today: string): DateRange {
    const end = to ?? today;
    const start = from ?? `${end.slice(0, 7)}-01`;
    if (start > end) throw new ReportRangeError("The start date must not be after the end date");
    const range = new DateRange(start, end);
    if (range.days > MAX_RANGE_DAYS)
      throw new ReportRangeError(`A report covers at most ${MAX_RANGE_DAYS} days`);
    return range;
  }

  get days(): number {
    return Math.round((toTime(this.to) - toTime(this.from)) / DAY_MS) + 1;
  }

  /** The same number of days just before this range (for "vs previous period"). */
  previous(): DateRange {
    return new DateRange(addDays(this.from, -this.days), addDays(this.from, -1));
  }

  /** The range cut to end on `date` at the latest (null when it starts after it). */
  until(date: string): DateRange | null {
    if (this.from > date) return null;
    return this.to <= date ? this : new DateRange(this.from, date);
  }

  /** Days for up to a month, weeks up to a quarter, months beyond. */
  defaultGranularity(): Granularity {
    if (this.days <= 31) return "day";
    if (this.days <= 92) return "week";
    return "month";
  }

  buckets(granularity: Granularity): Bucket[] {
    const buckets: Bucket[] = [];
    let start = this.from;
    while (start <= this.to) {
      const end = min(bucketEnd(start, granularity), this.to);
      buckets.push({ key: bucketKey(start, granularity), from: start, to: end });
      start = addDays(end, 1);
    }
    return buckets;
  }
}

function bucketEnd(date: string, granularity: Granularity): string {
  if (granularity === "day") return date;
  if (granularity === "week") return addDays(isoWeek(date).monday, 6);
  const [y, m] = date.split("-").map(Number) as [number, number];
  return toDate(Date.UTC(y, m, 0)); // day 0 of the next month: the last day of this one
}

const min = (a: string, b: string) => (a < b ? a : b);

/**
 * Sums dated rows into the buckets of a range (rows outside it are ignored). Every bucket is
 * present, empty ones with zeros.
 */
export function series<K extends string>(
  range: DateRange,
  granularity: Granularity,
  rows: readonly (Readonly<{ date: string }> & Readonly<Record<K, number>>)[],
  fields: readonly K[],
): (Bucket & Readonly<Record<K, number>>)[] {
  const totals = new Map<string, Record<K, number>>();
  for (const b of range.buckets(granularity))
    totals.set(b.key, Object.fromEntries(fields.map((f) => [f, 0])) as Record<K, number>);
  for (const row of rows) {
    if (row.date < range.from || row.date > range.to) continue;
    const bucket = totals.get(bucketKey(row.date, granularity))!;
    for (const f of fields) bucket[f] += row[f];
  }
  return range.buckets(granularity).map((b) => ({ ...b, ...totals.get(b.key)! }));
}
