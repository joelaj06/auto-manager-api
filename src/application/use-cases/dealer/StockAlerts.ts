import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { IDealerStock } from "../../ports/IDealerStock.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { Notifier } from "../notifications/Notifier.js";

const DAY_MS = 86_400_000;
const DEFAULT_AFTER_DAYS = 90;

/**
 * The daily aged-stock alert (docs/10 §2, decision 435): a vehicle on the lot for more than the
 * rule's days (default 90) is reported once per stay to the branch's staff who see stock (rule
 * `stock_aged`).
 */
export class StockAlerts implements ITenantDailyTask {
  readonly name = "stock_alerts";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      stock: IDealerStock;
      settings: INotificationSettingsStore;
      notifier: Notifier;
    }>,
  ) {}

  run(localDate: string): Promise<void> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const settings = await deps.settings.get();
      const rule = settings.rules.stock_aged;
      if (!rule.enabled) return;
      const days = rule.afterDays ?? DEFAULT_AFTER_DAYS;
      const before = new Date(Date.parse(`${localDate}T00:00:00Z`) - (days + 1) * DAY_MS)
        .toISOString()
        .slice(0, 10);
      for (const s of await deps.stock.agedStock(before)) {
        const name = `${s.make} ${s.model} (${s.plateNumber ?? s.code})`;
        await deps.notifier.staff(settings, {
          rule: "stock_aged",
          permission: "dealer.stock.view",
          branchId: s.branchId,
          dedupeKey: `stock_aged:${s.vehicleId}:${s.stockedOn}`,
          title: `${name} has been in stock over ${days} days`,
          body: `${name} entered stock on ${s.stockedOn}. Review its price or move it on.`,
          severity: "warning",
          data: { vehicleId: s.vehicleId },
        });
      }
    });
  }
}
