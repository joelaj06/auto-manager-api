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

## Engineering decisions during P1-1 (2026-10-16)

| # | Topic | Decision | Why |
|---|---|---|---|
| 87 | Staff MFA | **TOTP now (RFC 6238, built on Node crypto), passkeys (WebAuthn) later in Phase 1** when the console UI exists. TOTP secrets encrypted at rest with `MFA_ENCRYPTION_KEY`; each code usable once | Satisfies "MFA mandatory" without a browser client; no extra dependency for a ~60-line algorithm verified against the RFC test vectors |
| 88 | Console sessions | **Session row checked on every console request** (idle 60 min, max 12 h, access tokens 10 min) — unlike tenant requests, which rely on the permission version | Few staff, high privilege: sign-out, disabling and idle expiry must take effect at once |
| 89 | Step-up | **Automatic from the catalogue**: any route whose platform permission is marked `sensitive` needs a password + code re-check within the last 10 minutes | The rule lives next to the permission, so new sensitive routes cannot forget it |
| 90 | Four-eyes | **Approval requests with registered executors**; the approver must be a different staff member (enforced in code and by a DB check), may need a specific system role, and approving runs the action in the same transaction behind a savepoint. Requests expire after 24 h | One mechanism for every dangerous action in docs/27 §8; a failed action is recorded as `failed` and never half-applied |
| 91 | First Super Admin | **Created with `yarn platform:invite-admin` on the server** (also the recovery path); staff can never invite a Super Admin directly — granting it needs another Super Admin's approval | No self-registration of staff (docs/27 §2) and no single person can create a new Super Admin |
| 92 | Staff escalation | **Non-Super-Admins can assign or define only roles within their own permissions**; nobody changes their own roles or account; the last active Super Admin cannot be disabled or demoted | Prevents privilege escalation and lock-out |
| 93 | Invitation links | **Token in the URL fragment** (`/accept-invitation#token=…`), stored only as SHA-256, single use, 72 h | Fragments are not sent to servers, so tokens do not end up in proxy or access logs |

## Engineering decisions during P1-2 (2026-10-16)

| # | Topic | Decision | Why |
|---|---|---|---|
| 94 | Applicant access | **No account before approval; a private link per application** — random token stored as SHA-256, sent by clients in the `X-Application-Token` header (never in a query string), placed in the URL fragment of emailed links, and **rotated whenever we email a new link** (e.g. an information request) | Applicants can follow and answer without creating credentials; tokens never reach server logs; an old leaked link stops working |
| 95 | Verification before review | **Email and phone must both be verified** (6-digit codes, 10 min, 5 attempts) before an application reaches staff | Matches docs/27 §3.2 and keeps unverified spam out of the queue |
| 96 | Platform SMS | **Open decision: platform SMS provider** (Hubtel, Arkesel, mNotify, Twilio…). Until chosen, `SMS_PROVIDER=log` writes messages to the log in development and refuses to send in production (logged as an error at startup) | Signup needs SMS from *our* account, unlike tenant notifications (decision 17). Nothing fake can reach production |
| 97 | Risk signals | **Informational only at launch** (manual approval): disposable email, previously rejected contact, existing customer, duplicate business name, ≥ 3 applications from one IP in 24 h, existing tenant name; level high/medium/low | Focuses reviewers now; the same signals can gate the optional auto-approval mode later |
| 98 | Re-applying | **Rejection blocks new applications from the same email or phone for 30 days by default** (reviewer can change it, 0 = no block); the message never says why | docs/27 §3.2 "can re-apply after N days" without telling a bad actor what triggered it |

## Engineering decisions during P1-3 (2026-10-16)

