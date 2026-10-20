import type {
  Channel,
  QuietHours,
  RuleConfig,
  RuleKey,
} from "../../domain/notifications/NotificationRules.js";

// --- the tenant's SMS account (decision 17) ---

export const SMS_PROVIDERS = ["hubtel", "arkesel", "mnotify"] as const;
export type SmsProvider = (typeof SMS_PROVIDERS)[number];

/** Credential fields each provider needs (all secret). */
export const SMS_CREDENTIAL_FIELDS: Readonly<Record<SmsProvider, readonly string[]>> =
  Object.freeze({
    hubtel: ["clientId", "clientSecret"],
    arkesel: ["apiKey"],
    mnotify: ["apiKey"],
  });

export type SmsAccount = Readonly<{
  provider: SmsProvider;
  senderId: string;
  /** The credentials, sealed (never returned by the API). */
  sealedCredentials: string;
  updatedAt: string;
}>;

export type SmsResult = Readonly<{ messageId: string }>;

/** Sends one SMS through one provider with the tenant's own account. */
export interface ISmsGateway {
  readonly provider: SmsProvider;
  /** `to` in E.164 (+233…). Throws SmsProviderError when the provider refuses. */
  send(
    account: Readonly<{ senderId: string; credentials: Readonly<Record<string, string>> }>,
    to: string,
    text: string,
  ): Promise<SmsResult>;
}

// --- push to the staff app ---

export type PushMessage = Readonly<{
  title: string;
  body: string;
  data: Readonly<Record<string, string>>;
}>;

export interface IPushSender {
  /** Returns the tokens the push service no longer knows (to forget). */
  send(tokens: readonly string[], message: PushMessage): Promise<Readonly<{ invalid: string[] }>>;
}

export type PushPlatform = "android" | "ios" | "web";

export interface IPushDevices {
  register(userId: string, token: string, platform: PushPlatform, now: Date): Promise<void>;
  remove(userId: string, token: string): Promise<void>;
  tokensOf(userId: string): Promise<string[]>;
  forget(tokens: readonly string[]): Promise<void>;
}

// --- settings ---

export type NotificationSettings = Readonly<{
  sms: SmsAccount | null;
  /** No SMS in this window (local time); messages wait for its end. */
  quietHours: QuietHours | null;
  /** Local time of the remittance cut-off check (HH:MM). */
  remittanceCutoff: string;
  rules: Readonly<Record<RuleKey, RuleConfig>>;
}>;

export interface INotificationSettingsStore {
  get(): Promise<NotificationSettings>;
  set(settings: NotificationSettings): Promise<void>;
}

// --- in-app inbox ---

export type Severity = "info" | "warning" | "critical";

export type InboxItem = Readonly<{
  id: string;
  userId: string;
  rule: RuleKey;
  title: string;
  body: string;
  severity: Severity;
  data: Readonly<Record<string, string>>;
  readAt: Date | null;
  createdAt: Date;
}>;

export interface INotificationInbox {
  /** False when the user already has this notification (same dedupe key). */
  add(
    item: Omit<InboxItem, "id" | "readAt" | "createdAt"> & Readonly<{ dedupeKey: string }>,
  ): Promise<boolean>;
  list(
    userId: string,
    filter: Readonly<{
      unreadOnly: boolean;
      limit: number;
      /** Keyset: the last id of the previous page (ids are time-ordered). */
      afterId?: string;
    }>,
  ): Promise<InboxItem[]>;
  unreadCount(userId: string): Promise<number>;
  /** Marks the user's notifications read (all of them when `ids` is null); returns how many. */
  markRead(userId: string, ids: readonly string[] | null, now: Date): Promise<number>;
}

// --- outgoing messages ---

export type DeliveryChannel = Exclude<Channel, "in_app">;
export type DeliveryStatus = "queued" | "sent" | "failed" | "skipped";
export type RecipientType = "user" | "driver";

export type Delivery = Readonly<{
  id: string;
  channel: DeliveryChannel;
  rule: RuleKey | "test";
  recipientType: RecipientType;
  recipientId: string;
  /** Phone (E.164) for SMS, email address, or the user id for push. */
  address: string;
  title: string | null;
  body: string;
  data: Readonly<Record<string, string>>;
  status: DeliveryStatus;
  sendAfter: Date;
  attempts: number;
  provider: string | null;
  providerMessageId: string | null;
  error: string | null;
  sentAt: Date | null;
  createdAt: Date;
}>;

export type NewDelivery = Pick<
  Delivery,
  "channel" | "rule" | "recipientType" | "recipientId" | "address" | "title" | "body" | "data"
> &
  Readonly<{ dedupeKey: string; sendAfter: Date }>;

export interface INotificationDeliveries {
  /** The new delivery's id; null when this recipient already got it on this channel (dedupe). */
  queue(delivery: NewDelivery): Promise<string | null>;
  find(id: string): Promise<Delivery | null>;
  /** Locks up to `limit` queued deliveries that are due (skipping ones locked elsewhere). */
  claimDue(now: Date, limit: number): Promise<Delivery[]>;
  /** The earliest queued delivery not yet due. */
  nextDue(now: Date): Promise<Date | null>;
  sent(id: string, provider: string | null, messageId: string | null, now: Date): Promise<void>;
  /** `retryAt` null: failed for good. */
  failed(id: string, error: string, retryAt: Date | null): Promise<void>;
  skipped(id: string, reason: string): Promise<void>;
  list(
    filter: Readonly<{
      channel?: DeliveryChannel;
      status?: DeliveryStatus;
      recipientId?: string;
      limit: number;
      afterId?: string;
    }>,
  ): Promise<Delivery[]>;
}

// --- who to tell and what about (rule scans) ---

export type StaffRecipient = Readonly<{
  userId: string;
  name: string;
  email: string | null;
}>;

export interface IRecipientDirectory {
  /** Active users holding `permission` for `branchId` (null: business-wide records). */
  staffWith(permission: string, branchId: string | null): Promise<StaffRecipient[]>;
}

export type ExpiringVehicleDocument = Readonly<{
  documentId: string;
  vehicleId: string;
  vehicleCode: string;
  plateNumber: string | null;
  branchId: string;
  type: string;
  title: string | null;
  expiresOn: string;
  /** The document's own reminder days (empty: the rule's). */
  reminderDays: readonly number[];
}>;

export type ExpiringLicence = Readonly<{
  driverId: string;
  name: string;
  phone: string;
  branchId: string;
  expiresOn: string;
}>;

export type DueRemittance = Readonly<{
  remittanceId: string;
  driverId: string;
  driverName: string;
  phone: string;
  branchId: string;
  plateNumber: string | null;
  periodEnd: string;
  outstandingMinor: number;
  status: string;
}>;

export interface INotificationQueries {
  /** Current documents (not replaced by a later one of the same type) expiring between the days. */
  expiringVehicleDocuments(from: string, to: string): Promise<ExpiringVehicleDocument[]>;
  /** Active drivers whose licence expires between the days. */
  expiringLicences(from: string, to: string): Promise<ExpiringLicence[]>;
  /** Fixed-target periods ending on `date` in these statuses with money still owed. */
  remittancesEnding(date: string, statuses: readonly string[]): Promise<DueRemittance[]>;
  /** Expenses waiting for approval per branch. */
  pendingApprovals(): Promise<Readonly<{ branchId: string; count: number; amountMinor: number }>[]>;
}
