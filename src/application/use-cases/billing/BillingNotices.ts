import type { NoticeChannel } from "../../../domain/billing/Dunning.js";
import { Money } from "../../../domain/money/Money.js";
import { RULES } from "../../../domain/notifications/NotificationRules.js";
import type { IBillingAutomationRepository } from "../../../domain/repositories/IBillingAutomationRepository.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { ISmsSender } from "../../ports/ISmsSender.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantSeeder } from "../../ports/ITenantSeeder.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { Notifier } from "../notifications/Notifier.js";

/** What a notice is about: an unpaid invoice, without its reference (docs/25 §5.1). */
export type NoticeSubject = Readonly<{
  tenantId: string;
  tenantName: string;
  invoiceId: string | null;
  outstandingMinor: number;
  currency: string;
  branchCount: number;
  dueOn: string;
  deactivateOn: string;
  extendedUntil: string | null;
}>;

type Text = Readonly<{ subject: string; body: string; severity: "info" | "warning" | "critical" }>;

/** The words of each step; reminders never carry an invoice number, only a sign-in link. */
export function noticeText(step: string, s: NoticeSubject): Text {
  const amount = Money.ofMinor(s.outstandingMinor, s.currency).formatAscii();
  const branches = `${s.branchCount} branch${s.branchCount === 1 ? "" : "es"}`;
  const days = Number(/_(\d+)$/.exec(step)?.[1] ?? 0);
  if (step.startsWith("reminder_"))
    return {
      subject: `Your Autoforce licence is due in ${days} day${days === 1 ? "" : "s"}`,
      body: `${amount} for ${s.tenantName} (${branches}) is due on ${s.dueOn}. Pay early in the Billing tab.`,
      severity: "info",
    };
  if (step === "due")
    return {
      subject: "Your Autoforce licence is due today",
      body: `${amount} for ${s.tenantName} (${branches}) is due today. A saved card is charged automatically; otherwise pay in the Billing tab.`,
      severity: "warning",
    };
  if (step.startsWith("overdue_"))
    return {
      subject: "Your Autoforce payment is overdue",
      body: `${amount} for ${s.tenantName} was due on ${s.dueOn}. Access will be switched off on ${s.deactivateOn} unless it is paid or more time is agreed.`,
      severity: "critical",
    };
  if (step.startsWith("extension_reminder_"))
    return {
      subject: `Your payment extension ends in ${days} day${days === 1 ? "" : "s"}`,
      body: `${amount} for ${s.tenantName} is due by ${s.extendedUntil ?? s.dueOn} (extension).`,
      severity: "warning",
    };
  if (step === "final_notice")
    return {
      subject: "Last day to pay: access is switched off tomorrow",
      body: `${amount} for ${s.tenantName} is still unpaid. Access will be switched off on ${s.deactivateOn}; pay today in the Billing tab to keep working.`,
      severity: "critical",
    };
  if (step === "deactivated")
    return {
      subject: `${s.tenantName} is deactivated for an unpaid invoice`,
      body: `Access is switched off until ${amount} is paid. Sign in to the Billing tab to pay or ask for more time; access returns as soon as it is paid.`,
      severity: "critical",
    };
  if (step === "extension_approved")
    return {
      subject: "More time to pay was granted",
      body: `You have until ${s.extendedUntil ?? s.dueOn} to pay ${amount} for ${s.tenantName}.`,
      severity: "info",
    };
  if (step === "extension_denied")
    return {
      subject: "Your request for more time was declined",
      body: `${amount} for ${s.tenantName} was due on ${s.dueOn}. Please pay in the Billing tab.`,
      severity: "warning",
    };
  throw new Error(`Unknown billing notice step ${step}`);
}

/**
 * Sends billing notices (docs/25 §5.1) on the policy's channels, once per tenant, invoice, step,
 * channel and recipient (`billing_notices`): email and SMS from the platform's own senders to the
 * tenant's billing contacts and its owner; the in-app inbox and push to every user holding
 * `billing.manage`. A channel that fails is logged as failed; the others still go.
 */
