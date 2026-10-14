# 27 — Platform Admin Console (Super Admin)

The console used by **us, the owners/managers of the whole system**, to run Autoforce Manager as a business: approve and manage tenants, watch system health, manage billing, support customers, and keep the platform safe.

> Not part of any tenant. Separate web app, separate login, separate API namespace, separate database tables (`autoforce_platform`). Tenant tokens are never accepted here and platform tokens are never accepted on tenant APIs.

## 1. Who uses it (platform staff roles)

| Role | Typical person | Can do |
|---|---|---|
| **Super Admin** | Founder / CTO | Everything, including managing staff and dangerous actions (as approver) |
| **Operations** | Ops manager | Approve/reject tenants, deactivate/restore (special cases), extensions, branches, data operations, migrations, backups |
| **Support** | Support agent | Search tenants/users, reset access, read-only impersonation, notes, tickets, announcements |
| **Billing / Finance** | Accountant | Plans, invoices, payments, refunds, credits, revenue reports |
| **Sales / Onboarding** | Account manager, partners | View signup queue, trials, tenant health, assign plans/coupons; no destructive actions |
| **Engineering / On-call** | Developers | System health, jobs, logs, feature flags, diagnostics; no business data by default |
| **Auditor (read-only)** | Compliance | Audit logs, reports |
| **Partner / Reseller** | External sales agent given a console account (decision 33) | Create assisted tenant applications, see **only their own referred tenants'** status, onboarding progress, subscription status and commissions. No access to other tenants, tenant business data, support mode, or system settings |

Anyone can be given console access by a Super Admin (an invite creates the account; MFA enrolment is forced on first login). Super Admin can also create **custom staff roles** from the platform permission catalogue. Platform roles and permissions are themselves **seeded in the platform DB** (same mechanism as tenants, doc 28 §12) and editable by Super Admin only.

## 2. Security model (non-negotiable)

| Control | Detail |
|---|---|
| Separate surface | `admin.<domain>`, API under `/api/platform/v1/*`, own JWT audience/secret, own `platform_users` table |
| Strong auth | Mandatory MFA (TOTP or WebAuthn passkeys). Short sessions (e.g. 60 min idle), re-auth for sensitive actions |
| Network | Optional IP allow-list / VPN for the admin host; rate limiting; no public self-registration of staff (invite only by Super Admin) |
| **Step-up auth** | Re-enter password/MFA for: manual deactivate, restore from backup, impersonate-write, refund, change plan prices |
| **Four-eyes approval** | Second staff member must approve: hard-delete tenant, restore tenant data from backup, move tenant between clusters, write-mode impersonation, refunds above a threshold, bulk actions over N tenants, permission catalogue changes that affect system roles |
| Reason required | Every state-changing action asks for a reason (+ optional ticket reference). Stored and (where relevant) shown to the tenant |
| Full audit | `platform_audit_logs` (immutable): actor, action, target tenant/user, before/after, reason, IP, device, request id. Exportable, retained long-term |
| Least data | Staff see operational metadata by default. Tenant **business data** (vehicles, customers, payments) is only visible through time-boxed, audited impersonation, never in list/search screens |
| Secrets | Console never displays or logs tenant secrets (SMS keys, tokens) |
| Alerts | New staff login from unknown device, failed MFA bursts, dangerous action performed → notify Super Admins |

## 3. Console modules

### 3.1 Dashboard & monitoring ⭐
**Business tiles**: active / trialing / past-due / deactivated tenants (by reason) and **tenants due for automatic deactivation in the next 48 h**, new signups (7/30 days), pending approvals, MRR, ARR, ARPA, churned this month, total branches billed, active users (DAU/MAU), top tenants by activity.

**System health** (live, from metrics/health endpoints):
- API: request rate, p50/p95/p99 latency, 4xx/5xx rates, per-route and per-tenant top offenders.
- Workers/queues: depth, failed jobs, oldest job age, scheduler lateness.
- PostgreSQL: connections, replication/WAL lag, disk usage and growth, slow queries, number of tenant DBs, per-cluster capacity (tenants vs ~1,000 target), autovacuum/bloat warnings.
- PgBouncer: pool saturation, waiting clients.
- Redis, object storage usage, email provider status, payment gateway status/webhook lag.
- Backups (doc 26): last successful backup per layer, WAL archive lag, tenants without a recent dump, last restore-test result.
- Migrations (doc 22 §2.5): tenants by schema version, failed/pending list.
- Deployments: current app version, previous, rollback button/link.

