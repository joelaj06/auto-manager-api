import type { RuleKey } from "../../../domain/notifications/NotificationRules.js";
import type {
  Delivery,
  INotificationDeliveries,
  NotificationSettings,
} from "../../ports/INotifications.js";

/**
 * A WhatsApp message that cannot reach someone goes by SMS instead, when the rule also sends SMS
 * and a provider is set up: the person still needs to know. Queued once per message.
 */
export async function fallBackToSms(
  deliveries: INotificationDeliveries,
  settings: NotificationSettings,
  delivery: Delivery,
  now: Date,
): Promise<boolean> {
  const rule = settings.rules[delivery.rule as RuleKey] as
    NotificationSettings["rules"][RuleKey] | undefined;
  if (rule === undefined || !rule.enabled || !rule.channels.includes("sms")) return false;
  if (settings.sms === null) return false;
  const id = await deliveries.queue({
    channel: "sms",
    rule: delivery.rule,
    recipientType: delivery.recipientType,
    recipientId: delivery.recipientId,
    address: delivery.address,
    title: null,
    body: delivery.body,
    data: {},
    dedupeKey: `whatsapp-fallback:${delivery.id}`,
    sendAfter: now,
  });
  return id !== null;
}
