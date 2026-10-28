import type { RuleKey } from "../../../domain/notifications/NotificationRules.js";
import { Money } from "../../../domain/money/Money.js";
import type { RentalBooking } from "../../../domain/rentals/RentalBooking.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ILogger } from "../../ports/ILogger.js";
import type {
  INotificationSettingsStore,
  NotificationSettings,
} from "../../ports/INotifications.js";
import type {
  IOrganisationSettings,
  OrganisationRecord,
} from "../../ports/IOrganisationSettings.js";
import type { IRentalRates } from "../../ports/IRentalRates.js";
import type { IRentalReporting, RentalNoticeRow } from "../../ports/IRentalReporting.js";
import type { ITenantRoster } from "../../ports/ITenantRoster.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { Notifier } from "../notifications/Notifier.js";

const STANDARD = {
  rental_confirmed:
    "Hello {{customerName}}, your rental {{number}} is confirmed: {{vehicle}} from {{pickupAt}} to {{returnAt}} at {{branch}}. Total {{amount}}. {{businessName}}",
  rental_pickup_reminder:
    "Hello {{customerName}}, a reminder that you collect {{vehicle}} ({{number}}) at {{branch}} on {{pickupAt}}. Please bring your driving licence and ID. {{businessName}}",
  rental_return_reminder:
    "Hello {{customerName}}, {{vehicle}} ({{number}}) is due back at {{branch}} by {{returnAt}}. Call us if you need longer. {{businessName}}",
  rental_overdue:
    "Hello {{customerName}}, {{vehicle}} ({{number}}) was due back at {{branch}} on {{returnAt}}. Please return it or call us; the extra time is charged. {{businessName}}",
  rental_payment_received:
    "Hello {{customerName}}, we received {{amount}} for rental {{number}} (receipt {{receipt}}). Balance: {{balance}}. Thank you. {{businessName}}",
  rental_deposit_received:
    "Hello {{customerName}}, we received a security deposit of {{amount}} for rental {{number}} (receipt {{receipt}}). It is returned when the vehicle is back. {{businessName}}",
  rental_invoiced:
    "Hello {{customerName}}, invoice {{invoice}} for rental {{number}}: {{amount}}. Balance {{balance}}, due {{dueOn}}. Thank you. {{businessName}}",
} as const;

const TITLES: Readonly<Record<keyof typeof STANDARD, string>> = {
  rental_confirmed: "Your rental is confirmed",
  rental_pickup_reminder: "Your rental pickup",
  rental_return_reminder: "Your rental is due back",
  rental_overdue: "Your rental is overdue",
  rental_payment_received: "Payment received",
  rental_deposit_received: "Security deposit received",
  rental_invoiced: "Your rental invoice",
};

type Context = Readonly<{
  settings: NotificationSettings;
  organisation: OrganisationRecord;
  when: (instant: Date) => string;
  money: (minor: number, currency: string) => string;
}>;

export type PaymentNotice = Readonly<{
  paymentId: string;
  number: string;
  amountMinor: number;
  /** A security deposit (held, not a payment of the charges). */
  deposit: boolean;
  /** What the booking still owes afterwards. */
  balanceMinor: number;
}>;

export type InvoiceNotice = Readonly<{
  invoiceId: string;
  number: string;
  totalMinor: number;
  balanceMinor: number;
  dueDate: string;
}>;

/**
 * Rental notifications (docs/07 §10) through the business's SMS provider and email: the
 * booking confirmed, the pickup and return reminders and overdue returns (the hourly run, also
 * telling the branch's check-in staff), a receipt for each payment and the invoice. Dedupe keys
 * make every run safe to repeat; a changed time reminds again (decisions 369–370).
 */
