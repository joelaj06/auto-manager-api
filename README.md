# auto-manager-api

Backend for **Autoforce Manager** — a multi-tenant platform for vehicle businesses in Ghana: fleets and
driver remittances, Work & Pay (hire purchase), car rentals, dealerships, purchases, maintenance and
reporting. Each tenant gets its own PostgreSQL database.

> **Status:** version 2 is being rebuilt from scratch (Phase 0 — foundation). The previous MongoDB
> implementation was removed; it remains available in git history.
> Design and plan: [`docs/`](docs/00_index.md) — start with
> [`docs/30_implementation_plan.md`](docs/30_implementation_plan.md).

## Requirements

- Node.js 24 or newer (`.nvmrc`)
- Yarn 1.22
- Docker with Compose (for local PostgreSQL, Redis and Mailpit)

## Getting started

```bash
cp .env.example .env
yarn install
docker compose up -d
yarn db:setup        # roles, platform + template databases, all migrations (idempotent)
yarn dev
```

Local services use non-default host ports (PostgreSQL **54320**, Redis **63790**) so they don't
clash with other projects.

## Databases

One PostgreSQL cluster holds the **platform database** (`autoforce_platform`: tenants, billing,
platform staff), a **tenant template** (`tenant_template`) and **one database per tenant**
(`t_<tenant uuid>`), cloned from the template. See
[`docs/22_postgresql_architecture.md`](docs/22_postgresql_architecture.md).

| Role           | Used by                         | Can do                                                                               |
| -------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| `migrator`     | migrations, tenant provisioning | Owns all app databases, runs DDL, creates tenant databases                           |
| `platform_app` | the API                         | Data access to the platform database only                                            |
| `tenant_app`   | the API                         | Data access to tenant databases only; cannot change tenant identity or audit history |

SQL migrations live in `db/migrations/platform` and `db/migrations/tenant` (`0001_name.sql`;
never edit an applied file — add a new one). `yarn db:migrate` applies them to the platform
database, the template and every tenant database.

| Command             | What it does                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `yarn db:setup`     | Create/refresh roles and databases (needs `DATABASE_ADMIN_URL`), then migrate everything |
| `yarn db:migrate`   | Migrate platform, template and all tenant databases                                      |
| `yarn db:status`    | Schema versions of the platform DB, template and tenants                                 |
| `yarn db:load-test` | Create N throw-away tenant databases and measure (needs `DATABASE_ADMIN_URL`)            |

## Scripts

| Command                               | What it does                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn dev`                            | Run the app with reload on change (tsx)                                                                                                                           |
| `yarn dev:worker`                     | Run the background worker with reload (jobs, scheduler, outbox, email)                                                                                            |
| `yarn build`                          | Compile to `dist/`                                                                                                                                                |
| `yarn start`                          | Run the compiled app                                                                                                                                              |
| `yarn typecheck`                      | Type-check everything (`tsc --noEmit`)                                                                                                                            |
| `yarn lint` / `yarn lint:fix`         | ESLint, including architecture boundary rules                                                                                                                     |
| `yarn format` / `yarn format:check`   | Prettier                                                                                                                                                          |
| `yarn test` / `yarn test:watch`       | Unit tests (Vitest)                                                                                                                                               |
| `yarn test:integration`               | Integration tests (`*.int.test.ts`) in throw-away PostgreSQL + Mailpit containers (needs Docker); `TEST_INFRA=external` uses the running compose services instead |
| `yarn load:health` / `yarn load:auth` | k6 load scripts against a running API (`PROFILE=smoke\|load\|stress`, `BASE_URL=…`); uses a local `k6` or the k6 Docker image                                     |
| `yarn verify`                         | Typecheck, lint, format check and tests — run before every commit                                                                                                 |

## HTTP API

| Endpoint                   | Purpose                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /health/live`         | Liveness: the process is up (never touches dependencies)                                                    |
| `GET /health/ready`        | Readiness: dependencies answer (`503` when not) — no details are exposed                                    |
| `GET /api/v1/me`           | The signed-in user, their business and permissions (bearer token)                                           |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 document generated from the route declarations (off in production unless `EXPOSE_OPENAPI=true`) |

Conventions for every endpoint:

- **Responses:** `{ "data": … }` (plus `"meta"` for pages); errors are
  `{ "error": { "code", "message", "details"?, "requestId" } }` with a stable `code`.
- **Request ids:** every response carries `X-Request-Id` (a well-formed incoming one is kept);
  it appears in every log line written during the request.
- **Validation:** routes declare zod schemas for params, query and body (`adapters/routes`);
  all invalid fields are reported at once, values are never echoed.
- **Security:** helmet headers, CORS allow-list (wildcard subdomains supported), JSON bodies
  limited in size, `/api` rate-limited per client, no stack traces in responses.
