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
yarn storage:setup   # object storage buckets for files (idempotent)
yarn dev
```

Local services use non-default host ports (PostgreSQL **54320**, Redis **63790**) so they don't
clash with other projects. Object storage (RustFS, S3-compatible) listens on **9000**.

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
| `yarn load:seed` / `yarn load:tenant` | A seeded tenant on a local database, then k6 back-office reads and payments as its owner (start the API with a high `RATE_LIMIT_MAX`); figures in docs/33 §7      |
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

Console views: `GET /dashboard` (tenants by status, applications waiting, trials ending,
failures), `GET /health` (database, jobs, email, backups, migrations — each `ok`/`warning`/
`critical`), `GET /tenants?status&q&tag` and `GET /tenants/:id` (360° profile with usage counts
read from the tenant database), `/tenants/:id/timeline`, `/tenants/:id/notes`,
`PUT /tenants/:id/tags`, `GET /backups[/summary]`, `GET /migrations`,
`GET /audit-logs/export` (CSV).

Resellers (docs/29): staff manage partners under `/partners` (create, edit, pause/resume,
terminate, `PUT /partners/:id/capabilities`, `POST /partners/:id/users/invitations`,
`/partners/:id/tenants`) and attribution with `PUT /tenants/:id/partner`. A partner's users sign
in like staff (password + authenticator) and use `/partner/*` only: dashboard, profile and
referral link, tenants, applications (assisted signup, answering information requests) and,
if granted, colleagues. Public signups with `referralCode` are attributed to the partner.

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

## Files

Files are uploaded straight to S3-compatible storage with pre-signed URLs (no file bytes pass
through the API): `POST /api/v1/files/uploads` (`kind`, `filename`, `contentType`, `sizeBytes`) →
`PUT` the bytes to `upload.url` with exactly `upload.headers` → `POST /api/v1/files/:id/complete`
(the size and the real file type are checked; a mismatch is refused and deleted). Public files
(the business logo, `PUT /api/v1/organisation/logo`) are served from the public bucket or a CDN
(`FILES_PUBLIC_BASE_URL`); private files only through short-lived signed links. Applicants attach
KYC documents with `/api/v1/applications/:id/documents` (X-Application-Token); staff see them at
`/api/platform/v1/applications/:id/documents`; partner documents live under
`/api/platform/v1/partners/:id/documents`. Abandoned uploads are removed daily.

## Money, currencies, tax and reference data

Amounts are integer **minor units** of a currency (`GET /api/v1/currencies` lists minor units);
send amounts as decimal strings (`"1250.50"`), read them as `{ amountMinor, currency, formatted }`.
Settings: `/api/v1/settings/currency` (base currency locked once money is recorded),
`/api/v1/settings/tax` and `/api/v1/tax-codes` (each business enters its own rates; codes need
rates before they can be activated; `POST /tax-codes/:code/preview` shows the result),
`/api/v1/fx-rates` (manual rates), `/api/v1/expense-categories`,
`/api/v1/reference/vehicle-makes`.

## Vehicles

`/api/v1/vehicles` is the register, scoped to your branches: register, edit, transfer between
branches (`POST /vehicles/transfer`), remove mistaken entries (`DELETE` with a reason). Statuses
change through `POST /vehicles/:id/status` only between states no module owns
(`GET /api/v1/vehicle-statuses` lists the lifecycle); every change is kept in
`/vehicles/:id/status-history`. Per vehicle: `/documents` (with scans and compliance),
`/odometer`, `/photos`, `/overview` and `/timeline`; across the fleet: `/vehicles/compliance`.
Groups are at `/api/v1/vehicle-groups`, settings (required documents, reminders, custom fields)
at `/api/v1/settings/vehicles`. CSV: `GET /vehicles/import/template`, `POST /vehicles/import`
(`{ csv, commit }` — a preview unless `commit`, and all rows or none) and `GET /vehicles/export`.
Cost and book value appear only with `vehicles.financials.view`.

## Drivers, customers and suppliers

`/api/v1/drivers` (scoped to your branches) registers drivers as applicants; they become active
through `POST /drivers/:id/activate` once `/drivers/:id/onboarding` is complete, and are
suspended, reinstated, terminated or rehired with a reason (`/suspend`, `/reinstate`,
`/terminate`, `/rehire`). Guarantors are at `/drivers/:id/guarantors`; licences expiring soon at
`/drivers/expiring-licences`; the onboarding rules at `/api/v1/settings/drivers`.
`/api/v1/customers` holds individuals and companies for every branch, with
`POST /customers/:id/risk` to watch, blacklist or clear them. `/api/v1/suppliers` lists who the
business buys from. Identity documents and scans (`…/documents`) need the sensitive
`drivers.documents.view` or `customers.id_documents.view`; without them Ghana Card numbers are
masked.

## Assignments

A vehicle has at most one driver and a driver at most one vehicle. `POST
/api/v1/vehicles/:id/assignment` hands an available vehicle to an active driver with the handover
checklist (`GET /api/v1/settings/assignments` lists its items), the odometer and the remittance
terms; `/assignment/end` takes it back, `/assignment/handover` changes the driver in one step and
`PATCH /assignment/terms` changes the terms. `/api/v1/assignments?open=true` is the current board;
`/vehicles/:id/assignment-at?at=…` says who had the vehicle at a given time.

## Finance (record only)

Tenants record money; they never process it (decision 16). Every event posts a balanced journal
entry in the base currency (`/api/v1/ledger/trial-balance`, `/ledger/lines`,
`/ledger/parties/:type/:id`); posted lines cannot change, corrections are reversals, and
`PUT /ledger/period-lock` closes past periods. `/api/v1/invoices` drafts, issues (with the
business's tax codes — Ghana businesses start with VAT 15% + NHIL 2.5% + GETFund 2.5% from
2026-01-01, editable at `/api/v1/tax-codes`) and voids invoices. `/api/v1/payments` records
money in (to the payer's credit, allocated to invoices) and out (refunds, expenses), with
receipts at `/payments/:id/receipt`. Cash goes through `/api/v1/cash-sessions`.
`GET /api/v1/ledger/integrity` checks the books (entries balanced, allocations adding up, the
work and pay sub-ledgers agreeing with their accounts); every backup restore test runs the same
checks (docs/31 §4).

## Expenses

`/api/v1/expenses` enters expenses (split across vehicles with `vehicleIds` or `split`), and
`/submit`, `/approve`, `/reject`, `/pay` and `/void` move them along; receipts are attached at
`/expenses/:id/receipts`. Approval rules (`/api/v1/expense-approval-rules`) can approve small
spend automatically; approvers stay within their role's `max_amount_minor` limit. Fuel fills go
to `POST /api/v1/vehicles/:id/fuel` (efficiency at `GET …/fuel`), budgets to `/api/v1/budgets`,
recurring expenses to `/api/v1/recurring-expenses` (created by the daily tenant job).

## Remittances and the driver ledger

Fixed-target assignments get one remittance row per period from the daily tenant job
(`/api/v1/remittances`). Drivers or staff declare what was paid
(`POST /remittances/:id/submissions`), a supervisor approves (`…/approve`, which records the
payment) or rejects it; staff can record money directly (`/record`) and waive shortfalls
(`/waive`). Variable-mode drivers declare a period with `POST /remittances/declare`.
`GET /api/v1/drivers/:id/ledger` is the driver's statement, `POST …/ledger/adjustments`
charges or credits them, and `GET /api/v1/operations/board` is the morning board.

## Dashboards

`GET /api/v1/dashboards/overview`, `/dashboards/vehicles`, `/dashboards/remittances` and
`/dashboards/expenses` take `from`, `to` (business dates, default this month to date), `branchId`
and `groupBy` (`day`, `week` — ISO, Monday–Sunday — or `month`). `GET /api/v1/vehicles/:id/profit`
is one vehicle's P&L with its trend. Vehicle figures come from `daily_vehicle_stats`, which the
daily tenant job and each read bring up to date; `POST /api/v1/dashboards/stats/rebuild` forces it.

## Notifications

Each business connects its own SMS account (`PUT /api/v1/settings/notifications/sms` — Hubtel,
Arkesel or mNotify; `POST …/sms/test` sends a test) and tunes the reminder rules, quiet hours and
the remittance cut-off time with `PATCH /api/v1/settings/notifications`. Staff read their
notifications at `GET /api/v1/notifications` (`/unread-count`, `POST /notifications/read`), and the
staff app registers for push with `POST /api/v1/me/push-devices`. `GET /api/v1/notification-deliveries`
is the log of SMS, push and email sent. Locally `PUSH_PROVIDER=log` writes pushes to the API log;
`PUSH_PROVIDER=fcm` with `FCM_SERVICE_ACCOUNT_FILE` sends them through Firebase.

## Driver app and PDFs

Staff give an active driver an app login with `POST /api/v1/drivers/:id/app-access` (QR to scan,
SMS and email invitation; `DELETE` takes it away). Signed in with their phone number, the driver
uses `/api/v1/me/driver` (home), `/vehicle`, `/ledger` and `/ledger/statement.pdf`,
`/payments/:id/receipt.pdf`, `/remittances` (declare what was paid), `/fuel` and `/issues`.
Staff handle reported issues at `/api/v1/vehicle-issues` and print receipts
(`/api/v1/payments/:id/receipt.pdf`) and statements (`/api/v1/drivers/:id/ledger/statement.pdf`).

## Documents and templates

`GET /api/v1/document-types` lists the documents the system issues with their fields and locked
clauses. Businesses write their own template versions (`/api/v1/document-templates`: drafts,
`/preview` PDF with sample data, `/:id/activate`); locked clauses must stay unchanged. Documents
are issued by the modules — `POST /api/v1/assignments/:id/handover-document` for now — rendered to
an immutable PDF in the background (`/api/v1/documents/:id/download`) and checked by anyone with
the verification code: `GET /api/v1/public/documents/:code?sha256=…` with `X-Tenant`.

## Signing documents

Documents issued with signers wait for their signatures. Anyone signed in sees theirs at
`GET /api/v1/me/signatures` and signs with `POST …/:signerId/code` then `…/sign` (code, drawn PNG,
consent); guests use their link's token with `POST /api/v1/public/signing/{open,code,sign,decline}`
and `X-Tenant`. Staff hand out new links (`/documents/:id/signers/:signerId/link`, with QR),
remind (`/documents/:id/remind`) and record paper signatures by their scan. The signed copy with
its signature record page downloads with `/documents/:id/download?copy=signed`.

## Work & Pay

`POST /api/v1/workpay/simulate` tries terms (price by multiplier, markup or total; deposit;
instalments daily, weekly or monthly; the remainder on the last instalment). Agreements are
drafted at `/api/v1/workpay/agreements`, sent for signature (`/:id/send-for-signature`: the
agreement document for the owner, driver and guarantors), paid a deposit (`/:id/deposit`) and
started once signed (`/:id/activate`: the schedule begins and the vehicle is handed over).
Drivers see their agreement at `/api/v1/me/driver/workpay`.

Instalments are paid at `POST /api/v1/workpay/agreements/:id/payments` (late fees first, then the
oldest instalments, the rest in advance). `GET …/:id/balance` shows what is outstanding, overdue
and due now; `GET …/:id/payments` what each payment paid. The tenant's daily job marks
instalments overdue after the grace days, charges the agreement's late fee and moves the
agreement to in arrears, defaulted or completed (`?status=in_arrears,defaulted` lists them).
Instalments and late fees are waived with a reason at `…/instalments/:number/waive` and
`…/penalties/:penaltyId/waive`. Reversing a payment in finance puts what it paid back as owed.

A running agreement can get a payment holiday (`…/:id/payment-holiday`) or be restructured
(`…/:id/restructure`); `…/:id/reschedules` keeps the history. `GET …/:id/closing-figures` shows
the payoff; `POST …/:id/settlement-quotes` quotes it and `POST …/:id/settle` pays it off.
Agreements are ended with `…/:id/terminate` or `…/:id/repossess`, and the vehicle goes off the
road and back through `…/:id/downtime` and `…/:id/downtime/end`. With the `driverExpenses`
setting on `agreement`, costs the driver bears (maintenance, tyres, insurance by the agreement)
are added to the agreement.

When an agreement is paid in full its transfer letter goes out for the owner and the driver to
sign (`GET …/:id/transfer`; corrections with `POST …/:id/transfer-letter`). Once both signed, the
vehicle is transferred to the driver. The DVLA change of ownership is tracked at
`PATCH …/:id/transfer/dvla`, with papers attached at `…/:id/transfer/papers`; the driver
downloads the letter at `/api/v1/me/driver/workpay/:id/transfer-letter`.

Statements: `GET …/:id/statement` (and `statement.pdf`), for drivers at
`/api/v1/me/driver/workpay/:id/statement(.pdf)`. The portfolio dashboard
(`/api/v1/dashboards/workpay`) shows collections, PAR 7/30/60/90, ageing, the collection rate and
the forecast; `/api/v1/dashboards/workpay/arrears` lists who is behind. Due, overdue, guarantor,
default, payment and milestone messages are rules in `/settings/notifications` (`workpay_*`).

## Subscriptions and billing (manual for now)

Every tenant starts on a **standard trial** when provisioned. Staff set the standard price per
branch (`PUT /api/platform/v1/billing/plans/standard/price`, step-up), issue each period's invoice
(`POST /api/platform/v1/tenants/:id/invoices`) and record payments received
(`POST /api/platform/v1/billing/invoices/:id/payments`). A fully paid invoice activates the
subscription and the tenant. Tenants read their Billing tab at `/api/v1/billing/*`. Branches
beyond the subscription are refused with `ENTITLEMENT_BRANCH_LIMIT` (or added with
`confirmBranchPurchase: true` once paying). Amounts are in pesewas (minor units).

## Mobile app connect

`GET /api/v1/mobile/connect-link` returns the business's signed connect link and QR code (SVG)
for the web portal; scanning it opens the app (or `/connect`, which offers the store). Links are
signed with an Ed25519 key (`yarn mobile:keygen`, then `MOBILE_CONNECT_KEY_FILE`); locally a fixed
development key is used. Invitation emails include an app link. Payload format: docs/23 §11.

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
| End to end        | `src/framework/e2e`                               | Money through every beta module (remittances, invoices, a work and pay agreement to ownership transfer) with the integrity checks after every step, then a backup restored and verified                                                                                                                                                                                    |
| OWASP             | `src/framework/security/owasp.int.test.ts`        | The automatable OWASP Top 10 checks: access control across branches and drivers, tokens, enumeration, injection, mass assignment, headers, CORS, limits, uploads, brute force (review: docs/32)                                                                                                                                                                            |

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
