import {
  quietDelay,
  renderTemplate,
  type RuleKey,
} from "../../../domain/notifications/NotificationRules.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  INotificationDeliveries,
  INotificationInbox,
  IRecipientDirectory,
  NotificationSettings,
  Severity,
} from "../../ports/INotifications.js";
import { localDateTime } from "../../services/TenantLocalTime.js";

export type StaffNotice = Readonly<{
  rule: RuleKey;
  /** Who: active staff holding this permission for the branch (null: business-wide). */
  permission: PermissionKey;
  branchId: string | null;
  /** The same key never reaches the same person twice. */
  dedupeKey: string;
  title: string;
  body: string;
  severity: Severity;
  /** Ids for links in the apps ({ vehicleId } …). */
  data: Readonly<Record<string, string>>;
}>;

export type DriverSms = Readonly<{
  rule: RuleKey;
  driverId: string;
  phone: string;
  dedupeKey: string;
  /** The standard text, used unless the business wrote its own for the rule. */
  standardText: string;
  values: Readonly<Record<string, string>>;
}>;

/**
 * Turns a rule's finding into messages on the channels the business chose for that rule
 * (docs/15): the staff inbox, push to their app, email, and SMS to drivers through the
 * business's own provider — never twice for the same key, SMS held back during quiet hours.
 * Call inside a tenant unit of work; messages go out after commit.
 */
export class Notifier {
  constructor(
    private readonly deps: Readonly<{
      inbox: INotificationInbox;
      deliveries: INotificationDeliveries;
      directory: IRecipientDirectory;
      clock: IClock;
    }>,
  ) {}

  /** Returns how many people were told for the first time. */
  async staff(settings: NotificationSettings, notice: StaffNotice): Promise<number> {
    const { deps } = this;
    const rule = settings.rules[notice.rule];
    if (!rule.enabled) return 0;
    const channels = new Set(rule.channels);
    const now = deps.clock.now();
    let told = 0;
    for (const person of await deps.directory.staffWith(notice.permission, notice.branchId)) {
      let fresh = true;
      if (channels.has("in_app"))
        fresh = await deps.inbox.add({
          userId: person.userId,
          rule: notice.rule,
          title: notice.title,
          body: notice.body,
          severity: notice.severity,
          data: notice.data,
          dedupeKey: notice.dedupeKey,
        });
      const base = {
        rule: notice.rule,
        recipientType: "user" as const,
        recipientId: person.userId,
        title: notice.title,
        body: notice.body,
        dedupeKey: notice.dedupeKey,
        sendAfter: now,
      };
      if (channels.has("push"))
        fresh =
          (await deps.deliveries.queue({
            ...base,
            channel: "push",
            address: person.userId,
            data: { ...notice.data, rule: notice.rule },
          })) !== null || fresh;
      if (channels.has("email") && person.email !== null)
        fresh =
          (await deps.deliveries.queue({
            ...base,
            channel: "email",
            address: person.email,
            data: { recipientName: person.name },
          })) !== null || fresh;
      if (fresh) told += 1;
    }
    return told;
  }

  /** Queues the SMS; false when the rule does not send SMS, no provider is set up, or it was sent. */
  async sms(
    settings: NotificationSettings,
    timezone: string,
    message: DriverSms,
  ): Promise<boolean> {
    const rule = settings.rules[message.rule];
    if (!rule.enabled || !rule.channels.includes("sms") || settings.sms === null) return false;
    const now = this.deps.clock.now();
    const local = localDateTime(now, timezone);
    const wait = quietDelay(local.hour * 60 + local.minute, settings.quietHours);
    const id = await this.deps.deliveries.queue({
      channel: "sms",
      rule: message.rule,
      recipientType: "driver",
      recipientId: message.driverId,
      address: message.phone,
      title: null,
      body: renderTemplate(rule.smsTemplate ?? message.standardText, message.values),
      data: {},
      dedupeKey: message.dedupeKey,
      sendAfter: new Date(now.getTime() + wait * 60_000),
    });
    return id !== null;
  }
}
