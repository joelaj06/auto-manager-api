/** What a portfolio figure needs of an agreement. */
export type PortfolioAgreement = Readonly<{
  status: string;
  instalmentsMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  penaltiesOutstandingMinor: number;
  chargesOutstandingMinor: number;
  arrearsSince: string | null;
}>;

export type PortfolioSummary = Readonly<{
  byStatus: Readonly<Record<string, number>>;
  /** Running agreements (active, in arrears, defaulted). */
  running: number;
  /** Instalments of running and completed agreements. */
  financedMinor: number;
  collectedMinor: number;
  /** Still owed on running agreements. */
  outstandingMinor: number;
  overdueMinor: number;
  penaltiesOutstandingMinor: number;
  chargesOutstandingMinor: number;
  /** Collected over financed (one decimal). */
  completionPercent: number | null;
}>;

/** Portfolio at risk: the outstanding of agreements more than `days` in arrears. */
export type ParBucket = Readonly<{
  days: number;
  agreements: number;
  outstandingMinor: number;
  /** Of the running portfolio's outstanding (one decimal). */
  percent: number | null;
}>;

export type Forecast = Readonly<{
  next7Minor: number;
  next30Minor: number;
  next90Minor: number;
  /** 13 weeks from tomorrow. */
  weeks: readonly Readonly<{ from: string; to: string; amountMinor: number }>[];
}>;

export const PAR_DAYS = [7, 30, 60, 90] as const;
const RUNNING = new Set(["active", "in_arrears", "defaulted"]);
const DAY_MS = 86_400_000;

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const percent = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 10;
const sum = <T>(rows: readonly T[], pick: (row: T) => number) =>
  rows.reduce((total, row) => total + pick(row), 0);

/** Days an agreement has been in arrears on `today` (the first overdue day counts as 1). */
export const daysInArrears = (arrearsSince: string | null, today: string) =>
  arrearsSince === null
    ? 0
    : Math.round(
        (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${arrearsSince}T00:00:00Z`)) / DAY_MS,
      ) + 1;

export function portfolioSummary(rows: readonly PortfolioAgreement[]): PortfolioSummary {
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const running = rows.filter((r) => RUNNING.has(r.status));
  const financedMinor = sum(rows, (r) => r.instalmentsMinor);
  const collectedMinor = sum(rows, (r) => r.paidMinor);
  return {
    byStatus,
    running: running.length,
    financedMinor,
    collectedMinor,
    outstandingMinor: sum(running, (r) => r.outstandingMinor),
    overdueMinor: sum(running, (r) => r.overdueMinor),
    penaltiesOutstandingMinor: sum(running, (r) => r.penaltiesOutstandingMinor),
    chargesOutstandingMinor: sum(running, (r) => r.chargesOutstandingMinor),
    completionPercent: percent(collectedMinor, financedMinor),
  };
}

export function portfolioAtRisk(
  rows: readonly PortfolioAgreement[],
  today: string,
): readonly ParBucket[] {
  const running = rows.filter((r) => RUNNING.has(r.status));
  const total = sum(running, (r) => r.outstandingMinor);
  return PAR_DAYS.map((days) => {
    const late = running.filter((r) => daysInArrears(r.arrearsSince, today) > days);
    const outstandingMinor = sum(late, (r) => r.outstandingMinor);
    return {
      days,
      agreements: late.length,
      outstandingMinor,
      percent: percent(outstandingMinor, total),
    };
  });
}

/** What comes due after `today`: in 7, 30 and 90 days, and week by week. */
export function forecast(
  due: readonly Readonly<{ dueOn: string; outstandingMinor: number }>[],
  today: string,
): Forecast {
  const within = (days: number) =>
    sum(
      due.filter((d) => d.dueOn > today && d.dueOn <= addDays(today, days)),
      (d) => d.outstandingMinor,
    );
  const weeks = Array.from({ length: 13 }, (_, k) => {
    const from = addDays(today, 1 + 7 * k);
    const to = addDays(from, 6);
    return {
      from,
      to,
      amountMinor: sum(
        due.filter((d) => d.dueOn >= from && d.dueOn <= to),
        (d) => d.outstandingMinor,
      ),
    };
  });
  return { next7Minor: within(7), next30Minor: within(30), next90Minor: within(90), weeks };
}

/** Paid over due for instalments due in a window (one decimal). */
export const collectionRate = (dueMinor: number, paidMinor: number) => percent(paidMinor, dueMinor);
