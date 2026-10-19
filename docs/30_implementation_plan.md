# 30 — Implementation Plan (Phased)

> Status: **plan only — no code has been written yet.** This is the authoritative build plan and **supersedes the roadmap in [18](18_roadmap_and_phasing.md)**. It turns every design decision (docs 01–29) into ordered phases, work packages, exit criteria and milestones.
> Product: **Autoforce Manager** · Written 2026-10-14.

## 1. How to read this plan

- **Phases 0–4 get the product to a commercial launch** (platform + fleet + Work & Pay + billing). Phases 5–9 add the remaining modules and maturity.
- Each phase has: goal, work packages (WP), dependencies, deliverables, **exit criteria** (what must be true to call it done), rough effort, risks and the decisions needed before it starts.
- Effort is a **rough estimate for one experienced backend developer** (±40%). Two developers can overlap work as shown in §4. Re-estimate after Phase 0, when real velocity is known.
- WP size: **S** ≈ ≤ 3 days · **M** ≈ 1 week · **L** ≈ 2 weeks · **XL** ≈ 3+ weeks.
- Frontends (web portal, admin console UI, mobile app) are separate tracks that follow the backend (§5), as decided: backend first.

## 2. Milestones

| Milestone | After | What it means | Rough date from start (1 dev) |
|---|---|---|---|
| **M0 Foundation ready** | Phase 0 | Environments, database foundation, backups and auth core work; nothing customer-facing yet | week 6 |
| **M1 Tenant onboarding works** | Phase 1 | Staff approve a signup, a tenant database is created, owner logs in, invites users, custom roles work, tenants can be deactivated and restored | week 14 |
| **M2 Private beta** | Phase 3 | Fleet + remittances + Work & Pay + documents with e-signed agreements; trusted tenants, **manual billing**, backups verified | week 30 |
| **M3 Commercial launch** | Phase 4 | Automated subscription billing, deactivation/restore automation, resellers and commissions, support tooling, legal basics | week 38 |
| **M4 Full fleet suite** | Phases 5–6 | Rentals v2 + maintenance & compliance | week 50 |
| **M5 Dealer suite** | Phase 7 | Purchases, import tracking, dealership, multi-currency | week 59 |
| **M6 Complete platform** | Phases 8–9 | Reports/analytics, platform maturity, integrations | week 70 |

(With two developers working in parallel after Phase 2, M3 lands around week 30–32 and M6 around week 45–50.)

## 3. Ground rules (apply to every phase)

**Definition of done for any work package**
1. Code reviewed, `tsc --noEmit` and lint pass, boundaries lint passes.
2. Unit tests for domain logic; integration tests against a real PostgreSQL; **tenant-isolation tests** for any new table/endpoint.
3. Every endpoint: zod validation, a permission from the manifest, audit logging for state changes, OpenAPI updated.
4. Money flows: property-based or table-driven tests (schedules, allocations, commissions, proration); ledger stays balanced.
5. Migrations reviewed (expand → deploy → contract), applied to staging through the real runner.
6. Docs updated (this folder), changelog entry, new permissions added to the manifest.
7. Observability: structured logs with request/tenant ids, metrics for new jobs, alerts for new failure modes.
8. Security checklist: no secrets in logs, input escaping, rate limits on public endpoints, least privilege.

**Engineering conventions**
- **Same repository, no new repo, no parallel branch strategy** (decision 59). The app is not live and the mobile apps are unpublished, so nothing needs to keep working. The legacy Mongo code is **overridden in place**: it is removed or replaced as the new foundation lands (git history remains the reference). The `dist/` folder, the `vercel.json` serverless config and the pre-commit hook that builds and stages `dist/` are removed in P0-1 (CI builds instead).
- Target layout is the modular monolith from doc 03, built in the existing `src/`.
- Feature flags for anything not ready for tenants.
- Every phase ends with a demo against **staging** with seeded demo tenants, and a short retrospective that updates this plan.

## 4. Phase summary

| Phase | Theme | Effort (1 dev) | Can overlap with | Ends at |
|---|---|---|---|---|
| **0** | Foundation: infrastructure, database, backups, core framework | 5–6 wks | – | M0 |
| **1** | Platform control plane & tenant core | 7–8 wks | – | M1 |
| **2** | Fleet core & finance recording | 8–10 wks | frontend work can start | – |
| **3** | Work & Pay + documents & e-signatures | 6–8 wks | – | **M2 private beta** |
| **4** | Billing, automation, resellers, launch readiness | 6–8 wks | – | **M3 commercial launch** |
| **5** | Rentals v2 | 5–7 wks | 6, 7 | – |
| **6** | Maintenance & compliance | 4–6 wks | 5, 7 | **M4** |
| **7** | Purchases, dealership, multi-currency | 7–9 wks | 5, 6 | **M5** |
| **8** | Reports & analytics | 4–6 wks | 7 | – |
| **9** | Platform maturity & integrations | 6–8 wks | ongoing | **M6** |

Critical path: **0 → 1 → 2 → 3 → 4** (everything needed to launch). Phases 5–7 are independent modules once Phase 2 and Phase 4 are done and can run in parallel with a second developer.

---

## Phase 0 — Foundation (5–6 weeks)

**Goal:** a safe, repeatable base: environments, PostgreSQL database-per-tenant machinery, backups, and the core framework every module will use. Nothing here is customer-visible.

| WP | Work package | Key outputs | Size | Docs |
|---|---|---|---|---|
| P0-1 | **Repo & tooling** | Remove legacy Mongo code, `dist/`, `vercel.json` and the auto-staging pre-commit hook; folder skeleton (`bootstrap`, `shared`, `platform`, `modules/*`); TypeScript strict; ESLint + Prettier + import-boundary rules; Vitest config; zod-validated config with no insecure defaults; `.env.example`; Dockerfile | M | 03, 17 |
| P0-2 | **CI/CD** | Pipeline: lint → typecheck → unit → integration (Postgres service) → image build → deploy to staging; migration job; secrets handling | M | 17 |
| P0-3 | **Infrastructure** — *deferred until hosting is available (decision 63)* | VPS provisioning as code; firewall, SSH hardening, fail2ban; reverse proxy with TLS (wildcard for portal subdomains); PostgreSQL tuned + PgBouncer; Redis; S3-compatible storage buckets; staging and production environments; metrics (Prometheus/Grafana), error tracking (Sentry), log shipping | L | 22 §10 |
| P0-4 | **Backups & disaster recovery (first cut)** — *local part now, production part when hosting is available (decision 63)* | WAL archiving/PITR to off-site encrypted, write-only storage; nightly per-tenant dump job skeleton; platform DB dumps; backup metadata table + alerts; first written restore runbooks; **automated restore test** | L | 26 |
| P0-5 | **Database foundation** | `autoforce_platform` schema v0; `tenant_template` build pipeline (migrations on an empty DB in CI); DB roles (`platform_app`, `tenant_app`, `migrator`, `backup`); extensions; **SQL migration runner with tenant fan-out**, version table, version gate; **tenant pool manager** (LRU, PgBouncer-aware, `tenant_info` assertion); tenant-aware transaction helper; base repository (keyset pagination); counters service; audit log + outbox tables; load test with ~500 empty tenant DBs | XL | 22 |
| P0-6 | **HTTP core** | Request id; logger with redaction; error classes with stable codes + mapper (no stack in prod); zod validation middleware; response envelope/pagination; helmet, CORS, rate limiting; health endpoints; `/api/v1` router; OpenAPI generation | M | 03, 16 |
| P0-7 | **Auth & access core** | Async password hashing; JWT with `tid`, `sid`, `ver`; refresh-session store; OTP service (hashed, attempts, TTL); tenant resolution (token + host/header agreement); **permission manifest tooling** and `can()` evaluator with scopes/limits and cache; CI check that every route has a manifest permission | L | 16, 28 |
| P0-8 | **Jobs, events, notifications** | Queue (pg-boss in the platform DB, or BullMQ — decision pending); scheduler with per-tenant fan-out and timezone; outbox dispatcher; notification service abstraction (email adapter + templates); idempotent job pattern | M | 03, 15 |
| P0-9 | **Test & security harness** | Postgres test containers; tenant fixtures; **generated isolation tests** over every table; regression tests for audit findings C1–C7; k6 load scripts | M | 01, 03 |

