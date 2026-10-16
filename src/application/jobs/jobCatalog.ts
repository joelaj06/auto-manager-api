/**
 * Every background job, with its payload type and queue policy. The worker refuses to start a
 * handler for a job missing here, and the migration command creates one queue per entry.
 *
 * Rules (docs/22 §2.7, docs/15 §3):
 * - Tenant jobs carry `tenantId` and run inside that tenant's context.
 * - Payloads are small and contain ids, never secrets or rendered messages.
 * - Handlers are idempotent: jobs are delivered at least once.
 */
export type JobPayloads = {
  /** Publish the tenant's pending outbox events (enqueued after commit and by the sweeper). */
  "outbox.drain": Readonly<{ tenantId: string }>;
  /** Safety net: enqueue a drain for every active tenant. */
  "outbox.sweep": Readonly<Record<string, never>>;
  /** Hand one outbox event to one event handler. */
  "event.deliver": Readonly<{
    tenantId: string;
    eventId: string;
    eventType: string;
    handler: string;
    aggregateType: string | null;
    aggregateId: string | null;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: string;
  }>;
  /** Enqueue each tenant's daily jobs once its local time reaches their hour. */
  "scheduler.tick": Readonly<Record<string, never>>;
  /** Retention clean-up in one tenant database (sessions, codes, processed messages, outbox). */
  "tenant.daily_maintenance": Readonly<{ tenantId: string; localDate: string }>;
  /** Send one queued platform email. */
  "email.send": Readonly<{ deliveryId: string }>;
};

export type JobName = keyof JobPayloads;

/**
 * Queue policies (pg-boss): `standard` allows any number of jobs; `stately` keeps at most one
 * queued and one active job per singleton key — used for "drain tenant X" so bursts collapse.
 */
export type JobDefinition = Readonly<{
  description: string;
  tenantScoped: boolean;
  policy: "standard" | "stately";
  retryLimit: number;
  /** Seconds before the first retry; doubled each attempt when `retryBackoff`. */
  retryDelaySeconds: number;
  retryBackoff: boolean;
  /** A running job that takes longer is considered failed and retried. */
  expireInSeconds: number;
  /** Recurring jobs: cron expression in UTC. */
  cron?: string;
}>;

export const JOB_CATALOG: Readonly<Record<JobName, JobDefinition>> = Object.freeze({
  "outbox.drain": {
    description: "Publish pending outbox events of a tenant",
    tenantScoped: true,
    policy: "stately",
    retryLimit: 5,
    retryDelaySeconds: 5,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  "outbox.sweep": {
    description: "Enqueue an outbox drain for every active tenant",
    tenantScoped: false,
    policy: "stately",
    retryLimit: 1,
    retryDelaySeconds: 30,
    retryBackoff: false,
    expireInSeconds: 900,
    // Hourly: drains are triggered after every commit; this only catches lost triggers.
    cron: "7 * * * *",
  },
  "event.deliver": {
    description: "Run one event handler for one outbox event",
    tenantScoped: true,
    policy: "standard",
    retryLimit: 8,
    retryDelaySeconds: 10,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  "scheduler.tick": {
    description: "Enqueue tenant daily jobs in each tenant's local time",
    tenantScoped: false,
    policy: "stately",
    retryLimit: 1,
    retryDelaySeconds: 60,
    retryBackoff: false,
    expireInSeconds: 900,
    cron: "*/15 * * * *",
  },
  "tenant.daily_maintenance": {
    description: "Delete expired sessions, codes, processed messages and published events",
    tenantScoped: true,
    policy: "standard",
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: true,
    expireInSeconds: 1_800,
  },
  "email.send": {
    description: "Send a queued platform email",
    tenantScoped: false,
    policy: "standard",
    retryLimit: 6,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 120,
  },
} satisfies Record<JobName, JobDefinition>);

export const JOB_NAMES = Object.freeze(Object.keys(JOB_CATALOG) as JobName[]);

/** Daily tenant jobs and the local hour (tenant timezone) from which they may run. */
export type TenantDailyJob = Readonly<{ job: "tenant.daily_maintenance"; localHour: number }>;

export const TENANT_DAILY_JOBS: readonly TenantDailyJob[] = Object.freeze([
  { job: "tenant.daily_maintenance", localHour: 2 },
]);
