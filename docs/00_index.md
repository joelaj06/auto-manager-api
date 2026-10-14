# AutoManager — Brainstorm & Architecture Docs

> Status: **Brainstorm / design phase.** Nothing in this folder has been implemented yet.
> **Read [21_decisions_log.md](21_decisions_log.md) first** — the product owner's answers (PostgreSQL with a database per tenant, no data migration, tenant-side payments are record-only while tenants pay *us* in-app, per-branch pricing, e-signed transfer letter, backups essential) supersede parts of docs 03, 05, 13 and 17.
> Started: 2026-10-13. These documents are living — update them as decisions are made.

## How to read this folder

| # | Document | What it covers |
|---|----------|----------------|
| 01 | [Current state assessment](01_current_state_assessment.md) | What exists today, how it's wired, and every bug / risk found during review |
| 02 | [Product vision & scope](02_product_vision_and_scope.md) | Who the product serves, business segments, module map, plan tiers |
| 03 | [Target architecture](03_target_architecture.md) | Modular monolith, layers, DI, events, jobs, API conventions, deployment |
| 04 | [Multi-tenant architecture](04_multi_tenant_architecture.md) | Control plane vs tenant plane, resolution, auth binding, provisioning, migrations |
| 05 | [Data model & DB conventions](05_data_model.md) | Collection catalogue, money, IDs, codes, soft-delete, indexes, ER overview |
| 06 | [Vehicle records & lifecycle](06_vehicle_records_and_lifecycle.md) | Vehicle master, state machine, documents, odometer, assignments, telematics |
| 07 | [Car rentals (enhanced)](07_car_rentals.md) | Reservations, availability, rate plans, check-out/in, deposits, damages |
| 08 | [Work & Pay (hire purchase)](08_work_and_pay.md) | Schedules, arrears, penalties, defaults, ownership transfer |
| 09 | [Driver operations & remittances](09_driver_operations_and_remittances.md) | Today's "sales" module re-imagined: targets, shortfalls, driver ledger |
| 10 | [Car dealership](10_car_dealership.md) | Inventory, leads, quotes, deals, trade-ins, financing, commissions |
| 11 | [Vehicle purchases & procurement](11_vehicle_purchases_and_procurement.md) | Buying cars: suppliers, imports, landed cost, supplier payments |
| 12 | [Maintenance & expenses](12_maintenance_and_expenses.md) | Service schedules, work orders, parts, vendors, expense approvals, fuel |
| 13 | [Finance, ledger & payments](13_finance_ledger_and_payments.md) | Unified money movement: invoices, receipts, ledger, MoMo/Paystack |
| 14 | [Reports & analytics](14_reports_and_analytics.md) | Report catalogue, P&L per vehicle, exports, scheduled reports |
| 15 | [Notifications & automation](15_notifications_and_automation.md) | Reminders, channels, scheduler, rules |
| 16 | [Security, RBAC & audit](16_security_rbac_and_audit.md) | Auth hardening, permissions model, scoping, audit trail |
| 17 | [Code optimization & refactoring](17_code_optimization_and_refactoring.md) | Concrete refactors, performance, testing, tooling |
| 18 | [Roadmap & phasing](18_roadmap_and_phasing.md) | *Superseded by doc 30.* Early roadmap, kept for history |
| 19 | [Open questions](19_open_questions.md) | Decisions that need the product owner's input |
| 20 | [Currency management](20_currency_management.md) | User-selectable currency (default **Ghana Cedi, GHS**), multi-currency transactions, FX rates, formatting, migration |
| 21 | [Decisions log](21_decisions_log.md) | Product owner's answers (2026-10-13) and their impact |
| 22 | [PostgreSQL architecture](22_postgresql_architecture.md) | PostgreSQL with **a database per tenant**: platform + template DBs, pools/PgBouncer, migration fan-out, provisioning saga, conventions, stack, VPS deployment, rewrite strategy |
| 23 | [Mobile onboarding: QR & deep links](23_mobile_onboarding_qr_and_deeplinks.md) | QR on the web portal, app/universal links, signed payload, tenant-config endpoint |
| 24 | [Documents & e-signatures](24_documents_and_esignatures.md) | Document engine, W&P transfer letter signed by owner and driver, verification |
| 25 | [Platform billing & subscriptions](25_platform_billing_and_subscriptions.md) | How tenants pay Autoforce's per-branch subscription in-app: invoices, checkout, webhooks, dunning, access states |
| 26 | [Backup & disaster recovery](26_backup_and_disaster_recovery.md) | WAL/PITR + per-tenant dumps, off-site encrypted storage, RPO/RTO, restore runbooks and drills |
| 27 | [Platform admin console](27_platform_admin_console.md) | Super-admin console for us: tenant approval, lifecycle (approve, billing-driven deactivate/restore, extensions), branches, billing, monitoring, support/impersonation, security, analytics |
| 28 | [Tenant roles, permissions & seeding](28_tenant_roles_permissions_and_seeding.md) | Permission catalogue in the platform DB, seeded into each tenant DB at creation; system vs custom roles, scopes, limits, sync on releases |
| 29 | [Reseller / partner program](29_reseller_partner_program.md) | Reseller console accounts, referral attribution, per-reseller commission terms (Super Admin), commission ledger and payouts, what resellers can see |
| 30 | [Implementation plan (phased)](30_implementation_plan.md) | **Authoritative build plan**: phases 0–9, work packages, milestones M0–M6, exit criteria, risks, what is needed before Phase 0 |

## Legend used across docs

- 🔴 **Critical** — security or data-integrity issue; fix before onboarding real tenants.
- 🟠 **High** — functional bug or design flaw that will hurt soon.
- 🟡 **Medium** — tech debt / inconsistency.
- 🟢 **Idea** — enhancement / new feature.
- **MVP / V2 / V3** — rough phase tags (see doc 18).

## Guiding principles

1. **Fix the foundation before adding floors.** Several critical tenant-isolation and auth issues exist (doc 01, 16). New modules should land on a corrected base.
2. **One money pipeline.** Rentals, work-and-pay, remittances, dealer sales, purchases and expenses should all post to a single payments/ledger layer (doc 13) so reporting is trivial and consistent.
3. **Vehicle is the hub.** Every module hangs off the vehicle record; vehicle P&L is the killer report.
4. **Modules are switchable per tenant.** A rental company, a dealer and a hire-purchase fleet owner should each see only what they pay for (doc 02, 04).
5. **Events over coupling.** Modules talk through domain events (e.g. `rental.checkedIn` → vehicle status, ledger, notification) instead of calling each other's repositories.
