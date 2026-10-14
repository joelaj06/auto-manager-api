# 22 — PostgreSQL Architecture & Multi-Tenancy

> Supersedes the MongoDB-specific parts of docs 03, 04, 05 and 17.
> Where those docs say "collection", read "table". Business content (fields, rules, lifecycles) in docs 05–15 still applies.
> **Revision 2 (2026-10-13):** decision 26 — **every tenant gets its own PostgreSQL database.** The first draft of this doc proposed shared tables with Row-Level Security; that is withdrawn. Sections below reflect database-per-tenant.
> Status: proposal for approval. Versions and tool choices are recommendations to confirm before implementation.

## 1. Why PostgreSQL helps this product

| Need | What Postgres gives |
|---|---|
| Money correctness | Transactions across any tables, `CHECK` constraints, `bigint`/`numeric` exact math |
| Ledger / reports | Joins, window functions, CTEs, materialized views — P&L per vehicle is a SQL query |
| Rental double-booking | `EXCLUDE USING gist` on time ranges makes overlap **impossible at the database level** |
| "One open assignment per vehicle", "one live agreement per vehicle" | Partial unique indexes |
| Safe numbering | Counter table with row lock |
| Flexible fields | `jsonb` for custom fields and snapshots |
| Search | `pg_trgm` + GIN for plate/name/VIN; full-text search |
| Telematics (later) | Partitioned tables or TimescaleDB; PostGIS for geofences |
| Per-tenant backup/restore/export/delete | `pg_dump`/`pg_restore` and `DROP DATABASE` on one tenant (needs database-per-tenant) |

## 2. Multi-tenancy: database per tenant

### 2.1 Layout

```
Postgres cluster (one or more)
 ├─ autoforce_platform        ← control plane (one DB)
 │    tenants, tenant_domains, clusters, plans, subscriptions, billing invoices/payments,
 │    platform_users, user_directory, tenant_migrations, platform_audit_logs, webhook_events, job queue
 ├─ tenant_template           ← pristine, fully-migrated template (never used for data)
 ├─ t_<tenantId>              ← tenant A (all business tables, no tenant_id column needed)
 ├─ t_<tenantId>              ← tenant B
 └─ …
```

- Tenant databases are named by **immutable tenant id** (`t_8f3a…`), not slug, because slugs/subdomains can change.
- Tenant tables have **no `tenant_id` column, no RLS, no composite foreign keys** — the database *is* the boundary. DDL is simpler than the withdrawn shared-table design.
- Each tenant DB has a single-row `tenant_info(tenant_id, schema_version, created_at)` table used for safety assertions (§2.4).
- `ref` data (currencies, makes/models, permission registry) is a schema inside each tenant DB, seeded from the template. It can be updated by migrations.

### 2.2 Why this is a good fit (and its costs)

| Benefit | Cost to manage |
|---|---|
| Strong isolation: a bad query or bug can't cross tenants at the SQL level | **Connection management**: pool per tenant DB (§2.3) |
| Per-tenant backup, restore, export, deletion are trivial (doc 26) | **Migrations fan out** across N databases (§2.5) |
| Noisy tenant can be moved to its own cluster | **Cross-tenant analytics need fan-out** (platform metrics via jobs) |
| Enterprise tenant on dedicated cluster = change a row in `tenants` | **Catalog overhead**: every DB carries its own catalogs/extensions (tens of MB each when empty-with-schema; measure). Autovacuum cycles through all DBs. Practical comfort zone is hundreds to low thousands of DBs per cluster; beyond that, shard tenants across clusters (`tenants.cluster_id`) |
| Simple schema, simple indexes (nothing leads with `tenant_id`) | **Provisioning creates a database** (cannot run inside a transaction; needs idempotent saga) |

Rule of thumb: plan for **up to ~1,000 tenants per cluster** and add a cluster after that. Validate with a load test of 500 empty tenant DBs early (P0).

### 2.3 Connections

