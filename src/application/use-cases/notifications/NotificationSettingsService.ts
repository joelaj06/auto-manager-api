import {
  quietHours,
  RULE_KEYS,
  RULES,
  ruleConfig,
  senderId,
  timeOfDay,
  type Channel,
  type QuietHours,
  type RuleConfig,
  type RuleKey,
  NotificationRuleError,
} from "../../../domain/notifications/NotificationRules.js";
import type { Principal } from "../../authorization/Principal.js";
import { SmsNotConfiguredError, SmsProviderError } from "../../errors/NotificationErrors.js";
import type { Page } from "../../dto/Page.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import {
  SMS_CREDENTIAL_FIELDS,
  type Delivery,
  type DeliveryChannel,
  type DeliveryStatus,
  type INotificationDeliveries,
  type INotificationSettingsStore,
  type ISmsGateway,
  type NotificationSettings,
  type SmsProvider,
} from "../../ports/INotifications.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ISecretBox } from "../../ports/ISecretBox.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { PageCursor } from "../../services/PageCursor.js";
import { recordUserAction } from "../reference/userAudit.js";

export type RuleView = RuleConfig &
  Readonly<{
    key: RuleKey;
    description: string;
    availableChannels: readonly Channel[];
    placeholders: readonly string[];
  }>;

export type NotificationSettingsView = Readonly<{
  /** The SMS account without its credentials. */
  sms: Readonly<{ provider: SmsProvider; senderId: string; updatedAt: string }> | null;
  quietHours: QuietHours | null;
  remittanceCutoff: string;
  rules: readonly RuleView[];
}>;

export type NotificationSettingsChanges = Readonly<{
  quietHours?: QuietHours | null;
  remittanceCutoff?: string;
  rules?: Readonly<Partial<Record<RuleKey, Partial<RuleConfig>>>>;
}>;

export type SmsAccountInput = Readonly<{
  provider: SmsProvider;
  senderId: string;
  credentials: Readonly<Record<string, string>>;
}>;

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Notification settings (docs/15, decision 17): the business's own SMS provider account (Hubtel,
 * Arkesel or mNotify; credentials sealed at rest and never shown again), quiet hours, the
 * remittance cut-off time, and per rule whether it runs, on which channels, how many days ahead
 * and with what SMS text. Also the log of messages sent and a test SMS.
 */
