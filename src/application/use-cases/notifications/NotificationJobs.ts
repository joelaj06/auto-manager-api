import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { IClock } from "../../ports/IClock.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { ITenantRoster } from "../../ports/ITenantRoster.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import type { ReminderRules } from "./ReminderRules.js";

/** The morning reminders of one tenant (enqueued once a day from 07:00 local time). */
export class RunNotificationRules implements IJobHandler<"tenant.notification_rules"> {
  readonly job = "tenant.notification_rules" as const;

  constructor(private readonly rules: ReminderRules) {}

  handle({ localDate }: JobPayloads["tenant.notification_rules"]): Promise<void> {
    return this.rules.morning(localDate);
  }
}

/**
 * The remittance cut-off of one tenant. Enqueued once a day after midnight local time, it waits
 * (a delayed copy of itself) until the business's cut-off time, then checks today's remittances.
 */
export class RunRemittanceCutoff implements IJobHandler<"tenant.remittance_cutoff"> {
  readonly job = "tenant.remittance_cutoff" as const;

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      settings: INotificationSettingsStore;
      organisation: IOrganisationSettings;
      rules: ReminderRules;
      queue: IJobQueue;
      clock: IClock;
    }>,
  ) {}

  async handle(payload: JobPayloads["tenant.remittance_cutoff"]): Promise<void> {
    const { deps } = this;
    const { cutoff, timezone } = await deps.unitOfWork.run(async () => ({
      cutoff: (await deps.settings.get()).remittanceCutoff,
      timezone: (await deps.organisation.get()).timezone,
    }));
    const now = deps.clock.now();
    const local = localDateTime(now, timezone);
    if (local.date !== payload.localDate) return; // a day late: that day's cut-off has passed
    const wait =
      Number(cutoff.slice(0, 2)) * 60 +
      Number(cutoff.slice(3, 5)) -
      (local.hour * 60 + local.minute);
    if (wait > 0) {
      const at = new Date(now.getTime() + wait * 60_000);
      await deps.queue.enqueue("tenant.remittance_cutoff", payload, {
        singletonKey: `${payload.tenantId}:${payload.localDate}`,
        startAfter: at,
      });
      return;
    }
    await deps.rules.cutoff(payload.localDate);
  }
}

/**
 * Safety net for the after-commit send trigger and for messages whose delayed run was lost:
 * asks every usable tenant to send what is due (cheap when nothing is).
 */
export class SweepNotifications implements IJobHandler<"notifications.sweep"> {
  readonly job = "notifications.sweep" as const;

  constructor(private readonly deps: Readonly<{ roster: ITenantRoster; queue: IJobQueue }>) {}

  async handle(): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const tenants = await this.deps.roster.listUsable(after, 500);
      for (const tenant of tenants)
        await this.deps.queue.enqueue(
          "notifications.send",
          { tenantId: tenant.id },
          { singletonKey: tenant.id },
        );
      if (tenants.length < 500) return;
      after = tenants.at(-1)?.id ?? null;
    }
  }
}
