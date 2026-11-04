import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  checkWebhookEvents,
  checkWebhookUrl,
  IntegrationRuleError,
  isWebhookEvent,
  MAX_WEBHOOK_ENDPOINTS,
  nextWebhookAttempt,
  shouldDisableEndpoint,
  WEBHOOK_DELIVERY_RETENTION_DAYS,
  WEBHOOK_EVENTS,
} from "../../../domain/integrations/Integrations.js";
import type { Principal } from "../../authorization/Principal.js";
import type { AuditEntry } from "../../dto/AuditEntry.js";
import { WebhookNotFoundError } from "../../errors/IntegrationErrors.js";
import type { DeliveredEvent, IEventHandler } from "../../events/IEventHandler.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IOutbox } from "../../ports/IOutbox.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ISecretBox } from "../../ports/ISecretBox.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IWebhooks, IWebhookTransport } from "../../ports/IWebhooks.js";
import type { Notifier } from "../notifications/Notifier.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { EnterpriseGate } from "./EnterpriseGate.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const SWEEP_BATCH = 500;

/** `t=<unix seconds>,v1=<HMAC-SHA256 of "<t>.<body>">`: the time guards against replays. */
export function signWebhook(secret: string, body: string, unixSeconds: number): string {
  const digest = createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex");
  return `t=${unixSeconds},v1=${digest}`;
}

/**
 * Publishes the changes a business can subscribe to (decision 525). Every committed change that
 * matters already passes through the audit trail in its own transaction, so an event exists
 * exactly when the change does, and nothing is written when nobody listens.
 */
export class WebhookPublishingAuditTrail implements IAuditTrail {
  constructor(
    private readonly inner: IAuditTrail,
    private readonly webhooks: Pick<IWebhooks, "hasSubscriber">,
    private readonly outbox: IOutbox,
  ) {}

  async record(entry: AuditEntry): Promise<string> {
    const id = await this.inner.record(entry);
    if (isWebhookEvent(entry.action) && (await this.webhooks.hasSubscriber(entry.action)))
      await this.outbox.enqueue({
        eventType: entry.action,
        aggregateType: entry.entityType,
        aggregateId: entry.entityId ?? null,
        payload: { entityType: entry.entityType, entityId: entry.entityId ?? null },
      });
    return id;
  }
}

