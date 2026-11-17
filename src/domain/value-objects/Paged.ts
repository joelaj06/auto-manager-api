/** Which rows of a list to read: `limit` rows after skipping `offset`. */
export type PageWindow = Readonly<{ limit: number; offset?: number }>;

/** One window of a list, with how many rows the whole list has. */
export type Paged<T> = Readonly<{ rows: T[]; total: number }>;

/**
 * The money of a whole list, not just one window, in minor units of one currency: the list's
 * main amount, that amount for each status, and other amounts its rows carry.
 */
export type ListSums = Readonly<{
  amount: number;
  byStatus: Readonly<Record<string, number>>;
  measures: Readonly<Record<string, number>>;
}>;

/** One window of a list, its size and its sums. */
export type Summed<T> = Paged<T> & Readonly<{ sums: ListSums }>;

/** Sums of a list's rows already in hand, for a list worked out in memory. */
export function sumRows<T>(
  rows: readonly T[],
  spec: Readonly<{
    amount?: (row: T) => number;
    status?: (row: T) => string;
    measures?: Readonly<Record<string, (row: T) => number>>;
  }>,
): ListSums {
  let amount = 0;
  const byStatus: Record<string, number> = {};
  const measures: Record<string, number> = Object.fromEntries(
    Object.keys(spec.measures ?? {}).map((name) => [name, 0]),
  );
  for (const row of rows) {
    const value = spec.amount?.(row) ?? 0;
    amount += value;
    if (spec.status !== undefined) {
      const status = spec.status(row);
      byStatus[status] = (byStatus[status] ?? 0) + value;
    }
    for (const [name, of] of Object.entries(spec.measures ?? {}))
      measures[name] = (measures[name] ?? 0) + of(row);
  }
  return { amount, byStatus, measures };
}

/** A summed window of a list whose money is all in one known currency (platform billing). */
export type SummedIn<T> = Summed<T> & Readonly<{ currency: string }>;
