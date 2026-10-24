# 33 — Operations runbooks (private beta)

Day-to-day procedures for running the beta. Backups and restores have their own runbooks ([31](31_backup_restore_runbooks.md)); security posture is in [32](32_security_review.md). Commands are `yarn …` from the repository; the API is `node dist/index.js`, the worker `node dist/worker.js`.

> **Status (2026-10-24): local.** Incident, on-call, data-protection and data-export runbooks added with P4-8; multi-tenant load figures and the support process (doc 35) with P4-9. Everything below runs on the local stack today. Steps marked **(hosting)** need P0-3 (decision 63).

## 1. Start, stop, upgrade

| Task | Steps |
|---|---|
| Start locally | `docker compose up -d` → `yarn db:setup` (idempotent) → `yarn storage:setup` → `yarn build` → API `yarn start`, worker `yarn start:worker` |
| Upgrade | Take backups (31 §3) → deploy the new build → `yarn db:migrate` (platform, template, then every tenant; a failed tenant is reported and does not stop the others) → restart worker, then API → `yarn db:status` shows every tenant at the new version |
| Roll back a release | Redeploy the previous build. Migrations are forward-only: only roll back across a migration after restoring from the backup taken before it (31 §5) |
| Health | `GET /health/live` (process), `GET /health/ready` (platform database) — wire both into the host's checks **(hosting)** |

## 2. Daily checks

0. Console **alerts centre** (`GET /api/platform/v1/alerts?status=open`): acknowledge what you take, resolve what is done (§8).
1. `yarn backup list` — a successful backup of the platform and every tenant from the last 24 h.
2. Worker log: failed jobs (`tenant.daily_*`, `notifications.send`, `email.send`, `tenant.provision`). pg-boss retries with backoff; a job that keeps failing is in `pgboss.job` with `state = 'failed'`.
3. `notification-deliveries` with `status = failed` per tenant (`GET /api/v1/notification-deliveries?status=failed`): usually an SMS provider account out of credit or a wrong Sender ID.
4. Weekly: `yarn backup verify --sample 3` (31 §4).

## 3. Books out of balance (integrity check fails)

`GET /api/v1/ledger/integrity` (finance.ledger.view) runs the invariants of doc 31 §4 for one tenant; the restore test runs them on every verified backup.

1. Note the failing check and its offenders (the response lists the first five).
2. Freeze writes if money is moving wrongly: tenant `read_only` in the console.
3. Find the cause from the offenders: `journal_entries.source_type/source_id` tells which module posted; the audit log (`entity_id`) who did what.
4. Correct with the module's own operation (reverse the payment, void the expense, waive, restructure) — never edit ledger rows (they are immutable by trigger) or sub-ledger rows by hand.
5. If data was lost or corrupted: restore next to it and compare (31 §5).
6. Re-run the check, lift read-only, record the incident.

## 4. Tenant support

| Request | Steps |
|---|---|
| Owner locked out | They reset with `POST /api/v1/auth/password-reset` (email code). Repeated failures lock the account for a while (per-account lockout); it clears on its own |
| Owner lost access to their email | Verify identity off-line (business registration, Ghana Card, a call back on the number on file). Console **owner recovery** (`POST tenants/:id/owner-recovery`) with the checks written down; a Super Admin approves; the owner gets a reset code at the new address (doc 27 §3.7) |
| User locked out, signed in on a lost phone | Console user support: `…/users/:userId/unlock`, `…/force-logout`, `…/reset-password` (a code by email) |
| "I need to see what they see" | Support access (`POST tenants/:id/support-sessions`, reason and ticket): read-only; write mode needs a second staff member. Never for a request you cannot write down |
| Wrong payment recorded | The tenant reverses it (`POST /payments/:id/reverse`, `finance.payments.reverse`); work and pay, remittances and expenses follow automatically |
| Wrong work and pay terms after signing | Before activation: withdraw, change, sign again. After: restructure or payment holiday (`workpay.restructure`); terms of the signed document never change |
| Transfer letter wrong | Before both signed: `POST /workpay/agreements/:id/transfer-letter` with corrections. After: it stands; correct by a new document outside the system and note it on the agreement |
| SMS not arriving | Settings → notifications → SMS provider test (`POST /settings/notifications/sms/test`); check the delivery log; check the rule is enabled and quiet hours |
| Tenant stops paying | Billing reminders and automatic deactivation (doc 25); staff can grant an extension in the console |

## 5. Incidents

### 5.1 Severity

| Severity | Examples | Status page impact | Response |
|---|---|---|---|
| **SEV1** | API down for everyone, data lost or exposed, money posted wrongly at scale, payments taking money without crediting | `critical` (major outage) | Everyone available; updates every 30 min; tenants emailed |
| **SEV2** | One module down (payments, notifications, signing), one large tenant down, billing automation halted | `major` (partial outage) | Lead + one helper; updates hourly |
| **SEV3** | Degraded or slow, a workaround exists, one small tenant affected | `minor` (degraded) | Normal working hours |