- Platform DB: one small pool.
- Tenant DBs: an **LRU map of `pg.Pool` instances**, one per active tenant DB, each with `max` 2–4 connections, idle timeout ≈ 5 min, global cap (e.g. 200 live pools). A pool is evicted (and ends its clients) when idle.
- **PgBouncer** (transaction pooling) sits between the API and Postgres so the server sees few real connections regardless of how many tenant pools exist: `max_db_connections` per database, `default_pool_size` small. Use `SET LOCAL` only (no session state).
- Alternative worth benchmarking: no per-tenant pool at all — open a short-lived client to PgBouncer per request (`dbname = t_<id>`). Simpler code, slightly more latency.
- Pool creation is de-duplicated (in-flight promise map), like today's `ConnectionManager` which can be adapted rather than thrown away.
- Per-statement and per-transaction timeouts set at connect (`statement_timeout`, `idle_in_transaction_session_timeout`).

### 2.4 Roles & isolation safeguards

| Role | Used by | Rights |
|---|---|---|
| `platform_app` | API/worker for platform DB | DML on platform tables |
| `tenant_app` | API/worker for tenant DBs | `CONNECT` on tenant DBs; DML only (no DDL, no `CREATEDB`, not owner) |
| `migrator` | Migration runner, provisioning | Owns tenant DBs, runs DDL, `CREATEDB` |
| `backup` | Backup jobs | Read-only (`pg_read_all_data`) |

Safeguards against the one real risk (**wrong pool chosen for a request**):
1. On creating a pool for tenant X, run `SELECT tenant_id FROM tenant_info` and **assert it equals X**. Mismatch → refuse and alert.
2. Token `tid` must equal the resolved tenant (doc 04 §4).
3. Tenant-scoped repositories can only obtain a handle through the request context (`getTenantDb()`); the raw pool registry is not exported (lint-enforced).
4. Optional hardening for Enterprise: **per-tenant database role + password** stored encrypted in the platform DB, so a code bug physically cannot touch another database.
5. Automated isolation tests: two tenants, token A against tenant B → 401; repository calls under tenant A context never return B's rows.

### 2.5 Schema migrations across tenants

- SQL migration files in git: `migrations/0001_init.sql` …; applied in order.
- Each tenant DB records applied migrations in `schema_migrations`; the platform keeps `tenant_migrations(tenant_id, version, status, applied_at, error)` for visibility.
- **Runner**: a job that iterates active tenants with bounded concurrency (e.g. 4), applies pending migrations in a transaction per tenant, records result, continues on failure, alerts on failures.
- **Compatibility rule (expand → deploy → contract)**: app version N works with schema N and N−1. Destructive changes ship one release later. This lets deploys proceed while the runner is still fanning out.
- **Gate**: tenant resolution checks `schema_version >= min_required` for the running app; otherwise that tenant gets 503 "upgrading" instead of a crash.
- **New tenants** are created from `tenant_template`, which CI rebuilds at every release by running all migrations on an empty DB, so new tenants start at the latest version with no replay.
- `CREATE INDEX CONCURRENTLY` for big tables, applied outside the transaction wrapper where needed.

### 2.6 Provisioning (saga, idempotent)

```
tenant_applications: pending_verification → pending_review → approved | rejected | needs_info   (doc 27 §3.2)
tenants.status:      provisioning → trialing/active
                                   └─(fail)→ provisioning_failed (step + error; retryable)
1. signup (email/phone verified) → staff approval (manual, or auto-approve rule)
                                        ← DB is created only AFTER approval (stops spam creating databases)
2. reserve slug/domain + choose cluster
3. CREATE DATABASE t_<id> TEMPLATE tenant_template OWNER migrator   (retry-safe: drop partial DB if step 4+ never completed)
4. grant tenant_app; verify schema_version; write tenant_info
5. seed (one transaction in the new DB): organisation, default branch, **permissions + system roles copied from the platform permission catalogue (doc 28 §4)**, expense categories, tax codes, counters, settings, owner user assigned the `owner` role
6. platform: user_directory entry, subscription (trial), entitlements
7. send welcome message; mark active
```
- `CREATE DATABASE … TEMPLATE` requires no other sessions on the template; creations serialize briefly. Acceptable at signup rates. If it becomes a bottleneck, pre-create a small pool of spare databases ("warm pool") and claim one.
- **No deprovision/delete** (decision 36). Deactivation only revokes access; the database stays. After a long inactivity period (default ≥ 12 months, staff-initiated) a deactivated tenant can be moved to **cold archive** (verified dump kept indefinitely, live DB dropped to free capacity) and restored on request (doc 26 §8). Only never-activated artefacts (rejected applications, failed provisioning, demo tenants) may be purged.

