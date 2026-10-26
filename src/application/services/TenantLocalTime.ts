export type LocalDateTime = Readonly<{
  /** YYYY-MM-DD in the tenant's timezone. */
  date: string;
  /** 0–23 in the tenant's timezone. */
  hour: number;
  /** 0–59. */
  minute: number;
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
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** The instant a YYYY-MM-DD date starts in an IANA timezone (its local midnight). */
export function localMidnight(date: string, timeZone: string): Date {
  const target = Date.parse(`${date}T00:00:00Z`);
  let guess = target;
  // Two corrections settle any offset, including a change of offset that day.
  for (let i = 0; i < 2; i++) {
    const local = localDateTime(new Date(guess), timeZone);
    const seen = Date.parse(
      `${local.date}T${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}:00Z`,
    );
    guess += target - seen;
  }
  return new Date(guess);
}
