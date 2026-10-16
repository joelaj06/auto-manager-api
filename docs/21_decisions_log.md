# 21 — Decisions Log

Product name (as given): **Autoforce Manager**.
Answers from the product owner to [19_open_questions.md](19_open_questions.md), recorded 2026-10-13. Each decision lists its impact and the docs it changes.

## Decisions

| # | Question | Decision | Impact |
|---|---|---|---|
| 1 | Market | **Ghana** (targeted) | GHS default, GH VAT, MoMo, DVLA terms. Multi-country stays a design consideration, not a build item |
| 2 | First segment | **Roll out everything** | All modules are in scope. Phasing in doc 18 decides *order*, not *whether* |
| 3 | Existing data | **Test data only, expected to be lost** | **No data migration.** Greenfield schema. All "migration of existing data" sections become informational |
| 3b | Database | **PostgreSQL** (replaces MongoDB) | Biggest change. See [22](22_postgresql_architecture.md). Docs 03, 05, 17 partly superseded |
| 4 | Clients | **Mobile app exists; web portal planned** | `/api/v1` contract must serve both. Mobile app needs updating to the new contract (see open question in 19) |
| 5 | Pricing | **Monthly subscription, priced by number of branches** | Entitlement = branch count (not vehicle count). See doc 02 §6 (revised) |
| 6 | Work & Pay cases | **All outlined cases** | Arrears, penalties, restructure, early settlement, default, repossession, completion — all in scope |
| 7 | Transfer letter | **System must produce a transfer letter of agreement, signed by both driver and car owner** | E-signature + document engine. See [24](24_documents_and_esignatures.md) |
| 8 | Remittance target | **Depends on the business**; fixed target is **optional**, drivers/owners can opt in | Remittance mode per assignment: `fixed_target` / `variable` / `none`. Doc 09 updated |
| 9 | Multiple drivers per vehicle | **No** | One open assignment per vehicle (simple partial unique index). Shift model dropped |
| 10 | Rentals | **All options** (class/vehicle booking, self-drive + chauffeur, corporate) | Doc 07 as written |
| 11 | Dealers | **Track and record all** (imports, landed cost, consignment) | Docs 10–11 as written |
| 12 | VAT | **Support VAT based on Ghana rates / per business** | Configurable tax codes with effective dates. See doc 13 §6 (revised) |
| 13 | Parties | **Separate tables** (customers, drivers, suppliers) | As proposed in doc 05 |
| 14 | Hosting | **Container host on a VPS** | Docker-based deployment. See [22 §10](22_postgresql_architecture.md) |
| 15 | Redis | **Yes** | Cache / rate limiting. Job queue can be Postgres-based or Redis-based (22 §6) |
| 16 | Payments between a tenant and its customers/drivers | **Record only** — tenants do not process those payments through the system | No payment links/gateway/webhooks/provider keys for tenant-side collection. Finance module is a *recording* ledger (doc 13). **Does not cover our subscription fee — see decision 27** |
| 17 | SMS | **Tenant's own account** | Tenant configures their SMS provider and sender ID; we don't sell credits. Doc 15 revised |
| 18 | Tenant resolution / mobile | **Shared domain.** Web portal shows a **QR code** containing the backend URL; scanning also triggers a **deep link** to download/open the app | See [23](23_mobile_onboarding_qr_and_deeplinks.md) |
| 19 | Keep Mongo? | **No — PostgreSQL** | Same as 3b |
| 20 | `/api/v1` | **Yes** | New versioned API |
| 21 | Web dashboard repo | **None yet. Backend first, then frontend** | Backend design must be API-complete before frontend work. OpenAPI becomes the contract |
| 25 | Currency selection | **Tenant level** | No per-user display currency. Doc 20 §14 closed |

## Round 3 decisions (2026-10-13)

