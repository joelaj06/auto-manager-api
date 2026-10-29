import { Money } from "../../../domain/money/Money.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { IClock } from "../../ports/IClock.js";
import type { IDeals } from "../../ports/IDealerDeals.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { Notifier } from "../notifications/Notifier.js";
import type { DealerDeals } from "./DealerDeals.js";

/**
 * The daily deal jobs (docs/10 §7, decisions 449–450): reservations whose hold ran out go back
 * to drafts with the vehicle back on sale, telling the sales executive (rule `deal_hold_lapsed`);
 * an in-house instalment past its date and not paid is reported once to the sales executive and
 * the branch's staff who take payments on sales (rule `deal_instalment_overdue`).
 */
export class DealerDealAlerts implements ITenantDailyTask {
  readonly name = "dealer_deals";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      deals: IDeals;
      sales: DealerDeals;
      organisation: IOrganisationSettings;
      settings: INotificationSettingsStore;
      notifier: Notifier;
      clock: IClock;
    }>,
  ) {}

  run(localDate: string): Promise<void> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const settings = await deps.settings.get();
      for (const deal of await deps.sales.lapse(localDate)) {
        const d = deal.snapshot();
        await deps.notifier.users(settings, {
          rule: "deal_hold_lapsed",
          userIds: [d.salesExecutiveId],
          dedupeKey: `deal_hold_lapsed:${d.id}:${d.holdUntil}`,
          title: `Hold on deal ${d.number} ran out`,
          body: `The vehicle held on deal ${d.number} until ${d.holdUntil} is back on sale; the deposit stays with the customer as credit.`,
          severity: "warning",
          data: { dealId: d.id, vehicleId: d.vehicleId },
        });
      }

      const ids = await deps.deals.withUnnoticedDue(localDate);
      if (ids.length === 0) return;
      const { baseCurrency } = await deps.organisation.currencySettings();
      for (const id of ids) {
        const deal = await deps.deals.lock(id);
        if (deal === null) continue;
        const position = await deps.sales.position(deal, localDate);
        if (position === null) continue;
        const d = deal.snapshot();
        const noticed = await deps.deals.noticed(id);
        const past = position.instalments.filter((i) => i.dueOn < localDate);
        for (const i of past) {
          if (i.status !== "overdue" || noticed.has(i.number)) continue;
          const left = Money.ofMinor(i.amountMinor - i.paidMinor, baseCurrency).toJSON().formatted;
          const notice = {
            rule: "deal_instalment_overdue" as const,
            dedupeKey: `deal_instalment_overdue:${d.id}:${i.number}`,
            title: `Instalment ${i.number} on deal ${d.number} is overdue`,
            body: `${left} of instalment ${i.number} on deal ${d.number}, due on ${i.dueOn}, is not paid.`,
            severity: "warning" as const,
            data: { dealId: d.id, instalment: String(i.number) },
          };
          await deps.notifier.users(settings, { ...notice, userIds: [d.salesExecutiveId] });
          await deps.notifier.staff(settings, {
            ...notice,
            permission: "dealer.deals.payments.record",
            branchId: d.branchId,
          });
        }
        // Still within grace: looked at again tomorrow.
        const settled = past.filter((i) => i.status !== "due" && i.status !== "partially_paid");
        await deps.deals.markNoticed(
          id,
          settled.map((i) => i.number),
          deps.clock.now(),
        );
      }
    });
  }
}
