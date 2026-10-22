import { Money } from "../../../domain/money/Money.js";
import { reminderThreshold } from "../../../domain/notifications/NotificationRules.js";
import { addDays } from "../../../domain/reporting/DateRange.js";
import type { ILogger } from "../../ports/ILogger.js";
import type {
  INotificationQueries,
  INotificationSettingsStore,
  NotificationSettings,
} from "../../ports/INotifications.js";
import type {
  IOrganisationSettings,
  OrganisationRecord,
} from "../../ports/IOrganisationSettings.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { ExpenseAdministration } from "../expenses/ExpenseAdministration.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { WorkPayNotifications } from "../workpay/WorkPayNotifications.js";
import type { Notifier } from "./Notifier.js";

const DOCUMENT_LABELS: Readonly<Record<string, string>> = {
  registration: "Registration",
  roadworthy: "Roadworthy certificate",
  insurance: "Insurance",
  income_tax_sticker: "Income tax sticker",
  permit: "Permit",
  customs: "Customs papers",
  other: "Document",
};

const STANDARD_SMS = {
  driver_licence_expiry:
    "Hello {{driverName}}, your driving licence expires on {{expiresOn}}. Please renew it and bring the new licence to {{businessName}}.",
  remittance_due:
    "Hello {{driverName}}, your remittance of {{amount}} for {{plateNumber}} is due today ({{dueOn}}). Thank you. {{businessName}}",
  remittance_cutoff:
    "Hello {{driverName}}, we have not received your remittance of {{amount}} for {{plateNumber}} due {{dueOn}}. Please pay today. {{businessName}}",
} as const;

/** How far ahead expiry rules look (a document may ask for reminders up to a year before). */
const LOOK_AHEAD_DAYS = 365;

type Context = Readonly<{
  settings: NotificationSettings;
  organisation: OrganisationRecord;
  money: (minor: number) => string;
}>;

/**
 * The automation rules of docs/15 §2 that P2-9 covers. Each finds what is due and hands it to the
 * Notifier; dedupe keys make every run safe to repeat, and a missed day still reminds at the next
 * threshold ("expires in 13 days" when the 14-day run did not happen).
 */