| # | Topic | Decision | Why |
|---|---|---|---|
| 99 | Query layer (decision 64 follow-up) | **Stay with plain `pg` and typed repository classes** for module tables too | 25+ repositories already follow this pattern with explicit SQL, upserts, locks and keyset queries; an ORM/query builder now would add a second style without removing real risk. Revisit if query composition becomes painful |
| 100 | Tax codes | **Seeded as inactive placeholders without rates** (VAT, NHIL, GETFund, WHT); a code cannot be activated without a rate | Rates change and differ per business; hard-coding them risks silently wrong invoices |
| 101 | Provisioning | **Resumable saga with persisted steps; every step idempotent; nothing dropped automatically** — failed tenants stay `provisioning_failed` with the error, staff retry from the console, a sweep re-queues stalled sagas and only *reports* orphan databases | Safe retries without destroying data (decision 36); clear operator view |
| 102 | System roles at launch | **Owner, Administrator, Branch Manager, Accountant, Auditor**; module roles (Fleet Officer, Rental Agent, Driver, …) arrive with their modules' permissions | Avoids seeding roles that grant nothing yet; the catalogue sync adds them to every tenant later |
| 103 | User directory | **Email and phone stored as HMAC-SHA256** (key derived from `OTP_SECRET`) | Multi-tenant login lookups without a plain list of every tenant user's contacts in the platform DB; rotating `OTP_SECRET` requires re-hashing |

## Engineering decisions during P1-4 (2026-10-16)

| # | Topic | Decision | Why |
|---|---|---|---|
| 104 | Immediate deactivation | **Commit the status, forget this process's cached status (other API instances follow within 5 s — directory cache TTL lowered from 30 s), and revoke every session in the tenant database** | "Deactivating blocks every user immediately" (P1 exit criterion) without a platform lookup on every request; refresh tokens die at once, access tokens are rejected through the status check |
| 105 | Restore semantics | **Restore returns the status the tenant had before** (read-only remembered across a deactivation); sessions are not restored — users sign in again | Matches docs/27 §3.3; nothing about the tenant's data or branches changes |
| 106 | Read-only enforcement | **Every non-GET request on a tenant route is refused while read-only** unless the route explicitly allows it (`allowWhenReadOnly`, e.g. sign-out); sign-in routes are unaffected | One rule in the guard instead of per-endpoint checks |
| 107 | Branch deactivation effects | **Assignments to a deactivated branch grant nothing; members get a new permission version; a user whose branches are all deactivated gets `403 BRANCH_DEACTIVATED`**; deactivation is refused for the default and the last active branch, and modules add their own precondition checks | docs/27 §3.5: nobody reaches a deactivated branch, nothing live is left inside it, the tenant keeps working |

## Engineering decisions during P1-5 (2026-10-16)

| # | Topic | Decision | Why |
|---|---|---|---|
| 108 | Branch-specific role assignments | **A role assigned for one branch works only in that branch** (an `all` grant becomes `branch` limited to it); across assignments the widest scope wins and branch sets combine; numeric limits take the most generous value | docs/28 "branch-aware assignments" with one deterministic rule set, unit-tested in isolation |
| 109 | Escalation prevention | **Nobody can define or assign a grant they do not hold with at least the same scope (and in that branch)**; branch-scoped managers only assign per-branch roles in their branches; nobody changes their own roles or branches; the Owner role is never assignable and the owner never disabled | docs/28 §13 escalation tests; fixes the v1 class of bugs behind audit C3 |
| 110 | Multi-business discovery | **`/auth/discover` needs the password and returns only businesses where it is correct** | Lets the mobile app offer "choose your business" without telling anyone which businesses an email or phone belongs to |
| 111 | Password changes | **Reset and change sign the user out everywhere** (sessions revoked, permission version bumped); the client signs in again | Simple and safe: a stolen session never survives a password change |
| 112 | Password reset channel | **Email only for now**; phone-only users are reset by their administrator until tenant SMS (their own provider) exists | Decision 17: tenant SMS goes through the tenant's provider, not yet built |

## Engineering decisions during P1-6 (2026-10-16)

