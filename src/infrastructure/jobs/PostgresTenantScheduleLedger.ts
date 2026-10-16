import type pg from "pg";
import type { TenantDailyJob } from "../../application/jobs/jobCatalog.js";
import type { ITenantScheduleLedger } from "../../application/ports/ITenantScheduleLedger.js";
import { PostgresTransactionRunner } from "../database/postgres/PostgresTransactionRunner.js";
import type { PgBossJobQueue } from "./PgBossJobQueue.js";

/** Ledger row and job are written in one platform-database transaction. */
export class PostgresTenantScheduleLedger implements ITenantScheduleLedger {
  constructor(
    private readonly platform: pg.Pool,
    private readonly queue: PgBossJobQueue,
    private readonly transactions = new PostgresTransactionRunner(),
  ) {}

  enqueueOnce(tenantId: string, job: TenantDailyJob["job"], localDate: string): Promise<boolean> {
    return this.transactions.run(this.platform, async (tx) => {
      const { rowCount } = await tx.query(
        `insert into tenant_schedule_runs (tenant_id, job, local_date)
         values ($1, $2, $3)
         on conflict do nothing`,
        [tenantId, job, localDate],
      );
      if (rowCount !== 1) return false;
      await this.queue.enqueueWithin(tx, job, { tenantId, localDate });
      return true;
    });
  }
}
