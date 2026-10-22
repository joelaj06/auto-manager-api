import { Money } from "../../../domain/money/Money.js";
import { reminderThreshold } from "../../../domain/notifications/NotificationRules.js";
import type { IDriverRepository } from "../../../domain/repositories/IPartyRepositories.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { WorkPayAgreement } from "../../../domain/workpay/WorkPayAgreement.js";
import { daysInArrears } from "../../../domain/workpay/WorkPayPortfolio.js";
import type { ILogger } from "../../ports/ILogger.js";
import type {
  INotificationSettingsStore,
  NotificationSettings,
} from "../../ports/INotifications.js";
import type {
  IOrganisationSettings,
  OrganisationRecord,
} from "../../ports/IOrganisationSettings.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IWorkPaySettingsStore } from "../../ports/IWorkPayRecords.js";
import type { InstalmentNoticeRow, IWorkPayReporting } from "../../ports/IWorkPayReporting.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { Notifier } from "../notifications/Notifier.js";

const STANDARD_SMS = {
  workpay_due:
    "Hello {{driverName}}, your work and pay instalment of {{amount}} ({{number}}) is due on {{dueOn}}. Thank you. {{businessName}}",
  workpay_overdue:
    "Hello {{driverName}}, your instalment of {{amount}} ({{number}}) due {{dueOn}} is overdue. Please pay today to avoid late fees. {{businessName}}",
  workpay_guarantor_alert:
    "Hello {{guarantorName}}, {{driverName}}, whose work and pay agreement {{number}} you guarantee, is behind by {{amount}}. Please help them pay. {{businessName}}",
  workpay_payment_received:
    "Hello {{driverName}}, we received {{amount}} for {{number}}. Balance: {{balance}}. Next due: {{nextDue}}. Thank you. {{businessName}}",
  half_paid:
    "Well done {{driverName}}! You have paid half of work and pay agreement {{number}}. Keep going. {{businessName}}",
  paid_in_full:
    "Congratulations {{driverName}}! Agreement {{number}} is paid in full. Sign the transfer letter in the app to take ownership. {{businessName}}",
  transferred:
    "Congratulations {{driverName}}! {{plateNumber}} is now yours. Your signed transfer letter is in the app. {{businessName}}",
} as const;

type Context = Readonly<{
  settings: NotificationSettings;
  organisation: OrganisationRecord;
  money: (minor: number) => string;
}>;

type Milestone = "half_paid" | "paid_in_full" | "transferred";

/**
 * Work & Pay notifications (docs/08 §6, docs/15 §2) through the tenant's SMS provider and the
 * staff apps: instalments due in a few days, instalments overdue (once each, with a daily list
 * for the branch), guarantors told when the business opts in, defaults escalated to managers —
 * all in the morning run — and, as they happen, payments received with the new balance and the
 * milestones (half paid, paid in full, the vehicle the driver's). Dedupe keys make every run
 * safe to repeat.
 */
