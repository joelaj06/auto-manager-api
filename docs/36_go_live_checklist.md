# 36 — Go-live checklist

What must be true before the first paying tenant, and what to do in the first weeks after. Work through it top to bottom; tick each line with a date and a name. The platform checks most of section 1 itself.

> **Status (2026-10-24): ready to walk through, not walked through.** Hosting (P0-3) is deferred (decision 63), so the hosted items in §1 and §5 stay open until there is a server.

## 1. The readiness gate

`GET /api/platform/v1/launch/readiness` (`platform.health.view`) runs every check the platform can see for itself and says what to fix. `ready` is true when nothing **fails**; each **warning** is a judgement call to record here.

| Key | Check | Fails / warns when | Fix |
|---|---|---|---|
| `billing.price` | Standard price per branch set | No price (invoicing refuses) | Decide the price (§3), `PUT billing/plans/standard/price` |
| `billing.seller` | Autoforce as the seller | TIN or payment instructions missing (warn) | `PUT billing/settings`; confirm VAT registration with the accountant |
| `billing.gateway` | Real gateway | Fake gateway (fail in production, warn locally) | `BILLING_GATEWAY=paystack`, live key in production only |
| `billing.dry_run` | Automation in dry run, reviewed | Fewer than 14 days of dry runs (warn) | §2 |
| `legal.terms`, `legal.privacy` | Versions in force | Nothing published | Publish the counsel-reviewed versions (§4) |
| `ops.on_call` | On-call reachable | No `ONCALL_EMAILS` and no `ONCALL_WEBHOOK_URL` | Set them (doc 33 §8) |
| `ops.backups` | Backups within 36 h, every tenant | A stale platform backup or a tenant without one | `yarn backup run`, then schedule it (doc 31 §3) |
| `ops.restore_test` | Restore test passed this week | Never verified, failed, or older than 8 days | `yarn backup verify --sample 3` (doc 31 §4) |
| `ops.drill` | Quarterly drill scheduled, one done | None scheduled (fail); none done (warn) | Run the drill (doc 33 §10) |
| `ops.migrations` | Every tenant on the current schema | Platform or a tenant behind, or failed | `yarn db:migrate` |
| `ops.alerts` | No open critical alert | Any | Alerts centre |
| `security.four_eyes` | Two Super Admins | Fewer than two (approvals impossible) | Invite a second Super Admin |
| `security.support_team` | Support users | None (warn) | Invite them (doc 35) |
| `security.environment` | Production configuration | Not `NODE_ENV=production` (warn) | Hosting (§5) |

- [ ] Readiness shows `ready: true`, and every remaining warning has a line in §6.

## 2. Billing automation: dry run first

The automation (doc 25 §5) runs every day from launch, but in **dry run** for the first weeks: it records who it *would* suspend or deactivate and does nothing.

- [ ] Dry run is on (`GET billing/dunning-policy` → `dryRun: true`). It is the default.
- [ ] Every week, read `GET billing/automation/dry-run-review?days=28`: runs, would-be deactivations by invoice, which were paid afterwards (`paidAfterFlag`), which are still unpaid, halted and failed runs. Each would-be deactivation of a tenant that was in fact paying is a bug or a webhook problem: fix it before going further.
- [ ] After **at least 14 days** of dry runs with no unexplained flag, a Super Admin turns dry run off with `PUT billing/dunning-policy` `{ …, "dryRun": false, "dryRunReviewed": true }`. The API refuses without `dryRunReviewed`, and refuses anyone but a Super Admin before 14 days; the change is audited with the review summary (`billing.dry_run_ended`).
- [ ] The first live run is watched: alerts on, circuit breaker limits as agreed (doc 25 §5.6).

## 3. Pricing — decision for the owner of the business

No price is in code (decision 138). Before the first invoice:

- [ ] Standard price per branch per month (GHS), and whether it includes VAT.
- [ ] Trial length and what happens at its end (doc 25).
- [ ] Enterprise threshold: from how many branches a hand-built quote is offered (doc 25 §2.1).
- [ ] Reseller commission terms for the first resellers (doc 29), if any launch with us.
- [ ] Price set in the console and shown on the readiness gate.

## 4. Legal

- [ ] Terms of service, privacy policy and DPA drafted and **reviewed by counsel** (Ghana Data Protection Act 2012; registration with the Data Protection Commission confirmed).
- [ ] Published in the console; the readiness gate passes `legal.*`.
- [ ] Data-protection request deadline confirmed by counsel (doc 33 §9 assumes 30 days) and breach notification deadline (doc 33 §5.2 step 7 assumes 72 h).
- [ ] Beta tenants accept the published versions (they are asked in the app).

## 5. Hosting (P0-3, when a server exists)

- [ ] Production and staging environments; secrets in the host's secret store, not `.env` files.
- [ ] TLS on every domain; database not reachable from outside; firewall, SSH keys only.
- [ ] **PgBouncer** in transaction pooling in front of PostgreSQL. Size it from the load figures (doc 33 §7): at 200 virtual users across 100 tenants the local server's 100 connections are the limit, not the API.
- [ ] `max_connections` ≥ processes × (`TENANT_POOL_MAX_TOTAL_CONNECTIONS` + `PLATFORM_POOL_MAX` + `JOB_POOL_MAX`) + headroom, or PgBouncer's pool sized to it.
- [ ] Backups scheduled to off-site storage and the restore test weekly (doc 31).
- [ ] Health checks wired (`/health/live`, `/health/ready`); metrics, error tracking and log shipping.
- [ ] Load test repeated on staging at the target tenant count (`yarn load:seed --tenants N`, `PROFILE=load yarn load:tenants`).

## 6. Security decisions

Findings still open from the security review (doc 32 §3):

- [ ] **F1** — Ghana Card and licence numbers stored in clear. Decide: accept for the first paying tenants (backups encrypted, database not exposed, tenants informed), or build field-level encryption first.
- [ ] **F2** — no second factor for tenant users. Decide: accept with the mitigations (strong passwords, lockout, short-lived tokens, owners told), or build TOTP for owners and administrators first.
- [ ] `yarn audit` shows no known vulnerabilities on the release build.
- [ ] Accepted warnings from §1, each with a reason:

| Check | Accepted because | By | Date |
|---|---|---|---|
| | | | |

## 7. People and process

- [ ] Two Super Admins with MFA; Support users invited (doc 35).
- [ ] On-call rota for the first four weeks, primary and backup (doc 33 §8); both have the runbooks.
- [ ] Support channels and hours published to tenants (doc 35 §1).
- [ ] Incident message templates ready (doc 33 §5.3); the status page tested.
- [ ] Restore drill done once before launch and recorded.

## 8. Launch day and after

- [ ] Backups taken just before; readiness gate green.
- [ ] Announcement to tenants (console announcements) with support contacts.
- [ ] Daily for the first two weeks: alerts centre, dry-run review, failed jobs, support queue.
- [ ] Day 14: dry-run decision (§2). Day 30: review tickets, incidents and load; adjust pool sizes and prices.