**Deliverables** *(revised by decision 63: everything runs locally; the staging/production items below move to P0-3 when hosting is available)*: staging environment running the skeleton API; a script that creates a throw-away tenant database from the template and runs migrations on it; backups running with one successful restore test; CI green.

**Exit criteria**
- 500 empty tenant DBs created and migrated in a load test within agreed time; pool manager stays under connection limits.
- A request with tenant A's token on tenant B is rejected (test exists and passes).
- Backup of the platform DB and a sample tenant DB restored automatically in CI/cron.
- No endpoint can ship without validation, permission and OpenAPI entry (enforced by CI).

**Decisions needed before starting:** domains, VPS provider/size, backup storage provider and budget, job queue choice, expected tenant counts (consolidated list in [19](19_open_questions.md)).

**Risks:** underestimating database-per-tenant overhead (mitigated by the 500-DB load test early); backup complexity (start with the simplest reliable layer, add layers in order).

---

## Phase 1 — Platform control plane & tenant core (7–8 weeks)

**Goal (M1):** the company can run onboarding. Staff approve new tenants, tenant databases are provisioned with seeded permissions and roles, owners sign in and manage users, branches and roles, and tenants can be deactivated and restored.

| WP | Work package | Key outputs | Size | Docs |
|---|---|---|---|---|
| P1-1 | **Platform staff auth & governance** | `platform_users`, MFA (TOTP, passkeys), sessions, invites, seeded platform roles and permissions, step-up auth, **four-eyes approval framework**, immutable platform audit log | L | 27 §2 |
| P1-2 | **Applications & approval** | Public signup with email/phone verification; applications queue API; approve / reject / needs-info; basic risk signals; assisted-signup hook; applicant notifications | M | 27 §3.2 |
| P1-3 | **Provisioning saga** | Create DB from template; grants; seed organisation, default branch, **permissions + system roles from the platform catalogue**, expense categories, tax-code placeholders, counters, settings; owner user and first login; platform records (`user_directory`, trial subscription); idempotent and resumable; orphan-DB sweeper; **catalogue sync job** for later releases | XL | 22 §2.6, 28 |
| P1-4 | **Tenant lifecycle (manual)** | Status machine; deactivate / restore with session revocation and resolution-time gating; reasons and tenant-facing messages; status history; branch deactivate / reactivate with prerequisite checks and branch-aware permission evaluation; `403 TENANT_DEACTIVATED` / `BRANCH_DEACTIVATED`; public `tenant-config` | L | 27 §3.3, 3.5, 23 |
| P1-5 | **Tenant identity & organisation** | Organisation settings (GHS default, timezone, numbering); branches CRUD; users (invite, accept, disable); **roles and permissions APIs** (system vs custom roles, branch-aware assignments, limits, escalation prevention); `/me/permissions`; login, refresh, logout, password reset and change; sessions list/revoke; user discovery for multi-tenant login | XL | 28, 16 |
| P1-6 | **Console MVP APIs** | Dashboard basics (tenants by status, pending applications); tenant list and 360 profile; notes and tags; audit viewer; backup and migration status views; system health summary | M | 27 §3.1, 3.4 |
| P1-7 | **Resellers, part A** | Partner profiles (Super Admin); partner console users and **per-reseller capability grants**; referral code capture; assisted signup; attribution; "My tenants" and application-tracker APIs (no commission yet) | L | 29 |
| P1-8 | **Files service** | S3-compatible storage + image CDN; pre-signed uploads; `files` table; signed download URLs; used for KYC documents and logos | M | 03 §12 |
| P1-9 | **Mobile connect** | Signed QR/connect-link generation (server-side signing key); allow-list of backend hosts; deep-link metadata files; in-app scan payload format | S | 23 |
| P1-10 | **Subscription skeleton & entitlements** | Standard plan (flat per branch), trial subscription, licence-type flag, entitlement resolution and branch-limit enforcement hook; **manual billing** only (no gateway yet) | M | 25 §1–2 |

**Deliverables:** end-to-end onboarding on staging via API (console and tenant); Postman/OpenAPI collection; seeded demo tenants.

**Exit criteria**
- A signup becomes an application, is approved by staff, and within minutes a tenant DB exists with permissions and system roles seeded; retrying a failed provisioning is safe.
- Owner creates a custom role, invites a user to one branch only, and the user's access is limited accordingly.
- Deactivating a tenant blocks every user immediately; restoring brings it back unchanged; deactivating a branch hides that branch's access only.
- A partner user sees only their own tenants; a field they lack permission for is omitted.
- Catalogue sync adds a new permission to all tenants without touching custom roles.

**Decisions needed before starting:** approval policy details are set (manual at launch); platform staff names/roles to seed.

**Risks:** provisioning edge cases (partial failures) → covered by saga tests and fault-injection tests.

---

## Phase 2 — Fleet core & finance recording (8–10 weeks)

**Goal:** the daily operations of a fleet business work: vehicles, drivers, customers, expenses, remittances, recording payments with receipts, and correct dashboards.

| WP | Work package | Key outputs | Size | Docs |
|---|---|---|---|---|
| P2-1 | **Reference data & settings** | Currency catalogue and `Money` type (minor units, per-currency decimals), tenant base currency (GHS default); numbering formats; **tax codes** (Ghana VAT with effective dates; rates loaded after accountant confirms); vehicle makes/models; default expense categories | M | 20, 13 §6 |
| P2-2 | **Vehicles** | Registry; status machine and history; documents/compliance with expiry; odometer; photos; groups; CSV import/export; vehicle overview API skeleton | XL | 06 |
| P2-3 | **Parties** | Drivers (licence, guarantors, documents, status), customers (KYC, blacklist, corporate), suppliers | L | 05, 09 |
| P2-4 | **Assignments** | Vehicle–driver assignment history (one driver per vehicle, enforced by partial unique indexes), handover checklist | M | 06 §6 |
| P2-5 | **Finance recording core** | Payments (record-only: cash, MoMo, bank, cheque), allocations, receipts (PDF), invoices with VAT lines, cash sessions, **balanced-journal ledger framework**, period lock, wallet/credit | XL | 13 |
| P2-6 | **Expenses** | Category tree; approval rules with role limits; split across vehicles; receipts; recurring expenses; basic budgets; fuel logs | L | 12 |
| P2-7 | **Remittances & driver ledger** | Modes (`fixed_target` / `variable` / `none`); expected-row job; submit / approve / reject; shortfalls; driver statement; operations board | L | 09 |
| P2-8 | **Dashboards v1 & stats** | `daily_vehicle_stats`; correct date logic; vehicle P&L v1; remittance and expense dashboards (replaces the old buggy dashboard) | M | 14, 01 H12–H13 |
| P2-9 | **Notification rules v1** | Tenant SMS provider settings (Hubtel / Arkesel / mNotify adapters, encrypted credentials); document-expiry and remittance-cutoff reminders; in-app notifications and push | M | 15 |
| P2-10 | **PDF basics & driver endpoints** | HTML→PDF service for receipts and statements; `me` endpoints for drivers (vehicle, ledger, submit remittance, fuel, issue report) | M | 24, 09 |

**Deliverables:** a staging tenant can run a small fleet end to end; OpenAPI is stable enough for the web portal and mobile teams to start (§5).

