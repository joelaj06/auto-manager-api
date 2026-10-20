import type {
  Delivery,
  DeliveryChannel,
  DeliveryStatus,
  DueRemittance,
  ExpiringLicence,
  ExpiringVehicleDocument,
  InboxItem,
  INotificationDeliveries,
  INotificationInbox,
  INotificationQueries,
  INotificationSettingsStore,
  IPushDevices,
  IRecipientDirectory,
  NewDelivery,
  NotificationSettings,
  PushPlatform,
  StaffRecipient,
} from "../../application/ports/INotifications.js";
import {
  RULE_KEYS,
  RULES,
  type RuleConfig,
  type RuleKey,
} from "../../domain/notifications/NotificationRules.js";
import { OFF_FLEET_STATUSES } from "../../domain/vehicles/VehicleStatus.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const DEFAULTS: Omit<NotificationSettings, "rules"> = Object.freeze({
  sms: null,
  quietHours: Object.freeze({ start: "21:00", end: "07:00" }),
  remittanceCutoff: "20:00",
});

/** Notification settings in `organisation.settings->'notifications'`, over the defaults. */
export class PostgresNotificationSettingsStore implements INotificationSettingsStore {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async get(): Promise<NotificationSettings> {
    const { rows } = await this.transactions
      .current()
      .query<{ notifications: Partial<NotificationSettings> | null }>(
        "select settings->'notifications' as notifications from organisation",
      );
    const stored = rows[0]?.notifications ?? {};
    const rules = Object.fromEntries(
      RULE_KEYS.map((key) => [key, { ...RULES[key].defaults, ...(stored.rules?.[key] ?? {}) }]),
    ) as Record<RuleKey, RuleConfig>;
    return { ...DEFAULTS, ...stored, rules };
  }

  async set(settings: NotificationSettings): Promise<void> {
    await this.transactions
      .current()
      .query(
        "update organisation set settings = jsonb_set(settings, '{notifications}', $1::jsonb), updated_at = now()",
        [JSON.stringify(settings)],
      );
  }
}

type InboxRow = {
  id: string;
  user_id: string;
  rule: RuleKey;
  title: string;
  body: string;
  severity: InboxItem["severity"];
  data: Record<string, string>;
  read_at: Date | null;
  created_at: Date;
};

const toInboxItem = (r: InboxRow): InboxItem => ({
  id: r.id,
  userId: r.user_id,
  rule: r.rule,
  title: r.title,
  body: r.body,
  severity: r.severity,
  data: r.data,
  readAt: r.read_at,
  createdAt: r.created_at,
});

/** The staff inbox. */
export class PostgresNotificationInbox implements INotificationInbox {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async add(item: Parameters<INotificationInbox["add"]>[0]): Promise<boolean> {
    const result = await this.tx.query(
      `insert into notifications (user_id, rule, title, body, severity, data, dedupe_key)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (user_id, dedupe_key) do nothing`,
      [
        item.userId,
        item.rule,
        item.title,
        item.body,
        item.severity,
        JSON.stringify(item.data),
        item.dedupeKey,
      ],
    );
    return result.rowCount === 1;
  }

  async list(
    userId: string,
    filter: Parameters<INotificationInbox["list"]>[1],
  ): Promise<InboxItem[]> {
    const { rows } = await this.tx.query<InboxRow>(
      `select * from notifications
        where user_id = $1 and (not $2 or read_at is null)
          and ($3::uuid is null or id < $3)
        order by id desc
        limit $4`,
      [userId, filter.unreadOnly, filter.afterId ?? null, filter.limit],
    );
    return rows.map(toInboxItem);
  }

  async unreadCount(userId: string): Promise<number> {
    const { rows } = await this.tx.query<{ n: string }>(
      "select count(*) as n from notifications where user_id = $1 and read_at is null",
      [userId],
    );
    return Number(rows[0]!.n);
  }

  async markRead(userId: string, ids: readonly string[] | null, now: Date): Promise<number> {
    const result = await this.tx.query(
      `update notifications set read_at = $3
        where user_id = $1 and read_at is null and ($2::uuid[] is null or id = any($2::uuid[]))`,
      [userId, ids, now],
    );
    return result.rowCount ?? 0;
  }
}

type DeliveryRow = {
  id: string;
  channel: DeliveryChannel;
  rule: Delivery["rule"];
  recipient_type: Delivery["recipientType"];
  recipient_id: string;
  address: string;
  title: string | null;
  body: string;
  data: Record<string, string>;
  status: DeliveryStatus;
  send_after: Date;
  attempts: number;
  provider: string | null;
  provider_message_id: string | null;
  error: string | null;
  sent_at: Date | null;
  created_at: Date;
};

const toDelivery = (r: DeliveryRow): Delivery => ({
  id: r.id,
  channel: r.channel,
  rule: r.rule,
  recipientType: r.recipient_type,
  recipientId: r.recipient_id,
  address: r.address,
  title: r.title,
  body: r.body,
  data: r.data,
  status: r.status,
  sendAfter: r.send_after,
  attempts: r.attempts,
  provider: r.provider,
  providerMessageId: r.provider_message_id,
  error: r.error,
  sentAt: r.sent_at,
  createdAt: r.created_at,
});

