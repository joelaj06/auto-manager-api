import type pg from "pg";
import { PgBoss } from "pg-boss";
import { JOB_CATALOG, JOB_NAMES } from "../../application/jobs/jobCatalog.js";
import { DATABASE_GROUP_ROLES } from "../database/postgres/databaseRoles.js";
import { JOB_QUEUE_SCHEMA } from "./PgBossJobQueue.js";

/**
 * Installs or upgrades the pg-boss schema in the platform database as the migrator role, creates
 * one queue per catalogue entry (or updates its retry settings), and grants the app role data
 * access only. Runs as part of `yarn db:migrate`; idempotent.
 */
export class JobQueueInstaller {
  constructor(private readonly migratorConnection: pg.ClientConfig) {}

  async install(migrator: pg.ClientBase): Promise<Readonly<{ queues: number }>> {
    const c = this.migratorConnection;
    const boss = new PgBoss({
      host: c.host,
      port: c.port,
      database: c.database,
      user: c.user,
      password: typeof c.password === "string" ? c.password : undefined,
      ssl: c.ssl,
      application_name: "autoforce-migrate",
      max: 2,
      schema: JOB_QUEUE_SCHEMA,
      migrate: true,
      supervise: false,
      schedule: false,
    });
    let failure: Error | undefined;
    boss.on("error", (error) => (failure ??= error));
    await boss.start();
    try {
      for (const name of JOB_NAMES) {
        const job = JOB_CATALOG[name];
        const settings = {
          retryLimit: job.retryLimit,
          retryDelay: job.retryDelaySeconds,
          retryBackoff: job.retryBackoff,
          expireInSeconds: job.expireInSeconds,
        };
        if ((await boss.getQueue(name)) === null) {
          await boss.createQueue(name, { policy: job.policy, ...settings });
        } else {
          await boss.updateQueue(name, settings);
        }
      }
    } finally {
      await boss.stop({ graceful: false });
    }
    if (failure !== undefined) throw failure;

    const group = DATABASE_GROUP_ROLES.platformReadWrite;
    await migrator.query(`
      grant usage on schema ${JOB_QUEUE_SCHEMA} to ${group};
      grant select, insert, update, delete on all tables in schema ${JOB_QUEUE_SCHEMA} to ${group};
      grant usage, select on all sequences in schema ${JOB_QUEUE_SCHEMA} to ${group};
      grant execute on all functions in schema ${JOB_QUEUE_SCHEMA} to ${group};
      alter default privileges in schema ${JOB_QUEUE_SCHEMA}
        grant select, insert, update, delete on tables to ${group};
      alter default privileges in schema ${JOB_QUEUE_SCHEMA}
        grant usage, select on sequences to ${group};
      alter default privileges in schema ${JOB_QUEUE_SCHEMA}
        grant execute on functions to ${group};
    `);
    return { queues: JOB_NAMES.length };
  }
}