**Exit criteria**
- Vehicle, driver, customer, expense, remittance and payment flows covered by integration tests including permission scopes (`own` / `branch` / `all`).
- Ledger always balances (constraint test); receipts reproduce the same numbers as the ledger.
- All audited H-bugs relevant to these modules are covered by regression tests (status mismatch, date defaults, dashboard weeks).

**Decisions needed before starting:** VAT rates and registration rules (accountant), remittance mode ownership (owners enable; drivers can choose when enabled).

**Risks:** scope growth in vehicles/finance → time-box with a P2 backlog; money-rounding bugs → property tests.

---

## Phase 3 — Work & Pay, documents & e-signatures (6–8 weeks) → **M2 Private beta**

**Goal:** the hire-purchase product is complete, including legally signed agreements and the transfer letter. After this phase trusted tenants can use the system for real (billing still manual).

| WP | Work package | Key outputs | Size | Docs |
|---|---|---|---|---|
| P3-1 | **Document engine** | Versioned templates with locked clauses; data snapshots; PDF rendering worker; verification codes and QR; storage in immutable files | L | 24 §3, §6 |
| P3-2 | **E-signature** | Signer workflow; drawn signature; OTP confirmation; guest signing links; paper-and-scan; audit page and SHA-256; immutability; reminders | L | 24 §4–6 |
| P3-3 | **Work & Pay agreements** | Simulator; create and activate; schedule generation (remainder on last instalment); deposit; guarantors; agreement document signed by parties | L | 08 §2–3 |
| P3-4 | **Payments, allocation & arrears** | Allocation policy (penalties → overdue → current → future); reversals; grace; penalties; daily arrears job; status transitions; advance payments | XL | 08 §3–4 |
| P3-5 | **Lifecycle cases** | Restructure and payment holidays; early settlement quote; termination; default and repossession; vehicle status integration; driver-chargeable expenses | L | 08 §5 |
| P3-6 | **Completion & transfer letter** | Auto-generated transfer letter; both parties sign; ownership transfer only when fully signed; DVLA checklist; copies stored | M | 08, 24 §2 |
| P3-7 | **W&P reporting & notifications** | Statements (PDF), portfolio dashboard (PAR buckets), collections forecast, due/overdue SMS through the tenant's provider | M | 08 §7, 14 |
| P3-8 | **Beta hardening** | End-to-end money-flow tests; load test; internal penetration test against the OWASP checklist; backup + full restore drill; runbooks; beta tenant onboarding guide | L | 26, 16 |

**Exit criteria (M2)**
- A full agreement life-cycle (create → pay → arrears → restructure → complete → signed transfer letter → vehicle ownership transferred) runs in an automated end-to-end test.
- Restore drill completed from backups only, within the recovery targets.
- At least two trusted tenants onboarded to production with manual subscription invoices.

**Decisions needed before starting:** transfer letter legal wording and signatory rules (lawyer), W&P default rules (grace days, penalty rule).

**Risks:** legal review delays → run in parallel from Phase 2, ship templates with "pending legal review" flag in beta.

---

## Phase 4 — Billing, automation, resellers & launch readiness (6–8 weeks) → **M3 Commercial launch**

**Goal:** turn it into a business: tenants pay for the licence through the app, the lifecycle runs automatically, resellers earn commissions, and the support team has the tools to operate safely.

| WP | Work package | Key outputs | Size | Docs |
|---|---|---|---|---|
| P4-1 | **Billing core** | Plans (Standard), subscriptions, invoices with VAT, proration events, billing contacts, **Billing tab APIs** (invoices, full transaction history, receipts, payment methods) | L | 25 §2–3, §6 |
| P4-2 | **Payment gateway** | Hosted checkout (Paystack candidate), signed idempotent webhooks, server-side verification, saved cards, MoMo prompt flow, refunds, daily settlement reconciliation, webhook inspector | L | 25 §4, 27 §3.6 |
| P4-3 | **Billing automation** | Dunning policy; reminders by **email, SMS, in-app banner and push**; auto-deactivate and auto-restore; **billing-only sign-in scope**; extensions (max 10 days, approval, limits); manual lock; safeguards: dry-run mode, circuit breaker, gateway-health guard, 48 h review queue | XL | 25 §5 |
| P4-4 | **Enterprise licence** | Licence flag (locks at first payment); hand-built quote builder with `counts_as_licence` lines; subscription price items; first invoice with one-time items | M | 25 §2.1 |
| P4-5 | **Branch management & entitlements** | Console add / deactivate / reactivate / reassign wizard with price impact; tenant self-service with confirmation; billing-vs-actual reconcile job; limit enforcement | M | 27 §3.5 |
| P4-6 | **Reseller commissions** | Commission terms per reseller (Standard / Enterprise percentages); first-purchase commission engine; payable queue; payouts (MoMo / bank / cash / other with proof, cash second-approver and acknowledgement); statements; clawbacks; reseller views and grants | L | 29 |
| P4-7 | **Console operations readiness** | Support access (impersonation) with full trail; user support actions (reset password / MFA, force logout, owner recovery); announcements and maintenance windows; feature flags and entitlement overrides; four-eyes wired to dangerous actions; alerts centre and on-call integration; `usage_daily` | XL | 27 |
| P4-8 | **Legal & operations** | Terms and privacy versions and acceptance tracking; tenant data export; minimal data-protection request tracker; status page; quarterly restore drill scheduled; incident and on-call runbooks | M | 26, 27 §3.15 |
| P4-9 | **Launch readiness** | Production dry-run of billing automation (dry-run mode on for the first weeks), load test at target tenant count, security review, pricing configured, support process, go-live checklist | M | 25 §5.6 |

**Exit criteria (M3)**
- A tenant goes: trial → invoice → reminders → payment → active, and also: overdue → grace → automatic deactivation → pays in Billing tab → automatic restore, verified in staging with the gateway's test mode.
- A reseller's first-purchase commission is calculated, appears in the payable queue and is paid out with a recorded method; a refund reverses it.
- Support access sessions leave a complete trail; dangerous actions require a second approver.
- Dry-run of the deactivation job produces the expected list on production data for at least two weeks before enforcement is switched on.

**Decisions needed before starting:** gateway choice, actual price per branch, trial length and card requirement, reminder schedule, extension frequency, commission percentages for the first resellers, tax treatment of commission.

**Risks:** wrongly deactivating a paying tenant (hence the safeguards); gateway/MoMo behaviour differences → build against provider sandbox early and keep a manual-payment path.

---

## Phase 5 — Rentals v2 (5–7 weeks)

**Goal:** a complete car-rental product: reservations, availability, pricing, handover, deposits, damages.

| WP | Work package | Size | Docs |
|---|---|---|---|
| P5-1 | Vehicle classes, rate plans, extras; **pricing service** (pure, heavily tested; seasons, weekends, mileage, chauffeur, surcharges, VAT) | L | 07 §4 |
| P5-2 | **Availability engine**: `vehicle_blocks` with database exclusion constraint, buffers, class booking, calendar API | L | 07 §3, 22 §4 |
| P5-3 | Booking lifecycle: quote → reserve → confirm → check-out → check-in → close; cancellations and no-shows; extensions with re-quote | L | 07 §2 |
| P5-4 | Inspections and damages: photos, fuel/odometer, diff at check-in, damage records, optional work-order link, charges | M | 07 §6 |
| P5-5 | Deposits and invoices via finance recording; corporate accounts and credit limits; blacklist checks | M | 07 §5, 8 |
| P5-6 | Rental agreement document and signature; handover checklist | M | 24 |
| P5-7 | Rental notifications (pickup, return, overdue), reports (utilisation, ADR, deposits held, pickups/returns board) | M | 07 §10–11 |

**Exit:** double-booking impossible (constraint test with concurrent requests); price quotes match fixtures; full booking life-cycle e2e test.

