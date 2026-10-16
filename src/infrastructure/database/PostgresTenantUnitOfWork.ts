import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { IUnitOfWork } from "../../application/ports/IUnitOfWork.js";
import type { PostgresTransactionContext } from "./postgres/PostgresTransactionContext.js";
import type { TenantConnectionPools } from "./postgres/TenantConnectionPools.js";

/**
 * IUnitOfWork for tenant data: opens a transaction on the current tenant's database and makes
 * it available to repositories through the transaction context. A nested run joins the
 * transaction that is already open.
 *
 * After commit it runs the hooks repositories registered (e.g. the outbox drain trigger). A
 * failing hook is reported but does not fail the unit of work — the data is committed, and the
 * hooks' work has its own safety net (the outbox sweeper).
 */
export class PostgresTenantUnitOfWork implements IUnitOfWork {
  constructor(
    private readonly tenantContext: ITenantContext,
    private readonly pools: TenantConnectionPools,
    private readonly transactions: PostgresTransactionContext,
    private readonly onHookError: (error: unknown) => void = () => undefined,
  ) {}

  // async so every failure (including a missing tenant) surfaces as a rejected promise.
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactions.hasTransaction()) return work();

    const tenantId = this.tenantContext.currentTenantId();
    const { result, afterCommit } = await this.pools.withTransaction(tenantId, (tx) =>
      this.transactions.run(tx, work),
    );
    for (const hook of afterCommit) {
      try {
        await hook();
      } catch (error) {
        this.onHookError(error);
      }
    }
    return result;
  }
}