**Alerts centre**: unified list (severity, source, tenant, acknowledged-by, runbook link). Push to Slack/Telegram/WhatsApp/email/SMS for on-call.

**Public status page** feed (incidents + scheduled maintenance) so tenants see outages without calling us.

### 3.2 Tenant onboarding & approval queue ⭐

Self-signup creates an **application** (not yet a database). Staff review, approve, reject or ask for more information.

```
signup form → email + phone verified → application: pending_review
   ├─ auto-approve rules pass (optional)  ─┐
   ├─ staff: approve ─────────────────────┤→ approved → provisioning → trial/active
   ├─ staff: request info (message sent, status needs_info) → applicant replies → back to pending_review
   └─ staff: reject (reason, optional email) → rejected (can re-apply after N days)
```

Review screen shows: business name, type (fleet / rental / dealer / mixed), country, contact person, phone, email, TIN / registration number, number of branches/vehicles expected, how they heard of us / **referral partner**, uploaded documents (business registration, ID — optional, secure storage), risk signals (disposable email, duplicate phone/email/device/IP, previously rejected, blacklisted), history of similar applications.

Settings:
- Approval mode: **manual** (default at launch), **auto-approve low-risk**, or auto for invited/partner signups.
- **Partner-assisted signup**: a partner account creates an application on behalf of a client (the client verifies email/phone). It lands in the review queue tagged with the partner. Per-partner setting *trusted* lets its applications skip manual review (default off). Partners see status, can answer "needs info" requests, and never see other applicants.
- SLA timer (e.g. review within 24 h), reminders for old items, assignment to a reviewer.
- Pre-provisioning choices at approval: plan, trial length, cluster, feature flags, branch limit, coupon, partner.
- After approval: provisioning saga runs (doc 22 §2.6) → welcome email/SMS with login/QR instructions → onboarding checklist created.
- **The tenant database is created only after approval**, which also stops spam from creating databases.

Bulk actions: approve/reject many; export.

### 3.3 Tenant lifecycle management ⭐

