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
  /** Self-service for a persona (the driver app): only its own role holds it, not staff roles. */
  selfService?: boolean;
}>;

const ALL: readonly PermissionScope[] = ["all"];
const OWN: readonly PermissionScope[] = ["own"];
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
    description: "Set up the SMS provider, quiet hours and notification rules",
    scopes: ALL,
    sensitive: true,
  },
  "settings.mobile.connect": { description: "Show the mobile-app connect QR code", scopes: ALL },
  // --- finance (record only, decision 16) ---
  "finance.invoices.view": { description: "View invoices", scopes: BRANCH_OR_ALL },
  "finance.invoices.manage": {
    description: "Draft, edit and issue invoices",
    scopes: BRANCH_OR_ALL,
  },
  "finance.invoices.void": {
    description: "Void issued invoices",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "finance.payments.view": { description: "View payments and receipts", scopes: BRANCH_OR_ALL },
  "finance.payments.record": {
    description: "Record payments received and made, and allocate them",
    scopes: BRANCH_OR_ALL,
  },
  "finance.payments.reverse": {
    description: "Reverse payments and release allocations",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "finance.cash_sessions.manage": {
    description: "Open and close your own cash session",
    scopes: BRANCH_OR_ALL,
  },
  "finance.cash_sessions.view": {
    description: "See every cash session and close others' sessions",
    scopes: BRANCH_OR_ALL,
  },
  "finance.ledger.view": {
    description: "See the ledger, trial balance and party accounts",
    scopes: ALL,
    sensitive: true,
  },
  "finance.accounts.manage": { description: "Add ledger accounts", scopes: ALL },
  "finance.period.lock": {
    description: "Lock and unlock accounting periods",
    scopes: ALL,
    sensitive: true,
  },
  "finance.settings.manage": { description: "Edit finance settings", scopes: ALL },
  // --- finance and expense reference data ---
  "finance.fx_rates.view": { description: "View exchange rates", scopes: ALL },
  "finance.fx_rates.manage": { description: "Enter and remove exchange rates", scopes: ALL },
  "expenses.list": {
    description: "List expenses (own: only those you entered)",
    scopes: ["own", "branch", "all"],
  },
  "expenses.view": {
    description: "Open expenses with receipts (own: only those you entered)",
    scopes: ["own", "branch", "all"],
  },
  "expenses.create": {
    description: "Enter, correct and submit expenses",
    scopes: BRANCH_OR_ALL,
  },
  "expenses.approve": {
    description: "Approve or reject expenses (up to the role's max_amount_minor limit)",
    scopes: BRANCH_OR_ALL,
  },
  "expenses.pay": { description: "Pay approved expenses", scopes: BRANCH_OR_ALL },
  "expenses.void": {
    description: "Void unpaid expenses",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "expenses.fuel.record": { description: "Record fuel fills", scopes: BRANCH_OR_ALL },
  "expenses.rules.manage": { description: "Set expense approval rules", scopes: ALL },
  "expenses.recurring.manage": { description: "Set up recurring expenses", scopes: ALL },
  "expenses.budgets.view": { description: "See budgets and spending against them", scopes: ALL },
  "expenses.budgets.manage": { description: "Set budgets", scopes: ALL },
  "expenses.categories.manage": {
    description: "Create, rename and deactivate expense categories",
    scopes: ALL,
  },

  // --- vehicles ---
  "vehicles.list": { description: "List vehicles", scopes: BRANCH_OR_ALL },
  "vehicles.view": {
    description: "Open a vehicle, its photos and timeline",
    scopes: BRANCH_OR_ALL,
  },
  "vehicles.create": { description: "Register vehicles", scopes: BRANCH_OR_ALL },
  "vehicles.update": {
    description: "Edit vehicles, move them between branches and groups",
    scopes: BRANCH_OR_ALL,
  },
  "vehicles.delete": { description: "Remove mistaken vehicle entries", scopes: BRANCH_OR_ALL },
  "vehicles.change_status": {
    description: "Change a vehicle's status by hand",
    scopes: BRANCH_OR_ALL,
  },
  "vehicles.assign_driver": {
    description: "Assign drivers to vehicles, hand over and end assignments",
    scopes: BRANCH_OR_ALL,
  },
  "vehicles.import": { description: "Import vehicles from CSV", scopes: BRANCH_OR_ALL },
  "vehicles.export": { description: "Export the vehicle register", scopes: BRANCH_OR_ALL },
  "vehicles.documents.view": {
    description: "View vehicle documents and compliance",
    scopes: BRANCH_OR_ALL,
  },
  "vehicles.documents.manage": {
    description: "Add, renew and remove vehicle documents",
    scopes: BRANCH_OR_ALL,
  },
  "vehicles.odometer.record": { description: "Record odometer readings", scopes: BRANCH_OR_ALL },
  "vehicles.photos.manage": {
    description: "Upload and remove vehicle photos",
    scopes: BRANCH_OR_ALL,
  },
  "vehicles.financials.view": {
    description: "See and edit vehicle cost, residual and book value",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "vehicles.groups.manage": {
    description: "Create, rename and delete vehicle groups",
    scopes: ALL,
  },
  "vehicles.issues.view": {
    description: "See issues reported on vehicles (breakdowns, accidents …)",
    scopes: BRANCH_OR_ALL,
  },
  "vehicles.issues.manage": {
    description: "Log, acknowledge and resolve vehicle issues",
    scopes: BRANCH_OR_ALL,
  },
  "vehicles.damages.manage": {
    description:
      "Record vehicle damages, settle who pays (charging renters), and mark them repaired",
    scopes: BRANCH_OR_ALL,
  },
  "settings.vehicles.manage": {
    description: "Edit vehicle settings (required documents, custom fields)",
    scopes: ALL,
  },

  // --- parties (drivers belong to a branch; customers and suppliers to the whole business) ---
  "drivers.list": { description: "List drivers", scopes: BRANCH_OR_ALL },
  "drivers.view": { description: "Open a driver with their guarantors", scopes: BRANCH_OR_ALL },
  "drivers.create": { description: "Register drivers", scopes: BRANCH_OR_ALL },
  "drivers.update": {
    description: "Edit drivers, guarantors and documents; activate and rehire",
    scopes: BRANCH_OR_ALL,
  },
  "drivers.delete": { description: "Remove mistaken driver entries", scopes: BRANCH_OR_ALL },
  "drivers.suspend": { description: "Suspend and reinstate drivers", scopes: BRANCH_OR_ALL },
  "drivers.terminate": { description: "Terminate drivers", scopes: BRANCH_OR_ALL },
  "drivers.documents.view": {
    description: "See drivers' and guarantors' identity documents and Ghana Card numbers",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "drivers.app_access.manage": {
    description: "Give drivers a driver-app login and take it away",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "driver_app.use": {
    description:
      "Use the driver app: own vehicle, ledger, remittances, fuel and issue reports (the Driver role)",
    scopes: OWN,
    selfService: true,
  },
  "drivers.ledger.view": {
    description: "See drivers' ledgers, statements and shortfalls",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "drivers.ledger.adjust": {
    description: "Charge drivers (deductions) or credit them (bonuses)",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  // --- remittances (docs/09) ---
  "remittances.list": { description: "List remittances", scopes: BRANCH_OR_ALL },
  "remittances.view": {
    description: "Open a remittance with its submissions",
    scopes: BRANCH_OR_ALL,
  },
  "remittances.submit": {
    description: "Declare what a driver paid (for approval)",
    scopes: BRANCH_OR_ALL,
  },
  "remittances.record": {
    description: "Record remittance money received directly",
    scopes: BRANCH_OR_ALL,
  },
  "remittances.approve": {
    description: "Confirm or reject declared remittances",
    scopes: BRANCH_OR_ALL,
  },
  "remittances.waive": {
    description: "Waive remittance shortfalls",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "operations.board.view": {
    description: "See the daily operations board",
    scopes: BRANCH_OR_ALL,
  },
  // --- notifications (docs/15) ---
  "notifications.deliveries.view": {
    description: "See the log of SMS, push and email notifications sent",
    scopes: ALL,
  },
  // --- work & pay (docs/08) ---
  "workpay.view": {
    description: "See work and pay agreements, their schedules and guarantors",
    scopes: BRANCH_OR_ALL,
  },
  "workpay.create": {
    description: "Draft work and pay agreements and send them for signature",
    scopes: BRANCH_OR_ALL,
  },
  "workpay.activate": {
    description: "Start signed agreements (hand the vehicle over) and cancel unstarted ones",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "workpay.payment.record": {
    description: "Record work and pay deposits and instalments",
    scopes: BRANCH_OR_ALL,
  },
  "workpay.penalty.waive": {
    description: "Waive work and pay late fees and instalments",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "workpay.restructure": {
    description:
      "Give payment holidays, restructure schedules, take the vehicle off the road and quote special settlement discounts",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "workpay.terminate": {
    description: "Terminate agreements and repossess vehicles, with the settlement figures",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "workpay.transfer.manage": {
    description:
      "Correct transfer letters of paid-up agreements and track the DVLA change of ownership",
    scopes: BRANCH_OR_ALL,
  },
  "workpay.settings.manage": {
    description: "Change work and pay defaults (frequency, grace, rounding, deposit rule)",
    scopes: ALL,
  },
  // --- rentals (docs/07) ---
  "rentals.view": {
    description:
      "See rental classes, rate plans and extras, availability and the rental calendar, and price rentals",
    scopes: BRANCH_OR_ALL,
  },
  "rentals.create": {
    description: "Book and hold vehicles for customers and move class bookings between vehicles",
    scopes: BRANCH_OR_ALL,
  },
  "rentals.update": {
    description: "Change, confirm, extend and close rental bookings",
    scopes: BRANCH_OR_ALL,
  },
  "rentals.checkout": {
    description: "Hand rental vehicles over to customers (check-out)",
    scopes: BRANCH_OR_ALL,
  },
  "rentals.checkin": {
    description: "Take rental vehicles back (check-in) with their odometer and fuel",
    scopes: BRANCH_OR_ALL,
  },
  "rentals.cancel": {
    description: "Cancel rental bookings and mark no-shows (policy fees apply)",
    scopes: BRANCH_OR_ALL,
  },
  "rentals.payments.record": {
    description:
      "Take rental payments and security deposits, apply deposits to invoices and return them",
    scopes: BRANCH_OR_ALL,
  },
  "rentals.discount.apply": {
    description:
      "Give rental discounts, up to the role's max_percent (or the rental settings' maximum)",
    scopes: BRANCH_OR_ALL,
  },
  "rentals.price.override": {
    description: "Agree a rental price other than the rates, and discounts beyond the limit",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "rentals.rate_plans.manage": {
    description:
      "Manage vehicle classes, rate plans and seasons, extras, zones, promo codes, holidays and rental pricing settings",
    scopes: ALL,
  },
  // --- documents (docs/24) ---
  "documents.list": { description: "List issued documents", scopes: BRANCH_OR_ALL },
  "documents.view": {
    description: "Open and download issued documents",
    scopes: BRANCH_OR_ALL,
  },
  "documents.issue": {
    description: "Issue documents (handover notes, agreements …)",
    scopes: BRANCH_OR_ALL,
  },
  "documents.attach_paper": {
    description: "Record signatures made on paper by attaching the signed scan",
    scopes: BRANCH_OR_ALL,
  },
  "documents.void": {
    description: "Void issued documents",
    scopes: BRANCH_OR_ALL,
    sensitive: true,
  },
  "documents.templates.view": { description: "See document templates", scopes: ALL },
  "documents.templates.manage": {
    description: "Edit document templates and put versions in use (locked clauses stay)",
    scopes: ALL,
    sensitive: true,
  },
  // --- dashboards (docs/14) ---
  "dashboards.overview.view": {
    description: "See the business overview: revenue, costs and cash collected",
    scopes: BRANCH_OR_ALL,
  },
  "dashboards.vehicles.view": {
    description: "See vehicle profit and loss and utilisation",
    scopes: BRANCH_OR_ALL,
  },
  "dashboards.remittances.view": {
    description: "See the remittance collection dashboard",
    scopes: BRANCH_OR_ALL,
  },
  "dashboards.expenses.view": {
    description: "See the expense dashboard",
    scopes: BRANCH_OR_ALL,
  },
  "dashboards.workpay.view": {
    description:
      "See the work and pay portfolio: collections, arrears (PAR), ageing and the collections forecast",
    scopes: BRANCH_OR_ALL,
  },
  "dashboards.stats.rebuild": {
    description: "Rebuild the vehicle statistics behind the dashboards",
    scopes: ALL,
  },
  "customers.list": { description: "List customers", scopes: ALL },
  "customers.view": { description: "Open a customer", scopes: ALL },
  "customers.create": { description: "Register customers", scopes: ALL },
  "customers.update": { description: "Edit customers and their documents", scopes: ALL },
  "customers.delete": { description: "Remove mistaken customer entries", scopes: ALL },
  "customers.blacklist": {
    description: "Put customers on watch, blacklist or clear them",
    scopes: ALL,
  },
  "customers.id_documents.view": {
    description: "See customers' identity documents and Ghana Card numbers",
    scopes: ALL,
    sensitive: true,
  },
  "suppliers.list": { description: "List suppliers", scopes: ALL },
  "suppliers.view": { description: "Open a supplier", scopes: ALL },
  "suppliers.create": { description: "Add suppliers", scopes: ALL },
  "suppliers.update": { description: "Edit and deactivate suppliers", scopes: ALL },
  "suppliers.delete": { description: "Remove mistaken supplier entries", scopes: ALL },

  "data.export": {
    description: "Export all the business's data (a zip emailed as a link)",
    scopes: ALL,
    sensitive: true,
  },
  "legal.accept": {
    description: "Accept new terms and privacy policy for the business",
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

/** Permissions of a persona's own role (the driver app), never held by staff roles or the owner. */
export const SELF_SERVICE_PERMISSIONS: readonly PermissionKey[] = Object.freeze(
  (Object.keys(PERMISSION_CATALOG) as PermissionKey[]).filter(
    (key) => PERMISSION_CATALOG[key].selfService === true,
  ),
);
