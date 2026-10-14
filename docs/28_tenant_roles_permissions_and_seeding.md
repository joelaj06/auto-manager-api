# 28 — Tenant Roles, Permissions & Seeding

Requirement: **tenants can define roles with permissions for their users, and permissions are seeded from the database when a tenant is created.** This doc replaces the permission/role mechanics in doc 16 §2 (RBAC) and extends them. Platform staff roles use the same mechanism (§12).

## 1. Today (for reference)

- Permissions are string constants in `utils/constants/permissions.ts` (`create:role`, `view:vehicles`, typo `view:vehi-cle`, …) and a `Permission` collection holds names.
- A `Role` holds `permissions: string[]`; the whole role is copied into the JWT (stale for 30 days).
- Provisioning seeds all permission names and one "Admin" role.
- Roles have no scope, no limits, no system/custom distinction, no branch dimension.

## 2. Model overview

```
platform DB (authoritative, versioned)               tenant DB (per tenant, seeded + synced)
 permission_catalog  ──copied at provisioning──▶  permissions
 role_templates (+ permissions)  ───────────────▶ roles (is_system = true, locked)
                                                   roles (is_system = false, tenant-created "custom")
                                                   role_permissions (role, permission, scope)
                                                   user_roles (user, role, branch)
```

- **Permission** = one capability, e.g. `rentals.bookings.checkout`.
- **Role** = named set of permissions (+ scope per permission + numeric limits).
- **Assignment** = user ↔ role, optionally limited to a **branch**.
- **System roles** come from platform templates, are read-only and updated by releases. **Custom roles** are created and owned by the tenant.

## 3. Permission registry (single source of truth)

### 3.1 Definition
Permissions are declared once in code (`modules/*/permissions.ts`) in a typed manifest, e.g.

```ts
definePermission({
  key: "rentals.bookings.checkout",
  module: "rentals", resource: "bookings", action: "checkout",
  description: "Hand over a vehicle to a customer",
  scopes: ["own", "branch", "all"],        // which scopes make sense
  sensitive: false,
  dependsOn: ["rentals.bookings.view"],
  feature: "rentals",                       // entitlement needed (doc 04 §9)
  since: "1.0.0",
});
```

A build step compiles all manifests into one **catalogue release** (JSON + version number) which is:
1. checked in CI (every route handler must reference a permission that exists in the manifest; no unused or duplicate keys),
2. loaded into `platform.permission_catalog` by a deploy migration (version N).

The platform DB is the **database source** that tenant provisioning reads from.

### 3.2 Platform tables

| Table | Columns |
|---|---|
| `permission_catalog` | key (pk), module, resource, action, description, scopes[], sensitive, depends_on[], feature_key, since_version, deprecated_in, replaced_by, sort_order |
| `catalogue_versions` | version, released_at, notes, diff jsonb |
| `role_templates` | system_key (`owner`, `administrator`, `branch_manager`, …), name, description, locked, version |
| `role_template_permissions` | template, permission_key, scope, limits jsonb |

### 3.3 Tenant tables

| Table | Columns |
|---|---|
| `permissions` | key (pk), module, resource, action, description, scopes[], sensitive, depends_on[], feature_key, deprecated, catalogue_version |
| `roles` | id, name, description, **is_system**, system_key, locked, based_on_role_id, limits jsonb, perm_version int, created_by, created_at, deleted_at |
| `role_permissions` | role_id, permission_key (fk), scope (`own`/`branch`/`all`), unique(role_id, permission_key) |
| `user_roles` | user_id, role_id, **branch_id nullable** (null = all branches the user belongs to), assigned_by, assigned_at |
| `tenant_settings.catalogue_version` | which catalogue version this tenant has |
| `permission_notices` | permission_key, seen_by_owner_at — "new permissions available" |

## 4. Seeding when a tenant is created

Part of the provisioning saga (doc 22 §2.6), after the tenant DB exists and is migrated:

