import type pg from "pg";
import type { PgBoss, SendOptions } from "pg-boss";
import type { JobName, JobPayloads } from "../../application/jobs/jobCatalog.js";
import type { EnqueueOptions, IJobQueue } from "../../application/ports/IJobQueue.js";
import type { Queryable } from "../database/postgres/Queryable.js";

/** Schema of the queue tables in the platform database. */
export const JOB_QUEUE_SCHEMA = "pgboss";

/**
 * `api`: only sends jobs. `worker`: also runs maintenance (expiry, retries, retention) and the
 * cron scheduler. Neither may change the queue's schema — the migration command installs and
 * upgrades it as the migrator role (JobQueueInstaller).
 */
export type JobQueueMode = "api" | "worker";

export function pgBossOptions(
  connection: pg.ClientConfig,
  mode: JobQueueMode,
  max: number,
): ConstructorParameters<typeof PgBoss>[0] {
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: typeof connection.password === "string" ? connection.password : undefined,
    ssl: connection.ssl,
    application_name: `${connection.application_name ?? "autoforce"}-jobs`,
    max,
    schema: JOB_QUEUE_SCHEMA,
    migrate: false,
    createSchema: false,
    // Reindexing needs table ownership, which the app role deliberately lacks.
    reindex: false,
    supervise: mode === "worker",
    schedule: mode === "worker",
  };
}

/** IJobQueue on pg-boss. Starts lazily on first use; `stop()` on shutdown. */
export class PgBossJobQueue implements IJobQueue {
  private starting: Promise<void> | null = null;

  constructor(
    readonly boss: PgBoss,
    private readonly onError: (error: Error) => void = () => undefined,
  ) {
    boss.on("error", (error) => this.onError(error));
  }

  start(): Promise<void> {
    this.starting ??= this.boss.start().then(() => undefined);
    return this.starting;
  }

  async enqueue<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    await this.start();
    return this.boss.send(name, payload, sendOptions(options));
  }

  /**
   * Enqueues on `db` — a transaction on the platform database — so the job exists if and only if
   * that transaction commits.
   */
  async enqueueWithin<N extends JobName>(
    db: Queryable,
    name: N,
    payload: JobPayloads[N],
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    await this.start();
    return this.boss.send(name, payload, {
      ...sendOptions(options),
      db: { executeSql: (text, values) => db.query(text, values) },
    });
  }

  async stop(timeoutMs: number): Promise<void> {
    if (this.starting === null) return;
    await this.starting.catch(() => undefined);
    await this.boss.stop({ graceful: true, timeout: timeoutMs });
  }
}

function sendOptions(options: EnqueueOptions): SendOptions {
  return {
    ...(options.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
    ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
  };
}
