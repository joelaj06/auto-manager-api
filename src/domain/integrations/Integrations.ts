import { DomainError } from "../errors/DomainError.js";

export class IntegrationRuleError extends DomainError {
  readonly code = "INTEGRATION_RULE";
  constructor(message: string) {
    super(message);
  }
}

/** Keys a business may hold at once. */
export const MAX_API_KEYS = 25;
/** Webhook endpoints a business may hold. */
export const MAX_WEBHOOK_ENDPOINTS = 10;
/** The longest a key may be issued for. */
export const MAX_API_KEY_DAYS = 730;
/** Minutes before each further try of a failed delivery; then it has failed for good. */
export const WEBHOOK_RETRY_MINUTES = [1, 5, 30, 120, 360, 1_440] as const;
/** Failed tries in a row, with no success for days, after which an endpoint is switched off. */
export const WEBHOOK_DISABLE_AFTER_FAILURES = 30;
export const WEBHOOK_DISABLE_AFTER_DAYS = 3;
/** Deliveries are kept this long. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

const API_KEY = /^afk_([0-9a-f]{32})_[A-Za-z0-9_-]{43}$/;

/** `afk_<tenant id without dashes>_<secret>`: the key says which business it belongs to. */
export function formatApiKey(tenantId: string, secret: string): string {
  return `afk_${tenantId.replaceAll("-", "")}_${secret}`;
}

export function isApiKey(token: string): boolean {
  return token.startsWith("afk_");
}

/** The tenant a key claims to belong to; null when it is not a well-formed key. */
export function tenantOfApiKey(key: string): string | null {
  const hex = API_KEY.exec(key)?.[1];
  if (hex === undefined) return null;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function checkKeyExpiry(expiresAt: Date | null, now: Date): void {
  if (expiresAt === null) return;
  if (expiresAt.getTime() <= now.getTime())
    throw new IntegrationRuleError("A key's expiry must be in the future");
  if (expiresAt.getTime() - now.getTime() > MAX_API_KEY_DAYS * 86_400_000)
    throw new IntegrationRuleError(`A key lasts at most ${MAX_API_KEY_DAYS} days`);
}

const BLOCKED_HOSTS = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|onion)$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * An address we will call on a business's behalf: https to a public host name on the usual port
 * or a high one, with no credentials in it. The address it resolves to is checked again on every
 * call, when the connection is made.
 */
export function checkWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IntegrationRuleError("That is not a web address");
  }
  if (url.protocol !== "https:") throw new IntegrationRuleError("A webhook address must be https");
  if (url.username !== "" || url.password !== "")
    throw new IntegrationRuleError("A webhook address cannot carry a user name or password");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || IPV4.test(host) || !host.includes(".") || BLOCKED_HOSTS.test(host))
    throw new IntegrationRuleError("A webhook address must be a public host name");
  if (url.port !== "" && Number(url.port) < 1024)
    throw new IntegrationRuleError("A webhook address uses port 443 or a port from 1024");
  if (value.length > 2_000) throw new IntegrationRuleError("That web address is too long");
  url.hash = "";
  return url.toString();
}

/**
 * The events a business can subscribe to. Each is the name of an action in its audit trail, so an
 * event exists exactly when the change committed. Events are thin: what changed and its id, read
 * through the API with a key's own permissions, so no personal data travels in a webhook.
 */
export const WEBHOOK_EVENTS = Object.freeze({
  "vehicle.created": "A vehicle was added",
  "vehicle.updated": "A vehicle was edited",
  "vehicle.removed": "A vehicle was removed",
  "vehicle.status_changed": "A vehicle's status changed",
  "vehicle.transferred": "A vehicle moved to another branch",
  "vehicle.service_recorded": "A service was recorded on a vehicle",
  "vehicle_assignment.started": "A driver was assigned a vehicle",
  "vehicle_assignment.ended": "A driver's assignment ended",
  "driver.created": "A driver was added",
  "driver.updated": "A driver was edited",
  "driver.removed": "A driver was removed",
  "customer.created": "A customer was added",
  "customer.updated": "A customer was edited",
  "customer.removed": "A customer was removed",
  "supplier.created": "A supplier was added",
  "supplier.updated": "A supplier was edited",
  "supplier.removed": "A supplier was removed",
  "rental_booking.created": "A rental booking was made",
  "rental_booking.confirmed": "A rental booking was confirmed",
  "rental_booking.checked_out": "A rental vehicle left",
  "rental_booking.returned": "A rental vehicle came back",
  "rental_booking.extended": "A rental was extended",
  "rental_booking.closed": "A rental was closed",
  "vehicle_damage.recorded": "Damage was recorded on a vehicle",
  "invoice.issued": "An invoice was issued",
  "invoice.voided": "An invoice was voided",
  "payment.recorded": "A payment was recorded",
  "payment.reversed": "A payment was reversed",
  "expense.approved": "An expense was approved",
  "expense.paid": "An expense was paid",
  "remittance.recorded": "A remittance was recorded",
  "remittance.approved": "A remittance was approved",
  "workpay.agreement_activated": "A Work & Pay agreement started",
  "workpay.payment_recorded": "A Work & Pay payment was recorded",
  "work_order.opened": "A work order was opened",
  "incident.reported": "An incident was reported",
  "traffic_offence.recorded": "A traffic offence was recorded",
  "purchase.ordered": "A vehicle purchase was ordered",
  "lead.created": "A sales lead came in",
  "deal.created": "A deal was started",
  "deal.sold": "A deal was sold",
  "deal.delivered": "A sold vehicle was delivered",
} as const);

export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;

export function isWebhookEvent(value: string): value is WebhookEvent {
  return Object.hasOwn(WEBHOOK_EVENTS, value);
}

export function checkWebhookEvents(events: readonly string[]): readonly string[] {
  const unique = [...new Set(events)];
  if (unique.length === 0) throw new IntegrationRuleError("Choose at least one event");
  const unknown = unique.find((e) => !isWebhookEvent(e));
  if (unknown !== undefined) throw new IntegrationRuleError(`Unknown event ${unknown}`);
  return unique;
}

/** When to try a failed delivery again; null when it has had its tries. */
export function nextWebhookAttempt(attempts: number, now: Date): Date | null {
  const minutes = WEBHOOK_RETRY_MINUTES[attempts - 1];
  return minutes === undefined ? null : new Date(now.getTime() + minutes * 60_000);
}

/** An endpoint that has failed for days is switched off and its business told. */
export function shouldDisableEndpoint(
  endpoint: Readonly<{
    consecutiveFailures: number;
    lastSuccessAt: Date | null;
    createdAt: Date;
  }>,
  now: Date,
): boolean {
  if (endpoint.consecutiveFailures < WEBHOOK_DISABLE_AFTER_FAILURES) return false;
  const since = endpoint.lastSuccessAt ?? endpoint.createdAt;
  return now.getTime() - since.getTime() >= WEBHOOK_DISABLE_AFTER_DAYS * 86_400_000;
}