| # | Topic | Decision | Impact |
|---|---|---|---|
| 30 | Platform ("super admin") console | We need a **dedicated console** to monitor the system, **accept/approve new tenants**, **suspend / deactivate / restore** tenants, **add / remove / deactivate branches (shops)**, and anything else the platform managers need. Additional suggestions welcome | New [27](27_platform_admin_console.md). Signup becomes an *application* that staff approve; the tenant DB is created **after approval** (doc 22 §2.6 updated) |
| 31 | Tenant roles & permissions | **Tenants can define roles with permissions for their users. Permissions are seeded from the database when a tenant is created.** Suggestions welcome | New [28](28_tenant_roles_permissions_and_seeding.md): authoritative permission catalogue in the platform DB, copied into each tenant DB at provisioning, system roles locked, custom roles tenant-owned, catalogue sync on releases |

## Round 4 decisions (2026-10-13)

| # | Topic | Decision | Impact |
|---|---|---|---|
| 32 | Console proposals (docs 27, 28) | **Accepted as proposed** ("good with everything"): manual approval of new tenants at launch (auto-approve rules later), mandatory MFA, four-eyes on dangerous actions, system roles as listed, new permissions off by default in custom roles until the owner opts in | Docs 27/28 stand, with the changes below |
| 33 | Platform staff & resellers | **Staff = anyone given credentials to the console** (management, monitoring). **Resellers can be given console accounts** because the console handles tenant signup/creation | Console users have a `user_type` (`staff` / `partner`). Partner accounts are scoped to the tenants they referred. Custom staff roles allowed (Super Admin creates them). Doc 27 §1, §3.2, §4, §6 |
| 34 | Support access to a tenant | **No consent needed; any console user with the permission can do it; there must be a trail** | No tenant consent or approval step. Mandatory reason, time-box, immutable per-request trail. Doc 27 §3.8 |
| 35 | Meaning of "deactivated" | **Tenant deactivated → nobody in that tenant can access the entire system. Branch deactivated → nobody can access that branch/shop.** | Doc 27 §3.3 and §3.5, doc 28 rule 14, doc 23 tenant-config `status` |
| 36 | Deleting tenants | **Tenants are never deleted — they are deactivated so they can be restored** | Hard delete and scheduled deletion removed from the console and lifecycle. Optional *cold archive* instead (still restorable). Backups of deactivated tenants are retained. Docs 22, 25, 26, 27 updated. Legal erasure requests are a separate, controlled path (see doc 19 round 5) |
| 37 | Console hosting | **Yes** to the proposal: separate `admin.<domain>`, own auth, MFA, IP allow-list/VPN where possible | Doc 27 §2 |

## Round 5 decisions (2026-10-13)

| # | Topic | Decision | Impact |
|---|---|---|---|
| 38 | Billing-driven lifecycle | **Deactivation and reactivation are automated from billing.** Reminders go out as the billing date approaches. A tenant can request an extension and platform staff can extend it to a set date. **Staff deactivate/activate manually only in special cases** | New [25 §5](25_platform_billing_and_subscriptions.md): automated schedule, auto-deactivate, auto-restore on payment, extension workflow, manual lock, safeguards (dry run, circuit breaker, gateway-health guard) |
| 39 | Non-payment deactivation | **Billing is paused while deactivated for non-payment, until the tenant pays to be restored.** `suspended` is retired as a separate state — non-payment (and special cases) are `deactivated` with a reason | Docs 25, 27, 04, 02, 23 updated. A narrow exception applies: users with billing permission can sign in to the **Billing tab only** (decision 51) so they can pay |
| 40 | Resellers | **A reseller can view all the tenants they brought on board with their commissions. Commission terms are adjustable by the Super Admin, set on the reseller's profile, and differ per reseller** | New [29](29_reseller_partner_program.md) |
| 41 | Cold archive and erasure-by-anonymisation | **Yes — proceed for now; may change later** | Provisional. Docs 26 §8, 27 §3.3/§3.15 stand |
| 42 | Remaining round-5 defaults | **"Yes"** — read as accepting my proposed defaults for branch reactivation (owner self-service, with prerequisites cleared), waiving Work & Pay penalties for a deactivation gap by default, and support access limited to console users who hold the permission (never resellers). *Interpretation — please correct if you meant something else* | Docs 27 §3.3, §3.5, §3.8 stand as written |