```
step: seed_permissions_and_roles  (single transaction in the new tenant DB)
  1. read platform.permission_catalog (current version V)           ← "seeded from db"
  2. INSERT into tenant.permissions (all rows, filtered by nothing; feature gating is evaluated at runtime)
  3. read platform.role_templates + role_template_permissions
  4. INSERT tenant.roles (is_system=true, locked=true, system_key=…) and role_permissions
  5. store tenant_settings.catalogue_version = V
  6. create the owner user and assign role `owner` (branch_id null)
  7. verify: every role_permission key exists in permissions; owner has all permissions; exactly one owner exists
```

Properties:
- **Idempotent** (upserts keyed by `key` / `system_key`) so a retried provisioning is safe.
- The platform DB is read through a narrow service, not by the tenant app role.
- Seeding is deterministic from catalogue version V; the version is recorded for later sync.

## 5. Keeping tenants in sync when the catalogue changes

On a release that adds/changes permissions:

1. New `catalogue_versions` row + changes in `permission_catalog` / `role_templates`.
2. A **catalogue sync job** (rides on the migration fan-out, doc 22 §2.5) runs per tenant:
   - upsert new permissions into `permissions`;
   - mark removed ones `deprecated` (never hard-delete while referenced); optional `replaced_by` mapping automatically translates grants;
   - update **system roles** (locked) to match templates;
   - **do not touch custom roles**;
   - bump `perm_version` on affected roles; invalidate permission caches;
   - write `permission_notices` for the owner: "3 new permissions are available for custom roles: …".
3. Console shows sync status per tenant (doc 27 §3.10) and retries failures.
4. The app refuses to evaluate a permission key the tenant DB doesn't know (fails closed) and the tenant is marked "catalogue behind" until synced.

## 6. System roles (templates, proposal)

| Role | Purpose | Scope default |
|---|---|---|
| **Owner** | Full control, billing, can't be removed; at least one always exists | all |
| **Administrator** | Everything except billing/ownership transfer | all |
| **Branch Manager** | Runs one or more branches: fleet, drivers, rentals, expenses approval, reports | branch |
| **Fleet Officer** | Vehicles, assignments, documents, maintenance, remittances | branch |
| **Rental Agent** | Customers, bookings, check-out/in, receipts | branch |
| **Sales Executive** (dealer) | Leads, quotes, deals | own / branch |
| **Accountant** | Payments recording, invoices, expenses, ledger, reports, tax | all |
| **Cashier** | Record payments, cash sessions, receipts | branch |
| **Mechanic / Workshop** | Work orders, parts | branch |
| **Driver** | Own vehicle, own ledger/agreement, submit remittance, fuel, issues | own |
| **Auditor (read-only)** | View everything, export, no changes | all |

Tenants **clone** a system role to customise ("Create role from template"), or build from scratch.

## 7. Permission catalogue (proposal)

Key format `module.resource.action`. `view` is split into `list` (see lists) and `view` (open a record) only where useful. Sensitive ones are marked ⚠.