### 2.7 Cross-database concerns

| Concern | Approach |
|---|---|
| Branch count for billing | Source of truth: the tenant DB (`branches`). A sync step updates `platform.subscriptions.branch_count` when a branch is created/deactivated, and a nightly reconcile job fixes drift. **Entitlement is checked before creating a branch** (platform lookup), because there is no cross-DB transaction |
| User discovery for mobile login | `platform.user_directory(email_hash/phone_hash, tenant_id, status)` updated on user create/disable (idempotent upsert with retry via the platform queue) |
| Events / outbox | Outbox table lives in the **tenant DB**, written in the business transaction. After commit the request enqueues a "drain outbox for tenant X" job (platform queue); a sweeper job also drains tenants with undelivered rows. Handlers are idempotent |
| Scheduled jobs (daily W&P arrears, document expiry, reports) | Platform scheduler enqueues one job **per active tenant** (respecting tenant timezone). Worker obtains that tenant's pool, runs, releases |
| Platform analytics (usage, vehicle counts, health) | Periodic job reads small aggregates from each tenant DB into platform tables; never live cross-DB queries |
| Job queue | Lives in the platform DB (pg-boss) or Redis (BullMQ). Payload always contains `tenantId` |

## 3. Conventions (tenant database)

| Topic | Convention |
|---|---|
| **IDs** | `uuid` primary keys, time-ordered (UUIDv7: native `uuidv7()` on PostgreSQL 18, or generated in the app). Mobile clients can generate IDs offline → idempotent retries |
| **Human codes** | `counters(key text primary key, seq bigint)`; `INSERT … ON CONFLICT (key) DO UPDATE SET seq = counters.seq + 1 RETURNING seq` in the same transaction. Format from settings (`RT-2026-000123`). `UNIQUE (code)` |
| **Money** | `bigint` minor units + `currency char(3)` (doc 20). Base-currency copy `*_base_minor`. `fx_rate numeric(18,8)` |
| **Timestamps** | `timestamptz`, UTC. Business dates (`due_date`) as `date`, interpreted in the tenant timezone by the app |
| **Time ranges** | `tstzrange` for bookings/blocks |
| **Enums** | `text` + `CHECK` (or lookup tables), not native `ENUM` types |
| **Soft delete** | `deleted_at`, `deleted_by`; unique indexes are partial (`WHERE deleted_at IS NULL`); repositories filter centrally |
| **Audit columns** | `created_at, created_by, updated_at, updated_by, version int` (optimistic concurrency) |
| **Emails** | `citext`, unique |
| **Flexible data** | `jsonb` for `custom_fields`, snapshots, rule definitions. Not for heavily filtered/joined data |
| **Naming** | `snake_case`, plural tables, `<thing>_id` FKs, one column per relation |
| **Extensions** | `btree_gist`, `pg_trgm`, `citext`, `pgcrypto` installed in the template |

## 4. Constraints that replace application logic

| Rule | Mechanism |
|---|---|
| Vehicle can't be double-booked | `EXCLUDE USING gist (vehicle_id WITH =, during WITH &&) WHERE (status IN ('hold','confirmed','out'))` on `vehicle_blocks` |
| One open driver assignment per vehicle (decision 9) | `CREATE UNIQUE INDEX ON vehicle_assignments (vehicle_id) WHERE ended_at IS NULL` |
| A driver drives one vehicle at a time | same on `(driver_id)` |
| One live W&P agreement per vehicle | `UNIQUE (vehicle_id) WHERE status IN ('active','in_arrears','defaulted')` |
| Unique plate / VIN | `UNIQUE (plate_number) WHERE deleted_at IS NULL AND plate_number IS NOT NULL` |
| Optional unique fields | partial unique `WHERE email IS NOT NULL` |
| Ledger balanced | `journal_entries` + `journal_lines`; deferred constraint trigger checks `SUM(debit)=SUM(credit)` at commit |
| Allocations ≤ payment | deferred constraint trigger + nightly integrity job |
| Valid ranges/status | `CHECK` constraints |
| Odometer never decreases | trigger (allow `is_correction`) |
| Closed accounting periods | trigger rejects writes dated in a locked period |