---

## Phase 6 — Maintenance & compliance (4–6 weeks)

| WP | Work package | Size | Docs |
|---|---|---|---|
| P6-1 | Service plans and **due engine** (km / time triggers, recomputed on odometer events) | M | 12 §2 |
| P6-2 | Work orders, vendors, labour/parts lines, downtime blocks, cost allocation (company / driver / customer / insurer) | L | 12 §3 |
| P6-3 | Parts inventory (basic): catalogue, stock moves, reorder alerts | M | 12 §4 |
| P6-4 | Incidents and insurance claims; traffic offences; fuel anomaly detection | M | 06 §7–8 |
| P6-5 | Maintenance KPIs, compliance dashboard, cost-per-km; notification rules | M | 12 §6, 14 |

**Exit (M4 with Phase 5):** a vehicle off-road automatically blocks rentals and pauses W&P instalments suggestion; service due reminders fire on odometer updates.

---

## Phase 7 — Purchases, dealership & multi-currency (7–9 weeks)

| WP | Work package | Size | Docs |
|---|---|---|---|
| P7-1 | **Multi-currency**: enabled currencies per tenant, transaction currency, manual FX rates, base-currency snapshots, FX gain/loss postings | L | 20 |
| P7-2 | Suppliers, payables and supplier payments (recording) | M | 11 |
| P7-3 | **Purchases**: cost components in multiple currencies, landed-cost allocation, import status timeline, documents, receiving → creates the vehicle | XL | 11 |
| P7-4 | Dealer stock: statuses, pricing (cost / min price hidden by permission), ageing, transfers, consignment | L | 10 §2 |
| P7-5 | Leads / CRM, test drives, quotes | L | 10 §4–6 |
| P7-6 | Deals: reserve, payments, financing (cash / bank / in-house via Work & Pay engine), trade-ins, delivery, documents (sales agreement, delivery note) | XL | 10 §6–7 |
| P7-7 | Dealer commissions (tenant staff), depreciation job, COGS and sale postings, gross-profit per unit | M | 10 §8, 13 |
| P7-8 | Dealer reports | M | 14 |

**Exit (M5):** landed cost per vehicle reconciles with payments in two currencies; profit per unit matches the ledger.

---

## Phase 8 — Reports & analytics (4–6 weeks)

| WP | Work package | Size | Docs |
|---|---|---|---|
| P8-1 | **Report engine**: definitions in code, JSON / CSV / XLSX / PDF, async jobs with download links, per-tenant concurrency limits | L | 14 §2 |
| P8-2 | Report catalogue (executive, fleet, drivers, W&P, rentals, dealer, maintenance, finance, tax) | XL | 14 §3 |
| P8-3 | Scheduled reports by email; role-based dashboards; vehicle P&L complete | M | 14 §4 |
| P8-4 | Platform analytics in the console: growth funnel, adoption, health scores, cohorts, cost-to-serve, reseller performance | L | 27 §3.16 |
| P8-5 | Performance pass: summary tables, indexes review, read replica option | M | 22 §11 |

---

## Phase 9 — Platform maturity & integrations (6–8 weeks, ongoing)