export class NotificationSettingsService {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      settings: INotificationSettingsStore;
      deliveries: INotificationDeliveries;
      secrets: ISecretBox;
      gateways: readonly ISmsGateway[];
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
    }>,
  ) {}

  get(): Promise<NotificationSettingsView> {
    return this.deps.unitOfWork.run(async () => view(await this.deps.settings.get()));
  }

  async update(
    actor: Principal,
    changes: NotificationSettingsChanges,
  ): Promise<NotificationSettingsView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.settings.get();
      const rules = { ...before.rules };
      for (const [key, change] of Object.entries(changes.rules ?? {}) as [
        RuleKey,
        Partial<RuleConfig>,
      ][]) {
        if (!RULE_KEYS.includes(key)) throw new NotificationRuleError(`Unknown rule ${key}`);
        rules[key] = ruleConfig(key, { ...rules[key], ...stripUndefined(change) });
      }
      const after: NotificationSettings = {
        ...before,
        quietHours:
          changes.quietHours === undefined ? before.quietHours : quietHours(changes.quietHours),
        remittanceCutoff:
          changes.remittanceCutoff === undefined
            ? before.remittanceCutoff
            : timeOfDay(changes.remittanceCutoff),
        rules,
      };
      await deps.settings.set(after);
      await recordUserAction(deps, actor.userId, {
        action: "settings.notifications_updated",
        entityType: "organisation",
        before: withoutSms(before),
        after: withoutSms(after),
      });
      return view(after);
    });
  }

  /** Sets (or replaces) the SMS provider account; the credentials are sealed. */
  async setSmsAccount(actor: Principal, input: SmsAccountInput): Promise<NotificationSettingsView> {
    const { deps } = this;
    const fields = SMS_CREDENTIAL_FIELDS[input.provider];
    const credentials: Record<string, string> = {};
    for (const field of fields) {
      const value = input.credentials[field]?.trim();
      if (value === undefined || value === "")
        throw new NotificationRuleError(`${input.provider} needs ${fields.join(" and ")}`);
      credentials[field] = value;
    }
    return deps.unitOfWork.run(async () => {
      const before = await deps.settings.get();
      const after: NotificationSettings = {
        ...before,
        sms: {
          provider: input.provider,
          senderId: senderId(input.senderId),
          sealedCredentials: deps.secrets.seal(JSON.stringify(credentials)),
          updatedAt: deps.clock.now().toISOString(),
        },
      };
      await deps.settings.set(after);
      await recordUserAction(deps, actor.userId, {
        action: "settings.sms_provider_set",
        entityType: "organisation",
        before: { provider: before.sms?.provider ?? null, senderId: before.sms?.senderId ?? null },
        after: { provider: input.provider, senderId: after.sms!.senderId },
      });
      return view(after);
    });
  }

  async removeSmsAccount(actor: Principal): Promise<NotificationSettingsView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.settings.get();
      const after = { ...before, sms: null };
      await deps.settings.set(after);
      await recordUserAction(deps, actor.userId, {
        action: "settings.sms_provider_removed",
        entityType: "organisation",
        before: { provider: before.sms?.provider ?? null },
        after: { provider: null },
      });
      return view(after);
    });
  }

  /** Sends a test SMS now through the configured account; the result goes to the log too. */
  async testSms(actor: Principal, to: string): Promise<Delivery> {
    const { deps } = this;
    if (!E164.test(to)) throw new NotificationRuleError("Give the number as +233…");
    const { account, deliveryId } = await deps.unitOfWork.run(async () => {
      const settings = await deps.settings.get();
      if (settings.sms === null) throw new SmsNotConfiguredError();
      const now = deps.clock.now();
      const dedupeKey = `test:${now.toISOString()}`;
      const id = await deps.deliveries.queue({
        channel: "sms",
        rule: "test",
        recipientType: "user",
        recipientId: actor.userId,
        address: to,
        title: null,
        body: "Test message from Autoforce Manager: your SMS provider is set up correctly.",
        data: {},
        dedupeKey,
        // Never picked up by the send job: this request sends it.
        sendAfter: new Date(now.getTime() + 3_600_000),
      });
      return { account: settings.sms, deliveryId: id! };
    });
    const gateway = deps.gateways.find((g) => g.provider === account.provider)!;
    let outcome: Readonly<{ messageId: string } | { error: string }>;
    try {
      outcome = await gateway.send(
        {
          senderId: account.senderId,
          credentials: JSON.parse(deps.secrets.open(account.sealedCredentials)) as Record<
            string,
            string
          >,
        },
        to,
        "Test message from Autoforce Manager: your SMS provider is set up correctly.",
      );
    } catch (error) {
      if (!(error instanceof SmsProviderError)) throw error;
      outcome = { error: error.message };
    }
    const delivery = await deps.unitOfWork.run(async () => {
      if ("messageId" in outcome)
        await deps.deliveries.sent(
          deliveryId,
          account.provider,
          outcome.messageId,
          deps.clock.now(),
        );
      else await deps.deliveries.failed(deliveryId, outcome.error, null);
      return deps.deliveries.find(deliveryId);
    });
    if ("error" in outcome) throw new SmsProviderError(outcome.error, true);
    return delivery!;
  }

  /** The log of outgoing messages, newest first. */
  async deliveries(
    query: Readonly<{
      channel?: DeliveryChannel;
      status?: DeliveryStatus;
      recipientId?: string;
      cursor?: string;
      limit: number;
    }>,
  ): Promise<Page<Delivery>> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 1).values;
    return deps.unitOfWork.run(async () => {
      const rows = await deps.deliveries.list({
        ...(query.channel === undefined ? {} : { channel: query.channel }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.recipientId === undefined ? {} : { recipientId: query.recipientId }),
        limit: query.limit + 1,
        ...(after === undefined ? {} : { afterId: String(after[0]) }),
      });
      return PageCursor.paginate(rows, query.limit, (r) => [r.id]);
    });
  }
}

function view(settings: NotificationSettings): NotificationSettingsView {
  return {
    sms:
      settings.sms === null
        ? null
        : {
            provider: settings.sms.provider,
            senderId: settings.sms.senderId,
            updatedAt: settings.sms.updatedAt,
          },
    quietHours: settings.quietHours,
    remittanceCutoff: settings.remittanceCutoff,
    rules: RULE_KEYS.map((key) => ({
      key,
      description: RULES[key].description,
      availableChannels: RULES[key].channels,
      placeholders: RULES[key].placeholders ?? [],
      ...settings.rules[key],
    })),
  };
}

function withoutSms(settings: NotificationSettings) {
  const { sms: _sms, ...rest } = settings;
  return rest;
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