## 5. Example table (illustrative, not final)

```sql
create table vehicles (
  id            uuid primary key default uuidv7(),
  code          text not null unique,
  branch_id     uuid not null references branches(id),
  plate_number  text,
  vin           text,
  make          text not null,
  model         text not null,
  year          smallint,
  status        text not null default 'available'
                check (status in ('incoming','reconditioning','available','assigned','reserved',
                                  'on_rent','in_maintenance','on_workpay','for_sale','sold',
                                  'transferred','repossessed','retired','written_off')),
  usage         text not null check (usage in ('fleet','rental','workpay','stock','personal')),
  current_odometer integer not null default 0,
  acquisition_cost_minor bigint,
  acquisition_currency   char(3),
  custom_fields jsonb not null default '{}',
  version       int  not null default 1,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  deleted_at    timestamptz
);
create unique index vehicles_plate_uq on vehicles (plate_number) where deleted_at is null and plate_number is not null;
create index vehicles_status_ix on vehicles (branch_id, status) where deleted_at is null;
create index vehicles_search_ix on vehicles using gin ((coalesce(plate_number,'') || ' ' || coalesce(vin,'') || ' ' || make || ' ' || model) gin_trgm_ops);
```

## 6. Stack choices (proposal)

| Concern | Proposal | Notes |
|---|---|---|
| Query layer | **Drizzle ORM** (or Kysely) over `node-postgres` | SQL-close, typed. Drizzle schema = one tenant schema; connection supplied per request |
| Migrations | Plain SQL files + small custom runner (fan-out, §2.5) | `drizzle-kit` can generate SQL; the runner is ours |
| Pooling | PgBouncer (transaction mode) + app LRU of pools | §2.3 |
| Job queue | **pg-boss** in the platform DB, or BullMQ on Redis | Redis is available (decision 15) for cache/rate limits regardless. See open question 32 |
| Cache | Redis: tenant lookup by host/slug, permission sets, rate limits, entitlements | |
| Search | `pg_trgm` + full-text | |
| Files | S3-compatible object storage + Cloudinary for images | Files keyed by `tenantId/…`; included in backups (doc 26) |
| PDF | HTML → Playwright/Chromium or `pdfmake` | Doc 24 |
| Validation | zod 4 | |
| Language / runtime | TypeScript 6.0 (native ESM, `NodeNext`), Node.js 24 LTS | Pinned to TS 6.0 because typescript-eslint and other tooling don't support TS 7 yet |
| DI | Plain composition root, no container library (decision 62) | |
| Tests | Vitest | ESM-native; Jest dropped |
| Auth | JWT access (15 min) + rotating refresh in `sessions` table (in tenant DB) | Doc 16 |
| Reports | SQL + materialized views/summary tables refreshed per tenant by jobs | Doc 14 |

## 7. Translating the earlier docs

| Earlier doc says | Now |
|---|---|
| Doc 04 "database-per-tenant, system DB + tenant DBs" | **Back in force**, on Postgres. Control plane = `autoforce_platform` DB |
| Doc 04 §8 `useDb` / connection caching | Replaced by §2.3 (LRU of pools + PgBouncer) |
| Doc 04 §6–7 provisioning saga, migrations fan-out | Adapted in §2.5–2.6 (CREATE DATABASE from template, SQL migrations runner) |
| Doc 05 §1 conventions | Replaced by §3 here. **No `tenant_id` on tenant tables** |
| Embedded arrays | Child tables or `jsonb` |
| `counters`, `outbox`, `audit_logs` collections | Tables in each tenant DB (`audit_logs` partitioned by month) |
| `daily_vehicle_stats` | Summary table/materialized view per tenant |
| Doc 17 §3 `$facet` pagination | Keyset pagination or `COUNT(*) OVER()` |
| Doc 17 §14 strangler | Replaced by §9 rewrite |

## 8. Findings from doc 01