export class ReminderRules {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      settings: INotificationSettingsStore;
      organisation: IOrganisationSettings;
      queries: INotificationQueries;
      notifier: Notifier;
      expenses: ExpenseAdministration;
      posting: LedgerPosting;
      logger: ILogger;
      /** Work & Pay due, overdue, guarantor and default rules. */
      workpay?: WorkPayNotifications;
    }>,
  ) {}

  /** The morning run: expiries, today's remittances, budgets, approvals waiting. */
  async morning(today: string): Promise<void> {
    await this.each([
      ["vehicle_document_expiry", () => this.vehicleDocuments(today)],
      ["driver_licence_expiry", () => this.licences(today)],
      ["remittance_due", () => this.remittancesDue(today)],
      ["budget_threshold", () => this.budgets(today)],
      ["expense_approvals", () => this.approvals(today)],
      ["workpay", () => this.deps.workpay?.morning(today) ?? Promise.resolve()],
    ]);
  }

  /** At the cut-off time: today's remittances with nothing (or not enough) received. */
  async cutoff(today: string): Promise<void> {
    await this.each([["remittance_cutoff", () => this.remittanceCutoff(today)]]);
  }

  private async each(rules: readonly (readonly [string, () => Promise<void>])[]): Promise<void> {
    const failed: string[] = [];
    for (const [name, run] of rules) {
      try {
        await run();
      } catch (error) {
        failed.push(name);
        this.deps.logger.error("Notification rule failed", {
          rule: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failed.length > 0) throw new Error(`Notification rules failed: ${failed.join(", ")}`);
  }

  private within(body: (ctx: Context) => Promise<void>): Promise<void> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const settings = await deps.settings.get();
      const organisation = await deps.organisation.get();
      const base = await deps.posting.baseCurrency();
      await body({
        settings,
        organisation,
        money: (minor) => Money.ofMinor(minor, base).formatAscii(),
      });
    });
  }

  private vehicleDocuments(today: string): Promise<void> {
    return this.within(async ({ settings }) => {
      const rule = settings.rules.vehicle_document_expiry;
      if (!rule.enabled) return;
      const docs = await this.deps.queries.expiringVehicleDocuments(
        today,
        addDays(today, LOOK_AHEAD_DAYS),
      );
      for (const doc of docs) {
        const days = doc.reminderDays.length > 0 ? doc.reminderDays : (rule.daysBefore ?? []);
        const left = daysBetween(today, doc.expiresOn);
        const threshold = reminderThreshold(left, days);
        if (threshold === null) continue;
        const label =
          doc.type === "other" && doc.title !== null ? doc.title : DOCUMENT_LABELS[doc.type]!;
        const vehicle = doc.plateNumber ?? doc.vehicleCode;
        await this.deps.notifier.staff(settings, {
          rule: "vehicle_document_expiry",
          permission: "vehicles.documents.manage",
          branchId: doc.branchId,
          dedupeKey: `vehicle_document:${doc.documentId}:${doc.expiresOn}:${threshold}`,
          title: `${vehicle}: ${label} ${expiresIn(left)}`,
          body: `${label} of ${vehicle} (${doc.vehicleCode}) expires on ${doc.expiresOn}. Renew it and upload the new document.`,
          severity: left <= 3 ? "critical" : left <= 14 ? "warning" : "info",
          data: { vehicleId: doc.vehicleId, documentId: doc.documentId },
        });
      }
    });
  }

  private licences(today: string): Promise<void> {
    return this.within(async ({ settings, organisation }) => {
      const rule = settings.rules.driver_licence_expiry;
      if (!rule.enabled) return;
      const days = rule.daysBefore ?? [];
      const drivers = await this.deps.queries.expiringLicences(
        today,
        addDays(today, Math.max(0, ...days)),
      );
      for (const d of drivers) {
        const left = daysBetween(today, d.expiresOn);
        const threshold = reminderThreshold(left, days);
        if (threshold === null) continue;
        const dedupeKey = `licence:${d.driverId}:${d.expiresOn}:${threshold}`;
        await this.deps.notifier.sms(settings, organisation.timezone, {
          rule: "driver_licence_expiry",
          driverId: d.driverId,
          phone: d.phone,
          dedupeKey,
          standardText: STANDARD_SMS.driver_licence_expiry,
          values: {
            driverName: d.name,
            expiresOn: d.expiresOn,
            businessName: organisation.name,
          },
        });
        await this.deps.notifier.staff(settings, {
          rule: "driver_licence_expiry",
          permission: "drivers.update",
          branchId: d.branchId,
          dedupeKey,
          title: `${d.name}: driving licence ${expiresIn(left)}`,
          body: `${d.name}'s driving licence expires on ${d.expiresOn}. Record the renewed licence on the driver.`,
          severity: left <= 7 ? "critical" : "warning",
          data: { driverId: d.driverId },
        });
      }
    });
  }

  private remittancesDue(today: string): Promise<void> {
    return this.within(async ({ settings, organisation, money }) => {
      if (!settings.rules.remittance_due.enabled) return;
      for (const r of await this.deps.queries.remittancesEnding(today, ["pending"])) {
        await this.deps.notifier.sms(settings, organisation.timezone, {
          rule: "remittance_due",
          driverId: r.driverId,
          phone: r.phone,
          dedupeKey: `remittance_due:${r.remittanceId}`,
          standardText: STANDARD_SMS.remittance_due,
          values: {
            driverName: r.driverName,
            amount: money(r.outstandingMinor),
            plateNumber: r.plateNumber ?? "your vehicle",
            dueOn: r.periodEnd,
            businessName: organisation.name,
          },
        });
      }
    });
  }

  private remittanceCutoff(today: string): Promise<void> {
    return this.within(async ({ settings, organisation, money }) => {
      if (!settings.rules.remittance_cutoff.enabled) return;
      // A declaration waiting for approval counts as paid in for the cut-off.
      const unpaid = await this.deps.queries.remittancesEnding(today, [
        "pending",
        "partially_paid",
        "overdue",
      ]);
      const byBranch = new Map<string, typeof unpaid>();
      for (const r of unpaid) {
        await this.deps.notifier.sms(settings, organisation.timezone, {
          rule: "remittance_cutoff",
          driverId: r.driverId,
          phone: r.phone,
          dedupeKey: `remittance_cutoff:${r.remittanceId}`,
          standardText: STANDARD_SMS.remittance_cutoff,
          values: {
            driverName: r.driverName,
            amount: money(r.outstandingMinor),
            plateNumber: r.plateNumber ?? "your vehicle",
            dueOn: r.periodEnd,
            businessName: organisation.name,
          },
        });
        byBranch.set(r.branchId, [...(byBranch.get(r.branchId) ?? []), r]);
      }
      for (const [branchId, rows] of byBranch) {
        const total = rows.reduce((sum, r) => sum + r.outstandingMinor, 0);
        const names = rows.slice(0, 5).map((r) => r.driverName);
        const more = rows.length > 5 ? ` and ${rows.length - 5} more` : "";
        await this.deps.notifier.staff(settings, {
          rule: "remittance_cutoff",
          permission: "remittances.approve",
          branchId,
          dedupeKey: `remittance_cutoff:${branchId}:${today}`,
          title: `${rows.length} ${rows.length === 1 ? "driver has" : "drivers have"} not remitted today`,
          body: `${money(total)} outstanding for ${today}: ${names.join(", ")}${more}.`,
          severity: "warning",
          data: { branchId, date: today },
        });
      }
    });
  }

  private budgets(today: string): Promise<void> {
    return this.within(async ({ settings }) => {
      if (!settings.rules.budget_threshold.enabled) return;
      const month = today.slice(0, 7);
      for (const status of await this.deps.expenses.budgets(month)) {
        if (status.level === "ok") continue;
        const { budget } = status;
        const exceeded = status.level === "exceeded";
        await this.deps.notifier.staff(settings, {
          rule: "budget_threshold",
          permission: "expenses.budgets.manage",
          branchId: budget.branchId,
          dedupeKey: `budget:${budget.id}:${month}:${status.level}`,
          title: `${budget.name} budget ${exceeded ? "exceeded" : `at ${Math.floor(status.percent)}%`}`,
          body: `${status.spent.formatted} of ${budget.monthlyAmount.formatted} spent in ${month}.`,
          severity: exceeded ? "critical" : "warning",
          data: { budgetId: budget.id, month },
        });
      }
    });
  }

  private approvals(today: string): Promise<void> {
    return this.within(async ({ settings, money }) => {
      if (!settings.rules.expense_approvals.enabled) return;
      for (const branch of await this.deps.queries.pendingApprovals()) {
        await this.deps.notifier.staff(settings, {
          rule: "expense_approvals",
          permission: "expenses.approve",
          branchId: branch.branchId,
          dedupeKey: `expense_approvals:${branch.branchId}:${today}`,
          title: `${branch.count} ${branch.count === 1 ? "expense is" : "expenses are"} waiting for approval`,
          body: `${money(branch.amountMinor)} in total.`,
          severity: "info",
          data: { branchId: branch.branchId },
        });
      }
    });
  }
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function expiresIn(days: number): string {
  if (days === 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}