## Round 6 decisions (2026-10-14)

| # | Topic | Decision | Impact |
|---|---|---|---|
| 43 | ~~Billing page for unpaid tenants~~ **(superseded by decision 51)** | **The billing page is public but addressed to a tenant** (no login; URL identifies the tenant) | [25 §5.2](25_platform_billing_and_subscriptions.md) rewritten: `https://<billing-domain>/pay/<tenantSlug>`; shows only low-sensitivity info; anyone can pay; extension requests need a one-time code. Replaces the login-based "billing-only page" |
| 44 | Extension length | **Maximum 10 days** per extension | Doc 25 §5.4. Other limits stay as proposed (2 per 90 days, no auto-approval) until changed |
| 45 | Billing notification channels | **Email, SMS, and in-app notification (banner + normal/push notification)** | Doc 25 §5.1. WhatsApp dropped for billing notices. Platform-owned sender, platform pays for SMS |
| 46 | Reseller commission types and payout timing | **Two commission types: Standard and Enterprise. Payout happens after the customer/client makes a payment (licence purchase).** *Reading: the type follows the tenant's plan/licence; each reseller's profile holds a rate for each type; commission becomes payable as soon as the client's payment is confirmed (no long hold).* | [29](29_reseller_partner_program.md) §4–5 updated. Whether it applies to every renewal or only the first licence purchase is open (Q65) |
| 47 | Reseller capabilities | **"Yes", but each of these should be a permission the product owners can grant** | Doc 29 §7: per-reseller grantable permissions (e.g. see owner contact, see fee amounts, export, create assisted signups), set by Super Admin on the reseller profile |
| 48 | Subscription price structure | **Flat for now** (flat price per branch) | Docs 02 §6, 25 §1. *Read as the pricing answer (Q29); say if you meant the commission rate form* |

Unanswered round-6 items (schedule days, restart rule, commission tax) stay at my proposed defaults, marked as proposals in [19](19_open_questions.md).

## Round 7 decisions (2026-10-14)

| # | Topic | Decision | Impact |
|---|---|---|---|
| 49 | Commission rule | **Commission applies only to the first-time licence purchase, and it is a percentage** | Doc 29 §4: no renewals, no bounties/fixed amounts/tiers; one percentage per type per reseller |
| 50 | Enterprise licence | **Flagged by the Super Admin.** Priced differently from the flat rate, **based on number of branches, business size and the other costs involved in setup** | Doc 25 §2.1: quote builder with recurring and one-time line items; licence-type flag locked after first payment; docs 27, 29, 02 updated |
| 51 | How tenants pay / reminders | **Reminders carry no invoice reference. Tenants sign in to make payment, so they can use the Billing tab (including previous transactions). No dedicated public billing address.** | Supersedes 43. Doc 25 §5.2 rewritten: Billing tab with `billing.view`/`billing.manage`; for non-payment deactivation, sign-in is allowed to the **Billing tab only** (narrow exception to decision 35 — confirm, Q72) |
| 52 | Reseller payout methods | **Any method, including cash, but always with a record** | Doc 29 §5.1: MoMo/bank/cash/cheque/other, required proof per method, reseller acknowledgement for cash, controls |

Unanswered (proposals stand): extension frequency limit (2 per 90 days), the schedule days, billing restart on payment date, tax on commissions.

## Round 8 decisions (2026-10-14)

