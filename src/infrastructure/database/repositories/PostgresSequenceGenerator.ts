import type { ISequenceGenerator } from "../../../application/ports/ISequenceGenerator.js";
import type { PostgresTransactionContext } from "../postgres/PostgresTransactionContext.js";

const COUNTER_KEY = /^[a-z][a-z0-9_.:-]{0,99}$/;

/**
 * Counters table with an upsert: the row lock is held until the unit of work ends, so
 * concurrent callers get distinct values and a rollback returns the number (no gaps).
 */
export class PostgresSequenceGenerator implements ISequenceGenerator {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async next(key: string): Promise<number> {
    if (!COUNTER_KEY.test(key)) throw new Error(`Invalid counter key: ${key}`);

    const { rows } = await this.transactions.current().query<{ value: string }>(
      `insert into counters (key, value) values ($1, 1)
       on conflict (key) do update set value = counters.value + 1, updated_at = now()
       returning value`,
      [key],
    );
    const value = Number(rows[0]?.value);
    if (!Number.isSafeInteger(value)) throw new Error(`Counter ${key} returned an invalid value`);
    return value;
  }
}
