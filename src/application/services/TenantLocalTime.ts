export type LocalDateTime = Readonly<{
  /** YYYY-MM-DD in the tenant's timezone. */
  date: string;
  /** 0–23 in the tenant's timezone. */
  hour: number;
}>;

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar date and hour at `instant` in an IANA timezone (e.g. "Africa/Accra").
 * Throws RangeError for an unknown timezone.
 */
export function localDateTime(instant: Date, timeZone: string): LocalDateTime {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
