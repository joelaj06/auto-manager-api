import { DomainError } from "../errors/DomainError.js";

export class NotificationRuleError extends DomainError {
  readonly code = "NOTIFICATION_RULE";
  constructor(message: string) {
    super(message);
  }
}

/** In-app inbox, push to the staff app, email to staff, SMS through the tenant's provider. */
export const CHANNELS = ["in_app", "push", "email", "sms"] as const;
export type Channel = (typeof CHANNELS)[number];

export const RULE_KEYS = [
  "vehicle_document_expiry",
  "driver_licence_expiry",
  "remittance_due",
  "remittance_cutoff",
  "budget_threshold",
  "expense_approvals",
  "vehicle_issue_reported",
  "signature_requests",
  "workpay_due",
  "workpay_overdue",
  "workpay_guarantor_alert",
  "workpay_defaulted",
  "workpay_payment_received",
  "workpay_milestones",
  "billing_notices",
  "rental_confirmed",
  "rental_pickup_reminder",
  "rental_return_reminder",
  "rental_overdue",
  "rental_payment_received",
  "rental_invoiced",
  "service_due",
  "parts_reorder",
  "incident_reported",
  "traffic_offence",
  "fuel_anomaly",
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

export type RuleDefinition = Readonly<{
  description: string;
  /** Channels the rule can use: staff channels and, for driver rules, SMS. */
  channels: readonly Channel[];
  defaults: RuleConfig;
  /** Placeholders a custom SMS text may use (driver rules only). */
  placeholders?: readonly string[];
  /** The rule counts days before an expiry date. */
  usesDays?: boolean;
}>;

export type RuleConfig = Readonly<{
  enabled: boolean;
  channels: readonly Channel[];
  /** Days before the expiry date to remind on (0: the day it expires). */
  daysBefore?: readonly number[];
  /** Custom SMS text with {{placeholders}}; null: the standard text. */
  smsTemplate?: string | null;
}>;

const STAFF: readonly Channel[] = ["in_app", "push", "email"];
/** A rental customer is told by SMS (the business's provider) or email. */
const CUSTOMER: readonly Channel[] = ["sms", "email"];
const RENTAL_PLACEHOLDERS = [
  "customerName",
  "number",
  "vehicle",
  "pickupAt",
  "returnAt",
  "branch",
  "businessName",
];

/** The automation rules (docs/15 §2) and what each does when the business has not changed it. */
export const RULES: Readonly<Record<RuleKey, RuleDefinition>> = Object.freeze({
  vehicle_document_expiry: {
    description:
      "Vehicle documents (insurance, roadworthy, registration …) expiring: tell the fleet staff of the branch",
    channels: STAFF,
    defaults: { enabled: true, channels: ["in_app", "push"], daysBefore: [30, 14, 3, 0] },
    usesDays: true,
  },
  driver_licence_expiry: {
    description: "A driver's licence expiring: SMS the driver and tell the staff of the branch",
    channels: [...STAFF, "sms"],
    defaults: { enabled: true, channels: ["in_app", "sms"], daysBefore: [60, 30, 7, 0] },
    placeholders: ["driverName", "expiresOn", "businessName"],
    usesDays: true,
  },
  remittance_due: {
    description: "Morning reminder to drivers whose remittance is due today",
    channels: ["sms"],
    defaults: { enabled: false, channels: ["sms"] },
    placeholders: ["driverName", "amount", "plateNumber", "dueOn", "businessName"],
  },
  remittance_cutoff: {
    description:
      "At the cut-off time, nothing received for today's remittance: SMS the driver and tell the branch's approvers",
    channels: [...STAFF, "sms"],
    defaults: { enabled: true, channels: ["in_app", "push", "sms"] },
    placeholders: ["driverName", "amount", "plateNumber", "dueOn", "businessName"],
  },
  budget_threshold: {
    description: "A monthly budget reaching 80% or 100%: tell whoever manages budgets",
    channels: STAFF,
    defaults: { enabled: true, channels: ["in_app", "push"] },
  },
  expense_approvals: {
    description: "Morning digest of expenses waiting for approval to the approvers of the branch",
    channels: STAFF,
    defaults: { enabled: true, channels: ["in_app"] },
  },
  signature_requests: {
    description:
      "A document waits for someone's signature (and reminders): staff in the app, drivers and guests by SMS or email",
    channels: [...STAFF, "sms"],
    defaults: { enabled: true, channels: ["in_app", "push", "email", "sms"] },
    placeholders: ["signerName", "documentName", "number", "businessName", "link"],
  },
  workpay_due: {
    description:
      "A work and pay instalment comes due: SMS the driver the days before (default the day before)",
    channels: ["sms"],
    defaults: { enabled: true, channels: ["sms"], daysBefore: [1] },
    placeholders: ["driverName", "amount", "number", "dueOn", "businessName"],
    usesDays: true,
  },
  workpay_overdue: {
    description:
      "A work and pay instalment falls overdue after the grace days: SMS the driver once, and a daily list to the branch's collectors",
    channels: [...STAFF, "sms"],
    defaults: { enabled: true, channels: ["in_app", "sms"] },
    placeholders: ["driverName", "amount", "number", "dueOn", "businessName"],
  },
  workpay_guarantor_alert: {
    description:
      "An agreement some days in arrears (work and pay settings): SMS its guarantors once (opt-in)",
    channels: ["sms"],
    defaults: { enabled: false, channels: ["sms"] },
    placeholders: ["guarantorName", "driverName", "amount", "number", "businessName"],
  },
  workpay_defaulted: {
    description: "A work and pay agreement defaults: tell the branch's managers",
    channels: STAFF,
    defaults: { enabled: true, channels: ["in_app", "push"] },
  },
  workpay_payment_received: {
    description: "A work and pay payment is recorded: SMS the driver the amount and new balance",
    channels: ["sms"],
    defaults: { enabled: true, channels: ["sms"] },
    placeholders: ["driverName", "amount", "number", "balance", "nextDue", "businessName"],
  },
  billing_notices: {
    description:
      "Autoforce billing: reminders, overdue and deactivation notices to the business's billing managers (always sent)",
    channels: ["in_app", "push"],
    defaults: { enabled: true, channels: ["in_app", "push"] },
  },
  workpay_milestones: {
    description:
      "Half the agreement paid, paid in full, and the vehicle the driver's: SMS the driver (standard texts)",
    channels: ["sms"],
    defaults: { enabled: true, channels: ["sms"] },
  },
  rental_confirmed: {
    description:
      "A rental booking is confirmed: SMS or email the customer the vehicle, times, branch and total",
    channels: CUSTOMER,
    defaults: { enabled: true, channels: ["sms", "email"] },
    placeholders: [...RENTAL_PLACEHOLDERS, "amount"],
  },
  rental_pickup_reminder: {
    description:
      "Remind the customer of their pickup (rental settings: pickupReminderHours, default 24 hours before)",
    channels: CUSTOMER,
    defaults: { enabled: true, channels: ["sms", "email"] },
    placeholders: RENTAL_PLACEHOLDERS,
  },
  rental_return_reminder: {
    description:
      "Remind the customer the vehicle is due back (rental settings: returnReminderHours, default 2 hours before)",
    channels: CUSTOMER,
    defaults: { enabled: true, channels: ["sms"] },
    placeholders: RENTAL_PLACEHOLDERS,
  },
  rental_overdue: {
    description:
      "A rented vehicle is not back after the grace minutes: tell the customer once and the branch's check-in staff",
    channels: [...STAFF, ...CUSTOMER],
    defaults: { enabled: true, channels: ["in_app", "push", "sms"] },
    placeholders: RENTAL_PLACEHOLDERS,
  },
  rental_payment_received: {
    description:
      "A rental payment or security deposit is recorded: send the customer a receipt with the balance",
    channels: CUSTOMER,
    defaults: { enabled: true, channels: ["sms", "email"] },
    placeholders: ["customerName", "number", "amount", "receipt", "balance", "businessName"],
  },
  rental_invoiced: {
    description:
      "A rental is invoiced (at close, or a cancellation fee): send the customer the invoice total, balance and due date",
    channels: CUSTOMER,
    defaults: { enabled: true, channels: ["sms", "email"] },
    placeholders: [
      "customerName",
      "number",
      "invoice",
      "amount",
      "balance",
      "dueOn",
      "businessName",
    ],
  },
  vehicle_issue_reported: {
    description:
      "A driver or staff member reports a vehicle issue (breakdown, accident …): tell the fleet staff of the branch",
    channels: STAFF,
    defaults: { enabled: true, channels: ["in_app", "push"] },
  },
  service_due: {
    description:
      "A vehicle's service is coming up, due or overdue (by km or date): tell the branch's maintenance staff, and SMS the assigned driver once due",
    channels: [...STAFF, "sms"],
    defaults: { enabled: true, channels: ["in_app", "push", "sms"] },
    placeholders: ["driverName", "vehicle", "task", "dueAt", "businessName"],
  },
  parts_reorder: {
    description:
      "A part's stock at a branch is at or below its reorder level: tell the branch's staff who manage parts",
    channels: STAFF,
    defaults: { enabled: true, channels: ["in_app", "push"] },
  },
  incident_reported: {
    description:
      "An incident (accident, theft, impound …) is reported on a vehicle: tell the branch's staff who see incidents",
    channels: STAFF,
    defaults: { enabled: true, channels: ["in_app", "push"] },
  },
  traffic_offence: {
    description: "A traffic offence is recorded on a vehicle: SMS the driver who had it",
    channels: ["sms"],
    defaults: { enabled: true, channels: ["sms"] },
    placeholders: ["driverName", "vehicle", "offence", "date", "fine", "businessName"],
  },
  fuel_anomaly: {
    description:
      "A fuel fill looks wrong (far fewer km per litre than usual, or no km since the last fill): tell the branch's staff who see incidents",
    channels: STAFF,
    defaults: { enabled: true, channels: ["in_app", "push"] },
  },
});

export type QuietHours = Readonly<{ start: string; end: string }>;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

/** One rule's configuration, checked against what the rule allows. */
export function ruleConfig(key: RuleKey, config: RuleConfig): RuleConfig {
  const rule = RULES[key];
  const channels = [...new Set(config.channels)];
  for (const channel of channels)
    if (!rule.channels.includes(channel))
      throw new NotificationRuleError(`${key} cannot use the ${channel} channel`);
  let daysBefore: number[] | undefined;
  if (rule.usesDays) {
    daysBefore = [...new Set(config.daysBefore ?? rule.defaults.daysBefore ?? [])].sort(
      (a, b) => b - a,
    );
    if (daysBefore.length === 0 || daysBefore.length > 6)
      throw new NotificationRuleError("Remind on 1 to 6 days");
    if (daysBefore.some((d) => !Number.isInteger(d) || d < 0 || d > 365))
      throw new NotificationRuleError("Days before are 0 to 365");
  }
  const smsTemplate = config.smsTemplate?.trim() || null;
  if (smsTemplate !== null) {
    if (rule.placeholders === undefined)
      throw new NotificationRuleError(`${key} sends no SMS text to customise`);
    if (smsTemplate.length > 459)
      throw new NotificationRuleError("An SMS text is at most 459 characters (3 messages)");
    for (const [, name] of smsTemplate.matchAll(PLACEHOLDER))
      if (!rule.placeholders.includes(name!))
        throw new NotificationRuleError(
          `Unknown placeholder {{${name}}}; use ${rule.placeholders.map((p) => `{{${p}}}`).join(", ")}`,
        );
  }
  return {
    enabled: config.enabled,
    channels,
    ...(daysBefore === undefined ? {} : { daysBefore }),
    ...(rule.placeholders === undefined ? {} : { smsTemplate }),
  };
}

export function quietHours(value: QuietHours | null): QuietHours | null {
  if (value === null) return null;
  if (!TIME.test(value.start) || !TIME.test(value.end))
    throw new NotificationRuleError("Quiet hours are HH:MM, e.g. 21:00 to 07:00");
  if (value.start === value.end) throw new NotificationRuleError("Quiet hours need a length");
  return value;
}

export function timeOfDay(value: string): string {
  if (!TIME.test(value)) throw new NotificationRuleError("A time is HH:MM, e.g. 20:00");
  return value;
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * Minutes an SMS must wait at local time `minuteOfDay` (0–1439) so that it does not go out in
 * quiet hours (docs/15 §4); 0 outside them. A window may cross midnight (21:00–07:00).
 */
export function quietDelay(minuteOfDay: number, quiet: QuietHours | null): number {
  if (quiet === null) return 0;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  const inside =
    start < end
      ? minuteOfDay >= start && minuteOfDay < end
      : minuteOfDay >= start || minuteOfDay < end;
  if (!inside) return 0;
  return (end - minuteOfDay + 1_440) % 1_440;
}

/** Fills {{placeholders}}; unknown ones stay as written (checked when the template is saved). */
export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (match, name: string) => values[name] ?? match);
}

/**
 * A Sender ID as Ghanaian networks accept it: 3–11 letters, digits or spaces, starting with a
 * letter (NCA rules).
 */
export function senderId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9 ]{2,10}$/.test(trimmed))
    throw new NotificationRuleError(
      "A Sender ID is 3 to 11 letters or digits, starting with a letter",
    );
  return trimmed;
}

/**
 * The reminder a date `left` days away is due for: the nearest configured day at or above it
 * (null before the first). A missed run is caught up by the next one; dedupe keys per threshold
 * stop repeats.
 */
export function reminderThreshold(left: number, days: readonly number[]): number | null {
  if (left < 0) return null;
  const eligible = days.filter((d) => d >= left);
  return eligible.length === 0 ? null : Math.min(...eligible);
}