export class BillingNotices {
  constructor(
    private readonly deps: Readonly<{
      automation: IBillingAutomationRepository;
      email: NotificationService;
      sms: ISmsSender;
      tenantContext: ITenantContext;
      tenantUnitOfWork: IUnitOfWork;
      notifier: Notifier;
      settings: INotificationSettingsStore;
      seeder: ITenantSeeder;
      billingUrl: string;
      logger: ILogger;
    }>,
  ) {}

  /** Returns how many notices went out for the first time. */
  async send(
    step: string,
    subject: NoticeSubject,
    channels: readonly NoticeChannel[],
  ): Promise<number> {
    const { deps } = this;
    const text = noticeText(step, subject);
    const wanted = new Set(channels);
    let sent = 0;
    const owner = await this.inTenant(subject.tenantId, () => deps.seeder.owner());
    const people = [
      ...(owner === null ? [] : [{ name: owner.name, email: owner.email, phone: owner.phone }]),
      ...(await deps.automation.recipients(subject.tenantId)),
    ];
    const emails = new Map<string, string | null>();
    const phones = new Set<string>();
    for (const p of people) {
      if (p.email !== null && !emails.has(p.email.toLowerCase()))
        emails.set(p.email.toLowerCase(), p.name);
      if (p.phone !== null) phones.add(p.phone);
    }
    if (wanted.has("email"))
      for (const [address, name] of emails)
        sent += await this.once(step, subject, "email", address, async () => {
          await deps.email.sendEmail({
            to: address,
            template: "billing.notice",
            data: {
              name,
              subject: text.subject,
              paragraphs: [text.body],
              billingUrl: deps.billingUrl,
            },
            idempotencyKey: `billing:${subject.tenantId}:${subject.invoiceId ?? "-"}:${step}:${address}`,
            tenantId: subject.tenantId,
          });
        });
    if (wanted.has("sms"))
      for (const phone of phones)
        sent += await this.once(step, subject, "sms", phone, async () => {
          await deps.sms.send(phone, `Autoforce: ${text.body} ${deps.billingUrl}`);
        });
    if (wanted.has("in_app") || wanted.has("push"))
      sent += await this.once(step, subject, "in_app", "billing.manage", async () => {
        await this.inTenant(subject.tenantId, async () => {
          const settings = await deps.settings.get();
          // Always on, on the channels the policy chose (tenants cannot switch them off).
          const rule = {
            ...RULES.billing_notices.defaults,
            channels: RULES.billing_notices.channels.filter((c) => wanted.has(c)),
          };
          await deps.notifier.staff(
            { ...settings, rules: { ...settings.rules, billing_notices: rule } },
            {
              rule: "billing_notices",
              permission: "billing.manage",
              branchId: null,
              dedupeKey: `billing:${subject.invoiceId ?? "-"}:${step}`,
              title: text.subject,
              body: text.body,
              severity: text.severity,
              data: subject.invoiceId === null ? {} : { invoiceId: subject.invoiceId },
            },
          );
        });
      });
    return sent;
  }

  private async once(
    step: string,
    subject: NoticeSubject,
    channel: NoticeChannel,
    recipient: string,
    deliver: () => Promise<void>,
  ): Promise<number> {
    const { deps } = this;
    const id = await deps.automation.claimNotice({
      tenantId: subject.tenantId,
      invoiceId: subject.invoiceId,
      step,
      channel,
      recipient,
    });
    if (id === null) return 0;
    try {
      await deliver();
      return 1;
    } catch (error) {
      deps.logger.warn("A billing notice could not be sent", {
        tenantId: subject.tenantId,
        step,
        channel,
        error,
      });
      await deps.automation.noticeFailed(id, error instanceof Error ? error.message : "Failed");
      return 0;
    }
  }

  private inTenant<T>(tenantId: string, body: () => Promise<T>): Promise<T> {
    return this.deps.tenantContext.runAs(TenantId.from(tenantId), () =>
      this.deps.tenantUnitOfWork.run(body),
    );
  }
}
