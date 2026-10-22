# 33 — Operations runbooks (private beta)

Day-to-day procedures for running the beta. Backups and restores have their own runbooks ([31](31_backup_restore_runbooks.md)); security posture is in [32](32_security_review.md). Commands are `yarn …` from the repository; the API is `node dist/index.js`, the worker `node dist/worker.js`.

> **Status (2026-10-22): local.** Everything below runs on the local stack today. Steps marked **(hosting)** need P0-3 (decision 63).

## 1. Start, stop, upgrade

| Task | Steps |
|---|---|
| Start locally | `docker compose up -d` → `yarn db:setup` (idempotent) → `yarn storage:setup` → `yarn build` → API `yarn start`, worker `yarn start:worker` |
| Upgrade | Take backups (31 §3) → deploy the new build → `yarn db:migrate` (platform, template, then every tenant; a failed tenant is reported and does not stop the others) → restart worker, then API → `yarn db:status` shows every tenant at the new version |
| Roll back a release | Redeploy the previous build. Migrations are forward-only: only roll back across a migration after restoring from the backup taken before it (31 §5) |
| Health | `GET /health/live` (process), `GET /health/ready` (platform database) — wire both into the host's checks **(hosting)** |

## 2. Daily checks (until alerts exist)

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
| Owner lost access to their email | Verify identity off-line (business registration, Ghana Card). Another administrator of the business can update the owner's user; if there is none, there is no console action yet (gap, P4): a reviewed database change by two staff members, recorded in the tenant's notes |
| Wrong payment recorded | The tenant reverses it (`POST /payments/:id/reverse`, `finance.payments.reverse`); work and pay, remittances and expenses follow automatically |
| Wrong work and pay terms after signing | Before activation: withdraw, change, sign again. After: restructure or payment holiday (`workpay.restructure`); terms of the signed document never change |
| Transfer letter wrong | Before both signed: `POST /workpay/agreements/:id/transfer-letter` with corrections. After: it stands; correct by a new document outside the system and note it on the agreement |
| SMS not arriving | Settings → notifications → SMS provider test (`POST /settings/notifications/sms/test`); check the delivery log; check the rule is enabled and quiet hours |
| Tenant stops paying | Billing reminders and automatic deactivation (doc 25); staff can grant an extension in the console |

## 5. Incidents

1. **Declare**: one person leads; open an incident note (time, symptom, who is affected).
2. **Contain**: tenant `read_only` / `deactivated` for a tenant-specific problem; stop the worker if jobs make it worse; for a suspected credential leak, rotate the secret (§6) — rotating `TENANT_JWT_SECRET` signs everyone out.
3. **Diagnose** with request ids (every response carries `requestId`; logs and the audit trail record it).
4. **Recover** (31 for data, §1 for releases).
5. **Close**: tell affected tenants what happened and what was lost; within 72 h if personal data was exposed (Ghana Data Protection Act 2012 — confirm with counsel, doc 19); write down the cause and the follow-up.

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
