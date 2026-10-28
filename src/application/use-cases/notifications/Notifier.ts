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
  /** A driver (default) or a document signer without an account. */
  recipientType?: "driver" | "signer" | "guarantor" | "customer";
  driverId: string;
  phone: string;
  dedupeKey: string;
  /** The standard text, used unless the business wrote its own for the rule. */
  standardText: string;
  values: Readonly<Record<string, string>>;
  /** Carries a one-time link: hidden in the log, erased once sent. */
  sensitive?: boolean;
  /** Something the person is waiting for now (a signing link): not held for quiet hours. */
  immediate?: boolean;
}>;

/** A message to a rental customer: the same text by SMS and email, as the rule says. */
export type CustomerMessage = Readonly<{
  rule: RuleKey;
  customerId: string;
  name: string;
  phone: string | null;
  email: string | null;
  /** The same key never reaches the customer twice on a channel. */
  dedupeKey: string;
  /** The email's subject. */
  title: string;
  standardText: string;
  values: Readonly<Record<string, string>>;
}>;

/** A notice to particular users (a signer's own request), on the rule's staff channels. */
export type UserNotice = Omit<StaffNotice, "permission" | "branchId"> &
  Readonly<{ userIds: readonly string[] }>;

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
    for (const person of await deps.directory.staffWith(notice.permission, notice.branchId))
      if (await this.tell(person, channels, notice, now)) told += 1;
    return told;
  }

  /** Tells particular users (inbox, push, email as the rule says); returns how many were new. */
  async users(settings: NotificationSettings, notice: UserNotice): Promise<number> {
    const rule = settings.rules[notice.rule];
    if (!rule.enabled || notice.userIds.length === 0) return 0;
    const channels = new Set(rule.channels);
    const now = this.deps.clock.now();
    let told = 0;
    for (const person of await this.deps.directory.users(notice.userIds))
      if (await this.tell(person, channels, notice, now)) told += 1;
    return told;
  }

  /** An email to someone without an account (a guest signer), if the rule sends email. */
  async guestEmail(
    settings: NotificationSettings,
    message: Readonly<{
      rule: RuleKey;
      recipientId: string;
      name: string;
      email: string;
      dedupeKey: string;
      title: string;
      body: string;
      sensitive?: boolean;
    }>,
  ): Promise<boolean> {
    const rule = settings.rules[message.rule];
    if (!rule.enabled || !rule.channels.includes("email")) return false;
    const id = await this.deps.deliveries.queue({
      channel: "email",
      rule: message.rule,
      recipientType: "signer",
      recipientId: message.recipientId,
      address: message.email,
      title: message.title,
      body: message.body,
      data: { recipientName: message.name },
      dedupeKey: message.dedupeKey,
      sendAfter: this.deps.clock.now(),
      ...(message.sensitive === true ? { sensitive: true } : {}),
    });
    return id !== null;
  }

  /**
   * A customer (docs/07 §10): SMS when the rule sends SMS, a provider is set up and they have a
   * phone (held for quiet hours); email when the rule sends email and they have an address.
   * Returns whether anything new was queued.
   */
  async customer(
    settings: NotificationSettings,
    timezone: string,
    message: CustomerMessage,
  ): Promise<boolean> {
    const rule = settings.rules[message.rule];
    if (!rule.enabled) return false;
    let queued = false;
    if (message.phone !== null)
      queued = await this.sms(settings, timezone, {
        rule: message.rule,
        recipientType: "customer",
        driverId: message.customerId,
        phone: message.phone,
        dedupeKey: message.dedupeKey,
        standardText: message.standardText,
        values: message.values,
      });
    if (rule.channels.includes("email") && message.email !== null) {
      const id = await this.deps.deliveries.queue({
        channel: "email",
        rule: message.rule,
        recipientType: "customer",
        recipientId: message.customerId,
        address: message.email,
        title: message.title,
        body: renderTemplate(rule.smsTemplate ?? message.standardText, message.values),
        data: { recipientName: message.name },
        dedupeKey: message.dedupeKey,
        sendAfter: this.deps.clock.now(),
      });
      queued = id !== null || queued;
    }
    return queued;
  }

  private async tell(
    person: Readonly<{ userId: string; name: string; email: string | null }>,
    channels: ReadonlySet<string>,
    notice: Omit<StaffNotice, "permission" | "branchId">,
    now: Date,
  ): Promise<boolean> {
    const { deps } = this;
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
    return fresh;
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
    const wait =
      message.immediate === true
        ? 0
        : quietDelay(local.hour * 60 + local.minute, settings.quietHours);
    const id = await this.deps.deliveries.queue({
      channel: "sms",
      rule: message.rule,
      recipientType: message.recipientType ?? "driver",
      recipientId: message.driverId,
      address: message.phone,
      title: null,
      body: renderTemplate(rule.smsTemplate ?? message.standardText, message.values),
      data: {},
      dedupeKey: message.dedupeKey,
      sendAfter: new Date(now.getTime() + wait * 60_000),
      ...(message.sensitive === true ? { sensitive: true } : {}),
    });
    return id !== null;
  }
}
