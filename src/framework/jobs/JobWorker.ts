import type { Job } from "pg-boss";
import { assertTenantUsable } from "../../application/authorization/TenantAccessRules.js";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import { JOB_CATALOG, type JobName } from "../../application/jobs/jobCatalog.js";
import type { ILogger } from "../../application/ports/ILogger.js";
import type { IRequestContext } from "../../application/ports/IRequestContext.js";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { ITenantDirectory } from "../../application/ports/ITenantDirectory.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import type { PgBossJobQueue } from "../../infrastructure/jobs/PgBossJobQueue.js";

export type JobWorkerOptions = Readonly<{
  queue: PgBossJobQueue;
  handlers: readonly IJobHandler[];
  tenantContext: ITenantContext;
  tenants: ITenantDirectory;
  requestContext: IRequestContext;
  logger: ILogger;
  concurrency: number;
  pollingIntervalSeconds?: number;
}>;

/**
 * Runs job handlers on pg-boss and registers the recurring (cron) jobs of the catalogue.
 *
 * Each job runs with its own request context (`requestId: job-<id>`, so its log lines can be
 * found together) and, for tenant jobs, inside the tenant's context. Jobs of tenants that are
 * deactivated or gone are completed without running. A thrown error fails the attempt and
 * pg-boss retries it with the queue's backoff.
 */
export class JobWorker {
  private started = false;

  constructor(private readonly options: JobWorkerOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    const { queue, handlers } = this.options;
    const seen = new Set<JobName>();
    for (const handler of handlers) {
      if (!(handler.job in JOB_CATALOG)) throw new Error(`Unknown job: ${String(handler.job)}`);
      if (seen.has(handler.job)) throw new Error(`Two handlers for job ${handler.job}`);
      seen.add(handler.job);
    }

    await queue.start();
    for (const handler of handlers) {
      await queue.boss.work<Record<string, unknown>>(
        handler.job,
        {
          batchSize: 1,
          localConcurrency: this.options.concurrency,
          pollingIntervalSeconds: this.options.pollingIntervalSeconds ?? 2,
        },
        async ([job]) => {
          if (job !== undefined) await this.run(handler, job);
        },
      );
    }
    for (const name of Object.keys(JOB_CATALOG) as JobName[]) {
      const cron = JOB_CATALOG[name].cron;
      if (cron !== undefined && seen.has(name)) {
        await queue.boss.schedule(name, cron, {}, { tz: "UTC" });
      }
    }
    this.started = true;
  }

  private run(handler: IJobHandler, job: Job<Record<string, unknown>>): Promise<void> {
    const { logger, requestContext } = this.options;
    const context = { jobId: job.id, attempt: job.retryCount + 1 };
    const started = Date.now();

    return requestContext.run(
      { requestId: `job-${job.id}`, method: "JOB", path: job.name },
      async () => {
        try {
          const execute = () => handler.handle(job.data as never, context);
          if (JOB_CATALOG[handler.job].tenantScoped) {
            const ran = await this.inTenant(job, execute);
            if (!ran) return;
          } else {
            await execute();
          }
          logger.debug("Job completed", {
            job: job.name,
            attempt: context.attempt,
            durationMs: Date.now() - started,
          });
        } catch (error) {
          logger.warn("Job failed", { job: job.name, attempt: context.attempt, error });
          throw error;
        }
      },
    );
  }

  /** Runs `execute` as the job's tenant; false when the tenant is gone or not usable. */
  private async inTenant(
    job: Job<Record<string, unknown>>,
    execute: () => Promise<void>,
  ): Promise<boolean> {
    const tenantId = job.data.tenantId;
    if (typeof tenantId !== "string" || !TenantId.isValid(tenantId)) {
      throw new Error(`Job ${job.name} has no valid tenantId`);
    }
    const tenant = await this.options.tenants.findById(tenantId);
    try {
      if (tenant === null) throw new Error("unknown tenant");
      assertTenantUsable(tenant);
    } catch {
      this.options.logger.info("Job skipped: tenant not usable", {
        job: job.name,
        tenantId,
        status: tenant?.status ?? "unknown",
      });
      return false;
    }
    await this.options.tenantContext.runAs(TenantId.from(tenant.id), execute);
    return true;
  }
}