When in doubt, declare the higher severity and lower it later.

### 5.2 Steps

1. **Declare.** One person leads (the *incident lead*), one writes the timeline. Open the incident on the status page for anything tenants notice: `POST /api/platform/v1/incidents` (`title`, `impact`, `components`: api, web, mobile, payments, notifications, `message`). Acknowledge the alert that brought you here.
2. **Contain.** Tenant-specific: `read_only` or `deactivated` (console). Feature-specific: turn the kill switch or flag off (`PATCH flags/:key`, e.g. `documents.signing`). Platform-wide writes: a read-only maintenance window (`POST maintenance-windows`, `readOnly: true`, starting now). Jobs making it worse: stop the worker. Suspected credential leak: rotate (§6).
3. **Communicate.** Post an update at each change of status (`POST incidents/:id/updates`: investigating → identified → monitoring → resolved) and at the cadence of §5.1. Say what is affected, what tenants should do, when the next update comes. Never guess at causes in public.
4. **Diagnose** with request ids (every response carries `requestId`; logs, the audit trail and support-session trails record it), the alerts' detail, `GET /api/v1/ledger/integrity` for money.
5. **Recover** (31 for data, §1 for releases). Lift containment one step at a time and watch.
6. **Resolve** the incident on the status page when tenants are whole, then resolve the alerts.
7. **Notify.** If personal data was exposed: tell affected tenants (and through them their people) and the Data Protection Commission within 72 h — Ghana Data Protection Act 2012, confirm the deadline with counsel (doc 19). Log it as a data-protection request of its own (§9) so the steps are kept.
8. **Review** within five working days, blameless: timeline, cause, what went well, what to change (each with an owner and a date). Keep it in the incident notes; link the status page incident.

### 5.3 Messages

- *Investigating:* "We are looking into reports that {what} is {not working / slow} for some businesses. Next update by {time}."
- *Identified:* "We found the cause ({plain words}) and are fixing it. {What to do meanwhile}. Next update by {time}."
- *Monitoring:* "A fix is in place and we are watching. {Anything to re-do}."
- *Resolved:* "{What} works again since {time}. {Anything lost or to re-do}. We are sorry for the trouble."

## 6. Secrets

| Secret | Rotation | Effect |
|---|---|---|
| `TENANT_JWT_SECRET`, `PLATFORM_JWT_SECRET` | On suspicion; yearly | All sessions of that audience end; users sign in again |
| `OTP_SECRET`, `MFA_ENCRYPTION_KEY` | On suspicion | Pending codes stop working; MFA secrets must be re-encrypted (plan a migration first) |
| Database role passwords | On staff change; yearly | `yarn db:setup` re-syncs roles with the new `.env` |
| Backup key pair | Never casually: old backups need the old private key | Generate a new pair, keep both private keys offline (31 §2) |
| Tenant SMS provider keys | Owned by the tenant | They replace them in settings; sealed at rest |

Secrets live in `.env` locally and in the host's secret store **(hosting)**; never in the repository or tenant data.

## 7. Load and capacity

`yarn load:seed` creates a tenant with data on a local database and prints how to run `yarn load:tenant` (k6: back-office reads plus payments). Measured 2026-10-22 on a developer laptop (one API process, local PostgreSQL 18):

| Profile | Virtual users | Requests | Errors | p95 reads | p95 payment writes | Throughput |
|---|---|---|---|---|---|---|
| smoke | 2 | 53 | 0 | 29 ms | 42 ms | 5 req/s |
| load | 20 | 14,760 | 0 | 25 ms | 36 ms | 89 req/s |
| stress | up to 200 | 82,203 | 0 | 92 ms | 103 ms | 456 req/s |

After the stress run (≈ 8,700 payments posted concurrently) every integrity check passed and receipt numbers had no gaps. Laptop numbers are an upper bound for the API code, not for the hosted system: repeat on staging **(hosting)** with the database on its own host before sizing.

**Many tenants (P4-9).** `yarn load:seed --tenants 100 --vehicles 10 --drivers 10 --payments 20` provisions 100 tenants with data and writes `load/k6/data/tenants.json`; `PROFILE=load yarn load:tenants` signs in to each and spreads reads and payments over all of them at random. Measured 2026-10-24, same laptop, local PostgreSQL with `max_connections = 100`, one API process:

| Profile | Tenants | Virtual users | Requests | Errors | p95 reads | p95 payment writes | Throughput |
|---|---|---|---|---|---|---|---|
| load | 100 | 20 | 14,999 | 0 | 23 ms | 37 ms | 87 req/s |
| stress (defaults: 60 total, 4 per pool) | 100 | up to 200 | 74,488 | 13.9 % | 184 ms | 456 ms | 402 req/s |
| stress (80 total, 2 per pool) | 100 | up to 200 | 76,096 | 5.8 % | 148 ms | 369 ms | 412 req/s |