- **Access control:** every route declares `access` (`adapters/routes/RouteAccess.ts`) —
  `public`, `tenant` (anonymous, for the business named in `X-Tenant`) or `authenticated` with a
  permission from `application/authorization/permissionCatalog.ts`. Tenant routes run inside
  that tenant's context, so the unit of work can only reach its database. Bearer tokens are
  short-lived JWTs signed with a per-tenant key; a token for one business is rejected on
  another (`401 TENANT_MISMATCH`, logged as a security alert). Refresh tokens rotate on every
  use and a reused one revokes the session. Sign-in endpoints arrive with users in P1-5.
- **Logging:** JSON lines (`LOG_FORMAT=json`) or readable (`pretty`); passwords, tokens, OTPs,
  authorization headers and connection-string credentials are redacted automatically.
- **Shutdown:** on SIGTERM/SIGINT the server stops accepting requests, finishes in-flight ones
  and closes database pools, within `SHUTDOWN_TIMEOUT_MS`.

## Background jobs, events and email

The worker is a second process from the same image: `yarn dev:worker` locally,
`node dist/worker.js` in the container (override the image `CMD`).

- **Queue:** pg-boss in the platform database (schema `pgboss`). `yarn db:migrate` installs and
  upgrades it as the migrator and creates one queue per entry of
  `application/jobs/jobCatalog.ts`; the app role gets data access only.
- **Outbox:** events written with `IOutbox` inside a unit of work trigger an `outbox.drain` job
  after commit. The drain fans each event out to its subscribed handlers (`event.deliver`), which
  run in the tenant's transaction and record `event:<handler>:<eventId>` in `processed_messages`,
  so a redelivered event changes nothing. An hourly sweep catches triggers lost in a crash.
- **Scheduler:** every 15 minutes `scheduler.tick` enqueues each tenant's daily jobs once its
  local time (`tenants.timezone`, default `Africa/Accra`) reaches their hour; the ledger
  `tenant_schedule_runs` makes it once per tenant per local day, and missed ticks catch up.
  Today: `tenant.daily_maintenance` (retention clean-up) at 02:00.
