import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { IUnitOfWork } from "../../application/ports/IUnitOfWork.js";
import type { PostgresTransactionContext } from "./postgres/PostgresTransactionContext.js";
import type { Queryable } from "./postgres/Queryable.js";
import type { TenantConnectionPools } from "./postgres/TenantConnectionPools.js";

export type ReplicaReads = Readonly<{
  /** Pools on the replica, one per tenant database as on the primary. */
  pools: TenantConnectionPools;
  maxLagSeconds: number;
}>;

export type ReportReadFallback = Readonly<
  { reason: "lagging"; lagSeconds: number } | { reason: "unavailable"; error: unknown }
>;

/**
 * IUnitOfWork for catalogue reports (decision 489): a read-only transaction with the longer
 * report statement timeout, on the read replica when one is configured. A replica that cannot be
 * reached, is behind the tenant's schema or lags more than allowed is passed over for the
 * primary, so a report is never refused or stale for it. A nested run joins the transaction that
 * is already open (on the primary when a writing unit of work started it).
 */
export class PostgresReportUnitOfWork implements IUnitOfWork {
  constructor(
    private readonly deps: Readonly<{
      tenantContext: ITenantContext;
      primary: TenantConnectionPools;
      replica: ReplicaReads | null;
      transactions: PostgresTransactionContext;
      statementTimeoutMs: number;
      onFallback?: (fallback: ReportReadFallback) => void;
    }>,
  ) {}

  // async so every failure (including a missing tenant) surfaces as a rejected promise.
  async run<T>(work: () => Promise<T>): Promise<T> {
    const { deps } = this;
    if (deps.transactions.hasTransaction()) return work();

    const tenantId = deps.tenantContext.currentTenantId();
    const options = { readOnly: true, statementTimeoutMs: deps.statementTimeoutMs };
    if (deps.replica !== null) {
      const { pools, maxLagSeconds } = deps.replica;
      let started = false;
      try {
        const read = await pools.withTransaction(
          tenantId,
          async (tx): Promise<{ done: { result: T } } | { lagSeconds: number }> => {
            const lagSeconds = await replicaLag(tx);
            if (lagSeconds > maxLagSeconds) return { lagSeconds };
            started = true;
            return { done: await deps.transactions.run(tx, work) };
          },
          options,
        );
        if ("done" in read) return read.done.result;
        deps.onFallback?.({ reason: "lagging", lagSeconds: read.lagSeconds });
      } catch (error) {
        // The report's own failure is not the replica's.
        if (started) throw error;
        deps.onFallback?.({ reason: "unavailable", error });
      }
    }
    const { result } = await deps.primary.withTransaction(
      tenantId,
      (tx) => deps.transactions.run(tx, work),
      options,
    );
    return result;
  }

  /** Closes the replica's pools (the primary's belong to the writing unit of work). */
  async close(): Promise<void> {
    await this.deps.replica?.pools.closeAll();
  }
}

/** Seconds the server is behind its primary: none when it is one or has replayed all it got. */
async function replicaLag(tx: Queryable): Promise<number> {
  const { rows } = await tx.query<{ lag: string }>(
    `select case when not pg_is_in_recovery() then 0
                 when pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() then 0
                 else coalesce(extract(epoch from now() - pg_last_xact_replay_timestamp()),
                               'infinity')
            end as lag`,
  );
  return Number(rows[0]?.lag ?? 0);
}
