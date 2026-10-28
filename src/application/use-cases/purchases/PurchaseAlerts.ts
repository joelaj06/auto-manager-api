import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IPurchases } from "../../ports/IPurchases.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { Notifier } from "../notifications/Notifier.js";
import { DEFAULT_PORT_FREE_DAYS } from "./Purchases.js";

const DAY_MS = 86_400_000;
/** Warned this many days before the free days at the port run out. */
const WARN_DAYS = 2;

/**
 * The daily import alerts (docs/11 §4, decision 427): a shipped import past its ETA without its
 * arrival recorded (rule `purchase_eta`, once per ETA), and an import at the port nearing the end
 * of its free days and then paying demurrage (rule `purchase_demurrage`, once each).
 */
export class PurchaseAlerts implements ITenantDailyTask {
  readonly name = "purchase_alerts";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      purchases: IPurchases;
      settings: INotificationSettingsStore;
      notifier: Notifier;
    }>,
  ) {}

  run(localDate: string): Promise<void> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const settings = await deps.settings.get();
      for (const p of await deps.purchases.importsUnderWay()) {
        if (p.stage === "shipped" && p.eta !== null && p.eta <= localDate)
          await deps.notifier.staff(settings, {
            rule: "purchase_eta",
            permission: "purchases.view",
            branchId: p.branchId,
            dedupeKey: `purchase_eta:${p.purchaseId}:${p.eta}`,
            title: `${p.number} was due at the port on ${p.eta}`,
            body: `The import from ${p.supplierName} was expected on ${p.eta}. Record its arrival or update the ETA.`,
            severity: "info",
            data: { purchaseId: p.purchaseId },
          });
        if (p.arrivedOn === null || p.stage === "shipped") continue;
        const free = p.portFreeDays ?? DEFAULT_PORT_FREE_DAYS;
        const days = Math.round(
          (Date.parse(`${localDate}T00:00:00Z`) - Date.parse(`${p.arrivedOn}T00:00:00Z`)) / DAY_MS,
        );
        const ends = new Date(Date.parse(`${p.arrivedOn}T00:00:00Z`) + free * DAY_MS)
          .toISOString()
          .slice(0, 10);
        if (days >= free)
          await deps.notifier.staff(settings, {
            rule: "purchase_demurrage",
            permission: "purchases.view",
            branchId: p.branchId,
            dedupeKey: `purchase_demurrage:${p.purchaseId}:over`,
            title: `${p.number} is paying demurrage`,
            body: `The import from ${p.supplierName} has been at the port since ${p.arrivedOn}; its ${free} free days ended on ${ends}. Clear and release it.`,
            severity: "warning",
            data: { purchaseId: p.purchaseId },
          });
        else if (days >= free - WARN_DAYS)
          await deps.notifier.staff(settings, {
            rule: "purchase_demurrage",
            permission: "purchases.view",
            branchId: p.branchId,
            dedupeKey: `purchase_demurrage:${p.purchaseId}:near`,
            title: `${p.number}: free days at the port end on ${ends}`,
            body: `The import from ${p.supplierName} has been at the port since ${p.arrivedOn}. Demurrage starts after ${ends}.`,
            severity: "warning",
            data: { purchaseId: p.purchaseId },
          });
      }
    });
  }
}
