# 18 — Roadmap & Phasing

> **SUPERSEDED (2026-10-14) by [30_implementation_plan.md](30_implementation_plan.md)**, which is the authoritative phased plan with work packages, milestones and exit criteria. This file is kept for history only.

> ## Revision 2026-10-13 (supersedes P0/P1 below where they conflict)
> Decisions: PostgreSQL, no data migration, rewrite persistence, VPS hosting, everything in scope, tenants record-only payments, per-branch pricing.
>
> **Revision 2 (later 2026-10-13):** database-per-tenant (decision 26), tenants pay subscriptions in-app (27), backups essential (29).
>
> **P0 — Postgres foundation (≈ 5–6 weeks)**
> - [ ] VPS + Docker Compose environment, CI with a Postgres service container
> - [ ] **Backups (doc 26)**: WAL archiving/PITR to off-site encrypted bucket, nightly per-tenant dumps, platform DB dumps, alerts, automated restore test — *before any real tenant*
> - [ ] Postgres + Drizzle; `autoforce_platform` DB, `tenant_template` DB, tenant DB pool manager (LRU + PgBouncer) with `tenant_info` assertion, roles, SQL migration runner with fan-out, generated isolation tests; load test with ~500 empty tenant DBs
> - [ ] Auth v2: tenant-bound tokens, refresh sessions, invitations (no public admin signup), platform admin auth separate (C1–C5)
> - [ ] Validation (zod), error codes, log redaction, config validation, rate limiting (C6, C7)
> - [ ] Counters, audit log, outbox, jobs (pg-boss or BullMQ), file storage
> - [ ] Tenant provisioning saga: verify signup → `CREATE DATABASE … TEMPLATE` → seed (organisation, default branch, roles, categories, counters, owner) → platform records (directory, subscription/trial) → activate; idempotent and retryable
> - [ ] OpenAPI generation; `/api/v1` skeleton; `public/tenant-config`
> - [ ] **Permission catalogue + role templates in platform DB, seeded into tenant DBs at provisioning, catalogue sync job (doc 28)**
> - [ ] **Platform console MVP (doc 27 §11 P0)**: staff auth + MFA, seeded staff roles, applications queue (approve/reject), tenant list/profile, deactivate/restore + billing-driven automation (doc 25 §5), audit log, backup & migration visibility, health page
>
> **P1 — Port + core money (≈ 8–10 weeks)**: organisation/branches, users/roles, vehicles v2, drivers/customers/suppliers, expenses v2, remittances (with optional target mode), currency v1 (default GHS), finance recording (payments, allocations, receipts, cash sessions, VAT codes), Work & Pay v2 (schedule, arrears, penalties, restructure, default/repossession) **plus document engine and e-signed agreements + transfer letter** (doc 24), QR/deep-link connect endpoints (doc 23), per-branch subscription entitlements; **platform billing v1** (plans, subscriptions, invoices, manual payment recording; doc 25); **platform console P1** (branch management, entitlement overrides, read-only impersonation, user support actions, four-eyes approvals, announcements/maintenance; doc 27 §11); custom tenant roles UI/API (doc 28 §10–11); **partner (reseller) console accounts and assisted signup** (doc 27 §1, §3.2). Paystack checkout/webhooks/saved cards/dunning in P2.
>
> P2–P6 below stay in the same order. Items mentioning Paystack/MoMo collection, payment links, webhooks and SMS credits are **dropped from tenant-to-customer scope** (decisions 16–17); gateway work moves to **platform billing** (doc 25).

Durations are rough for **one backend developer**; adjust once team size is known. Each phase ends with something shippable.

## P0 — Foundation & safety (≈ 3–4 weeks)

Goal: safe to onboard paying tenants.

- [ ] Security fixes C1–C7 (tenant-bound tokens, platform auth, invite-only users, refresh tokens, error/log redaction, regex escaping, config validation)
- [ ] Quick bug fixes H1–H17 (doc 17 §1)
- [ ] Single DI container, base repository, validation middleware (zod), error codes
- [ ] Counters service for codes
- [ ] Migrations framework + `migrations_state`
- [ ] Docker Compose (Mongo replset + Redis), CI pipeline, lint/typecheck
- [ ] Tenant isolation test suite
- [ ] Decide hosting (move off serverless if adopting workers) — doc 03 §10

## P1 — Core money & fleet (≈ 6–8 weeks)

- [ ] Organisation + branches (replace Company), scope-based RBAC v2, audit log
- [ ] Money value object, minor units migration
- [ ] Currency management v1 (doc 20): currency catalogue, tenant base currency selector (default **GHS**), `currency` on every money document, existing data migrated to GHS
- [ ] Finance core: payments, allocations, receipts (PDF + SMS), cash sessions (basic)
- [ ] Vehicle registry v2: status machine, history, documents, odometer, assignments
- [ ] Remittances (rename from Sales) + driver ledger
- [ ] Expenses v2: approvals, split, receipts, categories tree
- [ ] Work & Pay v2: schedule, allocation, arrears job, penalties, completion/transfer, statements
- [ ] Background jobs (BullMQ) + scheduler + notifications (SMS + email) for W&P and documents
- [ ] Dashboard fixes + `daily_vehicle_stats`

## P2 — Rentals v2 (≈ 4–6 weeks)

- [ ] Vehicle classes, rate plans, extras, pricing service
- [ ] Availability engine (`vehicle_blocks`), calendar
- [ ] Booking lifecycle, check-out/in inspections, damages
- [ ] Deposits, invoices, contract PDF + signature
- [ ] Rental notifications & reports

## P3 — Maintenance & compliance (≈ 3–5 weeks)

- [ ] Service plans & due engine
- [ ] Work orders, vendors, downtime
- [ ] Fuel logs & anomalies
- [ ] Incidents & insurance claims
- [ ] Parts inventory (basic)

## P4 — Purchases & dealership (≈ 6–8 weeks)

- [ ] Multi-currency transactions + manual FX rates + FX gain/loss (doc 20) — needed for imports
- [ ] Suppliers, purchases, cost components, landed cost, import tracking, receiving → vehicle
- [ ] Stock management, pricing, ageing
- [ ] Leads/CRM, test drives, quotes, deals, trade-ins, commissions
- [ ] Ledger postings for COGS / vehicle sales; depreciation job

## P5 — Reports, portals, integrations (ongoing)

- [ ] Report engine + catalogue (doc 14), scheduled reports, XLSX/PDF exports
- [ ] Paystack payment links & webhooks (tenant subaccounts), MoMo reconciliation import
- [ ] Driver app endpoints (statement, pay, submit remittance, fuel, issues)
- [ ] Customer portal / booking widget
- [ ] Platform console: plans, entitlements, billing, impersonation, tenant export/delete
- [ ] WhatsApp notifications

## P6 — Scale & differentiation (V3)

- [ ] Telematics/GPS integration, live map, geofences, utilisation from ignition data
- [ ] Accounting exports (QuickBooks/Xero), bank feeds
- [ ] OCR for receipts & documents
- [ ] Dealer listings feed / marketplace
- [ ] Predictive maintenance & replacement planning
- [ ] Multi-language templates

## Milestone definition of done

- Migrations written and tested on a copy of production data.
- API documented (OpenAPI) and mobile/web teams notified of v1 deprecations.
- Permissions seeded for existing tenants' roles (mapping old → new).
- Regression + isolation tests green.
- Release notes in `docs/changelog/` (to create when implementation starts).