export class WorkPayNotifications {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      settings: INotificationSettingsStore;
      workpaySettings: IWorkPaySettingsStore;
      organisation: IOrganisationSettings;
      reporting: IWorkPayReporting;
      drivers: IDriverRepository;
      vehicles: IVehicleRepository;
      notifier: Notifier;
      posting: LedgerPosting;
      logger: ILogger;
    }>,
  ) {}

  /** The morning run (with the other reminder rules). */
  async morning(today: string): Promise<void> {
    const failed: string[] = [];
    for (const [name, run] of [
      ["workpay_due", () => this.due(today)],
      ["workpay_overdue", () => this.overdue(today)],
      ["workpay_guarantor_alert", () => this.guarantors(today)],
      ["workpay_defaulted", () => this.defaulted()],
    ] as const)
      try {
        await run();
      } catch (error) {
        failed.push(name);
        this.deps.logger.error("Notification rule failed", {
          rule: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    if (failed.length > 0) throw new Error(`Notification rules failed: ${failed.join(", ")}`);
  }

  // --- as it happens (inside the caller's unit of work) ---

  async paymentReceived(
    agreement: WorkPayAgreement,
    payment: Readonly<{
      paymentId: string;
      amountMinor: number;
      balanceMinor: number;
      nextDueOn: string | null;
    }>,
  ): Promise<void> {
    const ctx = await this.context();
    if (!ctx.settings.rules.workpay_payment_received.enabled) return;
    const a = agreement.snapshot();
    const driver = await this.driver(a.driverId);
    await this.deps.notifier.sms(ctx.settings, ctx.organisation.timezone, {
      rule: "workpay_payment_received",
      driverId: a.driverId,
      phone: driver.phone,
      dedupeKey: `workpay_payment:${payment.paymentId}`,
      standardText: STANDARD_SMS.workpay_payment_received,
      values: {
        driverName: driver.name,
        amount: ctx.money(payment.amountMinor),
        number: a.number,
        balance: ctx.money(payment.balanceMinor),
        nextDue: payment.nextDueOn ?? "none",
        businessName: ctx.organisation.name,
      },
    });
  }

  async milestone(agreement: WorkPayAgreement, milestone: Milestone): Promise<void> {
    const ctx = await this.context();
    if (!ctx.settings.rules.workpay_milestones.enabled) return;
    const a = agreement.snapshot();
    const driver = await this.driver(a.driverId);
    const vehicle = (await this.deps.vehicles.findById(a.vehicleId))?.snapshot();
    await this.deps.notifier.sms(ctx.settings, ctx.organisation.timezone, {
      rule: "workpay_milestones",
      driverId: a.driverId,
      phone: driver.phone,
      dedupeKey: `workpay_${milestone}:${a.id}`,
      standardText: STANDARD_SMS[milestone],
      values: {
        driverName: driver.name,
        number: a.number,
        plateNumber: vehicle?.plateNumber ?? "your vehicle",
        businessName: ctx.organisation.name,
      },
    });
  }

  // --- the morning rules ---

  private due(today: string): Promise<void> {
    return this.within(async ({ settings, organisation, money }) => {
      const rule = settings.rules.workpay_due;
      if (!rule.enabled) return;
      const days = rule.daysBefore ?? [1];
      // Every day up to the furthest reminder: a missed run still reminds at the next threshold.
      const rows = await this.deps.reporting.instalmentsDueOn(
        Array.from({ length: Math.max(0, ...days) + 1 }, (_, d) =>
          TenantCalendar.addDays(today, d),
        ),
      );
      for (const r of rows) {
        const left = daysBetween(today, r.dueOn);
        const threshold = reminderThreshold(left, days);
        if (threshold === null) continue;
        await this.sms(settings, organisation, r, {
          rule: "workpay_due",
          dedupeKey: `workpay_due:${r.instalmentId}:${threshold}`,
          amount: money(r.outstandingMinor),
        });
      }
    });
  }

  private overdue(today: string): Promise<void> {
    return this.within(async ({ settings, organisation, money }) => {
      const rule = settings.rules.workpay_overdue;
      if (!rule.enabled) return;
      const rows = await this.deps.reporting.overdueInstalments();
      const byBranch = new Map<string, InstalmentNoticeRow[]>();
      for (const r of rows) {
        await this.sms(settings, organisation, r, {
          rule: "workpay_overdue",
          dedupeKey: `workpay_overdue:${r.instalmentId}`,
          amount: money(r.outstandingMinor),
        });
        byBranch.set(r.branchId, [...(byBranch.get(r.branchId) ?? []), r]);
      }
      for (const [branchId, overdue] of byBranch) {
        const agreements = new Set(overdue.map((r) => r.agreementId));
        const names = [...new Set(overdue.map((r) => r.driverName))];
        const total = overdue.reduce((sum, r) => sum + r.outstandingMinor, 0);
        await this.deps.notifier.staff(settings, {
          rule: "workpay_overdue",
          permission: "workpay.payment.record",
          branchId,
          dedupeKey: `workpay_overdue:${branchId}:${today}`,
          title: `${agreements.size} work and pay ${agreements.size === 1 ? "agreement is" : "agreements are"} behind`,
          body: `${money(total)} overdue: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}.`,
          severity: "warning",
          data: { branchId, date: today },
        });
      }
    });
  }

  private guarantors(today: string): Promise<void> {
    return this.within(async ({ settings, organisation, money }) => {
      if (!settings.rules.workpay_guarantor_alert.enabled) return;
      const { guarantorAlertAfterDays } = await this.deps.workpaySettings.get();
      for (const a of await this.deps.reporting.inArrears()) {
        if (daysInArrears(a.arrearsSince, today) < guarantorAlertAfterDays) continue;
        for (const g of a.guarantors)
          await this.deps.notifier.sms(settings, organisation.timezone, {
            rule: "workpay_guarantor_alert",
            recipientType: "guarantor",
            driverId: a.agreementId,
            phone: g.phone,
            dedupeKey: `workpay_guarantor:${a.agreementId}:${a.arrearsSince}:${g.phone}`,
            standardText: STANDARD_SMS.workpay_guarantor_alert,
            values: {
              guarantorName: g.name,
              driverName: a.driverName,
              amount: money(a.overdueMinor),
              number: a.number,
              businessName: organisation.name,
            },
          });
      }
    });
  }

  private defaulted(): Promise<void> {
    return this.within(async ({ settings, money }) => {
      if (!settings.rules.workpay_defaulted.enabled) return;
      for (const a of await this.deps.reporting.inArrears()) {
        if (a.status !== "defaulted") continue;
        await this.deps.notifier.staff(settings, {
          rule: "workpay_defaulted",
          permission: "workpay.terminate",
          branchId: a.branchId,
          dedupeKey: `workpay_defaulted:${a.agreementId}:${a.arrearsSince}`,
          title: `${a.number} has defaulted`,
          body: `${a.driverName} is ${money(a.overdueMinor)} behind since ${a.arrearsSince}. Restructure, settle or repossess.`,
          severity: "critical",
          data: { agreementId: a.agreementId },
        });
      }
    });
  }

  // --- helpers ---

  private async sms(
    settings: NotificationSettings,
    organisation: OrganisationRecord,
    r: InstalmentNoticeRow,
    message: Readonly<{
      rule: "workpay_due" | "workpay_overdue";
      dedupeKey: string;
      amount: string;
    }>,
  ): Promise<void> {
    await this.deps.notifier.sms(settings, organisation.timezone, {
      rule: message.rule,
      driverId: r.driverId,
      phone: r.phone,
      dedupeKey: message.dedupeKey,
      standardText: STANDARD_SMS[message.rule],
      values: {
        driverName: r.driverName,
        amount: message.amount,
        number: r.number,
        dueOn: r.dueOn,
        businessName: organisation.name,
      },
    });
  }

  private async driver(id: string) {
    const d = (await this.deps.drivers.findById(id))!.snapshot();
    return { name: `${d.firstName} ${d.lastName}`, phone: d.phone };
  }

  private async context(): Promise<Context> {
    const { deps } = this;
    const base = await deps.posting.baseCurrency();
    return {
      settings: await deps.settings.get(),
      organisation: await deps.organisation.get(),
      money: (minor) => Money.ofMinor(minor, base).formatAscii(),
    };
  }

  private within(body: (ctx: Context) => Promise<void>): Promise<void> {
    return this.deps.unitOfWork.run(async () => body(await this.context()));
  }
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