export class RentalNotifications {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      settings: INotificationSettingsStore;
      organisation: IOrganisationSettings;
      rates: IRentalRates;
      reporting: IRentalReporting;
      notifier: Notifier;
      clock: { now(): Date };
      logger: ILogger;
    }>,
  ) {}

  /** The hourly run: reminders due within the settings' hours, and overdue returns. */
  async hourly(): Promise<void> {
    const failed: string[] = [];
    for (const [name, run] of [
      ["rental_pickup_reminder", () => this.pickups()],
      ["rental_return_reminder", () => this.returns()],
      ["rental_overdue", () => this.overdue()],
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

  async confirmed(booking: RentalBooking): Promise<void> {
    const row = await this.deps.reporting.notice(booking.id);
    if (row === null) return;
    const ctx = await this.context();
    await this.tell(ctx, "rental_confirmed", row, `rental_confirmed:${row.bookingId}`, {
      amount: ctx.money(row.chargedMinor, row.currency),
    });
  }

  async paymentReceived(booking: RentalBooking, payment: PaymentNotice): Promise<void> {
    const row = await this.deps.reporting.notice(booking.id);
    if (row === null) return;
    const ctx = await this.context();
    await this.tell(
      ctx,
      "rental_payment_received",
      row,
      `rental_payment:${payment.paymentId}`,
      {
        amount: ctx.money(payment.amountMinor, row.currency),
        receipt: payment.number,
        balance: ctx.money(Math.max(0, payment.balanceMinor), row.currency),
      },
      payment.deposit ? "rental_deposit_received" : "rental_payment_received",
    );
  }

  async invoiced(booking: RentalBooking, invoice: InvoiceNotice): Promise<void> {
    const row = await this.deps.reporting.notice(booking.id);
    if (row === null) return;
    const ctx = await this.context();
    await this.tell(ctx, "rental_invoiced", row, `rental_invoice:${invoice.invoiceId}`, {
      invoice: invoice.number,
      amount: ctx.money(invoice.totalMinor, row.currency),
      balance: ctx.money(Math.max(0, invoice.balanceMinor), row.currency),
      dueOn: invoice.dueDate,
    });
  }

  // --- the hourly rules ---

  private pickups(): Promise<void> {
    return this.within(async (ctx, now) => {
      const { pickupReminderHours } = await this.deps.rates.settings();
      const until = new Date(now.getTime() + pickupReminderHours * 3_600_000);
      for (const row of await this.deps.reporting.pickupsBetween(now, until))
        await this.tell(
          ctx,
          "rental_pickup_reminder",
          row,
          `rental_pickup:${row.bookingId}:${row.pickupAt.toISOString()}`,
        );
    });
  }

  private returns(): Promise<void> {
    return this.within(async (ctx, now) => {
      const { returnReminderHours } = await this.deps.rates.settings();
      const until = new Date(now.getTime() + returnReminderHours * 3_600_000);
      for (const row of await this.deps.reporting.returnsBetween(now, until))
        await this.tell(
          ctx,
          "rental_return_reminder",
          row,
          `rental_return:${row.bookingId}:${row.returnAt.toISOString()}`,
        );
    });
  }

  private overdue(): Promise<void> {
    return this.within(async (ctx, now) => {
      const { graceMinutes } = await this.deps.rates.settings();
      const before = new Date(now.getTime() - graceMinutes * 60_000);
      for (const row of await this.deps.reporting.overdue(before)) {
        const key = `rental_overdue:${row.bookingId}:${row.returnAt.toISOString()}`;
        await this.tell(ctx, "rental_overdue", row, key);
        await this.deps.notifier.staff(ctx.settings, {
          rule: "rental_overdue",
          permission: "rentals.checkin",
          branchId: row.branchId,
          dedupeKey: key,
          title: `${row.number} is overdue`,
          body: `${row.customerName} has not brought back ${vehicleOf(row)}, due ${ctx.when(row.returnAt)}.`,
          severity: "warning",
          data: { bookingId: row.bookingId },
        });
      }
    });
  }

  // --- helpers ---

  private async tell(
    ctx: Context,
    rule: RuleKey,
    row: RentalNoticeRow,
    dedupeKey: string,
    extra: Readonly<Record<string, string>> = {},
    text: keyof typeof STANDARD = rule as keyof typeof STANDARD,
  ): Promise<void> {
    await this.deps.notifier.customer(ctx.settings, ctx.organisation.timezone, {
      rule,
      customerId: row.customerId,
      name: row.customerName,
      phone: row.phone,
      email: row.email,
      dedupeKey,
      title: `${TITLES[text]} (${row.number})`,
      standardText: STANDARD[text],
      values: {
        customerName: row.customerName,
        number: row.number,
        vehicle: vehicleOf(row),
        pickupAt: ctx.when(row.pickupAt),
        returnAt: ctx.when(row.returnAt),
        branch: row.branchName,
        businessName: ctx.organisation.name,
        ...extra,
      },
    });
  }

  private async context(): Promise<Context> {
    const { deps } = this;
    const organisation = await deps.organisation.get();
    const format = new Intl.DateTimeFormat("en-GB", {
      timeZone: organisation.timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    return {
      settings: await deps.settings.get(),
      organisation,
      when: (instant) => format.format(instant),
      money: (minor, currency) => Money.ofMinor(minor, currency).formatAscii(),
    };
  }

  private within(body: (ctx: Context, now: Date) => Promise<void>): Promise<void> {
    return this.deps.unitOfWork.run(async () => body(await this.context(), this.deps.clock.now()));
  }
}

const vehicleOf = (row: RentalNoticeRow) =>
  `${row.make} ${row.model}${row.plateNumber === null ? "" : ` (${row.plateNumber})`}`;

/** The hourly rental reminders of one tenant. */
export class RunRentalReminders implements IJobHandler<"tenant.rental_reminders"> {
  readonly job = "tenant.rental_reminders" as const;

  constructor(private readonly notifications: RentalNotifications) {}

  handle(): Promise<void> {
    return this.notifications.hourly();
  }
}

/** Hourly: a rental reminder run for every usable tenant. */
export class SweepRentalReminders implements IJobHandler<"rentals.reminders_sweep"> {
  readonly job = "rentals.reminders_sweep" as const;

  constructor(private readonly deps: Readonly<{ roster: ITenantRoster; queue: IJobQueue }>) {}

  async handle(): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const tenants = await this.deps.roster.listUsable(after, 500);
      for (const tenant of tenants)
        await this.deps.queue.enqueue(
          "tenant.rental_reminders",
          { tenantId: tenant.id },
          { singletonKey: tenant.id },
        );
      if (tenants.length < 500) return;
      after = tenants.at(-1)?.id ?? null;
    }
  }
}
