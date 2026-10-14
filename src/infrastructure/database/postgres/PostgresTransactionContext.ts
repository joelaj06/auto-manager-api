import { AsyncLocalStorage } from "node:async_hooks";
import { NoActiveTransactionError } from "../../../application/errors/TenantDatabaseErrors.js";
import type { Queryable } from "./Queryable.js";

/**
 * Holds the transaction of the current unit of work for the duration of an async call chain,
 * so singleton repositories can reach it without it being passed through every use case.
 */
export class PostgresTransactionContext {
  private readonly storage = new AsyncLocalStorage<Queryable>();

  run<T>(tx: Queryable, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(tx, fn);
  }

  hasTransaction(): boolean {
    return this.storage.getStore() !== undefined;
  }

  /** The current transaction; throws NoActiveTransactionError outside a unit of work. */
  current(): Queryable {
    const tx = this.storage.getStore();
    if (tx === undefined) throw new NoActiveTransactionError();
    return tx;
  }
}
