import type { IUsageRepository, UsageDay } from "../../../domain/repositories/IUsageRepository.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IUsageMeter } from "../../ports/IOperationsGates.js";
import type { ITenantRoster } from "../../ports/ITenantRoster.js";
import type { ITenantUsageCollector } from "../../ports/ITenantUsageCollector.js";

const DAY_MS = 86_400_000;
const PAGE = 200;
const FLUSH_MS = 60_000;

/**
 * Counts tenant API calls in memory per tenant and day and adds them to the platform database
 * every minute (and when the process stops), so counting never slows a request.
 */
export class UsageMeter implements IUsageMeter {
  private counts = new Map<string, { calls: number; errors: number }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: Readonly<{ usage: IUsageRepository; clock: IClock; logger: ILogger }>,
  ) {}

  count(tenantId: string): void {
    this.entry(tenantId).calls += 1;
  }

  failed(tenantId: string): void {
    this.entry(tenantId).errors += 1;
  }

  private entry(tenantId: string): { calls: number; errors: number } {
    const key = `${tenantId}|${this.deps.clock.now().toISOString().slice(0, 10)}`;
    let entry = this.counts.get(key);
    if (entry === undefined) {
      entry = { calls: 0, errors: 0 };
      this.counts.set(key, entry);
    }
    if (this.timer === null) {
      this.timer = setInterval(() => void this.flush(), FLUSH_MS);
      this.timer.unref();
    }
    return entry;
  }

  async flush(): Promise<void> {
    if (this.counts.size === 0) return;
    const batch = [...this.counts.entries()].map(([key, { calls, errors }]) => {
      const [tenantId, day] = key.split("|") as [string, string];
      return { tenantId, day, calls, errors };
    });
    this.counts = new Map();
    try {
      await this.deps.usage.addCalls(batch);
    } catch (error) {
      this.deps.logger.warn("Could not save API usage counters", { error });
    }
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

/**
 * `usage_daily` (docs/27 §4, §3.16): each night, every usable tenant's day before — active users,
 * API calls and server errors, records created and the modules they belong to, background jobs
 * and failures, vehicles, branches, users, storage and database size — and its onboarding
 * milestones, for the console's usage view, analytics, health and cost to serve.
 */
export class TenantUsageHistory implements IJobHandler<"usage.daily"> {
  readonly job = "usage.daily" as const;

  constructor(
    private readonly deps: Readonly<{
      usage: IUsageRepository;
      collector: ITenantUsageCollector;
      roster: ITenantRoster;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async handle(): Promise<void> {
    const day = new Date(this.deps.clock.now().getTime() - DAY_MS).toISOString().slice(0, 10);
    await this.collect(day);
  }

  async collect(day: string): Promise<number> {
    const { deps } = this;
    let collected = 0;
    let after: string | null = null;
    const jobs = await deps.usage.jobsOn(day);
    for (;;) {
      const tenants = await deps.roster.listUsable(after, PAGE);
      for (const t of tenants) {
        try {
          const counts = await deps.collector.collect(t.id, day);
          const calls = await deps.usage.callsOn(t.id, day);
          const ran = jobs.get(t.id);
          await deps.usage.saveDay({
            tenantId: t.id,
            day,
            apiCalls: calls.calls,
            apiErrors: calls.errors,
            jobs: ran?.jobs ?? 0,
            failedJobs: ran?.failed ?? 0,
            ...counts,
          });
          await deps.usage.saveOnboarding(t.id, await deps.collector.onboarding(t.id));
          collected += 1;
        } catch (error) {
          deps.logger.warn("Could not collect a tenant's usage", { tenantId: t.id, day, error });
        }
      }
      if (tenants.length < PAGE) break;
      after = tenants.at(-1)!.id;
    }
    return collected;
  }

  /** The last `days` days of a tenant (console). */
  history(tenantId: string, days: number): Promise<UsageDay[]> {
    const now = this.deps.clock.now().getTime();
    const to = new Date(now).toISOString().slice(0, 10);
    const from = new Date(now - days * DAY_MS).toISOString().slice(0, 10);
    return this.deps.usage.days(tenantId, from, to);
  }
}
