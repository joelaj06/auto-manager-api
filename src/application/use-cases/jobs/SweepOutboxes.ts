import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ITenantRoster } from "../../ports/ITenantRoster.js";

const PAGE_SIZE = 500;

/**
 * Safety net for the after-commit drain trigger (lost when the process stops between commit and
 * enqueue): enqueues a drain for every usable tenant. Drains of tenants with nothing pending are
 * cheap; the stately queue collapses duplicates.
 */
export class SweepOutboxes implements IJobHandler<"outbox.sweep"> {
  readonly job = "outbox.sweep" as const;

  constructor(private readonly deps: Readonly<{ roster: ITenantRoster; queue: IJobQueue }>) {}

  async handle(): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const tenants = await this.deps.roster.listUsable(after, PAGE_SIZE);
      for (const tenant of tenants) {
        await this.deps.queue.enqueue(
          "outbox.drain",
          { tenantId: tenant.id },
          { singletonKey: tenant.id },
        );
      }
      if (tenants.length < PAGE_SIZE) return;
      after = tenants.at(-1)?.id ?? null;
    }
  }
}