What it found and what changed:

- Seeding stopped at about 95 tenants: every tenant visited kept an idle connection for the 5-minute idle timeout until PostgreSQL ran out of slots. **`TENANT_POOL_MAX_TOTAL_CONNECTIONS`** (default 60 per process) now closes the least recently used idle pools beyond it.
- Under stress a connect that stalled never settled, and every later request for that tenant waited on it until the process restarted. **`DATABASE_CONNECT_TIMEOUT_MS`** (default 10 s) bounds connecting and waiting for a pooled connection; the request fails with 503 `TENANT_DATABASE_UNAVAILABLE` and the next one opens a fresh pool.
- The stress errors are the database server's connection limit (`53300 too many clients`) with 200 concurrent users on 100 busy tenants: the budget only closes *idle* pools, so busy ones can exceed it. That is PgBouncer's job when hosted (doc 36 §5); size `max_connections` ≥ processes × (tenant total + `PLATFORM_POOL_MAX` + `JOB_POOL_MAX`) + headroom.

## 8. On-call

| Item | How |
|---|---|
| Who | One person on call per week, a second as backup; the rota lives with the team (not in the system yet). Hand over on Monday with open alerts and incidents |
| Where alerts go | The alerts centre (`GET /api/platform/v1/alerts`), plus email to `ONCALL_EMAILS` and the webhook `ONCALL_WEBHOOK_URL` (Slack-compatible; Telegram or WhatsApp through a relay) for severity ≥ `ONCALL_MIN_SEVERITY` (default warning). A repeat counts on the same alert; a more severe repeat notifies again |
| Response | **critical**: acknowledge within 15 min, any hour. **warning**: within working hours the same day. **info**: in the daily check (§2) |
| Acknowledge / resolve | `POST alerts/:id/acknowledge` when you take it; `POST alerts/:id/resolve` (with a note) when it is done. An alert that is a symptom of an incident is resolved with the incident (§5) |
| Escalate | No progress in 30 min on a critical alert, or it is a SEV1: call the backup, then the engineering lead |
| Typical alerts | `billing.automation.*` (halted by the circuit breaker or failed: read the run, `GET billing/automation/runs`); `billing.gateway_guard:*` and `gateway.reconciliation*` (check webhooks and the provider, doc 25 §9); `billing.branch_reconcile:*` (over-limit tenants); `support.*` (unusual support access: ask the staff member); `drill.*` (§10); `dpr.*` (§9) |

## 9. Data-protection requests

1. **Log** every request the day it arrives: `POST /api/platform/v1/data-protection-requests` (`kind`: access, correction, erasure, objection; the requester and how to reach them; whose data; when received). The deadline defaults to 30 days — confirm the legal deadline with counsel (doc 19 round 5).
2. **Verify identity** before giving or changing anything; record how (`…/:id/steps`).
3. **Find the data.** Through the tenant when it is their user, driver or customer: the tenant is the controller for its business records; we help. Platform data (applications, billing contacts, staff) is ours.
4. **Act.** Access: the tenant's export (§11) or the records concerned. Correction: through the module's own edit. Erasure: tenants are never deleted; anonymisation of personal fields is a four-eyes action still to build (doc 26 §8) — until then record what was done by hand, by two staff members. Objection: stop the processing concerned (e.g. notifications).
5. **Close** with the outcome (`…/:id/close`: completed or rejected, with why). Alerts warn 5 days before the deadline and when it passes.

## 10. Restore drills

- A **quarterly game day** is always scheduled (`GET /api/platform/v1/restore-drills`, due by the end of each quarter); the daily compliance job keeps it scheduled, alerts two weeks before and when it is missed.
- Do it with doc 31 §5 (restore a tenant next to the live one, verify, switch) and, when hosted, a rebuild from backups only. Time it.
- Record it: `POST restore-drills/:id/record` (`outcome`: passed, partial, failed; RTO and RPO reached; notes). The next quarter's drill is scheduled at once. Add a line to the drill log (31 §9).
- Failed or partial: open the follow-ups as for an incident review (§5.2 step 8).

## 11. Data exports (portability)

- The owner (permission `data.export`, owner only) asks in the app (`POST /api/v1/data-exports`); staff can ask for them when a tenant leaves (`POST tenants/:id/data-exports`, reason).
- The archive has one CSV per table, the uploaded files (up to 200 MB; the manifest lists the rest) and a README; passwords, tokens and sealed credentials never leave. It is kept 7 days; the owner is emailed and downloads after signing in (a five-minute link, audited).
- Files beyond the budget: send them separately on request, from storage, after checking who asks.