/** Setting up webhooks: the addresses, their events, secrets, tests and replays. */
export class Webhooks {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      webhooks: IWebhooks;
      gate: EnterpriseGate;
      secrets: ISecretBox;
      queue: IJobQueue;
      tenants: ITenantDirectory;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
    }>,
  ) {}

  events() {
    return Object.entries(WEBHOOK_EVENTS).map(([key, description]) => ({ key, description }));
  }

  list() {
    return this.deps.unitOfWork.run(() => this.deps.webhooks.endpoints());
  }

  async create(
    actor: Principal,
    input: Readonly<{ url: string; description?: string | null; events: readonly string[] }>,
  ) {
    const { deps } = this;
    await deps.gate.require(actor.tenantId);
    const url = checkWebhookUrl(input.url);
    const events = checkWebhookEvents(input.events);
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    const id = await deps.unitOfWork.run(async () => {
      if ((await deps.webhooks.countEndpoints()) >= MAX_WEBHOOK_ENDPOINTS)
        throw new IntegrationRuleError(
          `A business holds at most ${MAX_WEBHOOK_ENDPOINTS} webhook addresses`,
        );
      const created = await deps.webhooks.createEndpoint({
        url,
        description: input.description ?? null,
        events,
        sealedSecret: deps.secrets.seal(secret),
        createdBy: actor.userId,
      });
      await this.audit(actor, "webhook.created", created, { url, events });
      return created;
    });
    return { ...(await this.endpoint(id)), secret };
  }

  async update(
    actor: Principal,
    id: string,
    input: Readonly<{
      url?: string;
      description?: string | null;
      events?: readonly string[];
      enabled?: boolean;
    }>,
  ) {
    const { deps } = this;
    const url = input.url === undefined ? undefined : checkWebhookUrl(input.url);
    const events = input.events === undefined ? undefined : checkWebhookEvents(input.events);
    await deps.unitOfWork.run(async () => {
      await this.require(id);
      await deps.webhooks.updateEndpoint(
        id,
        {
          ...(url === undefined ? {} : { url }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(events === undefined ? {} : { events }),
          ...(input.enabled === undefined
            ? {}
            : {
                status: input.enabled ? ("active" as const) : ("disabled" as const),
                disabledReason: input.enabled ? null : "Switched off by the business",
              }),
        },
        deps.clock.now(),
      );
      await this.audit(actor, "webhook.updated", id, { url, events, enabled: input.enabled });
    });
    return this.endpoint(id);
  }

  async remove(actor: Principal, id: string): Promise<void> {
    await this.deps.unitOfWork.run(async () => {
      await this.require(id);
      await this.deps.webhooks.removeEndpoint(id);
      await this.audit(actor, "webhook.removed", id, {});
    });
  }

  async rotateSecret(actor: Principal, id: string) {
    const { deps } = this;
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    await deps.unitOfWork.run(async () => {
      await this.require(id);
      await deps.webhooks.setSecret(id, deps.secrets.seal(secret), deps.clock.now());
      await this.audit(actor, "webhook.secret_rotated", id, {});
    });
    return { secret };
  }

  deliveries(id: string, limit: number) {
    return this.deps.unitOfWork.run(async () => {
      await this.require(id);
      return this.deps.webhooks.deliveries(id, limit);
    });
  }

  /** Sends a harmless event to check the address and the signature. */
  async test(actor: Principal, id: string): Promise<Readonly<{ deliveryId: string }>> {
    const { deps } = this;
    const eventId = randomUUID();
    const at = deps.clock.now();
    const tenant = await deps.tenants.findById(actor.tenantId);
    const deliveryId = await deps.unitOfWork.run(async () => {
      await this.require(id);
      return deps.webhooks.createDelivery({
        endpointId: id,
        eventId,
        eventType: "webhook.test",
        body: webhookBody(eventId, "webhook.test", at, tenant?.slug ?? "", {
          entityType: "webhook",
          entityId: id,
        }),
        at,
      });
    });
    await deps.queue.enqueue("tenant.webhook_deliver", {
      tenantId: actor.tenantId,
      deliveryId: deliveryId!,
    });
    return { deliveryId: deliveryId! };
  }

  async replay(actor: Principal, deliveryId: string): Promise<void> {
    const { deps } = this;
    const replayed = await deps.unitOfWork.run(() =>
      deps.webhooks.replay(deliveryId, deps.clock.now()),
    );
    if (!replayed) throw new WebhookNotFoundError();
    await deps.queue.enqueue("tenant.webhook_deliver", { tenantId: actor.tenantId, deliveryId });
  }

  private async endpoint(id: string) {
    const record = await this.deps.unitOfWork.run(() => this.deps.webhooks.endpoint(id));
    if (record === null) throw new WebhookNotFoundError();
    return record;
  }

  private async require(id: string): Promise<void> {
    if ((await this.deps.webhooks.endpoint(id)) === null) throw new WebhookNotFoundError();
  }

  private audit(actor: Principal, action: string, id: string, after: Record<string, unknown>) {
    return recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "webhook_endpoint",
      entityId: id,
      after,
    });
  }
}

function webhookBody(
  eventId: string,
  type: string,
  occurredAt: Date,
  tenant: string,
  data: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify({ id: eventId, type, occurredAt: occurredAt.toISOString(), tenant, data });
}

/** Turns an event into one delivery per address that wants it. */
export class WebhookFanOut implements IEventHandler {
  readonly name = "webhooks.fan_out";
  readonly eventTypes = Object.keys(WEBHOOK_EVENTS);

  constructor(
    private readonly deps: Readonly<{
      webhooks: IWebhooks;
      gate: EnterpriseGate;
      queue: IJobQueue;
      tenants: ITenantDirectory;
      clock: IClock;
    }>,
  ) {}

  async handle(event: DeliveredEvent): Promise<void> {
    const { deps } = this;
    if (!(await deps.gate.allows(event.tenantId))) return;
    const tenant = await deps.tenants.findById(event.tenantId);
    const body = webhookBody(
      event.id,
      event.eventType,
      event.occurredAt,
      tenant?.slug ?? "",
      event.payload,
    );
    const at = deps.clock.now();
    for (const endpointId of await deps.webhooks.subscribers(event.eventType)) {
      const deliveryId = await deps.webhooks.createDelivery({
        endpointId,
        eventId: event.id,
        eventType: event.eventType,
        body,
        at,
      });
      // A second after this transaction should have committed; a lost job is found by the sweep.
      if (deliveryId !== null)
        await deps.queue.enqueue(
          "tenant.webhook_deliver",
          { tenantId: event.tenantId, deliveryId },
          { startAfter: new Date(at.getTime() + 1_000) },
        );
    }
  }
}

