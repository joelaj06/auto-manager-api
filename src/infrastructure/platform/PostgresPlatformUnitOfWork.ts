import type pg from "pg";
import type { Attempt, IPlatformUnitOfWork } from "../../application/ports/IPlatformUnitOfWork.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";
import { PostgresTransactionRunner } from "../database/postgres/PostgresTransactionRunner.js";

/** IPlatformUnitOfWork on the platform pool, with savepoints for `attempt`. */
export class PostgresPlatformUnitOfWork implements IPlatformUnitOfWork {
  private savepoints = 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly transactions: PostgresTransactionContext,
    private readonly statementTimeoutMs: number,
    private readonly runner = new PostgresTransactionRunner(),
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactions.hasTransaction()) return work();
    const { result, afterCommit } = await this.runner.run(
      this.pool,
      (tx) => this.transactions.run(tx, work),
      { statementTimeoutMs: this.statementTimeoutMs },
    );
    for (const hook of afterCommit) await hook().catch(() => undefined);
    return result;
  }

  async attempt<T>(work: () => Promise<T>): Promise<Attempt<T>> {
    if (!this.transactions.hasTransaction()) {
      throw new Error("attempt() must run inside a platform unit of work");
    }
    const tx = this.transactions.current();
    const name = `attempt_${++this.savepoints}`;
    await tx.query(`savepoint ${name}`);
    try {
      const value = await work();
      await tx.query(`release savepoint ${name}`);
      return { ok: true, value };
    } catch (error) {
      await tx.query(`rollback to savepoint ${name}`);
      return { ok: false, error };
    }
  }
}