| Module | Permissions |
|---|---|
| **identity** | `users.list|view|create|invite|update|disable|delete`, `users.reset_password`, `roles.list|view|create|update|delete`, `roles.assign`, `permissions.list`, `sessions.revoke`, `audit.view` ⚠ |
| **organisation** | `organisation.view|update`, `branches.list|view|create|update|deactivate`, `settings.view|update`, `settings.numbering.manage`, `settings.currency.manage`, `settings.tax.manage` ⚠, `settings.notifications.manage` ⚠, `settings.mobile.connect`, `billing.view`, `billing.manage` ⚠ |
| **vehicles** | `vehicles.list|view|create|update|delete|import|export`, `vehicles.change_status`, `vehicles.assign_driver`, `vehicles.documents.view|manage`, `vehicles.odometer.record`, `vehicles.photos.manage`, `vehicles.financials.view` ⚠ (cost, book value, profit), `vehicles.incidents.manage`, `vehicles.groups.manage` |
| **parties** | `customers.list|view|create|update|delete|blacklist`, `customers.id_documents.view` ⚠, `drivers.list|view|create|update|delete|suspend|terminate`, `drivers.documents.view` ⚠, `drivers.ledger.view|adjust` ⚠, `suppliers.list|view|create|update|delete` |
| **remittances** | `remittances.list|view|submit|record|approve|reject|delete`, `remittances.targets.manage` |
| **workpay** | `workpay.list|view|simulate|create|activate|restructure|terminate|repossess|complete`, `workpay.payments.record`, `workpay.penalties.waive` ⚠, `workpay.settings.manage`, `workpay.statements.view` |
| **rentals** | `rentals.bookings.list|view|create|update|confirm|cancel`, `rentals.bookings.checkout|checkin|close|extend`, `rentals.discount.apply` (limit), `rentals.price.override` ⚠, `rentals.deposit.release` ⚠, `rentals.rate_plans.manage`, `rentals.classes.manage`, `rentals.extras.manage`, `rentals.damages.manage`, `rentals.calendar.view` |
| **dealership** | `dealer.stock.list|view|create|update|list_for_sale|withdraw|transfer`, `dealer.stock.cost.view` ⚠, `dealer.stock.price.manage` ⚠, `dealer.leads.list_own|list_all|create|update|assign`, `dealer.testdrives.manage`, `dealer.quotes.manage`, `dealer.deals.create|update|discount|approve|deliver|cancel`, `dealer.appraisals.manage`, `dealer.commissions.view|manage` ⚠ |
| **purchasing** | `purchases.list|view|create|update|approve|cancel|receive`, `purchases.costs.manage`, `purchases.import_tracking.manage` |
| **maintenance** | `maintenance.plans.manage`, `maintenance.due.view`, `workorders.list|view|create|update|complete|cancel`, `workorders.costs.view`, `parts.list|manage`, `fuel.logs.record|view`, `vendors.manage` |
| **expenses** | `expenses.list_own|list_branch|list_all`, `expenses.create|update|delete|submit`, `expenses.approve` (limit) ⚠, `expenses.pay`, `expenses.split`, `expense_categories.manage`, `budgets.manage` |
| **finance** | `payments.record`, `payments.reverse` ⚠, `payments.list|view`, `invoices.list|view|create|issue|void`, `receipts.view|reprint`, `cash_sessions.open|close|view_all`, `ledger.view` ⚠, `fx_rates.manage`, `finance.export` ⚠, `finance.periods.lock` ⚠, `reconcile.manage` |
| **documents** | `documents.list|view|create|send|sign|void|attach_paper`, `documents.templates.manage` ⚠ |
| **reports** | `reports.list`, `reports.run.<group>` (`fleet`, `finance`, `rentals`, `workpay`, `dealer`, `maintenance`), `reports.export`, `reports.schedule`, `dashboard.view.<tile-group>` |
| **notifications** | `notifications.rules.manage`, `notifications.templates.manage`, `notifications.log.view` |
| **data** | `data.export` ⚠, `data.import`, `files.upload|delete` |

(The final list is produced as the modules are built. New modules must add their manifest.)

## 8. Rules & invariants

1. **Owner invariant**: at least one active user holds `owner`; the owner role can't be edited or deleted; transfer of ownership is an explicit, audited, step-up action.
2. **No privilege escalation**: a user can only grant permissions and scopes they themselves hold; can't edit a role that has permissions they lack; can't assign `owner`.
3. **Cannot edit own role/assignments** (except Owner).
4. **Dependencies**: enabling a permission auto-adds `dependsOn` (shown in the UI); removing a dependency warns what breaks.
5. **Feature gating**: a permission whose `feature` is not in the tenant's entitlements is shown disabled ("Upgrade to unlock") and ignored at runtime even if granted.
6. **Scope**: each grant is `own | branch | all` and applies to **row-level visibility** (doc 16 §2.2). Repositories apply the policy filter centrally, so forgotten filters in controllers can't leak data.
7. **Branch-aware assignments**: a user may be *Branch Manager at Kumasi* and *Rental Agent at Accra* — two `user_roles` rows with different `branch_id`. Effective permission = union over assignments, evaluated against the record's branch.
8. **Limits** (per role): e.g. `{ "rentals.discount.max_percent": 10, "expenses.approve.max_amount_minor": 50000, "workpay.penalties.waive.max_minor": 20000 }` with currency = tenant base. Enforced in use-cases; exceeding requires a higher-limit approver (approval workflow).
9. **Sensitive permissions** (⚠) are never included in cloned roles by default and require explicit tick plus a confirmation; changes are audited and notify the Owner.
10. **Role deletion** requires reassigning its users (or blocks if in use); system roles can't be deleted.
11. **Deprecation**: removed permissions remain until no role references them; the sync translates via `replaced_by`.
12. **Disabled user** loses all access immediately (session revocation + cache bust).
13. **Driver/customer portal roles** are fixed system roles with `own` scope; tenants can't widen them beyond what the catalogue allows for `own`.
14. **Branch deactivation** (doc 27 §3.5): `user_roles` rows pointing at a deactivated branch grant nothing. A user with no active branch assignments (and no `all`-branch grant) is blocked with a clear message; effective permissions never include inactive branches. **Tenant deactivation** blocks everyone regardless of roles.

