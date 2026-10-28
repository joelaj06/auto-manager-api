import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { IMaintenanceReporting } from "../../ports/IMaintenanceReporting.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import type { Notifier } from "../notifications/Notifier.js";

const DAY_MS = 86_400_000;

/**
 * The daily maintenance alerts (docs/15 §2): vehicles standing available longer than the days
 * set (rule `vehicle_idle`), and vehicles still off the road for a work order past the time they
 * were expected back (rule `work_order_overdue`). Each spell and each expected time is told once
 * (decision 408).
 */
export class MaintenanceAlerts implements ITenantDailyTask {
  readonly name = "maintenance_alerts";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      reporting: IMaintenanceReporting;
      settings: INotificationSettingsStore;
      organisation: IOrganisationSettings;
      notifier: Notifier;
      clock: { now(): Date };
    }>,
  ) {}

  run(_localDate: string): Promise<void> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const settings = await deps.settings.get();
      const now = deps.clock.now();
      const { timezone } = await deps.organisation.get();
      const idle = settings.rules.vehicle_idle;
      if (idle.enabled) {
        const days = idle.afterDays ?? 7;
        for (const v of await deps.reporting.idleVehicles(
          new Date(now.getTime() - days * DAY_MS),
        )) {
          const name = v.plateNumber ?? v.code;
          const since = localDateTime(v.since, timezone).date;
          const idleDays = Math.floor((now.getTime() - v.since.getTime()) / DAY_MS);
          await deps.notifier.staff(settings, {
            rule: "vehicle_idle",
            permission: "dashboards.vehicles.view",
            branchId: v.branchId,
            dedupeKey: `vehicle_idle:${v.vehicleId}:${v.since.toISOString()}`,
            title: `${name} has been idle ${idleDays} days`,
            body: `${name} has been available and unused since ${since}. Assign, rent or sell it.`,
            severity: "info",
            data: { vehicleId: v.vehicleId },
          });
        }
      }
      if (settings.rules.work_order_overdue.enabled) {
        for (const o of await deps.reporting.lateWorkOrders(now)) {
          const at = localDateTime(o.expectedBackAt, timezone);
          await deps.notifier.staff(settings, {
            rule: "work_order_overdue",
            permission: "maintenance.work_orders.manage",
            branchId: o.branchId,
            dedupeKey: `work_order_overdue:${o.id}:${o.expectedBackAt.toISOString()}`,
            title: `${o.vehicleName} is not back from ${o.number}`,
            body: `${o.vehicleName} was expected back on the road on ${at.date} at ${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")} and work order ${o.number} is still open.`,
            severity: "warning",
            data: { vehicleId: o.vehicleId, workOrderId: o.id },
          });
        }
      }
    });
  }
}
