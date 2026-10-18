import {
  PERMISSION_CATALOG,
  type PermissionKey,
  type PermissionScope,
} from "./permissionCatalog.js";

/**
 * System roles seeded into every tenant and kept in sync by releases (docs/28 §6). Tenants cannot
 * edit them, only clone them into custom roles. Roles for modules that do not exist yet (Fleet
 * Officer, Rental Agent, Driver, …) are added together with those modules' permissions.
 */
export type TenantRoleTemplate = Readonly<{
  systemKey: string;
  name: string;
  description: string;
  grants: readonly Readonly<{ key: PermissionKey; scope: PermissionScope }>[];
}>;

const KEYS = Object.keys(PERMISSION_CATALOG) as PermissionKey[];
const widest = (key: PermissionKey): PermissionScope => {
  const scopes = PERMISSION_CATALOG[key].scopes;
  return scopes.includes("all") ? "all" : scopes.includes("branch") ? "branch" : "own";
};
const all = (keys: readonly PermissionKey[]) => keys.map((key) => ({ key, scope: widest(key) }));
const branch = (keys: readonly PermissionKey[]) =>
  keys.map((key) => ({
    key,
    scope: PERMISSION_CATALOG[key].scopes.includes("branch") ? ("branch" as const) : widest(key),
  }));
const readOnly = KEYS.filter((key) => /\.(list|view)$/.test(key));

export const OWNER_ROLE = "owner";

export const TENANT_ROLE_TEMPLATES: readonly TenantRoleTemplate[] = Object.freeze([
  {
    systemKey: OWNER_ROLE,
    name: "Owner",
    description: "Full control, including billing; at least one owner always exists",
    grants: all(KEYS),
  },
  {
    systemKey: "administrator",
    name: "Administrator",
    description: "Everything except billing changes",
    grants: all(KEYS.filter((key) => key !== "billing.manage")),
  },
  {
    systemKey: "branch_manager",
    name: "Branch Manager",
    description: "Runs one or more branches: their people and settings",
    grants: branch([
      "users.list",
      "users.view",
      "users.invite",
      "users.update",
      "users.disable",
      "users.reset_password",
      "roles.list",
      "roles.view",
      "roles.assign",
      "sessions.revoke",
      "branches.list",
      "branches.view",
      "branches.update",
      "organisation.view",
      "settings.view",
    ]),
  },
  {
    systemKey: "accountant",
    name: "Accountant",
    description: "Billing, tax and currency settings, reports",
    grants: all([
      "organisation.view",
      "branches.list",
      "branches.view",
      "settings.view",
      "settings.tax.manage",
      "settings.currency.manage",
      "finance.fx_rates.view",
      "finance.fx_rates.manage",
      "expenses.categories.manage",
      "billing.view",
    ]),
  },
  {
    systemKey: "auditor",
    name: "Auditor (read-only)",
    description: "Views everything and the audit log; changes nothing",
    grants: all([...new Set<PermissionKey>([...readOnly, "audit.view"])]),
  },
]);
