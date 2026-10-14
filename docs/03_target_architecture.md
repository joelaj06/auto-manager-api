# 03 — Target Architecture

> **Update 2026-10-13:** database is now **PostgreSQL** and hosting is a **VPS with containers** — see [22](22_postgresql_architecture.md). Sections 9–10 (caching, deployment) and any MongoDB wording are superseded by 22. The module layout, layering, events/outbox, validation, error and testing guidance still apply. Job queue: pg-boss or BullMQ (22 §6). Tenancy is **database-per-tenant** (22 §2). Backups: [26](26_backup_and_disaster_recovery.md).

## 1. Style: modular monolith

Keep one deployable, but organise code by **business module** rather than by technical layer across the whole repo. Each module owns its models, repositories, use-cases, routes, events and permissions. Modules only talk to each other through:

1. **Public service interfaces** (synchronous, in-process), and
2. **Domain events** (asynchronous, via outbox).

This keeps the door open to extract a module into its own service later (e.g. reports worker) without a rewrite.

### Proposed layout

```
src/
  bootstrap/                 # composition root: container, app, server, worker entrypoints
    container.ts             # loads every module's ContainerModule
    http.ts                  # express app factory
    worker.ts                # background job runner entrypoint
  platform/                  # control plane (tenants, plans, billing, platform users)
  shared/
    kernel/                  # Money, Result, DomainError, Clock, Id, Pagination, Specification
    db/                      # ConnectionManager, TenantContext, base schema plugin, counters, migrations
    http/                    # validation middleware, response envelope, error mapper, auth, tenant resolution
    events/                  # EventBus, Outbox, handlers registry
    jobs/                    # queue abstraction + scheduler
    files/                   # storage abstraction (Cloudinary / S3)
    notify/                  # email, SMS, push, WhatsApp adapters
  modules/
    identity/                # users, roles, permissions, sessions, auth
    organisation/            # org profile, branches, settings, numbering
    vehicles/                # registry, documents, odometer, assignments, telematics
    parties/                 # customers, drivers, suppliers, contacts (shared "Party" concept)
    rentals/
    workpay/
    remittances/             # today's "sales"
    dealership/
    purchasing/
    maintenance/
    expenses/
    finance/                 # invoices, payments, ledger, reconciliation
    reports/
    notifications/
  index.ts
```

Each module:

```
modules/rentals/
  domain/          # entities w/ behaviour, value objects, state machines, domain events
  application/     # use-cases (commands/queries), ports (interfaces)
  infrastructure/  # mongoose schemas, repositories, external adapters
  http/            # routes, controllers, request/response schemas (zod)
  permissions.ts   # module permission constants
  events.ts        # event names + payload types
  module.ts        # Inversify ContainerModule + route registration
```

## 2. Layer rules

| Layer | May depend on | Must not |
|---|---|---|
| domain | shared/kernel | mongoose, express, other modules' internals |
| application | domain, ports, other modules' **public** interfaces | mongoose models directly |
| infrastructure | mongoose, SDKs, application ports | express |
| http | application, validation | repositories |

Enforce with `eslint-plugin-boundaries` or `dependency-cruiser` in CI.

## 3. Dependency injection

> **Updated 2026-10-14 (decision 62):** Inversify is dropped. Dependencies are wired by hand in a typed composition root.

- **Single composition root** in `src/bootstrap/container.ts`. Each module exposes a `module.ts` factory (`createRentalsModule(deps)`) that builds its repositories, use-cases and routes from explicitly passed dependencies (replaces the 15 per-route containers).
- Repositories and services are **singletons**; they read the tenant database handle from `AsyncLocalStorage` at call time.
- No decorators or reflection metadata, so the TypeScript compiler, the dev runner (tsx) and the test runner (Vitest) all behave the same. Tests construct use-cases directly with fakes.

## 4. Request pipeline (target)

```
requestId → logger(ctx) → helmet/cors → rateLimit(ip)
  → tenantResolution (host | X-Tenant header | token claim)
  → authenticate (verify JWT, check tid === tenant.id, load session/permissions from cache)
  → entitlement(module) → authorize(permission, scope)
  → validate(zod schema: params/query/body)
  → controller → use-case → repo
  → response envelope
  → error mapper (no stack in prod)
```

## 5. Validation & DTOs

- **Zod** schemas per endpoint: `CreateRentalBody`, `ListRentalsQuery`, … Infer TS types from them.
- Separate **Command/Query DTOs** (input), **Domain entities** (behaviour), **Response DTOs** (output). Stop using the same `I*` class for all three.
- Whitelist fields — never spread `req.body` into persistence.
- Generate OpenAPI from zod (`zod-to-openapi`) → Swagger UI at `/docs` and typed client for the mobile/web apps.

## 6. Response & error conventions

```json
// list
{ "data": [...], "meta": { "page": 1, "pageSize": 20, "total": 134, "totals": { "amount": 52300 } } }
// single
{ "data": { ... } }
// error
{ "error": { "code": "RENTAL_VEHICLE_UNAVAILABLE", "message": "Vehicle is booked 12–15 Oct", "details": {...}, "requestId": "..." } }
```

