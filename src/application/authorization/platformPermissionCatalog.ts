/**
 * Platform (console) permission catalogue — docs/27 §6. Never part of a tenant catalogue (fixes
 * audit C2). Synced into `platform_permissions` by `yarn db:migrate`, together with the system
 * staff roles below. Modules add keys here as their console features are built.
 *
 * `fourEyes`: the action runs only after a second staff member approves (docs/27 §8).
 * `sensitive`: needs a recent step-up (password + code) and is never in a custom role by default.
 */
export type PlatformPermissionDefinition = Readonly<{
  description: string;
  sensitive?: boolean;
  fourEyes?: boolean;
}>;

const definitions = {
  "platform.dashboard.view": { description: "View the console dashboard" },
  "platform.health.view": { description: "View system health" },
  "platform.alerts.manage": { description: "Acknowledge and configure alerts" },

  "platform.applications.view": { description: "View tenant applications" },
  "platform.applications.review": { description: "Review applications and request information" },
  "platform.applications.approve": { description: "Approve applications (provisions a tenant)" },
  "platform.applications.reject": { description: "Reject applications" },
  "platform.applications.create_assisted": { description: "Create assisted applications" },

  "platform.tenants.view": { description: "View tenants and their operational data" },
  "platform.tenants.edit": { description: "Edit tenant profile data" },
  "platform.tenants.notes": { description: "Add internal notes and tags" },
  "platform.tenants.activate": { description: "Activate tenants" },
  "platform.tenants.deactivate": {
    description: "Deactivate tenants (special cases)",
    sensitive: true,
  },
  "platform.tenants.restore": { description: "Restore deactivated tenants", sensitive: true },
  "platform.tenants.set_read_only": {
    description: "Put tenants in read-only mode",
    sensitive: true,
  },
  "platform.tenants.set_licence_type": {
    description: "Set the licence type (before first payment)",
  },
  "platform.tenants.archive_cold": {
    description: "Move a long-deactivated tenant to cold archive",
    sensitive: true,
    fourEyes: true,
  },
  "platform.tenants.restore_cold_archive": {
    description: "Restore a tenant from cold archive",
    sensitive: true,
    fourEyes: true,
  },
  "platform.tenants.transfer_ownership": {
    description: "Transfer tenant ownership",
    sensitive: true,
    fourEyes: true,
  },
  "platform.tenants.move_cluster": {
    description: "Move a tenant to another database cluster",
    sensitive: true,
    fourEyes: true,
  },
  "platform.tenants.rename_slug": { description: "Change a tenant's slug", sensitive: true },

  "platform.branches.view": { description: "View tenant branches" },
  "platform.branches.manage": { description: "Create, deactivate and reactivate branches" },

  "platform.billing.view": { description: "View billing" },
  "platform.billing.manage": { description: "Manage plans, subscriptions and invoices" },
  "platform.billing.payments.record": { description: "Record payments" },
  "platform.billing.refunds.issue": { description: "Issue refunds and credits", sensitive: true },
  "platform.billing.extensions.grant": { description: "Grant payment extensions" },

  "platform.users.search": { description: "Search tenant users" },
  "platform.users.reset_access": {
    description: "Reset a tenant user's password or MFA, sign them out",
    sensitive: true,
  },

  "platform.support.access_tenant": { description: "Read-only support access to a tenant" },
  "platform.support.access_tenant_write": {
    description: "Write-mode support access to a tenant",
    sensitive: true,
    fourEyes: true,
  },
  "platform.support.announcements.manage": { description: "Manage announcements" },

  "platform.flags.manage": {
    description: "Manage feature flags and kill switches",
    sensitive: true,
  },
  "platform.catalogue.view": { description: "View the permission catalogue and role templates" },
  "platform.catalogue.publish": {
    description: "Publish permission catalogue and role template changes",
    sensitive: true,
    fourEyes: true,
  },

  "platform.data.backups.view": { description: "View backups and restore tests" },
  "platform.data.backups.restore": {
    description: "Restore tenant data from a backup",
    sensitive: true,
    fourEyes: true,
  },
  "platform.data.migrations.view": { description: "View tenant schema versions and failures" },
  "platform.data.migrations.run": { description: "Run schema migrations", sensitive: true },
  "platform.data.jobs.manage": { description: "Retry and cancel background jobs" },
  "platform.data.scripts.run": {
    description: "Run curated one-off data scripts",
    sensitive: true,
    fourEyes: true,
  },

  "platform.security.audit.view": { description: "View and export the platform audit log" },
  "platform.security.dsr.anonymise": {
    description: "Anonymise personal data for an erasure request",
    sensitive: true,
    fourEyes: true,
  },
  "platform.security.access_review.view": { description: "View the staff access review" },

  "platform.analytics.view": { description: "View platform analytics" },
  "platform.settings.manage": { description: "Manage platform settings", sensitive: true },
  "platform.staff.view": { description: "View staff accounts and roles" },
  "platform.staff.manage": {
    description: "Invite, disable and enable staff, assign roles, reset staff MFA",
    sensitive: true,
  },
  "platform.roles.manage": { description: "Create and edit custom staff roles", sensitive: true },
  "platform.partners.manage": { description: "Manage reseller partners" },
  "platform.approvals.approve": {
    description: "Approve or reject four-eyes requests of other staff",
    sensitive: true,
  },
} as const satisfies Record<string, PlatformPermissionDefinition>;

