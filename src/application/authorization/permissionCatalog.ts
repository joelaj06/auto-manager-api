/**
 * The permission catalogue (docs/28_tenant_roles_permissions_and_seeding.md §7): the single source
 * of truth for every tenant permission. Routes must declare a key from here (enforced by the
 * type of ApiRoute.access and by a test), and the catalogue is published to the platform DB and
 * seeded into tenant databases at provisioning (P1-3).
 *
 * Key format: `<module>.<resource>.<action>` or `<module>.<action>`, lowercase.
 * Modules add their permissions here as they are built.
 */
export type PermissionScope = "own" | "branch" | "all";

export type PermissionDefinition = Readonly<{
  description: string;
  /** Scopes a grant of this permission may use. */
  scopes: readonly PermissionScope[];
  /** Sensitive permissions are never copied into cloned roles by default. */
  sensitive?: boolean;
}>;

const ALL: readonly PermissionScope[] = ["all"];
const BRANCH_OR_ALL: readonly PermissionScope[] = ["branch", "all"];

const definitions = {
  // --- identity ---
  "users.list": { description: "List users", scopes: BRANCH_OR_ALL },
  "users.view": { description: "View a user", scopes: BRANCH_OR_ALL },
  "users.invite": { description: "Invite users", scopes: BRANCH_OR_ALL },
  "users.update": { description: "Edit users", scopes: BRANCH_OR_ALL },
  "users.disable": { description: "Disable or re-enable users", scopes: BRANCH_OR_ALL },
  "users.reset_password": { description: "Send password reset to a user", scopes: BRANCH_OR_ALL },
  "roles.list": { description: "List roles", scopes: ALL },
  "roles.view": { description: "View a role and its permissions", scopes: ALL },
  "roles.create": { description: "Create custom roles", scopes: ALL },
  "roles.update": { description: "Edit custom roles", scopes: ALL },
  "roles.delete": { description: "Delete custom roles", scopes: ALL },
  "roles.assign": { description: "Assign roles to users", scopes: BRANCH_OR_ALL },
  "permissions.list": { description: "List the permission catalogue", scopes: ALL },
  "sessions.revoke": { description: "Sign other users out", scopes: BRANCH_OR_ALL },
  "audit.view": { description: "View the audit log", scopes: ALL, sensitive: true },

  // --- organisation ---
  "organisation.view": { description: "View business profile", scopes: ALL },
  "organisation.update": { description: "Edit business profile", scopes: ALL },
  "branches.list": { description: "List branches", scopes: BRANCH_OR_ALL },
  "branches.view": { description: "View a branch", scopes: BRANCH_OR_ALL },
  "branches.create": { description: "Create branches", scopes: ALL },
  "branches.update": { description: "Edit branches", scopes: BRANCH_OR_ALL },
  "branches.deactivate": { description: "Deactivate or reactivate branches", scopes: ALL },
  "settings.view": { description: "View settings", scopes: ALL },
  "settings.update": { description: "Edit general settings", scopes: ALL },
  "settings.numbering.manage": { description: "Edit document numbering", scopes: ALL },
  "settings.currency.manage": { description: "Edit currency settings", scopes: ALL },
  "settings.tax.manage": { description: "Edit tax settings", scopes: ALL, sensitive: true },
  "settings.notifications.manage": {
    description: "Edit SMS/email provider settings",
    scopes: ALL,
    sensitive: true,
  },
  "settings.mobile.connect": { description: "Show the mobile-app connect QR code", scopes: ALL },
  // --- finance and expense reference data ---
  "finance.fx_rates.view": { description: "View exchange rates", scopes: ALL },
  "finance.fx_rates.manage": { description: "Enter and remove exchange rates", scopes: ALL },
  "expenses.categories.manage": {
    description: "Create, rename and deactivate expense categories",
    scopes: ALL,
  },

  "billing.view": { description: "View subscription and invoices", scopes: ALL },
  "billing.manage": {
    description: "Pay, change plan, request extensions",
    scopes: ALL,
    sensitive: true,
  },
} as const satisfies Record<string, PermissionDefinition>;

export type PermissionKey = keyof typeof definitions;

export const PERMISSION_CATALOG: Readonly<Record<PermissionKey, PermissionDefinition>> =
  Object.freeze(definitions);

export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && Object.hasOwn(PERMISSION_CATALOG, value);
}