## 9. Evaluation at runtime

- The access token carries only `sub`, `tid`, `sid`, and `ver` (permission version). **No permission list in the JWT.**
- Middleware loads the effective permission set from Redis (`perm:{tenantId}:{userId}`) built from `user_roles` ⨝ `role_permissions`, rebuilt when `perm_version` changes (role edit, assignment change, catalogue sync, user disabled).
- Check function:

```ts
authorize(user, "rentals.bookings.checkout", { branchId, ownerId }) →
  { allowed: boolean, scope: "own"|"branch"|"all", limits }
```
- Route declaration: `route.post("/rentals/:id/checkout", requires("rentals.bookings.checkout"), handler)`. Repository policy filters receive the resolved scope for list endpoints.
- `GET /me/permissions` returns effective permissions with scopes/limits and feature flags so web/mobile can show/hide UI.
- Fail closed: unknown permission, missing tenant catalogue, or cache failure → deny (and log).

## 10. Tenant UX (for the web portal and API design)

- **Roles page**: list (system vs custom, user counts), create from template/clone/scratch.
- **Permission picker**: grouped by module → resource, search, "select all in module", scope selector per row, dependency hints, ⚠ markers, plan-locked items greyed.
- **Compare roles**, **role diff** before saving, **"who has this permission?"** report, **effective access** view for a user (and why).
- **Invite user** → choose role(s) and branch(es).
- **New permissions available** banner for Owner after a release (§5).
- Templates/presets for typical jobs ("Cashier", "Workshop supervisor") to speed setup.
- Audit tab on every role and user.

## 11. API sketch

```
GET    /permissions                    (catalogue as seen by this tenant, grouped)
GET    /roles | POST /roles | GET/PATCH/DELETE /roles/:id
POST   /roles/:id/clone
PUT    /roles/:id/permissions          [{ key, scope }]   + limits
GET    /roles/:id/users
POST   /users/:id/roles                { roleId, branchId? } | DELETE /users/:id/roles/:assignmentId
GET    /users/:id/effective-permissions
GET    /permissions/:key/holders       (who has this permission)
GET    /me/permissions
```

## 12. Platform staff roles use the same pattern

`platform.permission_catalog` includes the `platform.*` keys (doc 27 §6); the platform DB has its own `platform_roles`, `platform_role_permissions`, `platform_user_roles`, seeded by a migration/seed script at install. Super Admin edits staff roles in the console; a catalogue release can add `platform.*` permissions with the same review rules.

## 13. Testing

- Manifest validation in CI (unique keys, valid dependencies, every route annotated, no orphan keys).
- Provisioning test: new tenant has all catalogue permissions, system roles match templates, exactly one owner with every permission.
- Sync test: release N+1 adds a permission → system roles updated, custom roles untouched, notice created, caches invalidated.
- Escalation tests: a user with partial rights cannot grant more than they have; cannot edit their own role.
- Scope tests: `own` / `branch` / `all` on list and by-id endpoints (404 for out-of-scope ids).
- Cache tests: role edit takes effect within seconds; disabled user denied immediately.

## 14. Mapping from the current code (no data migration needed)

Current constants (`create:vehicle`, `view:vehicles`, `view:others-sales`, `view:sales-filter-by-driver`, …) are replaced by the new keys; scope-based grants replace the "others/filter-by" permissions (e.g. `view:others-sales` → `remittances.list_all`; `view:sales-filter-by-driver` → scope + UI filter). Rename `sales` → `remittances` (doc 09). `MANAGE_TENANTS` moves to `platform.tenants.*` in the platform catalogue (it must never exist in a tenant catalogue — fixes finding C2).