export type PlatformPermissionKey = keyof typeof definitions;

export const PLATFORM_PERMISSION_CATALOG: Readonly<
  Record<PlatformPermissionKey, PlatformPermissionDefinition>
> = Object.freeze(definitions);

export const PLATFORM_PERMISSION_KEYS = Object.freeze(
  Object.keys(definitions) as PlatformPermissionKey[],
);

export function isPlatformPermissionKey(value: unknown): value is PlatformPermissionKey {
  return typeof value === "string" && Object.hasOwn(PLATFORM_PERMISSION_CATALOG, value);
}

/** System staff roles (docs/27 §1, §6). Read-only in the console; updated by releases. */
export type PlatformRoleTemplate = Readonly<{
  systemKey: string;
  name: string;
  description: string;
  permissions: readonly PlatformPermissionKey[] | "all";
}>;

const keysWithPrefix = (...prefixes: string[]) =>
  PLATFORM_PERMISSION_KEYS.filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));

export const SUPER_ADMIN_ROLE = "super_admin";

export const PLATFORM_ROLE_TEMPLATES: readonly PlatformRoleTemplate[] = Object.freeze([
  {
    systemKey: SUPER_ADMIN_ROLE,
    name: "Super Admin",
    description: "Everything, including staff management and approving dangerous actions",
    permissions: "all",
  },
  {
    systemKey: "operations",
    name: "Operations",
    description: "Applications, tenant lifecycle, branches, data operations",
    permissions: [
      "platform.dashboard.view",
      "platform.health.view",
      ...keysWithPrefix(
        "platform.applications.",
        "platform.tenants.",
        "platform.branches.",
        "platform.data.",
      ),
      "platform.billing.view",
      "platform.billing.extensions.grant",
      "platform.users.search",
      "platform.approvals.approve",
    ],
  },
  {
    systemKey: "support",
    name: "Support",
    description: "Find tenants and users, reset access, read-only support access",
    permissions: [
      "platform.dashboard.view",
      "platform.tenants.view",
      "platform.tenants.notes",
      "platform.branches.view",
      "platform.users.search",
      "platform.users.reset_access",
      "platform.support.access_tenant",
      "platform.support.announcements.manage",
      "platform.applications.view",
    ],
  },
  {
    systemKey: "billing",
    name: "Billing / Finance",
    description: "Plans, invoices, payments, refunds, extensions",
    permissions: [
      "platform.dashboard.view",
      "platform.tenants.view",
      ...keysWithPrefix("platform.billing."),
    ],
  },
  {
    systemKey: "sales",
    name: "Sales / Onboarding",
    description: "Signup queue, trials, tenant health, partners — no destructive actions",
    permissions: [
      "platform.dashboard.view",
      "platform.applications.view",
      "platform.applications.create_assisted",
      "platform.tenants.view",
      "platform.tenants.notes",
      "platform.partners.manage",
      "platform.analytics.view",
    ],
  },
  {
    systemKey: "engineering",
    name: "Engineering / On-call",
    description: "Health, jobs, flags and diagnostics; no tenant business data",
    permissions: [
      "platform.dashboard.view",
      "platform.health.view",
      "platform.alerts.manage",
      "platform.flags.manage",
      "platform.data.backups.view",
      "platform.data.migrations.view",
      "platform.data.migrations.run",
      "platform.data.jobs.manage",
    ],
  },
  {
    systemKey: "auditor",
    name: "Auditor (read-only)",
    description: "Audit log, access reviews and reports",
    permissions: [
      "platform.dashboard.view",
      "platform.security.audit.view",
      "platform.security.access_review.view",
      "platform.staff.view",
      "platform.analytics.view",
    ],
  },
]);
