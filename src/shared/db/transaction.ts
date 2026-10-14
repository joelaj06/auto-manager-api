import type pg from "pg";
import type { Queryable } from "./types.js";

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

export type TransactionOptions = Readonly<{
  /** Applied with SET LOCAL semantics, so it is safe behind PgBouncer transaction pooling. */
  statementTimeoutMs?: number;
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
  /**
   * Custom transaction-local settings readable in SQL via current_setting('app.<name>', true),
   * e.g. { "app.user_id": "…" } for audit triggers.
   */
  settings?: Readonly<Record<string, string>>;
}>;

const SETTING_NAME = /^app\.[a-z][a-z0-9_]{0,62}$/;

function beginStatement(options: TransactionOptions): string {
  const parts = ["begin"];
  if (options.isolationLevel !== undefined) {
    parts.push(`isolation level ${options.isolationLevel}`);
  }
  if (options.readOnly === true) parts.push("read only");
  return parts.join(" ");
}

function localSettings(options: TransactionOptions): [string, string][] {
  const settings: [string, string][] = [];
  if (options.statementTimeoutMs !== undefined) {
    settings.push(["statement_timeout", String(Math.trunc(options.statementTimeoutMs))]);
  }
  for (const [name, value] of Object.entries(options.settings ?? {})) {
    if (!SETTING_NAME.test(name)) {
      throw new Error(`Invalid transaction setting name: ${name}`);
    }
    settings.push([name, value]);
  }
  return settings;
}

/**
 * Runs `fn` in a transaction on a connection from `pool`. Commits when `fn` resolves, rolls
 * back when it throws. `fn` receives a query-only handle so it cannot release the connection
 * or leave the transaction open.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (tx: Queryable) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const settings = localSettings(options);
  const client = await pool.connect();
  let releaseError: Error | undefined;

  try {
    await client.query(beginStatement(options));

    if (settings.length > 0) {
      const calls = settings.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`);
      await client.query(`select ${calls.join(", ")}`, settings.flat());
    }

    const tx: Queryable = {
      query: (text, params) => client.query(text, params),
    };
    const result = await fn(tx);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      // The connection is in an unknown state: destroy it instead of returning it to the pool.
      releaseError = rollbackError instanceof Error ? rollbackError : new Error("rollback failed");
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