States and effects (the tenant's own users see a clear message with the reason when blocked):

| Status | Meaning | Login | Reads | Writes | Background jobs & notifications | Billing |
|---|---|---|---|---|---|---|
| `pending_review` | Application waiting | n/a | n/a | n/a | none | none |
| `needs_info` | Staff asked for more info | n/a | n/a | n/a | none | none |
| `rejected` | Not accepted | n/a | n/a | n/a | none | none |
| `provisioning` / `provisioning_failed` | Creating DB (retry available) | no | no | no | none | none |
| `trialing` | In trial | yes | yes | yes | normal | trial clock |
| `active` | Paying and in good standing | yes | yes | yes | normal | normal |
| `past_due` | Payment late; automated grace period (doc 25 §5) | yes | yes | yes + banner | normal | dunning (automated) |
| `read_only` | Optional dunning step (off by default) or staff-set | yes | yes | **no** | reminders only | accruing |
| `deactivated` | Access off. **Automatic** for `non_payment` / `trial_expired`; **by staff in special cases** (`requested_pause`, `abuse`, `legal`, `other`). **Nobody in the tenant can use the system**, with one narrow exception for `non_payment`/`trial_expired`: users with billing permission can sign in to the **Billing tab only** to pay or request an extension (doc 25 §5.2). Restorable at any time | Billing tab only (non-payment/trial) · otherwise no | no | no | paused | **paused** (no new invoices until restored) |
| `archived` | Deactivated for a long time; database moved to **cold archive** to free server capacity. Still restorable on request, never deleted | no | no | no | none | stopped |

**Deactivation semantics (decision 35)**
- **Tenant deactivated**: *nobody* in that tenant can access any part of the system — owner, staff, drivers, web portal, mobile app, public signing links. All sessions and refresh tokens are revoked at the moment of deactivation. APIs answer `403 TENANT_DEACTIVATED`; `public/tenant-config` returns the status so the app shows a blocking screen ("This account is deactivated. Contact <support>"). The reason category may be shown. *Exception (decision 51):* for `non_payment`/`trial_expired`, users with `billing.view`/`billing.manage` can sign in and reach **only the Billing tab** (doc 25 §5.2).
- Data is untouched. Scheduled jobs and notifications for the tenant are paused. **Branch statuses are left as they were**, so restoring brings everything back exactly as before.
- **Restore** (staff action) returns the tenant to its previous status; users sign in again. A **catch-up report** is produced for anything that came due while paused (Work & Pay instalments, document expiries, service due) and staff choose whether to waive penalties that would have accrued in the gap (default: no penalties for the deactivated period).
- Billing during deactivation: paused when deactivation is requested by the tenant or set as a pause; accruing when imposed for non-payment (open question in doc 19, round 5).
- **Never deleted** (decision 36): `deactivated` is a permanent resting state, not a step toward deletion.

Actions (each with reason, step-up auth, audit, tenant notification template, and where listed, four-eyes):
- **Approve / Reject** applications.
- **Deactivate / Restore.** These are **mostly automated from billing** (doc 25 §5: reminders → grace → auto-deactivate → auto-restore on payment). Manual use by staff is for **special cases only** (requested pause, abuse, legal, other): reason required, and a manual deactivation is **locked against automatic restore** (doc 25 §5.5). Restore returns the tenant to its previous status, with a "what changes" confirmation. There is no separate "suspended" state (decision 39): it is `deactivated` with a reason.
- **Grant / deny billing extensions** (§3.6).
- **Set read-only**, **extend trial**, **extend grace**, **force past-due/paid** (billing role).
- **Move to cold archive / restore from cold archive** (four-eyes; only for tenants deactivated for a long time, default ≥ 12 months; takes a verified dump, keeps it indefinitely, frees the live database; restoration is a documented runbook, doc 26 §8). There is **no delete action** for tenants.
- **Transfer ownership** (owner lost phone/email): identity verification checklist + four-eyes.
- **Rename slug/subdomain, add custom domain** (Enterprise).
- **Move to another cluster** (four-eyes): dump → restore → verify → switch → keep old read-only for N days.
- **Edit limits/overrides**: branch limit, user limit, storage quota, feature flags.
- **Bulk deactivate** for abuse waves (four-eyes).

Every transition is stored in `tenant_status_history` (from, to, reason, actor, approver, at, message shown to tenant).

### 3.4 Tenant 360° profile
One page per tenant:
- Overview: status, plan, subscription state, owner contact, signup date, partner, tags, health score, notes.
- Usage: users, branches, vehicles, drivers, active rentals/agreements, API calls, storage, last login/last activity, 90-day trend sparkline, modules used.
- Technical: cluster, database name, schema version, last migration, last backup, DB size, pool stats, recent errors, slow endpoints.
- Branches (§3.5), Users (§3.7), Billing (§3.6), Roles & permissions summary (counts, custom roles, last change), Documents/contracts count.
- Timeline: signup, approvals, status changes, billing events, support tickets, incidents, impersonation sessions, major config changes.
- Staff notes (internal), tags (VIP, at-risk, partner-managed), tasks/follow-ups for account managers.

### 3.5 Branch / shop management ⭐
Branches are the billing unit (per-branch pricing), so the console can manage them on a tenant's behalf (usually when the tenant asks support).

**Branch deactivation semantics (decision 35)**: when a branch is deactivated, **nobody can access that branch/shop**.
- Its vehicles, drivers, customers, rentals, stock, cash sessions and records are hidden from every operational screen, list, picker, report default and API result (`403 BRANCH_DEACTIVATED` when addressed directly). Records are kept, not deleted.
- User assignments to that branch stop granting anything (doc 28 rule 14). A user whose only branch is deactivated sees a blocking screen ("Your branch is deactivated, contact your administrator") but the tenant itself keeps working.
- **Preconditions**: a wizard requires open items to be resolved first — active rentals checked in or reassigned, open W&P agreements/assignments moved to another branch, pending remittances/expenses settled, open cash sessions closed, vehicles transferred. Nothing "live" is left inside a branch that no one can reach.
- Historical reporting: roles with `reports.include_inactive_branches` (Owner by default) can include deactivated branches in reports; they can also see a settings-only "Inactive branches" list to request or perform reactivation (no operational data).
- Reactivation: tenant owner (self-service, subject to branch entitlement and billing, doc 25 §7) or platform staff. Billing stops at the period end after deactivation and resumes on reactivation.
- Tenant deactivation does **not** change branch statuses.

Capabilities:
- List all branches per tenant with status, address, manager, vehicles/users counts, created date, billed since.
- **Add branch** (checks entitlement; shows price impact and proration before confirming; requires reason). Creates the branch in the tenant DB through the same use-case the tenant uses, with actor = platform user.
- **Deactivate** (soft: hide from new work, keep history; billing stops at period end), **reactivate** (billing resumes; entitlement check), **remove**:
  - hard removal is allowed only for a branch with **no records at all** (e.g. created by mistake); every other branch can only be deactivated, never removed.
  - guided **reassignment wizard** for vehicles, users, open rentals/agreements/leads before deactivation (assign to another branch).
- **Set a branch as default / HQ**, edit name/address/currency/timezone.
- **Enforce branch limits** (`branchesMax`) and show "over limit" tenants (e.g. after downgrade): grace then lock new branches.
- **Reconcile**: compare billed `branch_count` with tenant DB truth, one-click fix (doc 22 §2.7).
- Bulk import branches (onboarding for chains).

### 3.6 Subscriptions & billing (builds on doc 25)
- Plans & price rules: **Standard** = flat price per branch (versioned prices, existing tenants grandfathered unless migrated); **Enterprise** = custom pricing.
- **Licence type flag** (`standard`/`enterprise`): set by the Super Admin (permission `platform.tenants.set_licence_type`) at approval or any time **before the first payment**; locked afterwards.
- **Enterprise quote builder** (doc 25 §2.1), **hand-built** (decision 53): free-form line items for per-branch rate, business-size adjustment, one-time setup/onboarding, other costs, discounts, each with a `counts_as_licence` flag; versioned quotes with approval; the accepted quote becomes the tenant's subscription price items. No formula engine.
- Per-tenant subscription: change plan, change branch count, billing anchor, discounts/coupons, trial extension, pause dunning, extend grace, apply credits.
- Invoices: view/regenerate PDF, void, mark paid (manual bank transfer / MoMo reference), refund, credit note, write-off.
- Payments: list per tenant, gateway reference, status, **webhook inspector with replay**, reconciliation against the gateway settlement report, failed-payments queue with retry/contact actions.
- Revenue reports: MRR/ARR movement (new, expansion, contraction, churn), ageing receivables, collection rate, cohort retention, trial→paid conversion, ARPA, branch growth, VAT summary for our own tax filing.
- **Automation controls** (doc 25 §5): dunning policy (reminder offsets, grace days, optional read-only step, holidays, templates), dry-run toggle, circuit-breaker thresholds, pending-deactivation review queue (next 48 h), reminders log (`billing_notices`).
- **Extension requests queue**: view requests (tenant, invoice, amount, requested date, history of lapses), approve/deny/change date with reason; limits enforced; Super Admin for over-limit requests.
- Coupons. **Reseller commissions** (terms per reseller, ledger, payouts, statements) are managed in the partner area, see [29](29_reseller_partner_program.md).

### 3.7 Users & access support
- Global user search via `user_directory` (email/phone → tenants).
- Actions: resend invite, reset password, reset MFA, unlock, force logout (revoke all sessions), disable/enable a user, change a user's email/phone after verification, view roles (names only), see last login/devices.
- Owner-recovery workflow (identity checks, four-eyes).
- Suspicious-activity view: many failed logins, new device logins, impossible travel, unusual API volumes.

### 3.8 Support access (impersonation)
Policy (decision 34): **any console user whose role has the support-access permission can open a tenant in support mode. No tenant consent or approval is required. Every session is trailed.**

- Reason (free text) and optional ticket id are required before the session starts.
- Default **read-only**. Write mode is a separate permission and needs a second staff approver (four-eyes); still no tenant consent.
- Time-boxed (default 30 min, extendable up to 2 h), persistent red banner, auto-expire, ends when the staff member logs out.
- **The trail**:
  - `impersonation_sessions` row per session (who, tenant, mode, reason, ticket, start/end, approver).
  - Every request in the session is logged: staff id, tenant, route, method, resource ids touched, outcome. Tenant-side audit entries made during a session show the actor as `platform:<staff name>` (via the `imp` claim), so tenant logs can never be mistaken for a tenant user's own actions.
  - Immutable, retained long term, searchable by staff or tenant, exportable.
  - Weekly summary to Super Admins; alerts for unusual patterns (one staff member opening many tenants quickly, access outside normal hours, repeated write-mode use).
- Sensitive values (full ID numbers, bank/MoMo numbers, secrets) stay masked, and downloads/exports are disabled in support mode.
- Tenant-owner visibility of sessions (a "Support access log" in tenant settings) is **optional and on by default**; email notification per session is off by default. The platform-side trail is mandatory either way.
- **Partner/reseller accounts never have this permission.**

### 3.9 Plans, features & entitlements
- **Feature flags** (global, per plan, per tenant, percentage rollout) — enable beta modules (e.g. telematics) for chosen tenants.
- Module toggles per tenant (override plan).
- Limit overrides (branches, users, storage, API rate).
- **Kill switches** for risky features (e.g. disable document signing or SMS rules platform-wide quickly).

### 3.10 Roles & permissions catalogue (platform side; doc 28)
- Browse the permission registry (module, key, description, sensitivity, since-version).
- Manage **system role templates** (Owner, Administrator, Branch Manager, …) and publish a new catalogue version.
- **Sync status**: which tenants are on which catalogue version; run/retry sync; see failures.
- Insights: how many tenants customised roles; most-used/never-used permissions; tenants with risky grants (e.g. many users with `finance.payments.reverse`).
- Preview of "what changes for tenants" before publishing (diff).

### 3.11 Reference data & templates (platform-managed content)
- **Tax codes** (Ghana VAT and levies with effective dates) — publish new rates to all tenants on schedule (doc 13 §6).
- Currencies and default FX sources.
- Vehicle makes/models/body types.
- Default document templates (agreements, transfer letter, receipts) and legal clauses with versions (doc 24); notification templates; default expense categories; default service plans; report definitions.
- Terms of Service / Privacy Policy versions + tracking of which tenant owner accepted which version.
- Publishing = versioned release with diff, staged rollout (e.g. 5% of tenants first), rollback.

### 3.12 Communications
- **Announcements**: in-app banners and emails to all tenants or segments (plan, status, module, tag), schedule, expiry, read stats.
- **Maintenance windows**: schedule → banner countdown → optional read-only mode during window → status page.
- Product release notes, in-app "what's new".
- Targeted messages to owners of at-risk or past-due tenants.
- Mobile push to all users of a tenant or all tenants (via FCM) for critical notices.

### 3.13 Support desk (light)
- Tenant notes and **support tickets** (built-in minimal, or integrate Freshdesk/Zendesk/Crisp/WhatsApp Business). Link tickets to tenants/users/requests.
- Canned responses, SLA timers, escalation to engineering with request id and Sentry link.
- Knowledge base links, feedback/NPS collection.

### 3.14 Data operations
- **Backups** (doc 26): per-tenant backup list, status, size, verify results; request restore (four-eyes); on-demand backup; restore-test results.
- **Tenant data export** (owner request): generate, track, expire links.
- **Schema migrations** (doc 22 §2.5): matrix of tenants × versions, run/retry, pause fan-out, see logs.
- **Cluster management**: registry of clusters, capacity, add cluster, rebalance (move tenants), orphan-DB sweeper results.
- **Storage**: usage per tenant, quota alerts, cleanup suggestions.
- **Jobs & queues inspector**: per-tenant job history, retry/cancel/pause a queue, scheduler status.
- **One-off maintenance scripts** (curated, versioned, dry-run first, four-eyes, audited), e.g. recompute stats, fix a ledger, rebuild documents.

### 3.15 Security & compliance
- Platform + tenant security event log (logins, MFA, role changes, exports, impersonations).
- Abuse/fraud tools: block email/phone/domain/IP/device, rate-limit overrides, auto-flag rules.
- Data-protection requests tracker (access, correction, erasure): SLA, steps, evidence. Because tenants are never deleted (decision 36), a legal **erasure request** is handled by controlled **anonymisation of the personal data** (names, phones, ID numbers replaced by tokens) with an erasure ledger so the erasure is re-applied if a backup or cold archive is ever restored (doc 26 §8). Needs legal confirmation (doc 19 round 5).
- Consent and legal-version acceptance records; DPA templates.
- Audit log search/export; access reviews (quarterly report of who has which platform role).
- Secrets/key rotation reminders and last-rotated dates.

### 3.16 Analytics & health scoring
- Growth funnel: visits → signup → verified → approved → provisioned → first vehicle added → first transaction → paying.
- **Onboarding checklist progress** per tenant (add branch, vehicles, drivers, first remittance/rental, invite users, install app via QR).
- **Feature adoption** by module; unused paid features → customer-success outreach.
- **Health score** (0–100): login frequency, active users ratio, records created last 14 days, module breadth, payment history, support tickets, error rate. Flags **at-risk** and **expansion-ready** tenants.
- Churn reasons captured at cancellation; win-back campaigns.
- Cost to serve: DB size, storage, jobs per tenant → margin per tenant (informs pricing).

### 3.17 Mobile app management
- Min supported / latest version per platform (feeds `public/tenant-config`, doc 23), force-update switch, app version distribution, crash links, remote kill for compromised builds.
- QR/connect link diagnostics for a tenant (is the signed payload valid?).

### 3.18 Platform settings
- Global defaults: base currency (GHS), trial length, dunning schedule, password policy, session lifetimes, rate limits, allowed signup countries, approval mode.
- Platform email provider/sender, WhatsApp/SMS for platform notices, payment gateway keys (Secret Manager reference only).
- Domains: base domain, link domain, wildcard cert status.
- Staff management: invite/disable staff, roles, MFA reset, device list.
- Global maintenance mode; read-only mode for emergency.

### 3.19 Developer & diagnostics tools
- Look up a request by `x-request-id` → logs/traces/Sentry link, tenant, user, route, timing.
- **Tenant diagnostics run**: integrity checks (ledger balanced, allocation sums, orphan files, assignments vs vehicle status, duplicate codes), results saved with remediation hints.
- Impersonation of API behaviour (replay GET) disabled by default.
- Feature flag debugger: which flags resolve true for a given tenant/user.

## 4. Data model (platform DB additions)

| Table | Purpose / key columns |
|---|---|
| `platform_users` | email, name, phone, **user_type (`staff`/`partner`)**, **partner_id** (for partner accounts), status, mfa_enrolled, last_login_at |
| `platform_roles`, `platform_permissions`, `platform_role_permissions`, `platform_user_roles` | Staff RBAC (seeded) |
| `platform_sessions`, `platform_mfa_devices`, `platform_invites` | Auth |
| `tenant_applications` | contact, business info, documents, referral/partner id, risk signals jsonb, status, reviewer, decided_at, decision_reason |
| `tenant_status_history` | tenant_id, from, to, reason, actor_id, approver_id, message_to_tenant, at |
| `tenant_notes`, `tenant_tags`, `tenant_tasks` | Account management |
| `approval_requests` | action type, target, payload, requested_by, status (`pending, approved, rejected, expired, executed`), approver_id, expires_at |
| `impersonation_sessions` | staff_id, tenant_id, mode (`read`/`write`), reason, ticket, started/ended, approved_by, actions_count |
| `platform_audit_logs` | actor, action, target_type/id, before/after jsonb, reason, ip, ua, request_id (partitioned by month) |
| `feature_flags`, `flag_overrides` | Key, default, rules, per-plan/per-tenant overrides |
| `announcements`, `announcement_reads`, `maintenance_windows`, `incidents` | Communications |
| `support_tickets`, `ticket_messages` (optional) | Support |
| `legal_versions`, `legal_acceptances` | Terms/privacy |
| `reference_releases` | Versioned publishes of tax codes, templates, catalogue; rollout status per tenant |
| `usage_daily` | tenant_id, date, users_active, api_calls, records_created, storage_bytes, vehicles, branches |
| `health_scores` | tenant_id, date, score, factors jsonb |
| `clusters` | host, capacity, status, region, tenant_count |
| `partners`, `partner_commission_terms`, `partner_tenant_attributions`, `partner_commission_entries`, `partner_payouts`, `partner_adjustments` | Reseller program, see [29](29_reseller_partner_program.md) |
| `dunning_policies`, `billing_notices`, `billing_extensions` | Billing automation and extensions, see [25 §5.7](25_platform_billing_and_subscriptions.md) |
| plus: `tenants`, `tenant_domains`, `subscriptions`, `billing_*`, `tenant_backups`, `tenant_migrations`, `webhook_events`, `user_directory` (docs 22, 25, 26) |

## 5. Suggested enhancements (my input)

1. **Partner / reseller program** — in Ghana, many sales happen through agents. Specified in [29_reseller_partner_program.md](29_reseller_partner_program.md): referral code/link, assisted signup, a view of all their tenants and commissions, and commission terms set per reseller by the Super Admin.
2. **Demo / sandbox tenants** — one-click create a tenant pre-filled with realistic sample data (vehicles, drivers, rentals, W&P) for sales demos and training; auto-expire.
3. **Tenant health score & customer-success playbooks** (§3.16) to reduce churn before it happens.
4. **Public status page** and incident templates, so outages don't flood support.
5. **Staged rollouts** for reference data and feature flags (canary tenants first).
6. **Emergency controls**: global read-only, per-feature kill switches, per-tenant rate-limit overrides.
7. **Tenant data export on cancellation** as a product feature (builds trust) and as a retention tactic (offer pause instead of cancel).
8. **Pause instead of cancel** (`deactivated`) for seasonal fleets, reduced fee or free for N months.
9. **Customer self-service branch management with guardrails** so support isn't a bottleneck: tenant owners add/deactivate branches themselves (showing price impact); the console handles exceptions.
10. **Support-access log visible to tenant owners** (optional, on by default; transparency = trust). The platform trail is mandatory regardless.
11. **Cost-to-serve per tenant** (storage, DB size, jobs) to price and spot outliers.
12. **Onboarding concierge workflow**: task list for staff per new tenant (call within 24h, import vehicles, install app via QR) with completion tracking.
13. **Automated compliance reports** (data-protection requests, access review, backup-test evidence) to prove controls.
14. **Webhook/API access for enterprise tenants** managed here (keys, scopes, usage).
15. **Multi-region/cluster routing** hooks from day one (`clusters`, `tenants.cluster_id`).

## 6. Platform permission catalogue (platform DB, seeded)

`platform.dashboard.view`, `platform.health.view`, `platform.alerts.manage`,
`platform.applications.view|review|approve|reject`, `platform.tenants.view|edit|notes`, `platform.tenants.activate|deactivate|restore|set_read_only`, `platform.billing.extensions.grant`, `platform.billing.automation.manage`, `platform.tenants.set_licence_type`, `platform.billing.enterprise_pricing.manage`, `platform.billing.automation.override_lock`, `platform.tenants.archive_cold|restore_cold_archive` (four-eyes). **No delete permission exists**, `platform.tenants.transfer_ownership|move_cluster|rename_slug|manage_domains`,
`platform.branches.view|create|deactivate|reactivate|remove|reassign`,
`platform.billing.view|plans.manage|subscriptions.manage|invoices.manage|payments.record|refunds.issue|credits.issue|coupons.manage|dunning.manage|reports.view`,
`platform.users.search|reset_password|reset_mfa|disable|force_logout|recover_owner`,
`platform.support.access_tenant|access_tenant_write|tickets.manage|announcements.manage|maintenance.manage`,
`platform.flags.manage|entitlements.override`,
`platform.catalogue.view|publish` (roles/permissions/reference data), `platform.reference.publish` (tax, templates),
`platform.data.backups.view|restore_request|export|migrations.run|clusters.manage|jobs.manage|scripts.run`,
`platform.security.audit.view|abuse.manage|dsr.manage|dsr.anonymise|access_review.view`,
`platform.applications.create_assisted`, `platform.partner.tenants.view`, `platform.partner.commissions.view`, `platform.analytics.view`, `platform.mobile.manage`, `platform.settings.manage`, `platform.staff.manage`, `platform.partners.manage`, `approvals.approve` (second approver).

Default role grants: **Partner** = the per-reseller capability set that Super Admin grants (doc 29 §7: tenants.view, commissions.view, terms.view, create_assisted … plus optional sensitive ones such as owner contact and billing state), always scoped to the reseller's own partner id; Super Admin = all; Operations = tenants/branches/data/applications; Support = users/support/read-only impersonation/view; Billing = billing.*; Sales = applications.view, tenants.view, partners, analytics; Engineering = health, jobs, flags, diagnostics (no tenant business data); Auditor = view + audit.

## 7. API sketch (`/api/platform/v1`)

```
POST /auth/login | /auth/mfa | /auth/refresh | /auth/logout
GET  /dashboard | /health | /alerts
POST /applications (assisted signup; partner or staff) | GET  /applications?status … | GET /applications/:id | POST …/approve | …/reject | …/request-info
GET  /tenants?status&plan&q … | GET /tenants/:id | PATCH /tenants/:id
POST /tenants/:id/{deactivate|restore|read-only|archive-cold|restore-cold}   (manual, special cases)
GET  /billing/extensions?status=requested | PUT /billing/extensions/:id/{approve|deny} | GET /billing/automation/pending   (no delete endpoint)
POST /tenants/:id/transfer-ownership | /move-cluster | /extend-trial | /overrides
GET  /tenants/:id/{status-history|usage|health|audit|backups|migrations|timeline}
GET  /tenants/:id/branches | POST …/branches | POST …/branches/:bid/{deactivate|reactivate|reassign} | DELETE …/branches/:bid
GET  /tenants/:id/users | POST /users/:uid/{reset-password|reset-mfa|disable|enable|force-logout}
POST /tenants/:id/impersonate { mode, reason, ticket } → short-lived token
GET  /billing/plans | POST … | GET /billing/invoices | POST /billing/invoices/:id/{void|mark-paid|refund}
GET  /billing/reports/{mrr|churn|ageing|cohorts}
GET  /flags | PUT /flags/:key | PUT /tenants/:id/flags
GET  /catalogue/permissions | POST /catalogue/releases | GET /catalogue/sync-status
POST /reference/releases (tax codes, templates)  |  GET /reference/releases/:id/rollout
POST /announcements | /maintenance-windows
GET  /approvals?status=pending | POST /approvals/:id/{approve|reject}
GET  /audit-logs?actor&tenant&action&from&to
GET  /clusters | POST /clusters | GET /jobs | POST /jobs/:id/retry
CRUD /staff, /partners, /legal-versions
```

## 8. Four-eyes rules (summary)

| Action | Approver |
|---|---|
| Move tenant to / restore from cold archive | Super Admin or Operations lead |
| Data anonymisation for a legal erasure request | Super Admin + designated data-protection officer |
| Restore tenant data from backup | Super Admin or Operations lead |
| Move tenant across clusters | Super Admin / Engineering lead |
| Write-mode support access | Super Admin / Operations lead (no tenant consent needed) |
| Refund / credit above threshold | Billing lead or Super Admin |
| **Cash payout to a reseller (any amount)** | A second staff member approves (Billing lead or Super Admin) |
| Transfer tenant ownership | Super Admin / Operations lead |
| Bulk deactivate or bulk message > N tenants | Super Admin |
| Publishing permission catalogue / role template changes | Super Admin |
| Running one-off data scripts | Engineering lead + Operations |

Approval requests expire (e.g. 24 h), are logged, and the executor can't approve their own request.

## 9. Tenant-facing messages for lifecycle actions

Templates (editable, versioned): application received / approved / rejected / more info needed; welcome; trial ending; payment reminder; read-only notice; deactivated for non-payment (amount due, pay link, extension request); deactivated by staff (reason category, contact); extension granted / denied; account restored; restored; deactivation confirmation; deactivated (access disabled, how to request restoration); branch added/deactivated; support session started. Shown as **blocking screens** in web/mobile when the tenant is blocked (with support contact and pay button where relevant).

## 10. UI sitemap

```
Dashboard · Alerts
Tenants ─ Applications(queue) · All tenants · Branches · Users · Support sessions
Billing ─ Plans · Subscriptions · Invoices · Payments · Failed payments · Coupons · Reports
Operations ─ Backups · Migrations · Clusters · Jobs · Exports · Maintenance scripts
Product ─ Feature flags · Entitlements · Roles & permissions catalogue · Reference data & templates · Mobile app versions
Communications ─ Announcements · Maintenance windows · Status/incidents · Tickets
Security ─ Audit log · Approvals · Abuse & blocks · Data-protection requests · Access review
Growth ─ Analytics · Health scores · Partners & commissions · Demo tenants
Settings ─ Platform settings · Staff & roles · Legal versions
```

## 11. Phasing

| Phase | Scope |
|---|---|
| **P0** (with foundation) | Platform auth + MFA, staff roles (seeded), applications queue (approve/reject), tenant list/profile, lifecycle actions (billing-driven automatic deactivate/restore, manual deactivate/restore, extensions), audit log, backup & migration visibility, basic health page |
| **P1** | Partner (reseller) accounts and assisted signup, Branch management, subscriptions/plans/invoices (manual payments), entitlement overrides, impersonation (read-only), user support actions, approvals (four-eyes), announcements/maintenance |
| **P2** | Gateway billing admin (webhook inspector, refunds, dunning), revenue reports, feature flags, catalogue/reference-data releases, usage_daily + health scores |
| **P3+** | Partner program, demo tenants, support desk, diagnostics, cluster rebalancing, data-protection tracker, status page integration, cost-to-serve |

## 12. Open items

See doc 19 round 5.