| WP | Work package | Size | Docs |
|---|---|---|---|
| P9-1 | Cluster management: capacity view, add cluster, **move tenant between clusters**, orphan sweeper hardening | L | 22 §2.2, 27 §3.14 |
| P9-2 | **Cold archive** and restore runbook automation; annual archive verification; erasure-by-anonymisation with ledger | L | 26 §8 |
| P9-3 | Support desk (tickets, canned responses, SLA), demo / sandbox tenants, onboarding concierge checklists | M | 27 §3.13, §5 |
| P9-4 | Telematics / GPS ingestion (time-series), utilisation from ignition data, geofences | XL | 06 §9 |
| P9-5 | Accounting export (QuickBooks / Xero / CSV), bank-statement import for reconciliation | M | 13 |
| P9-6 | WhatsApp channel (tenant's own business account), deferred deep links on iOS, OCR for receipts | L | 15, 23 |
| P9-7 | Enterprise extras: API keys and webhooks for tenants, custom domains, dedicated clusters or per-tenant DB credentials | L | 04, 22 |

---

## 5. Parallel tracks

| Track | Starts | Notes |
|---|---|---|
| **Web portal (tenant)** | After Phase 2's API is stable (≈ week 20) | Billing tab and roles UI after Phases 1 and 4; QR connect page after P1-9 |
| **Admin console UI** | Alongside Phase 1 (API-first) | MVP screens for applications and tenants by M1; billing and reseller screens by M3 |
| **Mobile app** | After Phase 3 (≈ week 30) | App is updated to the new `/api/v1`; scan-to-connect and driver screens first (decision 28: app revisited after the backend) |
| **Legal / content** | From Phase 2 | VAT rates (accountant), transfer-letter and agreement wording (lawyer), terms and privacy, SMS and email templates |
| **Operations** | From Phase 0 | Support process, on-call rota, runbooks, pricing and reseller agreements |

## 6. Dependencies between phases

```
P0 ─▶ P1 ─▶ P2 ─▶ P3 ─▶ P4          (critical path to launch)
              │          │
              ├────────▶ P5 ─┐
              ├────────▶ P6 ─┼─▶ P8 ─▶ P9
              └─ (P4) ──▶ P7 ─┘
```
- P3 needs P2's finance recording, vehicles, drivers and documents infrastructure from P1/P2.
- P4 needs P1 (tenants, lifecycle, entitlements), P2 (notifications) and P3 for a meaningful product to sell.
- P5, P6, P7 need P2; P7 also needs P3's engine for in-house financing and P4 for multi-currency reporting consistency.
- P8 reads from everything built so far, so build report definitions as modules land and finish the engine here.

## 7. Risks (project level)

| Risk | Impact | Mitigation |
|---|---|---|
| Database-per-tenant operational overhead higher than expected | Slower provisioning, connection pressure | Phase 0 load test with 500 DBs; PgBouncer; cluster cap ~1,000 tenants; warm pool of spare DBs |
| Single developer capacity / key-person risk | Delays | Keep docs current; second developer from Phase 2; strong CI |
| Money-handling bugs (schedules, allocation, commission, proration) | Financial errors, trust loss | Property tests, ledger invariants, dry-run modes, reconciliation jobs |
| Wrongful automatic deactivation | Angry paying customers | Dry-run, circuit breaker, gateway guard, 48 h review queue, easy restore |
| Legal uncertainty (hire-purchase, e-signatures, data protection, no-delete vs erasure) | Rework of documents/flows | Early lawyer review; templates versioned and replaceable; flags for beta |
| Payment-provider constraints (MoMo recurring, sandbox differences) | Billing UX limits | Manual payment path always available; early sandbox integration |
| App-store policy on in-app payments | Mobile billing blocked | Billing tab on web; app links out |
| Scope creep from "roll out everything" | Launch slips | Strict phase exit criteria; launch at M3 with only P0–P4; later modules are additive |
| Backup/restore never tested | Data loss | Automated weekly restore test from Phase 0; quarterly drills |

## 8. Working agreement and what is still needed before Phase 0

### 8.1 Working agreement (decision 60)

- **I never commit.** I do not run `git add`, `git commit`, branch or push. All changes stay in the working tree for you to inspect and commit yourself.
- After each work package I give you: what changed (files and behaviour), the tests I ran and their results, anything I could not verify, and a **suggested commit message** (conventional-commit style, one message per logical unit so you can commit in small pieces).
- I work **one work package at a time** and stop at the end of each for your review unless you tell me to continue with the next one.
- Anything destructive (deleting legacy modules, dropping files, changing the pre-commit hook) is listed first and done as its own reviewable step.
- You give the go-ahead per phase, and I will tell you when a phase's prerequisites are ready.

### 8.2 Answered

| Item | Answer |
|---|---|
| Repository / branching | Same repo; override legacy code in place (decision 59) |
| Mobile apps | Unpublished; no compatibility needed; updated later with the new features. Package / bundle IDs are only needed at P1-9 (QR deep links) |

### 8.3 Still needed (Phase 0)

| Item | Blocks | Default I will use if you don't say otherwise |
|---|---|---|
| Domains (API, web portal, admin console) | P0-3 TLS/proxy, P1-9 deep links | `localhost` / `*.localhost` for local work |
| VPS provider and size; off-site backup storage provider and budget; recovery targets | P0-3 infrastructure, P0-4 backups (production part) | **Deferred by decision 63** — you will say when hosting is available. Until then everything runs locally with Docker Compose |
| Job queue | P0-8 | **pg-boss** (Postgres-based) |
| Expected tenant counts (year 1 / year 3) | P0-5 sizing assumptions | Plan for ~1,000 tenants per cluster |
| Who builds / second developer | scheduling only | Single developer assumed |

**Phase 0 can start before the infrastructure answers.** P0-1, P0-5, P0-6, P0-7, P0-8 and P0-9 run entirely on your machine with Docker Compose. P0-2 (CI) needs only the Git host, and P0-3/P0-4 wait for the VPS and storage decisions.

### 8.4 Start condition

I am **ready to start Phase 0** as soon as you say so. Suggested first step: P0-1 (repo and tooling), delivered as a reviewable set of changes with suggested commit messages.

## 9. Progress

| WP | Status | Notes |
|---|---|---|
| P0-1 Repo & tooling | **Done — awaiting your review** (2026-10-14) | Legacy code removed; ESM/TS 6/Vitest/ESLint+boundaries/Prettier; zod config; Dockerfile; compose.yaml. Runtime image switched to distroless `nodejs24-debian13:nonroot` (Scout: 0 critical/high/medium/low vs 4C/18H on `node:24-slim`). Docker image build not verified yet (Docker daemon not running) |
| P0-2 CI/CD | **Done — awaiting your review** (2026-10-14) | GitHub Actions: quality → integration (Postgres/Redis services) → image build, smoke test, Trivy scan (fails on fixable critical/high), SARIF to Security tab, publish to GHCR on `master`; CodeQL; dependency review; Dependabot (npm, Docker digests, actions). Actions pinned by SHA, base images by digest. **Staging deploy and migration job deferred** to P0-3/P0-5 (needs the VPS and the migration runner). Validated with actionlint and by running every job step locally; first real run happens on your next push |
| P0-5 Database foundation | **Done — awaiting your review** (2026-10-14) | Platform + tenant SQL migrations (0001), roles (`migrator`, `platform_app`, `tenant_app` via group roles), `db:setup`/`db:migrate`/`db:status`, migration runner (checksums, ordering, advisory lock, no-transaction files) with tenant fan-out and per-tenant status, tenant DB factory (clone template, lock CONNECT, stamp `tenant_info`), tenant pool manager (LRU, leases, identity + schema-version checks), transaction helper (SET LOCAL only — PgBouncer-safe), counters, audit log (append-only), outbox, keyset pagination. 64 unit + 38 integration tests. **Load test (local, PostgreSQL 18.6): 500 tenant DBs created in 16.2 s (p50 108 ms, p95 269 ms each); 8.4 MB disk per empty tenant DB (≈ 8.4 GB per 1,000 tenants); all 500 opened through the pool manager in 1.8 s with 50 pools max and ~54 connections.** PgBouncer itself is set up with infrastructure (P0-3); a backup role arrives with P0-4. Query layer is plain `pg` for now (decision 64). **Restructured to layer-first Clean Architecture with OOP classes behind `I*` ports and an Inversify container (decisions 67–68)** |
| P0-6 HTTP core | **Done — awaiting your review** (2026-10-14) | Express 5 app in `framework/express`; middleware in `adapters/middleware` (request id + context, request logging, helmet, CORS allow-list with wildcard subdomains, per-IP rate limit, 404, error handler); `errorPresenter` mapping every error to a stable code and status (no stack traces, generic 5xx messages, security alert for tenant DB mismatch); route declarations with zod validation that also generate the OpenAPI 3.1 document; `JsonLogger` with secret redaction + pretty sink; `ShutdownManager` + signal handlers; `/health/live`, `/health/ready` (`ReadinessService` + `DatabaseReadinessCheck`); Docker `HEALTHCHECK`; CI smoke test now starts the server and checks liveness + clean shutdown. Rate limiting uses an in-memory store (Redis store needed before running several replicas) |
| P0-7 Auth & access core | **Done — awaiting your review** (2026-10-16) | Argon2id password hashing; HS256 access tokens (`sub`, `tid`, `sid`, `ver`, 15 min) signed with a **per-tenant HKDF-derived key**, separate secret/audience for the platform console; opaque rotating refresh tokens (`<sessionId>.<256-bit secret>`, SHA-256 stored, row-locked rotation, reuse revokes the session); OTP challenges (6 digits, HMAC bound to purpose+subject, TTL, attempt lock, newest-only); tenant migration `0002` (`auth_sessions`, `otp_challenges`); cached tenant directory; permission catalogue (identity + organisation keys from doc 28) with `AuthorizationPolicy` (own/branch/all scopes, numeric limits) and a caching permission resolver; mandatory `access` on every route enforced by `AccessGuard` (X-Tenant/token agreement → `TENANT_MISMATCH` security alert, tenant status, permission version, permission) and a test that every route declares valid access. 214 unit + 50 integration tests. **Sign-in/refresh/logout endpoints and stricter auth rate limits come in P1-5** with the users table; until then `NoUsersPermissionResolver` rejects every token. Tenant is addressed by the `X-Tenant` header; host-subdomain resolution is added with the web portal |
| P0-8 Jobs, events, notifications | **Done — awaiting your review** (2026-10-16) | **pg-boss 12** (default from §8.3) in the platform DB, schema installed/upgraded by `db:migrate` as the migrator, app role data-only (verified: no DDL); typed job catalogue with per-queue retry/backoff/expiry; worker process `src/worker.ts` (`yarn dev:worker`) with per-job request context, tenant context and skip of deactivated tenants, graceful SIGTERM. Outbox dispatcher: after-commit drain trigger + hourly sweep, fan-out per subscribed handler, exponential backoff, idempotent handlers via `processed_messages` (tenant migration 0003). Scheduler: 15-minute tick, per-tenant timezone (`tenants.timezone`, platform migration 0002), once per local day via `tenant_schedule_runs` with catch-up; first daily job = retention clean-up. Notifications: `NotificationService` + typed, HTML-escaped email templates (`auth.otp_code`), `email_deliveries` with idempotency key queued atomically with its job, SMTP sender (Mailpit locally and in CI), content purged after sending. 232 unit + 56 integration tests. SMS (tenant providers), push and in-app channels plug into `NotificationService` with their modules |
| P0-9 Test & security harness | **Done — awaiting your review** (2026-10-16) | **Testcontainers**: `yarn test:integration` starts throw-away PostgreSQL 18 + Mailpit (tmpfs, removed after the run); `TEST_INFRA=external` for compose/CI services. **Tenant fixtures** (`TenantFixtures`: real DB + platform row, run-as/query/token helpers). **Generated isolation suite** over every tenant table discovered from the template (fixture or documented exemption required; A→B invisibility; app-role privileges; append-only; no DDL) plus platform-role checks and HTTP A-token-on-B via the container-wired app. **C1–C7 regression suite**; C7 also enforced by an ESLint rule banning runtime `RegExp`; C3 is a `todo` until registration exists (P1-5). JobWorker refuses tenant jobs without `tenantId` (doc 04 §13). `GET /api/v1/me`. **k6** scripts (`health`, `auth-rejection`; smoke/load/stress) run with local k6 or the Docker image — local smoke: health p95 4 ms, bad-token rejection p95 0.3 ms at ~3,500 req/s; load profile (20 VUs) health p95 8.5 ms. 252 unit + 72 integration tests |
| P0-3 Infrastructure | **Deferred** (decision 63) | No VPS yet; everything runs locally with `compose.yaml`. Resumes when you say hosting is available |
| P0-4 Backups | **Local part done — awaiting your review** (2026-10-16); **production part deferred** | Read-only `backup` role (`pg_read_all_data`, CONNECT on every database); logical dumps of each tenant (L2) and the platform DB (L3) on an exported snapshot with exact per-table row counts; client-side encryption (fresh AES-256 key per file, RSA-4096-OAEP key wrap, chunked AES-GCM — the server can write but not read backups); local storage with atomic writes; platform `backups` catalogue (migration 0003); **automated restore test** (scratch DB: checksum, restore, schema version, tenant identity, row counts, foreign keys); restore into a new database with provisioning grants; `yarn backup keygen|run|verify|restore|list`; runbooks in [31](31_backup_restore_runbooks.md). pg tools from PATH or the `postgres:18-alpine` image. **Waiting for hosting:** off-site write-only storage, WAL archiving/PITR, schedules, retention, alerts |
| P1-1 Platform staff auth & governance | **Done — awaiting your review** (2026-10-16) | Console API under `/api/platform/v1` (separate audience, own tables — migration 0004). **Invite-only staff** (first Super Admin and recovery via `yarn platform:invite-admin`); one-time invitation links (hash stored, 72 h); password policy; **mandatory TOTP** (RFC 6238, secrets encrypted with `MFA_ENCRYPTION_KEY`, replay-proof); lockout after 5 failures for 15 min with Super Admin email alert; new-device sign-in email; sessions checked on **every** request (60 min idle, 12 h max, 10 min access tokens, refresh rotation + reuse detection); **step-up** (password + code, 10 min) required automatically for permissions marked sensitive; platform permission catalogue + 7 seeded system roles synced by `db:migrate` (custom roles untouched); custom roles; escalation prevention; **four-eyes framework** (registered executors, self-approval impossible, 24 h expiry, executed behind a savepoint so failures are recorded without partial changes) — first use: granting Super Admin; immutable platform audit log with search API; stricter rate limit on credential endpoints. **Passkeys (WebAuthn) deferred** to when the console UI exists. 282 unit + 93 integration tests |
| P1-2 Applications & approval | **Done — awaiting your review** (2026-10-16) | Public signup `POST /api/v1/applications` (platform migration 0005): business details, slug check (reserved names, taken by tenants/open applications), Ghana phone normalisation to E.164; **email and phone verified with one-time codes** before review; applicant follows the application through a **private link** (token hashed, sent in `X-Application-Token`, rotated whenever we email a new link) to see status/messages and answer information requests. Duplicate in-progress applications refused; rejection can block re-applying (default 30 days). **Risk signals** (disposable email, previously rejected, existing customer, duplicate business name, IP velocity) with low/medium/high level. Console queue: list/search/filter, detail with timeline and similar applications, assign, request info, approve (records plan and trial days, default 14), reject (reason optionally shown); assisted signup by staff (link goes only to the client). Append-only application timeline; staff decisions in the platform audit log; applicant emails for each step; signup writes share the credential rate limit. **Provisioning on approval is P1-3.** **Platform SMS provider still to choose** — development `log` sender only (refuses to send in production). Also fixed the CI smoke test (missing production SMTP settings since P0-8; verified locally with the image). 289 unit + 102 integration tests |
| P1-3 Provisioning saga | **Done — awaiting your review** (2026-10-16) | Approval reserves the tenant (slug, `provisioning`) in the same transaction and queues `tenant.provision`. **Resumable saga** with each step recorded (`tenant_provisioning`, platform migration 0006): create DB from template → migrate → **seed in one tenant transaction** (organisation GHS/Africa-Accra, HQ branch, permissions + 5 system roles copied from the platform catalogue, 11 expense categories, inactive tax-code placeholders, owner user with the Owner role, invariants checked) → hashed `user_directory` entries → owner welcome email with a one-time link → `trialing` with trial end. Failures set `provisioning_failed` with step and error; pg-boss retries; console `GET/POST /api/platform/v1/tenants/:id/provisioning[/retry]`. **Owner first login**: `POST /api/v1/auth/invitations/accept` (X-Tenant) sets the password and returns tokens; the real tenant permission resolver (users → roles → permissions, widest scope, branches) replaces the "no users" placeholder. Tenant catalogue published by `db:migrate` (versioned by checksum); hourly `catalogue.sweep` + `tenant.catalogue_sync` update permissions and system roles, never custom roles. `provisioning.sweep` (10 min) re-queues stalled sagas and **reports** orphan databases (never drops). Tenant migration 0004 (organisation, branches, permissions, roles, users, invitations, expense categories, tax codes); isolation fixtures for every new table. 292 unit + 120 integration tests |
| P1-4 Tenant lifecycle (manual) | **Done — awaiting your review** (2026-10-16) | Tenant status machine (`TenantLifecycle`): **deactivate** (staff reasons requested_pause/abuse/legal/other, internal reason + tenant-facing message, step-up), remembering the previous status and locking against automatic restore; **restore** to the previous status; **read-only** set/clear (reads work, writes `403 TENANT_READ_ONLY`). Deactivation is immediate: status committed, cached status forgotten (other instances ≤ 5 s), **every tenant session revoked** (`tenant_deactivated`), requests answer `403 TENANT_DEACTIVATED`, jobs skip the tenant; owner emailed on deactivate/restore. Append-only `tenant_status_history` (platform migration 0007) + audit. **Branches**: deactivate/reactivate for owners (`/api/v1/branches/:id/…`) and staff on their behalf (`/api/platform/v1/tenants/:id/branches/…`), with precondition checks (default and last active branch refused; modules plug in their own checks); assignments to deactivated branches grant nothing, members get a new permission version (cache forgotten at once in-process), users whose branches are all deactivated get `403 BRANCH_DEACTIVATED` while the tenant keeps working. **Public `GET /api/v1/public/tenant-config?slug=`** (name, status + notice, currency, sign-in methods, server time; generic 404). Tenant migration 0005. **Deferred:** billing-only access for non-payment deactivation (P1-10, automatic) and the catch-up report after restore (needs the modules that create obligations). 296 unit + 128 integration tests |
| P1-5 Tenant identity & organisation | **Done — awaiting your review** (2026-10-16) | **Sign-in** (`/api/v1/auth/login` by email or phone, lockout 5/15 min, same answer for unknown accounts), **refresh** (rotation + reuse detection), **logout**, **password reset** by emailed code (always 202), **password change** (both sign out everywhere), **own sessions** list/revoke and admin "sign out everywhere"; **multi-business discovery** for the mobile app (`/api/v1/auth/discover`: only businesses where the password is correct). **Users**: list/view within branch scope, invite (emailed link, 72 h), resend, update, disable/enable (ends sessions, directory updated), role assignment per branch. **Roles**: list/view, create (or clone), edit (holders re-evaluated at once), delete if unused; system roles read-only; **escalation prevention** (no granting beyond own permissions/scope/branches, no own-role changes, Owner role never assignable, owner never disabled). **Branch-aware grants** (`mergeGrants`: a role assigned for one branch works only there; widest scope wins; most generous limits). `/me/permissions`, `/permissions`. **Organisation**: profile, timezone (validated), base currency (needs `settings.currency.manage`), document numbering formats; branches create/edit/make-default. Tenant migration 0006. C3 audit regression now a real test. **Phase 1 exit criterion met**: owner creates a custom role, invites a user to one branch, and that user's access is limited to it (integration test). 303 unit + 140 integration tests |
| P1-6 Console MVP APIs | **Done — awaiting your review** (2026-10-16) | **Dashboard** (`/dashboard`: tenants by status, deactivated by reason, live tenants, open applications by status, oldest waiting review, new applications/tenants 7/30 days, trials ending within 7 days, provisioning and schema failures, pending approvals). **System health** (`/health`: platform DB reachability/latency/connections/size and tenant DB count; pg-boss queues (ready, deferred, active, failed 24 h, oldest wait); email backlog and failures; backups (last platform backup, restore-test result, tenants without a backup in 26 h, failures); migrations (platform and tenants vs this build); fixed thresholds; a failing probe shows as critical; app version, uptime, memory). **Tenant list** (`/tenants`: status, tag and creation-date filters, search by name/slug/owner email/phone, keyset pages) and **360° profile** (`/tenants/:id`: status and reason, owner contact and application details, provisioning saga, schema version, backups, tags, notes count, pending approvals, plus usage counts read-only from the tenant DB: users by status, active in 30 days, last login, branches, custom roles, DB size; an unreachable DB never fails the page). **Timeline** (application events + audited console actions). **Notes** (author-only edit/delete, anyone pins, deletion hides, all audited) and **tags** (normalised, max 20, `/tags` usage counts). **Backups** list/summary and per tenant; **migrations** view (new permission `platform.data.migrations.view`); provisioning now records each new database schema version. **Audit viewer**: entity filters and CSV export (10,000-row cap, formula-safe, audited). Platform migration 0008. Billing tiles (MRR, due for automatic deactivation) wait for P1-10; DAU/MAU for usage_daily. 314 unit + 153 integration tests |
| P1-7 Resellers, part A | **Done — awaiting your review** (2026-10-16) | **Partner profiles** (`/partners`: create with generated or chosen referral code, edit, trusted flag, pause/resume, terminate; list with user/tenant/open-application counts). **Partner console users** (platform users of type `partner`, invited by staff or, with `users.manage`, by colleagues; password + authenticator like staff; never staff roles, enforced in code and by a database trigger; only `/partner/*` and their own session routes). **Per-partner capability grants** (`PUT /partners/:id/capabilities`, 12 reseller capabilities, 6 on by default, sensitive ones off; changes re-issue the users' tokens; terminating rejects them at once). **Referral capture** (signup `referralCode`, any case; paused/terminated partners not attributed) and **partner-assisted signup** (`POST /partner/applications`); self-referral and burst signals, 30 assisted applications per partner per day. **Attribution** (recorded at approval as `referral_code` or `assisted`; staff reassign/remove with reason via `PUT /tenants/:id/partner`, audited). **My tenants** (`/partner/tenants[/:id]` with status history; owner contact and billing state only with their capabilities, otherwise omitted) and **application tracker** (`/partner/applications[/:id]` with messages, `respond` to information requests). Dashboard and profile with referral link. Platform migration 0009; staff permissions `platform.partners.view|permissions.grant|terminate|attribution.manage`. **Phase 1 exit criterion met**: a partner user sees only their own tenants and a field they lack permission for is omitted (integration test). Commissions in part B (phase 2). 319 unit + 165 integration tests |
| P1-8 Files service | **Done — awaiting your review** (2026-10-18) | **S3-compatible object storage** (AWS SDK v3; AWS S3, R2, RustFS or MinIO; RustFS 1.0.1 in compose, tests and CI) with a **private bucket** (signed URLs only) and a **public bucket** for public files behind a CDN base URL (`FILES_PUBLIC_BASE_URL`). **Pre-signed uploads** (client → storage directly; the signature fixes content type and size), then **confirmation** that checks the stored size and the real type from the first bytes (PNG/JPEG/WebP/PDF; SVG never accepted); a mismatch is refused and the object deleted. **File records** in each tenant DB (`files`, tenant migration 0007) and the platform DB (`platform_files`, platform migration 0010), with kinds and per-kind rules (type list, size limit, visibility). **Signed download URLs** (5 min, `attachment` with the original name). **Business logo** (`PUT /api/v1/organisation/logo`, shown in `/organisation` and public tenant-config as `logoUrl`; the old file is deleted). **KYC documents**: applicants attach up to 10 to an open application via their private link; staff read them in the review queue; partner documents (KYC, agreements) kept by staff, audited. **Abandoned uploads** swept daily (`files.sweep` for platform files, tenant daily maintenance for tenant files). `yarn storage:setup` creates buckets, public-read policy and CORS. Image resizing/thumbnails later (when vehicle photos arrive). 325 unit + 173 integration tests |
| P1-9 Mobile connect | **Done — awaiting your review** (2026-10-18) | **Signed connect links** (Ed25519; key server-side from `yarn mobile:keygen` / `MOBILE_CONNECT_KEY_FILE`, fixed development key locally, required in production; key ids for rotation) and **QR codes** (SVG) at `GET /api/v1/mobile/connect-link` (`settings.mobile.connect`). **Payload format** v1 for the app (https link + `autoforce://` scheme; fixed signed message; spec in docs/23 §11) and public keys at `/api/v1/public/mobile/connect-keys`. **Backend host allow-list** (`MOBILE_ALLOWED_API_HOSTS`, exact or one-level wildcard; the API base must be in it; https in production). **Invitation app links** (signed, with token and expiry) in invitation emails. **App-link metadata** (`/.well-known/assetlinks.json`, `apple-app-site-association`, from store identifiers in config) and the **`/connect` landing page** (open the app / get it; Play install referrer without invitation tokens). Public tenant-config gains `logoUrl` (P1-8) and `app` (min/latest version, store links). Console **link diagnostics** (`platform.mobile.view`). Store identifiers, domains and app versions are config until the apps are registered. 334 unit + 180 integration tests |
| P1-10 Subscription skeleton & entitlements | **Done — awaiting your review** (2026-10-18) | **Plans** (`standard`: flat price per branch, set by staff with the sensitive `platform.billing.prices.manage`; `enterprise`: priced by hand), **trial subscription** started by the provisioning saga (existing tenants backfilled), **licence type** (`PUT /tenants/:id/licence-type`, locked at the first payment), trial extension (≤ 60 days ahead) and billed branch count for staff. **Entitlements** (`branchesMax`, `canBuyBranches`, trial end) and the **branch-limit hook** on branch creation and reactivation: trial up to 3 active branches; paying tenants add one by confirming the extra charge (`confirmBranchPurchase`, raises the billed count); deactivating lowers it; `ENTITLEMENT_BRANCH_LIMIT` (409) explains the price. **Manual billing**: staff issue the next period's invoice (standard computed: billed branches × price; enterprise line by line with `countsAsLicence`), gap-free numbers `AF-INV-YYYY-NNNNNN`, record payments (bank, MoMo, cash, cheque; unique reference; no overpayment), void unpaid invoices. A **fully paid** invoice activates the subscription for its period, locks the licence type and makes a trial/overdue tenant active or lifts a **billing** deactivation (manual ones stay). **Tenant Billing tab API** (`/api/v1/billing/subscription|invoices|transactions`, `billing.view`; no internal fields). Console dashboard billing tiles (MRR of standard licences, billed branches, open/overdue invoices). Platform migration 0011. Phase 2: gateway checkout, dunning and automatic deactivation, billing-only sign-in, extensions, invoice PDFs, proration, quote builder. 342 unit + 185 integration tests |
| P2-1 Reference data & settings | **Done — awaiting your review** (2026-10-18) | **Currency catalogue** (11 ISO currencies with symbol and minor units; `GET /api/v1/currencies`) and **`Money`** (integer minor units per currency, exact BigInt arithmetic, half-even rounding, decimal-string input, `{ amountMinor, currency, formatted }` output, `₵` on screens and the code in SMS/exports, allocation that always adds up, conversion by rate). **Currency settings** (`/api/v1/settings/currency`: base currency suggested from the country at provisioning, enabled currencies, base locked once money is recorded — `base_currency_locked_at`, set by finance). **Tax**: settings (`/settings/tax`: scheme, VAT number, tax-inclusive prices, default sales code) and the business's own **tax codes with dated rate components** (levies on the net or compounding, no overlapping periods, active only with rates unless exempt/zero-rated, rate in force on the document date, inclusive prices worked back exactly, `preview` endpoint); **no rates seeded** (decision 100). **Manual FX rates** (`/api/v1/fx-rates`, suggestion of the latest on or before a date). **Expense categories** as a two-level tree (seeded defaults, add/rename/move/deactivate). **Vehicle makes and models** (platform list of 25 common makes with models; staff add). **Document numbering** service (defaults per document kind, the business's formats, gap-free counters per kind and year). Platform migration 0012, tenant migration 0008. 354 unit + 193 integration tests |
| P2-2 Vehicles | **Done — awaiting your review** (2026-10-19) | Built as the single vehicles module (no separate "v2"; it replaces the legacy vehicle CRUD). **Register** (`/api/v1/vehicles`: branch-scoped list with keyset paging and filters by status, branch, usage, group, make, tag and plate search in any spelling; register with a `VEH-00001` code, normalised plate and VIN, unique among vehicles not removed, make/model linked to the platform catalogue by id or name, specs, tags, custom fields, first odometer reading; edit; bulk transfer between branches; remove mistaken entries with a reason). **Financials** (cost, residual value, straight-line book value) shown and edited only with the sensitive `vehicles.financials.view`. **Lifecycle**: 19 statuses with a transition table; users move vehicles by hand only between states no module owns (incidents allowed from any state), modules move them with a reference to their record; every change in `vehicle_status_history`; `/vehicle-statuses`, `status-options`. **Documents and compliance** (registration, roadworthy, insurance, tax sticker, permit, customs, other; expiry, cost, reminder days, scans; red/amber/green per vehicle and the compliance board; `operability()` for later modules). **Odometer** (only increasing, late entries checked against their neighbours, replacement with a reason). **Photos** (gallery, primary photo). **Groups**. **CSV import** (template, preview of every row, all-or-nothing commit) and **export** (same columns, financial columns only with access). **Overview** skeleton (`/:id/overview`, `/:id/timeline`). **Vehicle settings** (required documents, expiring window, warn/block, reminder days, custom fields). Branch deactivation blocked while vehicles remain. New Fleet Officer role. Tenant migration 0009. 367 unit + 212 integration tests |
| P2-3 Parties | **Done — awaiting your review** (2026-10-19) | **Drivers** (`/api/v1/drivers`: branch-scoped list with paging, status/employment filters and search by name, code, licence or phone in any format; register as applicants with `DRV-00001` codes, normalised phone, Ghana Card and licence, unique among drivers; edit and move between branches; emergency contact and MoMo/bank payout details; onboarding checklist; activate / suspend / reinstate / terminate / rehire with reasons and history; expiring-licence list; removal of mistaken entries). **Guarantors** per driver. **Customers** (`/api/v1/customers`: individuals and companies shared by every branch, KYC fields, corporate credit limit and payment terms, search, watch/blacklist/clear with reasons and history). **Suppliers** (`/api/v1/suppliers`: types, payment terms, payout details, deactivation). **Identity documents** with scans for drivers, guarantors and customers (sensitive permissions; Ghana Card numbers masked otherwise). **Driver settings** (`/settings/drivers`). Branch deactivation blocked while drivers remain. `BranchScope` shared by vehicles and drivers. Tenant migration 0010. 374 unit + 227 integration tests |
| P2-4 Assignments | **Done — awaiting your review** (2026-10-19) | **Vehicle ↔ driver assignments**: one open assignment per vehicle and per driver (partial unique indexes) and no overlapping periods (exclusion constraints, late entries included). `POST /vehicles/:id/assignment` (available vehicle, active driver of the same branch, valid licence, compliance warn/block), `/end` (reason, odometer, back to available or the workshop), `/handover` (driver change in one step, terms carried over), `PATCH …/terms`. **Handover checklist** (configurable items, fuel level, driver acknowledgement) and odometer at both ends, recorded as readings. **Remittance terms** per assignment (fixed target with amount, period and days off / variable / none). Vehicle moves to `assigned` and back through the module path with the assignment as reference. Assignment board and history (`/api/v1/assignments`), "who was driving at …" (`/vehicles/:id/assignment-at`). Vehicle overview shows the current driver; driver details show the current vehicle; drivers with a vehicle cannot be suspended, terminated or moved. Assignment settings. Tenant migration 0011. 378 unit + 233 integration tests |
| P2-5 Finance recording core | **Done — awaiting your review** (2026-10-19) | **Ghana standard VAT** seeded as one code with dated levies (VAT 15%, NHIL 2.5%, GETFund 2.5% on the same value from 2026-01-01, Act 1151; zero-rated and exempt codes), editable per business; existing tenants migrated. **Ledger**: system chart of accounts, balanced journal entries in the base currency (deferred DB trigger), immutable posted lines, reversals, trial balance, ledger lines by account/party/vehicle/branch, party accounts (credit, receivable). **Invoices**: drafts, issue (INV numbers, tax snapshot on the issue date, posting), void with reversal; tax only for VAT-registered businesses. **Payments** (record only): cash, MoMo, bank, cheque, card; money in lands in the party's credit and is allocated to invoices (credit/wallet for the rest), refunds limited to credit, money out to an expense; release and reversal; receipt data (RCT). **Cash sessions** with float, expected cash and posted variance. **Foreign currency** with the day's rate and exchange differences. **Period lock** (app + DB). Base currency locks at the first posting. Cashier role. Tenant migrations 0012–0013. 386 unit + 250 integration tests |
| P2-6 Expenses | **Done — awaiting your review** (2026-10-19) | One expenses module (no separate "v2"). **Expenses**: draft, split across vehicles (equal or by amounts), purchase VAT worked back from the receipt total, submit (EXP numbers), approve by someone else within the role's `max_amount_minor` limit or automatically by **approval rules** (category/branch/amount, by priority), reject and resubmit, **pay through finance** (payment out against payables; reversing the payment reopens the expense), void (reversal); duplicates flagged; **receipts** as scans, required above a threshold. Approval posts each share to the category's account (or vehicle/other expenses), input VAT, and payables to the supplier/driver/payee; costs borne by a driver go to driver receivables. Categories can point at a ledger account. **Recurring expenses** created by the tenant's daily job (catching up). **Monthly budgets** with 80%/100% levels. **Fuel logs** creating the fuel expense and an odometer reading, with efficiency and anomaly flags. Expense settings. Tenant migration 0014. 395 unit + 264 integration tests |
| P2-7 Remittances & driver ledger | **Done — awaiting your review** (2026-10-19) | **Expected rows** per period of each fixed-target assignment from the tenant's daily job (daily without days off, weekly/monthly anchored on the start); targets owed once the period plus grace days passes (or money is confirmed). **Declarations** (method, reference, ride-hailing earnings) **approved** as finance payments settling the period, or **rejected**; money **recorded** directly; **variable** periods declared on payment (income = money); **waivers** of shortfalls; payment reversals reopen the period. **Driver ledger**: one balance per driver, statement with opening/closing and shortfall ageing, deductions and bonuses. **Operations board**: fleet out/idle/workshop, today's remittances, drivers behind, licences expiring. Remittance settings, permissions and role grants. Tenant migration 0015. 402 unit + 273 integration tests |

## 10. Change log of this plan

- 2026-10-14: first version, replaces doc 18.
- 2026-10-14: same repo, legacy code overridden in place; mobile apps unpublished; no automatic commits; working agreement added (§8).
