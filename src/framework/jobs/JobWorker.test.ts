import type { Job } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { ILogger } from "../../application/ports/ILogger.js";
import type { ITenantDirectory, TenantSummary } from "../../application/ports/ITenantDirectory.js";
import { AsyncLocalRequestContext } from "../../infrastructure/context/AsyncLocalRequestContext.js";
import { AsyncLocalTenantContext } from "../../infrastructure/context/AsyncLocalTenantContext.js";
import type { PgBossJobQueue } from "../../infrastructure/jobs/PgBossJobQueue.js";
import { JobWorker } from "./JobWorker.js";

const ACTIVE = "0198f0e0-0000-7000-8000-00000000000a";
const CLOSED = "0198f0e0-0000-7000-8000-00000000000c";

type WorkFn = (jobs: Job<Record<string, unknown>>[]) => Promise<void>;

function setup() {
  const workers = new Map<string, WorkFn>();
  const schedules: string[] = [];
  const queue = {
    start: () => Promise.resolve(),
    boss: {
      work: (name: string, _options: unknown, fn: WorkFn) => {
        workers.set(name, fn);
        return Promise.resolve(name);
      },
      schedule: (name: string, cron: string) => {
        schedules.push(`${name} ${cron}`);
        return Promise.resolve();
      },
    },
  } as unknown as PgBossJobQueue;

  const tenants: TenantSummary[] = [
    { id: ACTIVE, slug: "alpha", status: "active" },
    { id: CLOSED, slug: "closed", status: "deactivated" },
  ];
  const directory: ITenantDirectory = {
    findBySlug: () => Promise.resolve(null),
    findById: (id) => Promise.resolve(tenants.find((t) => t.id === id) ?? null),
  };
  const logger: ILogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  const tenantContext = new AsyncLocalTenantContext();
  const requestContext = new AsyncLocalRequestContext();
  const seen: { tenant: string; requestId: string | undefined }[] = [];
  const drain: IJobHandler<"outbox.drain"> = {
    job: "outbox.drain",
    handle: () => {
      seen.push({
        tenant: tenantContext.currentTenantId().value,
        requestId: requestContext.current()?.requestId,
      });
      return Promise.resolve();
    },
  };
  const sweep: IJobHandler<"outbox.sweep"> = {
    job: "outbox.sweep",
    handle: vi.fn(() => Promise.resolve()),
  };

  const worker = new JobWorker({
    queue,
    handlers: [drain, sweep] as IJobHandler[],
    tenantContext,
    tenants: directory,
    requestContext,
    logger,
    concurrency: 1,
  });
  const job = (name: string, data: Record<string, unknown>) =>
    ({ id: "job-1", name, data, retryCount: 0 }) as unknown as Job<Record<string, unknown>>;
  return { worker, workers, schedules, seen, logger, job };
}

describe("JobWorker", () => {
  it("runs tenant jobs inside the tenant's context, with the job id as request id", async () => {
    const { worker, workers, seen, job } = setup();
    await worker.start();
    await workers.get("outbox.drain")!([job("outbox.drain", { tenantId: ACTIVE })]);
    expect(seen).toEqual([{ tenant: ACTIVE, requestId: "job-job-1" }]);
  });

  it("refuses to run a tenant job without a valid tenantId", async () => {
    const { worker, workers, seen, job } = setup();
    await worker.start();
    const run = workers.get("outbox.drain")!;
    await expect(run([job("outbox.drain", {})])).rejects.toThrow(/no valid tenantId/);
    await expect(run([job("outbox.drain", { tenantId: "x" })])).rejects.toThrow(/tenantId/);
    expect(seen).toEqual([]);
  });

  it("skips jobs of deactivated or unknown tenants without failing them", async () => {
    const { worker, workers, seen, logger, job } = setup();
    await worker.start();
    const run = workers.get("outbox.drain")!;
    await run([job("outbox.drain", { tenantId: CLOSED })]);
    await run([job("outbox.drain", { tenantId: "0198f0e0-0000-7000-8000-0000000000ff" })]);
    expect(seen).toEqual([]);
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it("schedules the cron jobs it has handlers for", async () => {
    const { worker, schedules } = setup();
    await worker.start();
    expect(schedules).toEqual(["outbox.sweep 7 * * * *"]);
  });

  it("rejects duplicate handlers", async () => {
    const { worker } = setup();
    const duplicate = new JobWorker({
      ...(worker as unknown as { options: ConstructorParameters<typeof JobWorker>[0] }).options,
      handlers: [
        { job: "outbox.sweep", handle: () => Promise.resolve() },
        { job: "outbox.sweep", handle: () => Promise.resolve() },
      ] as IJobHandler[],
    });
    await expect(duplicate.start()).rejects.toThrow(/Two handlers/);
  });
});