| # | Topic | Decision | Impact |
|---|---|---|---|
| 53 | Enterprise quote | **Built by hand** | Doc 25 §2.1, doc 27 §3.6: free-form line items, no formula engine; business size is a judgement note |
| 54 | Commission base | **Licence amount only** | Doc 29 §4.3: only lines flagged `counts_as_licence`; setup/onboarding/other costs never commissionable; the per-reseller "include setup fees" switch is removed |
| 55 | Billing-only sign-in | **Confirmed** | Decision 51 stands: tenants deactivated for non-payment/trial expiry can sign in to the Billing tab only |
| 56 | Cash payouts to resellers | **"Any amount"**. *Read as: every cash payout needs a second approver, whatever the amount (threshold 0, configurable). If you meant that no approver is needed for any amount, say so.* | Doc 29 §5.1, doc 27 §8 |
| 57 | First purchase refunded | **The reseller loses the commission.** *Assumed: the tenant's next paid licence invoice then becomes its first purchase.* | Doc 29 §4.3 |

## Round 9 (2026-10-14)

| # | Topic | Decision | Impact |
|---|---|---|---|
| 58 | Implementation plan | **Proceed with an implementation plan grouped in phases.** Written as [30](30_implementation_plan.md): phases 0–9, milestones M0–M6, commercial launch at M3 (phases 0–4). *Planning only — implementation has not started and no existing code has been changed.* | Doc 18 superseded. Implementation begins only when you say to start Phase 0 and the pre-Phase-0 inputs (doc 30 §8) are answered |

## Round 10 (2026-10-14)

| # | Topic | Decision | Impact |
|---|---|---|---|
| 59 | Repository | **No new repository.** The app is not live, so unneeded code in this repo is overridden | Doc 30 §3, P0-1: legacy Mongo code, `dist/`, `vercel.json` and the auto-staging pre-commit hook are removed in place |
| 59b | Mobile apps | **Android and iOS apps are not published yet and will be updated later with the new features** | No API compatibility work; package/bundle IDs needed only for P1-9 |
| 60 | Commits | **Never commit automatically.** The product owner inspects and commits; Claude suggests a commit message after each implementation step | Doc 30 §8.1 working agreement |
| 61 | Start | **Tell the product owner when ready to start; they give the go-ahead** | Doc 30 §8.4: ready for Phase 0 once told |

## Engineering decisions during implementation

| # | Topic | Decision | Why |
|---|---|---|---|
| 62 | Toolchain (P0-1) | **Native ESM project on Node 24, TypeScript 6.0, Vitest, plain composition-root DI (no Inversify), Yarn 1** — *DI part superseded by decision 67* | Key dependencies (pg-boss, Inversify 8, jose, zod 4) are ESM-only; Jest's ESM support is still experimental. Inversify needs decorator metadata that the fast ESM tools (tsx, Vitest) don't emit, so dev/test could behave differently from production. TypeScript is held at 6.0 because typescript-eslint and ts tooling don't support TS 7 yet. *Proposed by Claude; reversible — say if you prefer otherwise* |

## Round 11 (2026-10-14)

| # | Topic | Decision | Impact |
|---|---|---|---|
| 63 | Hosting | **Not deploying to a VPS now. Everything runs locally until the product owner says hosting is available** | P0-3 (infrastructure) deferred; P0-4 split into a local part (tooling + restore tests now) and a production part (off-site WAL archiving, schedules, alerts — later). CI still builds, scans and publishes the image to GHCR, which is not a deployment. M0 is reached locally |

## Engineering decisions during P0-5 (2026-10-14)

| # | Topic | Decision | Why |
|---|---|---|---|
| 64 | Query layer | **Plain `pg` (node-postgres) with small typed helpers** for the database foundation; the Drizzle-vs-Kysely choice is made in P1-5 when the first module tables arrive | The foundation is mostly DDL, migrations and connection management, where an ORM adds nothing; keeps the choice open with real module code in hand |
| 65 | Local ports | **PostgreSQL on 54320, Redis on 63790** in `compose.yaml` and `.env.example` | Port 5432 was already used by another project's container on the development machine; the non-default ports let both run side by side |
| 66 | Database roles | **Login roles are members of group roles `af_platform_rw` / `af_tenant_rw`**; migrations grant to the groups | Migrations stay independent of login names (tests use their own login roles against the same grants) |