- Keep `x-pagination` header for backward compatibility during migration, then deprecate.
- Stable machine-readable `code` on every error (mobile apps switch on it).
- API versioning by path: `/api/v1/...`; current routes become v1 aliases while v2 lands.

## 7. Domain events & outbox

Why: today interactors call other modules' repositories directly (rental → vehicle). As modules multiply this becomes spaghetti and non-atomic.

- Use-case writes its aggregate **and** an `outbox` document in the same tenant transaction.
- A dispatcher (in-process for sync handlers, queue for async) publishes events.
- Handlers are idempotent (`eventId` processed-set).

Example events:

| Event | Producers | Consumers |
|---|---|---|
| `rental.reserved`, `rental.checkedOut`, `rental.checkedIn`, `rental.cancelled` | rentals | vehicles (status), finance (invoice), notifications |
| `payment.received` | finance | rentals / workpay / remittances (allocate), notifications (receipt) |
| `workpay.installmentOverdue` | scheduler | notifications, workpay (penalty) |
| `workpay.completed` | workpay | vehicles (ownership transfer), dealership (disposal record) |
| `vehicle.odometerUpdated` | vehicles, rentals, fuel | maintenance (service due check) |
| `vehicle.documentExpiring` | scheduler | notifications |
| `expense.approved` | expenses | finance (ledger), reports |
| `purchase.received` | purchasing | vehicles (create stock unit), finance (payable) |
| `deal.closed` | dealership | vehicles (sold), finance (receivable), commissions |

## 8. Background jobs & scheduling

Needed for: reminders, overdue detection, penalty accrual, report generation, PDF rendering, SMS sending, telematics ingestion, nightly aggregates, tenant migrations.

| Option | Pros | Cons |
|---|---|---|
| **BullMQ + Redis** (recommended) | Mature, retries, delayed jobs, repeatable cron, dashboards | Needs Redis |
| Agenda (Mongo-backed) | No new infra | Slower, less active |
| Vercel Cron + queue service (QStash) | Fits serverless | Vendor lock-in, per-call cost |

Every job payload carries `tenantId`; the worker re-establishes tenant context before running the handler. Fan-out jobs ("for every active tenant run X") are enqueued by a platform-level scheduler.

## 9. Caching

- Redis (same instance as BullMQ):
  - Tenant registry lookups by host/slug (TTL 60s, bust on update).
  - User session + permission set (`perm:{tenantId}:{userId}` with a `permVersion`).
  - Entitlements per tenant.
  - Dashboard tiles (short TTL).
- No caching of transactional data.

## 10. Deployment

⚠️ The current target is **Vercel serverless**, but the design relies on a long-lived process (connection cache with idle timers, in-memory maps, AsyncLocalStorage per request is fine). Background workers, websockets and Redis-backed queues don't fit serverless well.

Recommendation:

| Component | Host |
|---|---|
| API (stateless containers, 2+ replicas) | Render / Railway / Fly.io / AWS ECS / DigitalOcean App Platform |
| Worker (same image, different entrypoint) | same |
| MongoDB | Atlas (replica set — required for transactions) |
| Redis | Upstash / Atlas-adjacent managed Redis |
| Files | Cloudinary (images) + S3-compatible (documents, PDFs, exports) |
| Observability | OpenTelemetry → Grafana / Better Stack / Datadog; Sentry for errors |

Environments: `local` → `staging` (seeded demo tenants) → `production`. Docker Compose for local (Mongo replica set + Redis + Mailpit).

## 11. Observability

- Structured JSON logs with `requestId`, `tenantId`, `userId`, `route`, `durationMs`. Redact `password`, `token`, `otp`, card / MoMo numbers.
- Metrics: request latency per route, tenant connection pool count, queue depth, job failures, slow queries.
- Health endpoints: `/health/live`, `/health/ready` (Mongo + Redis ping).
- Sentry with tenant tag.

## 12. Files & documents

`IStorageBucket` stays, extended:
- Upload via **pre-signed URLs** (client → storage directly) instead of base64 in JSON (current 5 MB body limit).
- `File` collection per tenant: `{ key, url, mime, size, ownerType, ownerId, kind: "vehicle_photo" | "insurance" | "contract" | "receipt" ..., uploadedBy }`.
- Generated PDFs (contracts, receipts, statements, reports) stored the same way.

## 13. Testing strategy

| Level | Tooling | Scope |
|---|---|---|
| Unit | Vitest | Domain logic: pricing, schedules, state machines, money |
| Integration | Vitest + a real PostgreSQL (Compose / CI service) | Repositories, transactions, tenant databases |
| API | Supertest | Auth, permissions, tenant isolation (token from A rejected on B) |
| Contract | OpenAPI schema check in CI | Prevent breaking mobile apps |
| Load | k6 | Lists, dashboard, report generation |

Mandatory regression tests for every 🔴 finding in doc 01.
