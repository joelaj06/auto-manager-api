import type { Queryable } from "./types.js";

const COUNTER_KEY = /^[a-z][a-z0-9_.:-]{0,99}$/;

/**
 * Allocates the next value of a named counter (1, 2, 3, …). The row lock is held until the
 * surrounding transaction ends, so concurrent callers get distinct values, and a rolled-back
 * transaction gives its number back (no gaps).
 *
 * Call it inside a transaction. Keys are per database, e.g. "rental:2026".
 */
export async function nextCounterValue(db: Queryable, key: string): Promise<number> {
  if (!COUNTER_KEY.test(key)) {
    throw new Error(`Invalid counter key: ${key}`);
  }
  const { rows } = await db.query<{ value: string }>(
    `insert into counters (key, value) values ($1, 1)
     on conflict (key) do update set value = counters.value + 1, updated_at = now()
     returning value`,
    [key],
  );
  const value = Number(rows[0]?.value);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Counter ${key} returned an invalid value`);
  }
  return value;
}

export type SequenceCodeFormat = Readonly<{
  prefix: string;
  value: number;
  /** Minimum number of digits, zero-padded. */
  padding?: number;
  year?: number;
}>;

/** Formats a human-readable code: RT-000123, or RT-2026-000123 when a year is given. */
export function formatSequenceCode({
  prefix,
  value,
  padding = 6,
  year,
}: SequenceCodeFormat): string {
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(prefix)) {
    throw new Error(`Invalid code prefix: ${prefix}`);
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid sequence value: ${value}`);
  }
  const number = String(value).padStart(padding, "0");
  return year === undefined ? `${prefix}-${number}` : `${prefix}-${year}-${number}`;
}