## Architecture style (2026-10-14)

| # | Topic | Decision | Impact |
|---|---|---|---|
| 67 | Dependency injection | **Inversify container** (product owner's choice). *Implementation:* classes carry no decorators; bindings use `toResolvedValue(factory, [tokens])` in `framework/dependency-injection/container.ts`; singletons by default; resources released through `onDeactivation` + `unbindAllAsync()` | Supersedes the "plain composition root" part of decision 62. Inner layers stay free of the DI framework and behave the same under tsc, tsx and Vitest |
| 68 | Code organisation | **Clean Architecture (onion), OOP, layer-first folders** following the product owner's reference project: `src/{domain, application, adapters, infrastructure, framework}` with `index.ts` / `worker.ts` entries; `I`-prefixed port interfaces in `application/ports` and repository interfaces in `domain/repositories`; use cases as classes in `application/use-cases/<area>`; `Postgres*` implementations in `infrastructure/database` | Supersedes the module-first layout of doc 03 §1. P0-5 restructured accordingly. ESLint enforces the onion (inner layers never import outer ones; domain/application import no third-party packages; production code never imports framework/ or testing/) |

## Engineering decisions during P0-7 (2026-10-16)

| # | Topic | Decision | Why |
|---|---|---|---|
| 69 | Access-token keys | **HS256 with a key per tenant derived by HKDF-SHA256** from `TENANT_JWT_SECRET` (context `tenant:<id>`); the platform console uses its own secret and audience | A token can only verify for the tenant in its `tid`, even if a bug skipped the tenant check; one secret to manage. Asymmetric keys (EdDSA) can replace it if other services must verify tokens |
| 70 | Revocation model | **Stateless access tokens (15 min) + permission version check on every request** (cached ≤ 15 s); refresh tokens rotate and are checked against the session row | Logout stops refresh at once; disabling a user or editing roles bumps the version and rejects existing access tokens within seconds — without a session lookup per request |
| 71 | Route access | **Every route must declare `access`** (`public` / `tenant` / `authenticated` + catalogue permission); the router refuses to mount protected routes without the guard, and a test checks every route and limits public routes to an allow-list | Implements "no endpoint ships without a permission" (Phase 0 exit criterion) at compile time and in CI |
| 72 | Tenant addressing | **`X-Tenant` header (slug), optional on authenticated requests** — the token's `tid` decides, a different header is rejected | Works the same for the mobile app and the web portal; subdomain resolution is added with the portal hosting |

## Engineering decisions during P0-8 (2026-10-16)

| # | Topic | Decision | Why |
|---|---|---|---|
| 73 | Job queue (open question 32) | **pg-boss** in the platform database — the default listed in doc 30 §8.3 | One less moving part than BullMQ + Redis; jobs can be enqueued in the same transaction as platform rows (schedule ledger, email deliveries). Redis stays for cache/rate limits. *Reversible: say if you prefer BullMQ* |
| 74 | Queue schema ownership | **The migrator installs and upgrades the pg-boss schema during `db:migrate`; the app role gets DML only** (`migrate: false`, `reindex: false`). Queues are non-partitioned, so creating one needs no DDL | Keeps decision 66: the running app can never change schemas |
| 75 | Event delivery | **At-least-once with idempotent handlers.** Outbox rows are drained into one `event.deliver` job per subscribed handler; handlers record `event:<handler>:<eventId>` in `processed_messages` in the same transaction as their changes. Side effects outside the tenant DB are enqueued as their own idempotent jobs | No distributed transaction exists between tenant and platform DBs; this makes duplicates harmless instead of trying to prevent them |
| 76 | Tenant scheduling | **15-minute tick; each daily job runs once its local hour is reached, once per (tenant, job, local date)** via `tenant_schedule_runs`, written in the same transaction as the job | Tenants can be in different timezones; a missed tick (deploy, outage) catches up the same day |
| 77 | Platform email content | **Rendered at request time, stored until sent, then erased**; the delivery row remains | Emails can contain one-time codes and links; nothing sensitive stays at rest longer than needed |

## Engineering decisions during P0-9 (2026-10-16)

| # | Topic | Decision | Why |
|---|---|---|---|
| 78 | Integration test infrastructure | **Testcontainers by default** (PostgreSQL 18 + Mailpit per run, data on tmpfs); `TEST_INFRA=external` for the compose stack, and CI keeps its service containers | Tests never depend on or touch development data, and need nothing started by hand; CI stays fast with pre-started services |
| 79 | Isolation coverage | **Every tenant table needs an isolation fixture or a written exemption**, enforced by a test that discovers tables from the migrated template | Isolation tests cannot silently fall behind the schema (docs/04 §13) |
| 80 | Runtime regular expressions | **Banned in production code by ESLint** (`no-restricted-syntax`); search uses SQL with escaped input | Audit C7 (ReDoS / regex injection) cannot come back |
| 81 | Load testing | **k6 scripts in `load/k6`**, run with a local k6 or the pinned `grafana/k6` image; profiles smoke/load/stress | No install needed; the same scripts run against staging once hosting exists |

## Engineering decisions during P0-4, local part (2026-10-16)

| # | Topic | Decision | Why |
|---|---|---|---|
| 82 | Backup encryption | **Client-side, public-key**: each file gets a fresh AES-256 key wrapped with an RSA-4096 public key (OAEP-SHA-256) and is sealed in 64 KiB AES-GCM chunks (STREAM construction). The private key and its passphrase live off the server | The server (or anyone who compromises it) can create backups but not read them; tampering, truncation and reordering are detected. Built on Node's crypto, so no extra binary is needed |
| 83 | Backup consistency checks | **Dump on an exported snapshot and count every table's rows in that snapshot**; the restore test compares counts exactly | Turns "the restore worked" into "the restore contains exactly what was backed up" |
| 84 | Backup role | **Dedicated `backup` login role** (group `af_backup`, `pg_read_all_data`), CONNECT on every application database | Backups never run with write privileges (doc 22 §2.4) |
| 85 | Restores | **Only into a new database**; switching a tenant to it is a manual runbook step. The tooling drops only its own `rv_` scratch databases | A restore can never destroy live data by mistake |
| 86 | PostgreSQL client tools | **From the PATH or the `postgres:18-alpine` image** (`BACKUP_PG_TOOLS=local\|docker`) | The app image is distroless, so the tools can't live there; they must match the server's major version |

## Consequences in one page

1. **Rewrite the persistence layer on PostgreSQL**, from a clean schema. Keep the clean-architecture shape and Inversify, replace Mongoose models and repositories. No data to carry over means no migration risk and a chance to fix every model-level bug at the root.
2. **Database per tenant on PostgreSQL** (decision 26, doc 22 §2). Strong isolation and trivial per-tenant backup/restore/export/delete, at the cost of connection management, migration fan-out and catalog overhead — all addressed in doc 22 (plan ≈1,000 tenants per cluster, then add clusters).
3. **Tenant-side payments are recorded, not processed.** The finance module keeps invoices, receipts, allocations, ledger and cash sessions.
4. **Platform billing is a real payment flow** (decision 27, doc 25): tenants pay their per-branch subscription in the app/portal via a gateway.
4b. **Backups are a P0 deliverable** (decision 29, doc 26).
5. **Documents with signatures** become a first-class capability (transfer letter, W&P agreement, rental agreement, sales agreement).
6. **Mobile onboarding via QR + deep link** needs a public tenant-config endpoint and a verified link format (doc 23).
7. **Pricing by branch** makes `branches` a billing entity: add/remove branch = proration event.
