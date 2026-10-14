import pg from "pg";
import {
  TenantDatabaseMismatchError,
  TenantDatabaseUnavailableError,
  TenantSchemaOutdatedError,
} from "../../../application/errors/TenantDatabaseErrors.js";
import type { TenantId } from "../../../domain/value-objects/TenantId.js";
import type { Queryable } from "./Queryable.js";
import { PostgresTransactionRunner, type TransactionOptions } from "./PostgresTransactionRunner.js";

export type TenantConnectionPoolsOptions = Readonly<{
  /** Client options (tenant app role) for a given tenant database name. */
  clientConfigFor: (databaseName: string) => pg.ClientConfig;
  databaseNameFor: (tenantId: TenantId) => string;
  /** Upper bound on open pools; least recently used idle pools are closed beyond it. */
  maxPools: number;
  maxConnectionsPerPool: number;
  idleTimeoutMs: number;
  statementTimeoutMs: number;
  /** Lowest schema version this build can run against; null disables the check. */
  requiredSchemaVersion: string | null;
  onPoolError?: (error: Error, tenantId: string) => void;
}>;

export type TenantPoolStats = Readonly<{
  openPools: number;
  totalConnections: number;
  idleConnections: number;
  waitingRequests: number;
}>;

type Entry = { pool: pg.Pool; leases: number };
type Opening = { waiters: number; promise: Promise<Entry> };
type VerificationRow = { tenant_id: string | null; schema_version: string | null };

/**
 * One small connection pool per tenant database, kept in least-recently-used order.
 *
 * Safety: when a pool is opened, the database must prove it belongs to the tenant
 * (tenant_info.tenant_id) and be at or above the required schema version; otherwise the pool is
 * discarded and an error is thrown. Pools are only reachable through `withTransaction`, which
 * holds a lease so an in-use pool is never evicted.
 */
export class TenantConnectionPools {
  private readonly entries = new Map<string, Entry>();
  private readonly opening = new Map<string, Opening>();
  private closed = false;

  constructor(
    private readonly options: TenantConnectionPoolsOptions,
    private readonly transactions: PostgresTransactionRunner = new PostgresTransactionRunner(),
  ) {}

  async withTransaction<T>(
    tenantId: TenantId,
    fn: (tx: Queryable) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const entry = await this.acquire(tenantId);
    try {
      return await this.transactions.run(entry.pool, fn, {
        statementTimeoutMs: this.options.statementTimeoutMs,
        ...options,
      });
    } finally {
      entry.leases -= 1;
      this.evictBeyondLimit();
    }
  }

  stats(): TenantPoolStats {
    let totalConnections = 0;
    let idleConnections = 0;
    let waitingRequests = 0;
    for (const { pool } of this.entries.values()) {
      totalConnections += pool.totalCount;
      idleConnections += pool.idleCount;
      waitingRequests += pool.waitingCount;
    }
    return { openPools: this.entries.size, totalConnections, idleConnections, waitingRequests };
  }

  /** Closes every pool. The instance cannot be used afterwards. */
  async closeAll(): Promise<void> {
    this.closed = true;
    const pools = [...this.entries.values()].map((entry) => entry.pool);
    this.entries.clear();
    await Promise.allSettled(pools.map((pool) => pool.end()));
  }

  private async acquire(tenantId: TenantId): Promise<Entry> {
    if (this.closed) throw new Error("TenantConnectionPools is closed");

    const key = tenantId.value;
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      // Re-insert to mark as most recently used; take the lease synchronously.
      this.entries.delete(key);
      this.entries.set(key, cached);
      cached.leases += 1;
      return cached;
    }

    // Every waiter is counted before awaiting. open() hands the new pool over with that many
    // leases already taken, so it can never be evicted between creation and first use.
    let opening = this.opening.get(key);
    if (opening === undefined) {
      const counter = { waiters: 0 };
      const promise = this.open(tenantId, () => counter.waiters).finally(() => {
        this.opening.delete(key);
      });
      opening = Object.assign(counter, { promise });
      this.opening.set(key, opening);
    }
    opening.waiters += 1;
    return opening.promise;
  }

  private async open(tenantId: TenantId, waiters: () => number): Promise<Entry> {
    const databaseName = this.options.databaseNameFor(tenantId);
    const pool = new pg.Pool({
      ...this.options.clientConfigFor(databaseName),
      max: this.options.maxConnectionsPerPool,
      idleTimeoutMillis: this.options.idleTimeoutMs,
    });
    pool.on("error", (error) => this.options.onPoolError?.(error, tenantId.value));

    try {
      await this.verify(pool, tenantId, databaseName);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }

    if (this.closed) {
      await pool.end().catch(() => undefined);
      throw new Error("TenantConnectionPools is closed");
    }

    const entry: Entry = { pool, leases: waiters() };
    this.entries.set(tenantId.value, entry);
    this.evictBeyondLimit();
    return entry;
  }

  private async verify(pool: pg.Pool, tenantId: TenantId, databaseName: string): Promise<void> {
    let row: VerificationRow | undefined;
    try {
      const result = await pool.query<VerificationRow>(
        `select (select tenant_id::text from tenant_info) as tenant_id,
                (select max(version) from schema_migrations) as schema_version`,
      );
      row = result.rows[0];
    } catch (error) {
      throw new TenantDatabaseUnavailableError(tenantId.value, { cause: error });
    }

    const actualTenantId = row?.tenant_id ?? null;
    if (actualTenantId !== tenantId.value) {
      throw new TenantDatabaseMismatchError(tenantId.value, actualTenantId, databaseName);
    }

    const required = this.options.requiredSchemaVersion;
    const current = row?.schema_version ?? null;
    if (required !== null && (current === null || current < required)) {
      throw new TenantSchemaOutdatedError(tenantId.value, current, required);
    }
  }

  private evictBeyondLimit(): void {
    if (this.entries.size <= this.options.maxPools) return;

    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.options.maxPools) return;
      const busy = entry.leases > 0 || entry.pool.totalCount - entry.pool.idleCount > 0;
      if (busy) continue;
      this.entries.delete(key);
      void entry.pool.end().catch((error: unknown) => {
        if (error instanceof Error) this.options.onPoolError?.(error, key);
      });
    }
    // If every pool is busy the limit is exceeded temporarily; it is enforced again on release.
  }
}
