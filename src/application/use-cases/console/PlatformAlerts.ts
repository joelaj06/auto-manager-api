import type {
  AlertInput,
  AlertSeverity,
  AlertStatus,
  IPlatformAlertRepository,
  PlatformAlert,
} from "../../../domain/repositories/IPlatformAlertRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IClock } from "../../ports/IClock.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IOnCallWebhook } from "../../ports/IOnCallWebhook.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "./consoleAudit.js";

export class AlertNotFoundError extends ApplicationError {
  readonly code = "ALERT_NOT_FOUND";
  constructor() {
    super("Alert not found");
  }
}

export type OnCallSettings = Readonly<{
  emails: readonly string[];
  minSeverity: AlertSeverity;
  consoleUrl: string;
}>;

const RANK: Readonly<Record<AlertSeverity, number>> = { info: 0, warning: 1, critical: 2 };

/** Raises alerts from anywhere in the platform; never fails the caller. */
export interface IAlerts {
  raise(input: AlertInput): Promise<void>;
}

/**
 * The alerts centre (docs/27 §3.1): one unified list of what needs attention — billing
 * automation halts and gateway problems, reconciliation mismatches, unusual support access …
 * — deduplicated by key while open and counted. New or escalated alerts at or above the
 * on-call severity are emailed to on-call and posted to the webhook by a job (retried).
 * Staff acknowledge and resolve them; both are audited.
 */
export class PlatformAlerts implements IAlerts {
  constructor(
    private readonly deps: Readonly<{
      alerts: IPlatformAlertRepository;
      queue: IJobQueue;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
      logger: ILogger;
      onCall: OnCallSettings;
    }>,
  ) {}

  async raise(input: AlertInput): Promise<void> {
    const { deps } = this;
    try {
      const { alert, escalated } = await deps.unitOfWork.run(() =>
        deps.alerts.raise(input, deps.clock.now()),
      );
      deps.logger.warn("Platform alert", {
        key: alert.key,
        severity: alert.severity,
        title: alert.title,
      });
      if (escalated && RANK[alert.severity] >= RANK[deps.onCall.minSeverity])
        await deps.queue.enqueue("alerts.notify", { alertId: alert.id });
    } catch (error) {
      deps.logger.error("Could not raise a platform alert", { key: input.key, error });
    }
  }

  list(
    filter: Readonly<{
      status?: AlertStatus;
      severity?: AlertSeverity;
      source?: string;
      limit: number;
    }>,
  ): Promise<PlatformAlert[]> {
    return this.deps.alerts.list(filter);
  }

  async get(id: string): Promise<PlatformAlert> {
    const alert = await this.deps.alerts.find(id);
    if (alert === null) throw new AlertNotFoundError();
    return alert;
  }

  openCounts() {
    return this.deps.alerts.openCounts();
  }

  async acknowledge(id: string, actor: PlatformPrincipal): Promise<PlatformAlert> {
    return this.change(id, actor, "alert.acknowledged", (now) =>
      this.deps.alerts.acknowledge(id, actor.userId, now),
    );
  }

  async resolve(id: string, actor: PlatformPrincipal, note: string | null): Promise<PlatformAlert> {
    return this.change(
      id,
      actor,
      "alert.resolved",
      (now) => this.deps.alerts.resolve(id, actor.userId, now),
      note,
    );
  }

  /** What on-call notification is set up (console settings view). */
  onCallChannels(webhookConfigured: boolean) {
    return {
      emails: this.deps.onCall.emails,
      webhook: webhookConfigured,
      minSeverity: this.deps.onCall.minSeverity,
    };
  }

  private async change(
    id: string,
    actor: PlatformPrincipal,
    action: string,
    apply: (now: Date) => Promise<void>,
    reason: string | null = null,
  ): Promise<PlatformAlert> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const alert = await deps.alerts.find(id, true);
      if (alert === null) throw new AlertNotFoundError();
      await apply(deps.clock.now());
      await recordStaffAction(deps, actor, {
        action,
        entityType: "platform_alert",
        entityId: id,
        targetTenantId: alert.tenantId,
        reason,
        before: { status: alert.status },
      });
    });
    return this.get(id);
  }
}

/** Sends a new or escalated alert to on-call: email and the webhook. Retried by the queue. */
export class AlertNotifier implements IJobHandler<"alerts.notify"> {
  readonly job = "alerts.notify" as const;

  constructor(
    private readonly deps: Readonly<{
      alerts: IPlatformAlertRepository;
      webhook: IOnCallWebhook;
      email: NotificationService;
      clock: IClock;
      onCall: OnCallSettings;
    }>,
  ) {}

  async handle({ alertId }: Readonly<{ alertId: string }>): Promise<void> {
    const { deps } = this;
    const alert = await deps.alerts.find(alertId);
    if (alert === null || alert.status === "resolved") return;
    for (const to of deps.onCall.emails)
      await deps.email.sendEmail({
        to,
        template: "platform.alert",
        data: {
          severity: alert.severity,
          title: alert.title,
          source: alert.source,
          occurrences: alert.occurrences,
          runbook: alert.runbook,
          url: `${deps.onCall.consoleUrl}/alerts/${alert.id}`,
        },
        idempotencyKey: `alert:${alert.id}:${alert.severity}:${to}`,
      });
    await deps.webhook.post(alert, deps.onCall.consoleUrl);
    await deps.alerts.markNotified(alert.id, deps.clock.now());
  }
}
