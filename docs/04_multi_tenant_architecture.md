# 04 — Multi-Tenant Architecture

> **Platform operations** (approval, lifecycle, branches, billing admin, impersonation) are specified in [27_platform_admin_console.md](27_platform_admin_console.md); tenant roles/permissions seeding in [28](28_tenant_roles_permissions_and_seeding.md).

> **Update 2026-10-13 (revision 2):** this doc's **database-per-tenant** design is **back in force** (decision 26), now on **PostgreSQL** — see [22](22_postgresql_architecture.md), which overrides the Mongo-specific mechanics: connection management (§8 → LRU of pools + PgBouncer), provisioning (§6 → `CREATE DATABASE … TEMPLATE tenant_template`, idempotent saga), migrations (§7 → SQL migration runner with fan-out), `useDb`, `databaseUri` and Mongo transactions are obsolete. Tenant resolution (§3) is refined by [23](23_mobile_onboarding_qr_and_deeplinks.md). Billing (§10) is detailed in [25](25_platform_billing_and_subscriptions.md); pricing is per branch (doc 02 §6). Backups: [26](26_backup_and_disaster_recovery.md).

## 1. Decision: keep database-per-tenant, harden it

The current approach (system DB + one DB per tenant, optional dedicated `databaseUri`) is a good fit:

| Model | Isolation | Ops cost | Fit |
|---|---|---|---|
| Shared collections + `tenantId` | Weak (one missing filter = leak) | Lowest | ❌ |
| **DB-per-tenant, shared cluster** (today) | Strong logical isolation, easy per-tenant backup/export/delete | Moderate (migrations fan-out, connection count) | ✅ default |
| Dedicated cluster per tenant | Strongest | High | ✅ Enterprise add-on via `databaseUri` |

**Hybrid tiering**: Starter/Business tenants on shared cluster(s); Enterprise on dedicated cluster. The `Tenant.databaseUri` field already supports this — add a `clusterId` reference so URIs/credentials live in a secrets store, not in the Tenant document.

## 2. Control plane vs tenant plane

```
┌─────────────── System DB (control plane) ───────────────┐
│ tenants · tenant_domains · plans · subscriptions ·       │
│ invoices(platform) · platform_users · user_directory ·   │
│ audit_logs(platform) · migrations_state · clusters       │
└──────────────────────────────────────────────────────────┘
┌──────────── tenant_<slug> DB (tenant plane) ─────────────┐
│ everything business: users, roles, vehicles, rentals ... │
│ + tenant audit_logs, outbox, counters, settings          │
└──────────────────────────────────────────────────────────┘
```

Rules:
- Tenant code **never** gets a handle to control-plane models. Remove `Tenant: createTenantSystemModel()` from `TenantModelFactory`.
- Platform code reaches tenant DBs only through an explicit `runInTenant(tenantId, fn)` helper (used by provisioning, migrations, support tools).
- Platform admin routes live under `/api/platform/*` (rename from `/api/admin/tenants`), served only on the base/admin host, authenticated against `platform_users` with a **different JWT audience/secret**.

## 3. Tenant resolution

Today: subdomain only. Mobile apps and API clients need more options.

Resolution order:
1. **Custom domain / subdomain** — `Host` header → `tenant_domains` lookup (cached).
2. **`X-Tenant-Id` / `X-Tenant-Slug` header** — for mobile apps that talk to a single API host (`api.automanager.app`).
3. **Token claim `tid`** — after login, the token itself identifies the tenant; header/host must agree if present.

Login flow for mobile (no subdomain):
```
POST /api/v1/auth/discover { email }      -> system.user_directory lookup
  <- [{ tenantSlug, tenantName, logo }]   (only if email verified; rate-limited; generic response if none)
POST /api/v1/auth/login  { tenant, email, password }
  <- { accessToken (tid, sub, sid), refreshToken }
```

`user_directory` (system DB): `{ emailHash, tenantId, userId, status }` — lets one person (e.g. a driver working for two fleets) belong to multiple tenants and pick at login. Store a hash or normalized email, not the full profile.

## 4. Auth binding (fixes C1, C4)

- Access token claims: `{ sub: userId, tid: tenantId, sid: sessionId, ver: permVersion, aud: "tenant-api" }`, **15 min** TTL.
- Refresh token: opaque, stored hashed in tenant `sessions` collection, rotated on use, 30 days, revocable.
- `authenticate` middleware: verify signature → **reject if `tid !== resolvedTenant.id`** → load permissions from cache (`perm:{tid}:{sub}`) → if `ver` mismatch, reload.
- Optional: per-tenant signing key derived via HKDF(masterSecret, tenantId) so a key leak in one tenant can't mint tokens for another.

## 5. Organisation, branches & the `company` field

Inside a tenant DB the `Company` collection is redundant with the tenant itself. Proposal:

- `organisation` (singleton document per tenant DB): legal name, logo, tax IDs, address, currency, timezone, fiscal year start, numbering formats, branding.
- `branches`: physical locations / business units (e.g. "Accra HQ", "Kumasi depot", "Spintex showroom").
- Replace `company` on business documents with **`branchId`** (optional for single-branch tenants, defaulted).
- Users get `branchIds[]` + a scope (`own` / `branch` / `all`) — see doc 16.

Migration: map each existing `company` value → a branch with the same id; keep a `company` alias for one release.

## 6. Provisioning (saga)

Make provisioning **idempotent and resumable**:

```
tenant.status: pending → provisioning → active
                          └─(fail)→ provisioning_failed (with step + error)

steps (each records completion in tenant.provisioning.steps[]):
 1. reserve slug + domain (unique)
 2. create DB / run migrations to latest
 3. seed: organisation, default branch, permissions registry, system roles (Owner, Manager, Agent, Accountant, Driver), default expense categories, numbering counters, settings
 4. create owner user (+ user_directory entry)
 5. create subscription (trial) + entitlements
 6. send welcome email / SMS
 7. activate
```
Retrying runs only incomplete steps. A `deprovision` job handles cancellation: export → grace period → drop DB → purge directory entries.

Also support **self-service signup** on the marketing site (creates `pending` tenant, verifies email, then provisions) — distinct from the in-tenant user registration, which should be **invite-only** (fixes C3).

## 7. Schema migrations across tenant DBs

Mongo is schemaless but data shape still changes (e.g. `company` → `branchId`, money → minor units).

- Use `migrate-mongo`-style scripts in `src/shared/db/migrations/NNNN_name.ts` with `up(ctx)` / `down(ctx)`.
- `migrations_state` in system DB: `{ tenantId, version, appliedAt, status }`.
- Runner job fans out across tenants with concurrency limit, records progress, resumable.
- Indexes declared in schemas are synced by migration (`syncIndexes`) — turn **off** `autoIndex` in production (currently `autoIndex: true` in `ConnectionManager.connect`).
- App boot refuses to serve a tenant whose `version < minRequired` (returns 503 "maintenance") — avoids running new code against old data.

## 8. Connection management at scale

Each tenant DB connection = its own pool. 500 tenants × poolSize 10 = 5,000 sockets → exceeds Atlas limits.

Options:
- **Use `connection.useDb(dbName, { useCache: true })`** on one shared cluster connection instead of `createConnection` per tenant. Shares the pool across tenant DBs on the same cluster. Dedicated-cluster tenants still get their own connection. ✅ Recommended.
- Keep idle eviction for dedicated-cluster connections.
- Expose metric: open connections per cluster.

## 9. Entitlements & limits

- `plans` define features (`rentals`, `workpay`, `dealership`, `maintenance`, `reports.advanced`, `api.access`, `branches.multi`) and limits (`vehicles.max`, `users.max`, `sms.monthly`).
- `subscriptions` hold plan + overrides + addons; resolved into an `entitlements` object cached in Redis.
- Middleware `requireFeature("rentals")` on module routers; use-cases check limits (`vehicles.max`) on create.
- Tenant resolution should **not** hard-block on `subscriptionExpiresAt`: use states `active → past_due (grace) → deactivated (Billing tab only, to pay) → active on payment` (doc 25 §5; "suspended" retired, decision 39). Owners must always be able to log in to pay.

## 10. Platform billing

- Paystack (subscriptions + MoMo) as primary; Stripe optional for international.
- Webhooks → `subscriptions` status updates → entitlement cache bust.
- Platform invoices + receipts emailed to tenant owner.
- Usage metering for SMS credits and vehicles count (daily snapshot).

## 11. Tenant lifecycle operations (platform console)

- Create / provision / retry provisioning
- Change plan, apply coupon, extend trial
- Deactivate / restore (automatic from billing; manual only for special cases) / cold-archive
- **Impersonate** (support login as tenant user — time-boxed, audited, banner shown)
- Export tenant data (JSON + CSV zip) — also a tenant-owner self-service feature (data portability)
- ~~Delete tenant~~ — **not offered** (decision 36): tenants are deactivated and can be restored; optional cold archive for long-inactive ones
- View tenant health: last activity, DB size, migration version, error rate

## 12. Data residency & backups

- Atlas continuous backup on shared clusters; per-tenant logical export nightly for Enterprise.
- Point-in-time restore of a single tenant = restore cluster snapshot to temp cluster → `mongodump --db tenant_x` → restore. Document the runbook.

## 13. Isolation test suite (must-have)

- Token from tenant A on tenant B host → 401.
- Header `X-Tenant` B with token A → 401.
- Platform route with tenant token → 401.
- Tenant request can't reach control-plane models (static check: no import of `system/` from `modules/`).
- Background job without `tenantId` → refuses to run.