/**
 * Outgoing messages. A new delivery asks for a send run after the transaction commits
 * (`onQueued`, a `notifications.send` job in production).
 */
export class PostgresNotificationDeliveries implements INotificationDeliveries {
  constructor(
    private readonly transactions: PostgresTransactionContext,
    private readonly onQueued?: () => Promise<void>,
  ) {}

  private get tx() {
    return this.transactions.current();
  }

  async queue(delivery: NewDelivery): Promise<string | null> {
    const { rows } = await this.tx.query<{ id: string }>(
      `insert into notification_deliveries (channel, rule, recipient_type, recipient_id, address,
         title, body, data, dedupe_key, send_after, sensitive)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (channel, recipient_id, dedupe_key) do nothing
       returning id`,
      [
        delivery.channel,
        delivery.rule,
        delivery.recipientType,
        delivery.recipientId,
        delivery.address,
        delivery.title,
        delivery.body,
        JSON.stringify(delivery.data),
        delivery.dedupeKey,
        delivery.sendAfter,
        delivery.sensitive ?? false,
      ],
    );
    const id = rows[0]?.id ?? null;
    // One send run per transaction; it schedules itself for messages that must wait.
    if (id !== null && this.onQueued !== undefined)
      this.transactions.afterCommit("notifications.send", this.onQueued);
    return id;
  }

  async find(id: string): Promise<Delivery | null> {
    const { rows } = await this.tx.query<DeliveryRow>(
      "select * from notification_deliveries where id = $1",
      [id],
    );
    return rows[0] === undefined ? null : toDelivery(rows[0]);
  }

  async claimDue(now: Date, limit: number): Promise<Delivery[]> {
    const { rows } = await this.tx.query<DeliveryRow>(
      `select * from notification_deliveries
        where status = 'queued' and send_after <= $1
        order by send_after, id
        limit $2
        for update skip locked`,
      [now, limit],
    );
    return rows.map(toDelivery);
  }

  async nextDue(now: Date): Promise<Date | null> {
    const { rows } = await this.tx.query<{ at: Date | null }>(
      "select min(send_after) as at from notification_deliveries where status = 'queued' and send_after > $1",
      [now],
    );
    return rows[0]?.at ?? null;
  }

  async sent(
    id: string,
    provider: string | null,
    messageId: string | null,
    now: Date,
  ): Promise<void> {
    await this.tx.query(
      `update notification_deliveries
          set status = 'sent', provider = $2, provider_message_id = $3, sent_at = $4,
              attempts = attempts + 1, error = null,
              body = case when sensitive then '(erased: it contained a one-time link)' else body end
        where id = $1`,
      [id, provider, messageId, now],
    );
  }

  async failed(id: string, error: string, retryAt: Date | null): Promise<void> {
    await this.tx.query(
      `update notification_deliveries
          set attempts = attempts + 1, error = $2,
              status = case when $3::timestamptz is null then 'failed' else 'queued' end,
              send_after = coalesce($3, send_after),
              body = case when sensitive and $3::timestamptz is null
                          then '(erased: it contained a one-time link)' else body end
        where id = $1`,
      [id, error.slice(0, 1_000), retryAt],
    );
  }

  async skipped(id: string, reason: string): Promise<void> {
    await this.tx.query(
      "update notification_deliveries set status = 'skipped', error = $2 where id = $1",
      [id, reason],
    );
  }

  async list(filter: Parameters<INotificationDeliveries["list"]>[0]): Promise<Delivery[]> {
    const { rows } = await this.tx.query<DeliveryRow>(
      `select *, case when sensitive and status <> 'sent'
                      then '(hidden: it contains a one-time link)' else body end as body
         from notification_deliveries
        where ($1::text is null or channel = $1) and ($2::text is null or status = $2)
          and ($3::uuid is null or recipient_id = $3)
          and ($4::uuid is null or id < $4)
        order by id desc
        limit $5`,
      [
        filter.channel ?? null,
        filter.status ?? null,
        filter.recipientId ?? null,
        filter.afterId ?? null,
        filter.limit,
      ],
    );
    return rows.map(toDelivery);
  }
}

/** Staff app installations for push. */
export class PostgresPushDevices implements IPushDevices {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async register(userId: string, token: string, platform: PushPlatform, now: Date) {
    // A token moves to whoever signed in last on that device.
    await this.tx.query(
      `insert into push_devices (user_id, token, platform, created_at, last_seen_at)
       values ($1, $2, $3, $4, $4)
       on conflict (token) do update
         set user_id = excluded.user_id, platform = excluded.platform, last_seen_at = excluded.last_seen_at`,
      [userId, token, platform, now],
    );
  }

  async remove(userId: string, token: string): Promise<void> {
    await this.tx.query("delete from push_devices where user_id = $1 and token = $2", [
      userId,
      token,
    ]);
  }

  async tokensOf(userId: string): Promise<string[]> {
    const { rows } = await this.tx.query<{ token: string }>(
      "select token from push_devices where user_id = $1 order by last_seen_at desc limit 10",
      [userId],
    );
    return rows.map((r) => r.token);
  }

