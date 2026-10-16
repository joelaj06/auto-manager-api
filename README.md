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

| Command                             | What it does                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `yarn dev`                          | Run the app with reload on change (tsx)                                                                       |
| `yarn dev:worker`                   | Run the background worker with reload (jobs, scheduler, outbox, email)                                        |
| `yarn build`                        | Compile to `dist/`                                                                                            |
| `yarn start`                        | Run the compiled app                                                                                          |
| `yarn typecheck`                    | Type-check everything (`tsc --noEmit`)                                                                        |
| `yarn lint` / `yarn lint:fix`       | ESLint, including architecture boundary rules                                                                 |
| `yarn format` / `yarn format:check` | Prettier                                                                                                      |
| `yarn test` / `yarn test:watch`     | Unit tests (Vitest)                                                                                           |
| `yarn test:integration`             | Integration tests (`*.int.test.ts`) against the compose PostgreSQL (uses its own `_test` databases and roles) |
| `yarn verify`                       | Typecheck, lint, format check and tests — run before every commit                                             |

## HTTP API

| Endpoint                   | Purpose                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /health/live`         | Liveness: the process is up (never touches dependencies)                                                    |
| `GET /health/ready`        | Readiness: dependencies answer (`503` when not) — no details are exposed                                    |
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
