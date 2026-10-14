import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { IUnitOfWork } from "../../application/ports/IUnitOfWork.js";
import type { PostgresTransactionContext } from "./postgres/PostgresTransactionContext.js";
import type { TenantConnectionPools } from "./postgres/TenantConnectionPools.js";

/**
 * IUnitOfWork for tenant data: opens a transaction on the current tenant's database and makes
 * it available to repositories through the transaction context. A nested run joins the
 * transaction that is already open.
 */
export class PostgresTenantUnitOfWork implements IUnitOfWork {
  constructor(
    private readonly tenantContext: ITenantContext,
    private readonly pools: TenantConnectionPools,
    private readonly transactions: PostgresTransactionContext,
  ) {}

  // async so every failure (including a missing tenant) surfaces as a rejected promise.
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactions.hasTransaction()) return work();

    const tenantId = this.tenantContext.currentTenantId();
    return this.pools.withTransaction(tenantId, (tx) => this.transactions.run(tx, work));
  }
}
