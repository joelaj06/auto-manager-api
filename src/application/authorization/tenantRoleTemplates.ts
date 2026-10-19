import {
  PERMISSION_CATALOG,
  type PermissionKey,
  type PermissionScope,
} from "./permissionCatalog.js";

/**
 * System roles seeded into every tenant and kept in sync by releases (docs/28 §6). Tenants cannot
 * edit them, only clone them into custom roles. Roles for modules that do not exist yet (Rental
 * Agent, Cashier, Driver, …) are added together with those modules' permissions.
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
/** Day-to-day vehicle work (no removal, no cost figures). */
const VEHICLE_OPERATIONS: readonly PermissionKey[] = [
  "vehicles.list",
  "vehicles.view",
  "vehicles.create",
  "vehicles.update",
  "vehicles.change_status",
  "vehicles.assign_driver",
  "vehicles.import",
  "vehicles.export",
  "vehicles.documents.view",
  "vehicles.documents.manage",
  "vehicles.odometer.record",
  "vehicles.photos.manage",
];
/** Day-to-day driver work (no removal, termination or identity documents). */
const DRIVER_OPERATIONS: readonly PermissionKey[] = [
  "drivers.list",
  "drivers.view",
  "drivers.create",
  "drivers.update",
  "drivers.suspend",
];
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
      ...VEHICLE_OPERATIONS,
      "vehicles.delete",
      "vehicles.financials.view",
      ...DRIVER_OPERATIONS,
      "drivers.delete",
      "drivers.terminate",
      "drivers.documents.view",
      "customers.list",
      "customers.view",
      "suppliers.list",
      "suppliers.view",
    ]),
  },
  {
    systemKey: "fleet_officer",
    name: "Fleet Officer",
    description: "Vehicles, their documents, odometer and status in their branches",
    grants: branch([
      "branches.list",
      "branches.view",
      "settings.view",
      ...VEHICLE_OPERATIONS,
      ...DRIVER_OPERATIONS,
      "suppliers.list",
      "suppliers.view",
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
      "vehicles.list",
      "vehicles.view",
      "vehicles.export",
      "vehicles.documents.view",
      "vehicles.financials.view",
      "customers.list",
      "customers.view",
      "customers.update",
      "suppliers.list",
      "suppliers.view",
      "suppliers.create",
      "suppliers.update",
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