/** One try of one delivery, made outside any transaction, and what follows from it. */
export class DeliverWebhook implements IJobHandler<"tenant.webhook_deliver"> {
  readonly job = "tenant.webhook_deliver" as const;

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      webhooks: IWebhooks;
      transport: IWebhookTransport;
      secrets: ISecretBox;
      queue: IJobQueue;
      notifier: Notifier;
      notificationSettings: INotificationSettingsStore;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async handle({ tenantId, deliveryId }: JobPayloads["tenant.webhook_deliver"]): Promise<void> {
    const { deps } = this;
    const delivery = await deps.unitOfWork.run(() => deps.webhooks.delivery(deliveryId));
    // Queued by a transaction that may not be visible yet: try again.
    if (delivery === null) throw new Error(`Webhook delivery ${deliveryId} not found`);
    if (delivery.status !== "pending") return;
    const now = deps.clock.now();
    if (delivery.endpointStatus !== "active") {
      await deps.unitOfWork.run(() =>
        deps.webhooks.recordAttempt({
          deliveryId,
          endpointId: delivery.endpointId,
          delivered: false,
          httpStatus: null,
          error: "The address is switched off",
          nextAttemptAt: null,
          at: now,
        }),
      );
      return;
    }

    const secret = deps.secrets.open(delivery.sealedSecret);
    const response = await deps.transport.post(
      delivery.url,
      {
        "Content-Type": "application/json",
        "User-Agent": "Autoforce-Webhooks/1",
        "X-Autoforce-Event": delivery.eventType,
        "X-Autoforce-Delivery": delivery.id,
        "X-Autoforce-Signature": signWebhook(
          secret,
          delivery.body,
          Math.floor(now.getTime() / 1_000),
        ),
      },
      delivery.body,
    );
    const status = response.status;
    const delivered = status !== null && status >= 200 && status < 300;
    const error = delivered
      ? null
      : (response.error ?? `The address answered ${status ?? "nothing"}`);
    const nextAttemptAt = delivered ? null : nextWebhookAttempt(delivery.attempts + 1, now);

    await deps.unitOfWork.run(async () => {
      const endpoint = await deps.webhooks.recordAttempt({
        deliveryId,
        endpointId: delivery.endpointId,
        delivered,
        httpStatus: status,
        error,
        nextAttemptAt,
        at: now,
      });
      if (endpoint === null || delivered || !shouldDisableEndpoint(endpoint, now)) return;
      await deps.webhooks.updateEndpoint(
        endpoint.id,
        { status: "disabled", disabledReason: `Kept failing: ${error}`.slice(0, 300) },
        now,
      );
      await deps.notifier.staff(await deps.notificationSettings.get(), {
        rule: "webhook_endpoint_disabled",
        permission: "integrations.manage",
        branchId: null,
        dedupeKey: `webhook_endpoint_disabled:${endpoint.id}:${now.toISOString().slice(0, 10)}`,
        title: "A webhook address was switched off",
        body: `${endpoint.url} has failed for days and receives nothing until it is switched on again.`,
        severity: "warning",
        data: { endpointId: endpoint.id },
      });
      deps.logger.warn("Webhook endpoint switched off", { tenantId, endpointId: endpoint.id });
    });
    if (nextAttemptAt !== null)
      await deps.queue.enqueue(
        "tenant.webhook_deliver",
        { tenantId, deliveryId },
        { startAfter: nextAttemptAt },
      );
  }
}

/** Daily: picks up deliveries whose job was lost and clears old ones. */
export class WebhookHousekeeping implements ITenantDailyTask {
  readonly name = "webhook_housekeeping";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      webhooks: IWebhooks;
      queue: IJobQueue;
      tenantContext: ITenantContext;
      clock: IClock;
    }>,
  ) {}

  async run(): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now().getTime();
    const tenantId = deps.tenantContext.currentTenantId().value;
    const lost = await deps.unitOfWork.run(() =>
      deps.webhooks.overdue(new Date(now - HOUR_MS), SWEEP_BATCH),
    );
    for (const deliveryId of lost)
      await deps.queue.enqueue("tenant.webhook_deliver", { tenantId, deliveryId });
    const before = new Date(now - WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS);
    while (
      (await deps.unitOfWork.run(() => deps.webhooks.purgeDeliveries(before, SWEEP_BATCH))) >=
      SWEEP_BATCH
    );
  }
}
