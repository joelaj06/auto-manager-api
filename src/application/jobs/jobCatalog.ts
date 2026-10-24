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
  /** Run (or resume) the provisioning saga of an approved tenant. */
  "tenant.provision": Readonly<{ tenantId: string }>;
  /** Re-queue stalled provisioning and report orphan databases. */
  "provisioning.sweep": Readonly<Record<string, never>>;
  /** Bring one tenant's permissions and system roles to the current catalogue. */
  "tenant.catalogue_sync": Readonly<{ tenantId: string; version: number }>;
  /** Enqueue a catalogue sync for every tenant behind the current catalogue version. */
  "catalogue.sweep": Readonly<Record<string, never>>;
  /** Remove abandoned platform uploads (tenant uploads: daily maintenance). */
  "files.sweep": Readonly<Record<string, never>>;
  /** Send a tenant's due notification messages (SMS, push, email). */
  "notifications.send": Readonly<{ tenantId: string }>;
  /** Safety net: a send run for every usable tenant. */
  "notifications.sweep": Readonly<Record<string, never>>;
  /** Morning reminders: expiries, remittances due, budgets, approvals waiting. */
  "tenant.notification_rules": Readonly<{ tenantId: string; localDate: string }>;
  /** Render and store the PDF of an issued document. */
  "documents.render": Readonly<{ tenantId: string; documentId: string }>;
  /** Render and store the signed copy of a fully signed document. */
  "documents.seal": Readonly<{ tenantId: string; documentId: string }>;
  /** Compare yesterday's gateway payments with the provider's transactions. */
  "billing.reconcile": Readonly<Record<string, never>>;
  /** Build a tenant's full data export. */
  "tenant.data_export": Readonly<{ exportId: string }>;
  /** Daily compliance chores: restore drills, data-protection deadlines, expired exports. */
  "compliance.daily": Readonly<Record<string, never>>;
  /** Email a published announcement to the owners of its tenants. */
  "announcements.email": Readonly<{ announcementId: string }>;
  /** Email and post a new or escalated alert to on-call. */
  "alerts.notify": Readonly<{ alertId: string }>;
  /** Collect yesterday's usage of every tenant (`usage_daily`). */
  "usage.daily": Readonly<Record<string, never>>;
  /** Compare each tenant's billed branch count with its active branches. */
  "billing.branch_reconcile": Readonly<Record<string, never>>;
  /** The daily billing automation: invoices, reminders, charges, past due, deactivation. */
  "billing.automation": Readonly<Record<string, never>>;
  /** Remittance cut-off check (waits until the tenant's cut-off time). */
  "tenant.remittance_cutoff": Readonly<{ tenantId: string; localDate: string }>;
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
  "tenant.provision": {
    description: "Provision an approved tenant (resumable saga)",
    // Not tenant-scoped: the tenant is not usable yet; the saga enters its context itself.
    tenantScoped: false,
    policy: "stately",
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 600,
  },
  "provisioning.sweep": {
    description: "Re-queue stalled provisioning and report orphan databases",
    tenantScoped: false,
    policy: "stately",
    retryLimit: 1,
    retryDelaySeconds: 60,
    retryBackoff: false,
    expireInSeconds: 600,
    cron: "*/10 * * * *",
  },
  "tenant.catalogue_sync": {
    description: "Sync a tenant's permissions and system roles with the catalogue",
    tenantScoped: true,
    policy: "stately",
    retryLimit: 5,
    retryDelaySeconds: 60,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  "catalogue.sweep": {
    description: "Enqueue catalogue syncs for tenants behind the current version",
    tenantScoped: false,
    policy: "stately",
    retryLimit: 1,
    retryDelaySeconds: 60,
    retryBackoff: false,
    expireInSeconds: 900,
    cron: "23 * * * *",
  },
  "billing.reconcile": {
    description: "Reconcile yesterday's gateway payments with the payment provider",
    tenantScoped: false,
    policy: "stately",
    retryLimit: 3,
    retryDelaySeconds: 900,
    retryBackoff: true,
    expireInSeconds: 1_800,
    cron: "17 5 * * *",
  },
  "tenant.data_export": {
    description: "Build a tenant's full data export (CSV per table, files, README)",
    tenantScoped: false,
    policy: "standard",
    retryLimit: 2,
    retryDelaySeconds: 600,
    retryBackoff: false,
    expireInSeconds: 3_600,
  },
  "compliance.daily": {
    description: "Schedule restore drills, flag data-protection deadlines, remove expired exports",
    tenantScoped: false,
    policy: "stately",
    retryLimit: 2,
    retryDelaySeconds: 900,
    retryBackoff: false,
    expireInSeconds: 1_800,
    // 06:43 Accra, before the working day.
    cron: "43 6 * * *",
  },
  "announcements.email": {
    description: "Email a published announcement to the owners of its tenants",
    tenantScoped: false,
    policy: "stately",
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: true,
    expireInSeconds: 3_600,
  },
  "alerts.notify": {
    description: "Email and post a new or escalated platform alert to on-call",
    tenantScoped: false,
    policy: "standard",
    retryLimit: 5,
    retryDelaySeconds: 60,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  "usage.daily": {
    description: "Collect each tenant's usage of the day before (usage_daily)",
    tenantScoped: false,
    policy: "stately",
    retryLimit: 2,
    retryDelaySeconds: 900,
    retryBackoff: false,
    expireInSeconds: 3_600,
    // 01:13 Accra: the day before is complete.
    cron: "13 1 * * *",
  },
  "billing.branch_reconcile": {
    description: "Compare billed branch counts with the tenants' active branches and fix drift",
    tenantScoped: false,
    policy: "stately",
    retryLimit: 1,
    retryDelaySeconds: 1_800,
    retryBackoff: false,
    expireInSeconds: 3_600,
    // 02:37 Accra: before the billing automation issues the day's invoices.
    cron: "37 2 * * *",
  },
  "billing.automation": {
    description:
      "Issue due invoices, send billing reminders, charge saved cards and deactivate unpaid tenants",
    tenantScoped: false,
    policy: "stately",
    retryLimit: 1,
    retryDelaySeconds: 1_800,
    retryBackoff: false,
    expireInSeconds: 3_600,
    // 07:07 Africa/Accra, after the reconciliation of the day before.
    cron: "7 7 * * *",
  },
  "files.sweep": {
    description: "Remove platform uploads that were started but never completed",
    tenantScoped: false,
    policy: "stately",
    retryLimit: 1,
    retryDelaySeconds: 300,
    retryBackoff: false,
    expireInSeconds: 900,
    cron: "41 3 * * *",
  },
  "notifications.send": {
    description: "Send a tenant's due SMS, push and email notifications",
    tenantScoped: true,
    policy: "stately",
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 600,
  },
  "notifications.sweep": {
    description: "Ask every tenant to send its due notifications",
    tenantScoped: false,
    policy: "stately",
    retryLimit: 1,
    retryDelaySeconds: 60,
    retryBackoff: false,
    expireInSeconds: 900,
    cron: "13 * * * *",
  },
  "tenant.notification_rules": {
    description: "Morning reminders of a tenant (expiries, remittances due, budgets, approvals)",
    tenantScoped: true,
    policy: "standard",
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: true,
    expireInSeconds: 1_800,
  },
  "documents.render": {
    description: "Render and store the PDF of an issued document",
    tenantScoped: true,
    policy: "standard",
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  "documents.seal": {
    description: "Render and store the signed copy of a fully signed document",
    tenantScoped: true,
    policy: "standard",
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  "tenant.remittance_cutoff": {
    description: "Remittance cut-off check of a tenant at its cut-off time",
    tenantScoped: true,
    policy: "stately",
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: true,
    expireInSeconds: 1_800,
  },
} satisfies Record<JobName, JobDefinition>);

export const JOB_NAMES = Object.freeze(Object.keys(JOB_CATALOG) as JobName[]);

/** Daily tenant jobs and the local hour (tenant timezone) from which they may run. */
export type TenantDailyJob = Readonly<{
  job: "tenant.daily_maintenance" | "tenant.notification_rules" | "tenant.remittance_cutoff";
  localHour: number;
}>;

export const TENANT_DAILY_JOBS: readonly TenantDailyJob[] = Object.freeze([
  { job: "tenant.daily_maintenance", localHour: 2 },
  // After the daily job has created today's remittance rows; before most people's day starts.
  { job: "tenant.notification_rules", localHour: 7 },
  // Waits inside the job for the business's cut-off time (a setting).
  { job: "tenant.remittance_cutoff", localHour: 0 },
]);
