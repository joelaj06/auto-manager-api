import { AsyncLocalStorage } from "node:async_hooks";
import { NoActiveTransactionError } from "../../../application/errors/TenantDatabaseErrors.js";
import type { Queryable } from "./Queryable.js";

type AfterCommitHook = () => Promise<void>;

type Scope = { tx: Queryable; afterCommit: Map<string, AfterCommitHook> };

/**
 * Holds the transaction of the current unit of work for the duration of an async call chain,
 * so singleton repositories can reach it without it being passed through every use case.
 *
 * Repositories can also register work to run once the transaction has committed (e.g. "drain
 * the outbox"); the unit of work runs it after commit and drops it on rollback.
 */
export class PostgresTransactionContext {
  private readonly storage = new AsyncLocalStorage<Scope>();

  /** Runs `fn` with `tx` as the current transaction; resolves with its result and the hooks. */
  async run<T>(
    tx: Queryable,
    fn: () => Promise<T>,
  ): Promise<Readonly<{ result: T; afterCommit: readonly AfterCommitHook[] }>> {
    const scope: Scope = { tx, afterCommit: new Map() };
    const result = await this.storage.run(scope, fn);
    return { result, afterCommit: [...scope.afterCommit.values()] };
  }

  hasTransaction(): boolean {
    return this.storage.getStore() !== undefined;
  }

  /** The current transaction; throws NoActiveTransactionError outside a unit of work. */
  current(): Queryable {
    return this.scope().tx;
  }

  /** Registers `hook` to run after commit; a second registration with the same key is ignored. */
  afterCommit(key: string, hook: AfterCommitHook): void {
    const { afterCommit } = this.scope();
    if (!afterCommit.has(key)) afterCommit.set(key, hook);
  }

  private scope(): Scope {
    const scope = this.storage.getStore();
    if (scope === undefined) throw new NoActiveTransactionError();
    return scope;
  }
}