- **Email:** `NotificationService.sendEmail` renders a template (`application/notifications`),
  stores it in `email_deliveries` with an idempotency key and enqueues `email.send` in the same
  transaction. Content is erased once sent. Locally mail goes to Mailpit
  (http://localhost:8025).
- Jobs of deactivated tenants are skipped; failed jobs retry with backoff.

## Platform console API

Staff (console) API under `/api/platform/v1` — separate tokens, sessions and permissions from
tenant users (docs/27).

```
yarn platform:invite-admin --email you@example.com --name "Your Name"   # first Super Admin (prints a one-time link)
```

Sign-in: `POST /auth/invitations/accept` (password) → `POST /auth/mfa/enrol` (authenticator
secret) → `POST /auth/mfa/enrol/confirm` (first code) → tokens. Afterwards `POST /auth/login`
→ `POST /auth/mfa`. Sensitive actions need `POST /auth/step-up` (password + code) within the
last 10 minutes. Staff, roles, approvals (four-eyes) and the audit log are under `/staff`,
`/roles`, `/approvals` and `/audit-logs`; see the OpenAPI document for every route.

## Public signup (tenant applications)

`POST /api/v1/applications` creates an application and sends an email code and an SMS code
(locally the SMS appears in the API log as `DEVELOPMENT SMS`; emails in Mailpit once
`yarn dev:worker` runs). The response contains a private `accessToken`: send it as
`X-Application-Token` to `GET /api/v1/applications/:id`, `POST …/verify`
(`{ channel: "email" | "phone", code }`), `POST …/resend-code` and `POST …/reply`. Once both are
verified, the application appears in the console queue (`/api/platform/v1/applications`) for
staff to request information, approve or reject.

## Tenant provisioning

Approving an application (console) reserves the tenant and queues the provisioning saga, which
the worker (`yarn dev:worker`) runs: database from the template, migrations, seed (organisation,
HQ branch, permissions and system roles from the platform catalogue, expense categories, tax-code
placeholders, owner), user directory, then a welcome email with a one-time link. The owner opens
it and calls `POST /api/v1/auth/invitations/accept` with `X-Tenant: <slug>` and
`{ token, password }` to get tokens — then `GET /api/v1/me` shows their permissions. Progress and
retry: `GET/POST /api/platform/v1/tenants/:id/provisioning[/retry]`.

## Tenant lifecycle and branches

Console (step-up required): `POST /api/platform/v1/tenants/:id/deactivate`
(`{ reasonCategory, reason, message }`), `…/restore`, `…/read-only`, `…/read-only/clear`,
`GET …/status-history`, and `…/branches[/:branchId/deactivate|reactivate]`. Tenant owners:
`GET /api/v1/branches`, `POST /api/v1/branches/:id/deactivate|reactivate`. Apps call
`GET /api/v1/public/tenant-config?slug=` to show the business name, currency and any blocking
notice.

## Tenant sign-in, users and roles

All with `X-Tenant: <slug>` (except discover). Sign-in: `POST /api/v1/auth/login`
(`{ identifier, password }`), `/auth/refresh`, `/auth/logout`, `/auth/password-reset[/confirm]`,
`POST /api/v1/auth/discover` (mobile: which businesses these credentials open). Me:
`/me/permissions`, `/me/password`, `/me/sessions`. Users: `/users` (list, view, invite, update,
disable/enable, `PUT /users/:id/roles` with per-branch assignments). Roles: `/roles`,
`/permissions`. Organisation: `/organisation`, `/settings/numbering`, `/branches`.

## Backups

Logical, encrypted backups of every tenant database and the platform database, with an
automated restore test. Runbooks: [docs/31](docs/31_backup_restore_runbooks.md).

```
BACKUP_PRIVATE_KEY_PASSPHRASE=… yarn backup keygen --out ./backup-keys   # once; keep the private key offline
yarn backup run                                    # platform + all tenants (needs BACKUP_PUBLIC_KEY_FILE)
yarn backup list
BACKUP_PRIVATE_KEY_PASSPHRASE=… yarn backup verify --private-key <file> --sample 3
BACKUP_PRIVATE_KEY_PASSPHRASE=… yarn backup restore --private-key <file> --id <id> --into <new database>
```

Without PostgreSQL client tools installed, set `BACKUP_PG_TOOLS=docker` (uses `postgres:18-alpine`).

## Tests and security checks

| Suite             | Where                                             | What it guarantees                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit              | `src/**/*.test.ts`                                | Domain rules, use cases, adapters, config — no I/O                                                                                                                                                                                                                                                                                                                         |
| Integration       | `src/**/*.int.test.ts`                            | Repositories, migrations, provisioning, jobs and email against real PostgreSQL and Mailpit                                                                                                                                                                                                                                                                                 |
| Tenant isolation  | `src/testing/isolation`                           | Generated over **every table** of the tenant schema: a row written by tenant A is invisible to tenant B; the app role owns nothing and cannot truncate, add triggers or create objects; append-only tables reject changes; tenant A's token is rejected on tenant B through the real app. A new table fails this suite until it gets a fixture in `tenantTableFixtures.ts` |
| Audit regressions | `src/framework/security/auditRegressions.test.ts` | One block per v1 audit finding C1–C7 (docs/01)                                                                                                                                                                                                                                                                                                                             |
| Load              | `load/k6`                                         | Health probes and bad-token rejection under load, with latency thresholds                                                                                                                                                                                                                                                                                                  |

`src/testing/fixtures/TenantFixtures.ts` creates real tenants (database + platform row) for
integration tests, with helpers to run SQL as the tenant and issue its access tokens.

## Continuous integration

GitHub Actions (`.github/workflows/`):

| Workflow                | When                            | What                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ci.yml`                | push to `master`, pull requests | typecheck, lint, format check, unit tests → integration tests (PostgreSQL + Redis services) → Docker image build, smoke test, vulnerability scan (fails on fixable critical/high), and on `master` publishes `ghcr.io/joelaj06/auto-manager-api` |
| `codeql.yml`            | push, pull requests, weekly     | Static security analysis                                                                                                                                                                                                                         |
| `dependency-review.yml` | pull requests                   | Blocks new dependencies with high/critical vulnerabilities                                                                                                                                                                                       |

Dependabot (`.github/dependabot.yml`) opens weekly update PRs for npm packages, the digest-pinned Docker base images and the SHA-pinned actions. No repository secrets are needed yet; deployment to staging is added with the VPS in P0-3.

## Project layout

Clean Architecture (onion), object-oriented, with dependencies pointing inwards only:

```
src/
  domain/           entities, value objects, enums, domain services, repository interfaces, errors
  application/      use cases, ports (I-prefixed interfaces), DTOs, application services, errors
  adapters/         controllers, routes, middleware, presenters, validators, workers
  infrastructure/   implementations of ports: database (Postgres*), config, context, …
  framework/        composition root (Inversify container), bootstrap, lifecycle, CLI commands
  testing/          test helpers (never imported by production code)
  index.ts          API entry point
  worker.ts         background worker entry point (P0-8)
```

| Layer            | May depend on                      |
| ---------------- | ---------------------------------- |
| `domain`         | nothing (no third-party packages)  |
| `application`    | `domain` (no third-party packages) |
| `adapters`       | `application`, `domain`            |
| `infrastructure` | `application`, `domain`            |
| `framework`      | everything (wires it all together) |

Dependency injection uses an **Inversify** container in `framework/dependency-injection`. Classes
take their dependencies (interfaces) through the constructor and carry **no decorators**; every
binding is a factory listing its dependencies by token, so the inner layers stay framework-free.

These rules are enforced by ESLint (`eslint.config.js`); see
[`docs/03_target_architecture.md`](docs/03_target_architecture.md).