| # | Topic | Decision | Why |
|---|---|---|---|
| 113 | Console view of a tenant's database | **The 360° profile reads only counts from the tenant database** (users by status, active users, last login, branches, custom roles, database size) in a read-only transaction; if the database cannot be read the profile still loads and says so | docs/27 §2 "least data": business records only through audited support access (later); one slow tenant never breaks the console |
| 114 | Staff notes and tags | **Only the author edits or deletes a note; anyone with notes access pins; deleting hides the note and the audit log keeps its text.** Tags are free-form but normalised (lowercase, hyphens, ≤30 chars), at most 20 per tenant | Notes are evidence of what staff told or promised a customer; free tags fit the early stage without a tag admin screen |
| 115 | System health | **Measurements come from infrastructure probes; the application layer judges them against fixed thresholds** (e.g. job waiting 5 min = warning, 30 min = critical; no platform backup in 26 h = critical; failed restore test = critical). A probe that throws is reported as critical, never a 500. pg-boss tables are read directly (read-only) | Unit-testable rules in one place; the console must work best exactly when something is broken |
| 116 | Migration view | **New permission `platform.data.migrations.view`** (Operations, Engineering); **provisioning records the new database's schema version** in `tenant_schema_status` | Viewing versions is not running migrations (`run` stays sensitive); without the record, new tenants looked "never migrated" |
| 117 | Audit export | **CSV export capped at 10,000 rows (a header says when cut off), spreadsheet formulas neutralised, and every export is itself audited** | Exports leave the system; the trail must show who took what |
| 118 | Dashboard scope | **Billing tiles (MRR, ARR, tenants due for automatic deactivation) and DAU/MAU are deferred** to subscriptions (P1-10) and `usage_daily` | No billing data exists yet; counting active users across every tenant database per page view does not scale |

## Engineering decisions during P1-7 (2026-10-16)