| Ref | Status |
|---|---|
| H1, H2, H8, H14–H17 | Gone by construction (no Mongoose, constraints in the DB) |
| C8 (tenant code can reach the tenant registry) | Gone: tenant DBs contain no platform data; `tenant_app` has no grants on the platform DB |
| C1–C7 | Still apply (auth, errors, config, validation) |
| H3–H7, H9–H13, H18 | Business-logic bugs; fix in the new modules. H18 (no rollback of half-provisioned tenants) is addressed by the idempotent saga in §2.6 |

## 9. Rewrite strategy (no data to migrate)

1. **Keep** the architecture shape: entities → interactors → controllers → routes. *(Inversify dropped in favour of a plain composition root — decision 62. Legacy code removed in P0-1; git history is the reference.)*
2. **Replace** `frameworks/database/mongodb/**`, the tenant context storage internals, tenant resolution middleware and tenant provisioning. The existing `ConnectionManager` concept (cache + in-flight de-dup + idle eviction) and the AsyncLocalStorage tenant context carry over conceptually.
3. **Foundation first (doc 18, P0)**: Postgres, template DB, platform DB, migration runner, pool manager, auth v2, validation, audit, outbox, jobs, backups.
4. **Port modules in dependency order**, fixing the audited bugs as each is rebuilt.
5. Keep the Mongo code on a `legacy-mongo` tag for reference.
6. **Mobile app**: API shapes will change; the app is revisited after the backend (decision 28). Don't spend effort on compatibility layers now.

## 10. Deployment on a VPS

```
Internet ─▶ Caddy/Traefik (TLS; wildcard cert via DNS-01 for portal subdomains)
              ├─▶ api    (Node containers ×2)
              ├─▶ worker (same image, worker entrypoint)
              └─▶ (later) web portal
          PgBouncer ─▶ PostgreSQL (primary)  ──WAL stream──▶ standby / off-site archive
          Redis · (optional) MinIO
```

- Docker Compose + deploy tool (Coolify / Dokku / GitHub Actions → SSH).
- **Backups are specified in [26_backup_and_disaster_recovery.md](26_backup_and_disaster_recovery.md)** — per-tenant logical dumps plus cluster-level WAL archiving, off-VPS, encrypted, with automated restore drills.
- Sizing starting point (validate by load test): 4 vCPU / 8 GB / NVMe for early stage. Disk grows with tenant count (catalog overhead per DB). Plan to split into DB host + app host when load or revenue allows.
- Security: firewall (only 80/443 public), private network for Postgres/Redis, SSH keys only, fail2ban, unattended security updates, secrets outside git.
- Observability: Prometheus/Grafana (or Better Stack), Sentry, `pg_stat_statements`, slow-query log, **metrics for pool count, DB count, migration status, backup age**.
- Zero-downtime deploys: 2 API replicas, backwards-compatible migrations.

## 11. Performance notes

- Indexes are simple (no tenant prefix), so planner behaviour is the same as a single-tenant app.
- Cold tenant = first request pays pool creation + connect (tens of ms); keep hot-tenant pools warm; cache tenant lookup in Redis.
- Partition large append-only tables per tenant DB (`audit_logs`, `journal_lines`, `notifications`, telematics) by month.
- Keyset pagination for long lists; heavy reports via jobs with cursor streaming; optional read replica for reports.
- Autovacuum tuning for many DBs (`autovacuum_naptime`, worker count); monitor bloat per DB.

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Too many DBs / catalog overhead on one cluster | Measure early, cap ~1,000 tenants per cluster, shard by `cluster_id`, template keeps schema lean |
| Connection storms / pool explosion | PgBouncer, small LRU pools, global cap, idle eviction, metrics and alerts |
| Migration fan-out failure leaves tenants on different versions | N / N−1 compatibility rule, per-tenant status in platform DB, 503 gate, retry job, alerts |
| Wrong DB chosen for a request | `tenant_info` assertion, token binding, no raw pool export, optional per-tenant roles |
| Provisioning leaves orphan databases | Idempotent saga, orphan-DB sweeper (DBs in cluster not referenced by an active tenant → alert, never auto-drop without a grace period) |
| Spam signups creating databases | DB created only after verification **and staff approval** (doc 27 §3.2); rate limits; expire stale applications after N days |
| Single VPS failure | WAL archive off-box, standby when affordable, rebuild runbook (doc 26) |
| Cross-tenant reporting is hard | Aggregates pushed to platform tables by jobs; not a product requirement for tenants |
