import { Money } from "../../../domain/money/Money.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { ILeads } from "../../ports/IDealerSales.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { Notifier } from "../notifications/Notifier.js";
import type { DealerQuotes } from "./DealerQuotes.js";

/**
 * The daily sales jobs (docs/10 §4, §6, decision 443): follow-ups due today or overdue remind
 * whoever has them (rule `lead_follow_up`, once per task); a listed vehicle that fits a lead's
 * saved search is reported once to the lead's sales executive, or the branch's staff who see
 * leads when it has none (rule `stock_match`); sent quotes past their date lapse.
 */
export class DealerCrmAlerts implements ITenantDailyTask {
  readonly name = "dealer_crm";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      leads: ILeads;
      quotes: DealerQuotes;
      organisation: IOrganisationSettings;
      settings: INotificationSettingsStore;
      notifier: Notifier;
    }>,
  ) {}

  run(localDate: string): Promise<void> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const settings = await deps.settings.get();
      for (const t of await deps.leads.dueTasks(localDate)) {
        if (t.assignedTo === null) continue;
        await deps.notifier.users(settings, {
          rule: "lead_follow_up",
          userIds: [t.assignedTo],
          dedupeKey: `lead_follow_up:${t.id}`,
          title: `Follow up ${t.leadName}: ${t.title}`,
          body: `${t.title} for lead ${t.leadNumber} (${t.leadName}) was due on ${t.dueOn}.`,
          severity: t.dueOn < localDate ? "warning" : "info",
          data: { leadId: t.leadId, taskId: t.id },
        });
      }

      const searches = await deps.leads.savedSearches();
      if (searches.length > 0) {
        const { baseCurrency } = await deps.organisation.currencySettings();
        const listed = await deps.leads.listedVehicles();
        for (const lead of searches)
          for (const v of listed) {
            if (!lead.matches(v) || !(await deps.leads.recordMatch(lead.id, v.vehicleId))) continue;
            const p = lead.snapshot();
            const name = `${v.make} ${v.model}${v.year === null ? "" : ` ${v.year}`}`;
            const price =
              v.askingPriceMinor === null
                ? ""
                : ` at ${Money.ofMinor(v.askingPriceMinor, baseCurrency).toJSON().formatted}`;
            const notice = {
              rule: "stock_match" as const,
              dedupeKey: `stock_match:${lead.id}:${v.vehicleId}`,
              title: `${name} for ${p.name}`,
              body: `${name} (${v.plateNumber ?? v.code})${price} fits what ${p.name} (lead ${p.number}) is looking for.`,
              severity: "info" as const,
              data: { leadId: lead.id, vehicleId: v.vehicleId },
            };
            if (p.assignedTo !== null)
              await deps.notifier.users(settings, { ...notice, userIds: [p.assignedTo] });
            else
              await deps.notifier.staff(settings, {
                ...notice,
                permission: "dealer.leads.view",
                branchId: p.branchId,
              });
          }
      }

      await deps.quotes.expire(localDate);
    });
  }
}