| # | Topic | Decision | Why |
|---|---|---|---|
| 119 | Partner users | **A reseller's users are platform users of type `partner` with a partner id; their permissions are exactly their partner's capability grants.** They never hold staff roles (use case + database trigger), reach only `/partner/*` and their own session routes, and every partner query filters on the partner id taken from the token | One sign-in, MFA and session system for the whole console, with a hard wall between staff and resellers |
| 120 | Capability catalogue | **Reseller capabilities are a separate audience in the platform catalogue** (`platform.partner.*`), never in staff roles (Super Admin's "all" means all staff permissions). Assisted signup by partners uses `platform.partner.applications.create`, not the staff `platform.applications.create_assisted` | Keeps the two permission sets disjoint so neither side can be granted the other's routes by mistake |
| 121 | Attribution | **Set at submission (referral code or partner-assisted) and recorded at approval; a paused or terminated partner's code attributes nothing (review signal). Changing it afterwards needs `platform.partners.attribution.manage` (Super Admin by default) and a reason** | docs/29 §3; the "locked at activation" rule is carried by this permission until paid activation exists (P1-10, phase 2) |
| 122 | Capability and status changes | **Changing capabilities re-issues the partner users' tokens (permission version); terminating disables every user and rejects tokens immediately; pausing blocks new clients only** | Grants take effect at once; a terminated reseller keeps no access, while their tenants keep the attribution |
| 123 | Abuse controls | **Self-referral (partner's email, phone or TIN on the application) is a high-risk signal; more than 10 assisted applications a day is a review signal and 30 a day is refused** | docs/29 §9 without blocking normal sales activity |
| 124 | Deferred | **`trusted` is stored but does not auto-approve yet; per-user restrictions inside a partner, commission terms and ledgers come with phase 2** (profile shows `commissionTerms: null` to those allowed to see terms) | No payments exist yet; auto-approval needs the approval policy settled |
| 125 | Partner replies | **A partner answering an information request is recorded as the applicant's reply, marked "on behalf of partner"** | The client sees one conversation; the trail still shows who wrote it |

## Engineering decisions during P1-8 (2026-10-18)

| # | Topic | Decision | Why |
|---|---|---|---|
| 126 | Object storage | **Any S3-compatible service through the AWS SDK v3; locally (compose, tests, CI) RustFS 1.0.1** (Apache-2.0, S3-compatible). Provider for hosting decided with P0-3 | MinIO no longer publishes community images; RustFS behaves the same for our use (signed URLs, bucket policies, CORS) and nothing in the code is provider-specific |
| 127 | Upload flow | **Pre-signed PUT straight to storage, then a confirm call**; the signature fixes content type and size, and confirmation checks the stored size and the real type from the first bytes before the file can be used | No file bytes through the API (fixes the old base64-in-JSON limit, docs/03 §12); declared types are never trusted |
| 128 | Public vs private | **Two buckets: public (anonymous read, served via `FILES_PUBLIC_BASE_URL`, i.e. a CDN later) and private (5-minute signed download links, saved as attachments)** | Logos must be cacheable and linkable; KYC documents must never have a permanent URL |
| 129 | File records | **One `files` table per tenant database and `platform_files` in the platform database, same shape; kinds with fixed rules (types, size, visibility) in code; SVG never accepted** | Tenant data stays in the tenant's database (backups, deletion); platform documents exist before any tenant does |
| 130 | Lifecycle | **Pending uploads older than 24 h and replaced or removed files are deleted with their bytes** (daily sweep; tenant files in daily maintenance) | Storage never fills with orphans; removed KYC documents really disappear |

## Engineering decisions during P1-9 (2026-10-18)

| # | Topic | Decision | Why |
|---|---|---|---|
| 131 | Link signatures | **Ed25519 over a fixed, line-based message; key id derived from the public key; the app embeds the trusted public keys at build time** | Small signatures fit in a QR; Node signs it natively; a deterministic message is easy to reproduce in Kotlin/Swift/Dart; key ids allow rotation (ship the new key in the app first) |
| 132 | Keys per environment | **Production requires a key (file or PEM in the environment); locally a fixed, publicly known development key is used** | Dev builds of the app can embed the dev key and links survive restarts; the dev key can never sign production links |
| 133 | Allow-list | **`MOBILE_ALLOWED_API_HOSTS` (exact hosts or one-level `*.domain`) must contain the server's own API host; https enforced in production. The app carries the same list** | docs/23 §5: a signed link pointing elsewhere is still refused, and a mis-configured server fails at start-up |
| 134 | Invitation links | **Invitation emails include a signed app link with the token and the invitation's expiry; the store install referrer never carries a token** (a fresh plain connect link instead) | Opens "set your password" in one tap without handing tokens to third parties |
| 135 | QR rendering | **Server-side SVG (`qrcode` 1.5.4)**; the portal can also draw its own QR from `url` | The signing key never reaches the browser either way; SVG prints sharply on stickers |

## Engineering decisions during P1-10 (2026-10-18)

| # | Topic | Decision | Why |
|---|---|---|---|
| 136 | Manual billing first | **Staff issue each period's invoice and record the payments they receive** (bank transfer, MoMo, cash, cheque; method + reference unique). **Only a fully paid invoice** activates anything; payments never exceed what is outstanding; clients never send amounts | docs/25 §11 phase 1, before a gateway exists; mirrors §5.3 (partial payments do not restore) |
| 137 | Billed branches = entitlement | **During the trial the billed count follows the active branches (up to the trial limit, 3); a paying tenant adds a branch only by confirming the extra monthly charge; deactivating a branch lowers the count** (from the next invoice); staff can set it | docs/25 §7 "explicit confirmation showing the new price"; the first invoice matches what was used in the trial |
| 138 | Price list | **No price in code: the standard price per branch is set by staff (sensitive permission, step-up, audited) and invoicing refuses until it is set. Enterprise invoices are entered line by line; licence lines (branch rate, size adjustment) count for commission by default** | Decisions 48, 50, 53, 54; the price is a business decision still open |
| 139 | Payment and lifecycle | **A paid invoice: subscription active for the invoice's period, licence type locked, tenant trialing/past due → active, billing deactivations (non-payment, trial expiry) lifted; manual deactivations stay** | docs/25 §2.1, §5.3, §5.5 |
| 140 | Invoice details | **VAT 0 until the accountant confirms; invoice numbers `AF-INV-YYYY-NNNNNN` with no gaps** (duplicate periods are refused before a number is taken); one invoice per subscription period | Tax records need continuous numbering; VAT registration is open (docs/25 §3) |
| 141 | Deferred to phase 2 | **Gateway checkout and webhooks, dunning and automatic deactivation, billing-only sign-in (decision 51), extensions, invoice PDFs, proration, enterprise quote builder; entitlements are read at branch activation only (no cache yet)** | Phase 1 needs the skeleton and the hook; these need real payments and the PDF service (P2-10) |

## Engineering decisions during P2-1 (2026-10-18)

| # | Topic | Decision | Why |
|---|---|---|---|
| 142 | Money type | **Integer minor units of one currency (by the currency's minor units: 2 for GHS, 0 for XOF), exact BigInt arithmetic for percentages and conversions, half-even rounding; amounts arrive as decimal strings (extra decimals refused, never rounded) and leave as `{ amountMinor, currency, formatted }`; `₵` on screens, `GHS` in SMS and exports** | docs/20 §4–8; no float ever touches money |
| 143 | Base currency | **Changed only in Settings → Currency (no longer on the organisation profile); suggested from the country at provisioning (GH → GHS, NG → NGN, Togo and the other UEMOA countries → XOF); fixed once money is recorded (`base_currency_locked_at`, set by the finance modules); enabled currencies always include the base** | docs/20 §3, §9; history is never silently re-denominated |
| 144 | Tax codes (refines 100) | **Each business keeps its own codes; a code has a kind and dated rate components (charged on the net or compounding on net + earlier levies); periods of a levy never overlap; a code is usable only when active, and active needs rates (exempt and zero-rated excepted); the rates in force on the document date are applied and snapshotted; tax-inclusive prices are worked back exactly (the last component absorbs rounding). No rates are seeded and there is no platform tax catalogue** | docs/13 §6 rates must come from the accountant; Ghana's levies have changed often; per-business schemes (standard, flat rate) differ |
| 145 | Exchange rates | **Manual rates per day (1 foreign unit = rate × base), the latest on or before the document date is suggested, one rate per currency per day; removing a rate never changes documents (they keep their own rate)** | docs/20 §5.3 V1; provider feeds later |
| 146 | Expense categories | **A two-level tree (category → subcategory); defaults seeded at provisioning; renamed, moved or deactivated, never deleted** | docs/12; expenses keep pointing at their category |
| 147 | Vehicle makes and models | **A platform list (25 common makes in Ghana with their usual models, motor tricycles included) maintained by staff; vehicles may still use free text for rare models (P2-2)** | One spelling per make for reports; no tenant has to type "Toyota" |
| 148 | Document numbers | **Default formats per document kind (INV, RCT, PAY, EXP, RMT, RNT, CRN yearly; VEH, DRV, CUS running), overridden by the business's formats; gap-free counters per kind (and year) taken in the document's own unit of work** | Continuous numbering for tax documents; rolled-back documents give their number back |
| 149 | Vehicle status changes | **Users move a vehicle by hand only between states no module owns; `assigned`, `reserved`, `sold`, `reserved_rental`, `on_rent`, `on_workpay`, `transferred` and `repossessed` are entered and left only by their module with a reference to its record; an incident (accident, impounded, stolen) can be reported from any state; every change is kept with its reason** | Fixes H9 (vehicles stuck "Rented", values outside the enum); `PATCH status` does not exist |
| 150 | One vehicles module | **P2-2 builds the vehicles module once, replacing the legacy vehicle CRUD; there is no separate "v2" in code, routes or tables** | The old MongoDB module is gone; one name avoids two parallel APIs |
| 151 | Plates and VINs | **Plates are stored as shown (upper case) and unique by their letters and digits; VINs are 17 characters without I, O or Q, check digit not enforced; both unique only among vehicles not removed; stock may have no plate** | "GR 1234-21" and "gr1234 21" are the same car; most imports are not North American |
| 152 | Removing vehicles | **"Delete" removes a mistaken entry: hidden everywhere, kept with the reason, plate and VIN freed; not while a module holds the vehicle** | History and audit stay intact; real disposals go through sale, transfer, write-off or scrapping |
| 153 | Compliance | **Per document type the document expiring last counts (renewals are new documents); a document is valid through its expiry date; missing or expired required documents make the vehicle red (cannot legally operate), anything expiring within the window (default 30 days) amber; required types and warn/block are business settings (default registration, roadworthy, insurance; warn)** | Rentals and assignments will use `operability()` to warn or block |
| 154 | Odometer | **Readings only go up over time, checked against the readings before and after (late entries allowed); a replaced odometer is recorded as a replacement with a reason and starts a new series; the latest reading is the current odometer** | Feeds maintenance, cost per km and fuel checks later |
| 155 | Vehicle financials and depreciation | **Cost, residual value and book value need the sensitive `vehicles.financials.view` (to see and to edit, in exports too); depreciation is `none` or straight-line by whole months in the base currency; declining balance and the monthly ledger posting come with the ledger (P2-5)** | Hides cost and profit from agents (docs/06 §13) |
| 156 | Drivers and branches | **A driver belongs to one branch (branch scope like vehicles; moved by editing); a branch cannot be deactivated while drivers who are not terminated remain in it** | Fleet officers see only their branches' drivers |
| 157 | Customers and suppliers | **Customers and suppliers are shared by every branch (their permissions are business-wide); a customer keeps a home branch for reports only; a watch or blacklist status follows the customer everywhere** | A blacklist that stops at a branch border would be useless; refines docs/27 §3.5 for customers |
| 158 | Driver lifecycle | **applicant → active → suspended ↔ active → terminated, rehiring starts again as an applicant; activation needs the onboarding checklist (Ghana Card, valid licence, guarantors, required documents — business settings, default: card, licence, 1 guarantor); suspend/reinstate and terminate are separate permissions and need a reason** | docs/09 §4; termination settlement arrives with the driver ledger (P2-7) |
| 159 | Identity data | **Ghana Card numbers are stored normalised (`GHA-123456789-1`) and unique per driver and per customer; shown masked without `drivers.documents.view` / `customers.id_documents.view` and never written in full to the audit log; identity documents (with scans) of drivers, guarantors and customers live in one `party_documents` table and need those permissions to read** | Least privilege for KYC data |
| 160 | Duplicate parties | **Drivers are unique by phone, Ghana Card and licence number; customers by email and Ghana Card (several customers may share a phone); suppliers by name — among records not removed** | Phones are shared within families; a driver's phone will be their app login |
| 161 | Payout details | **Drivers and suppliers carry mobile money (MTN, Telecel, AT) and bank details for record-only payments; a MoMo number needs its network and bank details need the bank and account number** | Decision 16 (record only) |
| 162 | One driver per vehicle in the database | **Partial unique indexes allow one open assignment per vehicle and per driver; exclusion constraints stop two assignments of the same vehicle (or driver) from overlapping in time, late entries included** | Decision 9 enforced where it cannot be bypassed; "who was driving at X" has one answer |
| 163 | Starting an assignment | **Only an available vehicle and an active driver of the same branch; the licence must be valid (setting, default on); the vehicle's compliance is checked per the business rule (warn: the response carries warnings; block: refused); the vehicle becomes `assigned` through the module path with the assignment as reference** | Work-and-pay assignments come from their agreement (Phase 3), not by hand |
| 164 | Handover | **Start, end and handover record the odometer (as an `assignment` reading, same rules as any reading) and a checklist answering every configured item (default 9 items, business setting), fuel level and driver acknowledgement; a handover ends and starts at the same instant with one checklist and carries the remittance terms over unless new ones are given** | docs/06 §6 mini inspection |
| 165 | Ending an assignment | **Needs a reason and an odometer not lower than at the start; the vehicle goes back to available or the workshop — unless an incident was reported meanwhile, in which case it stays in that state** | Accidents and impounds are not undone by taking the keys back |
| 166 | Remittance terms on the assignment | **Mode per assignment (fixed target / variable / none, default from settings for remittance drivers; none for salaried and chauffeur drivers); a fixed target has an amount in the base currency and a period, daily targets may have days off; terms can change during the assignment (audited)** | Decision 8; the expected-remittance job (P2-7) snapshots the terms on each row |
| 167 | Drivers with a vehicle | **A driver who has a vehicle cannot be suspended, terminated or moved to another branch until the assignment ends** | Nothing live is left with a driver who can no longer drive |

## Consequences in one page

1. **Rewrite the persistence layer on PostgreSQL**, from a clean schema. Keep the clean-architecture shape and Inversify, replace Mongoose models and repositories. No data to carry over means no migration risk and a chance to fix every model-level bug at the root.
2. **Database per tenant on PostgreSQL** (decision 26, doc 22 §2). Strong isolation and trivial per-tenant backup/restore/export/delete, at the cost of connection management, migration fan-out and catalog overhead — all addressed in doc 22 (plan ≈1,000 tenants per cluster, then add clusters).
3. **Tenant-side payments are recorded, not processed.** The finance module keeps invoices, receipts, allocations, ledger and cash sessions.
4. **Platform billing is a real payment flow** (decision 27, doc 25): tenants pay their per-branch subscription in the app/portal via a gateway.
4b. **Backups are a P0 deliverable** (decision 29, doc 26).
5. **Documents with signatures** become a first-class capability (transfer letter, W&P agreement, rental agreement, sales agreement).
6. **Mobile onboarding via QR + deep link** needs a public tenant-config endpoint and a verified link format (doc 23).
7. **Pricing by branch** makes `branches` a billing entity: add/remove branch = proration event.