  async forget(tokens: readonly string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.tx.query("delete from push_devices where token = any($1::text[])", [tokens]);
  }
}

/** Staff holding a permission for a branch (through any role assignment). */
export class PostgresRecipientDirectory implements IRecipientDirectory {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async staffWith(permission: string, branchId: string | null): Promise<StaffRecipient[]> {
    const { rows } = await this.transactions.current().query<{
      id: string;
      name: string;
      email: string | null;
    }>(
      `select distinct u.id, u.name, u.email::text as email
         from users u
         join user_roles ur on ur.user_id = u.id
         join role_permissions rp on rp.role_id = ur.role_id and rp.permission_key = $1
        where u.status = 'active'
          and (rp.scope = 'all'
               or (rp.scope = 'branch' and $2::uuid is not null
                   and (ur.branch_id = $2
                        or (ur.branch_id is null and exists (select 1 from user_branches ub
                              where ub.user_id = u.id and ub.branch_id = $2)))))
        order by u.name, u.id`,
      [permission, branchId],
    );
    return rows.map((r) => ({ userId: r.id, name: r.name, email: r.email }));
  }
}

/** What the notification rules look for. */
export class PostgresNotificationQueries implements INotificationQueries {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async expiringVehicleDocuments(from: string, to: string): Promise<ExpiringVehicleDocument[]> {
    const { rows } = await this.tx.query<{
      id: string;
      vehicle_id: string;
      code: string;
      plate_number: string | null;
      branch_id: string;
      type: string;
      title: string | null;
      expires_on: string;
      reminder_days: number[];
    }>(
      `select d.id, d.vehicle_id, v.code, v.plate_number, v.branch_id, d.type, d.title,
              d.expires_on::text as expires_on, d.reminder_days
         from vehicle_documents d
         join vehicles v on v.id = d.vehicle_id
        where v.deleted_at is null and v.status <> all($3::text[])
          and d.expires_on between $1 and $2
          -- Renewed: a later document of the same kind replaces it.
          and not exists (
            select 1 from vehicle_documents n
             where n.vehicle_id = d.vehicle_id and n.type = d.type and n.id <> d.id
               and (d.type <> 'other' or n.title is not distinct from d.title)
               and n.expires_on > d.expires_on)
        order by d.expires_on, v.code`,
      [from, to, [...OFF_FLEET_STATUSES]],
    );
    return rows.map((r) => ({
      documentId: r.id,
      vehicleId: r.vehicle_id,
      vehicleCode: r.code,
      plateNumber: r.plate_number,
      branchId: r.branch_id,
      type: r.type,
      title: r.title,
      expiresOn: r.expires_on,
      reminderDays: r.reminder_days,
    }));
  }

  async expiringLicences(from: string, to: string): Promise<ExpiringLicence[]> {
    const { rows } = await this.tx.query<{
      id: string;
      name: string;
      phone: string;
      branch_id: string;
      expires_on: string;
    }>(
      `select id, first_name || ' ' || last_name as name, phone, branch_id,
              licence_expires_on::text as expires_on
         from drivers
        where status = 'active' and deleted_at is null
          and licence_expires_on between $1 and $2
        order by licence_expires_on, code`,
      [from, to],
    );
    return rows.map((r) => ({
      driverId: r.id,
      name: r.name,
      phone: r.phone,
      branchId: r.branch_id,
      expiresOn: r.expires_on,
    }));
  }

  async remittancesEnding(date: string, statuses: readonly string[]): Promise<DueRemittance[]> {
    const { rows } = await this.tx.query<{
      id: string;
      driver_id: string;
      name: string;
      phone: string;
      branch_id: string;
      plate_number: string | null;
      period_end: string;
      outstanding: string;
      status: string;
    }>(
      `select r.id, r.driver_id, d.first_name || ' ' || d.last_name as name, d.phone, r.branch_id,
              v.plate_number, r.period_end::text as period_end,
              r.expected_minor - r.received_minor - r.waived_minor as outstanding, r.status
         from remittances r
         join drivers d on d.id = r.driver_id
         join vehicles v on v.id = r.vehicle_id
        where r.mode = 'fixed_target' and r.period_end = $1 and r.status = any($2::text[])
          and r.expected_minor > r.received_minor + r.waived_minor
        order by r.branch_id, d.code`,
      [date, statuses],
    );
    return rows.map((r) => ({
      remittanceId: r.id,
      driverId: r.driver_id,
      driverName: r.name,
      phone: r.phone,
      branchId: r.branch_id,
      plateNumber: r.plate_number,
      periodEnd: r.period_end,
      outstandingMinor: Number(r.outstanding),
      status: r.status,
    }));
  }

  async pendingApprovals() {
    const { rows } = await this.tx.query<{ branch_id: string; n: string; amount: string }>(
      `select branch_id, count(*) as n, sum(amount_minor) as amount
         from expenses where status = 'submitted'
        group by branch_id`,
    );
    return rows.map((r) => ({
      branchId: r.branch_id,
      count: Number(r.n),
      amountMinor: Number(r.amount),
    }));
  }
}
