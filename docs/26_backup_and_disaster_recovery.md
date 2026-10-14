# 26 — Backup & Disaster Recovery

Decision 29: **backups are essential.** This doc makes them a P0 deliverable, not an afterthought. It assumes database-per-tenant PostgreSQL on a VPS (doc 22).

## 1. Targets

| Metric | Target (proposal) | Meaning |
|---|---|---|
| **RPO** (data you can lose) | ≤ 5 minutes | Continuous WAL archiving |
| **RTO — one tenant** | ≤ 1 hour | Restore single tenant DB from dump or PITR |
| **RTO — whole server loss** | ≤ 4 hours | Rebuild VPS from IaC/runbook + restore latest base backup + WAL |
| Backup verification | Every backup checked; **automated restore test weekly, human drill quarterly** | A backup that has never been restored is not a backup |

Adjust once a hosting budget is known.

## 2. Layers (3-2-1: 3 copies, 2 media, 1 off-site)

| Layer | Tool | Covers | Frequency | Stored |
|---|---|---|---|---|
| **L1. Physical + WAL (PITR)** | pgBackRest or WAL-G | Entire cluster (all tenant DBs + platform DB) | Full weekly, differential/incremental daily, WAL continuous | Off-VPS object storage (different provider/region than the VPS) |
| **L2. Per-tenant logical dump** | `pg_dump -Fc` per tenant DB | One tenant at a time; portable across Postgres versions | Nightly (staggered), plus on-demand before risky operations and before migrations touching that tenant | Object storage, encrypted |
| **L3. Platform DB dump** | `pg_dump` of `autoforce_platform` | Tenants registry, billing, directory | Hourly + nightly | Object storage |
| **L4. Files** | Object-store versioning/replication; rclone sync | Uploaded documents, photos, signed PDFs | Continuous / daily | Second bucket |
| **L5. Config & secrets** | Encrypted export of env/secret store, IaC repo | Rebuild the server | On change | Separate secure location |
| **L6. Standby replica** (when budget allows) | Streaming replication | Fast failover | Continuous | Second server |

Why both L1 and L2: L1 restores *everything to a moment in time* but is clumsy for one tenant; L2 makes *single-tenant* restore/export/migration simple and independent of cluster version.

## 3. Rules

- **Off-VPS and off-provider**: backups never live only on the server they protect.
- **Encrypted at rest and in transit** (client-side encryption with `age`/GPG; keys stored separately from the bucket credentials; keys escrowed with two people).
- **Immutable / object-lock** buckets (or versioning with restricted delete) so ransomware or a compromised server can't delete history. Backup credentials are write-only from the server.
- **Retention (proposal)**: WAL/PITR window 14 days; per-tenant dumps — daily × 14, weekly × 8, monthly × 12; platform DB hourly × 48, daily × 30, monthly × 12. Legal/tax retention may require longer for billing data (confirm).
- **Staggered schedule**: dumps run through a queue with concurrency 2 and off-peak windows; skip/limit for very large tenants.
- **Consistency**: `pg_dump` is transactionally consistent per database. Files and DB are only loosely consistent; documents reference files by key and are immutable once signed, so restore order is DB first, then files.
- **Never auto-delete** backups of a deleted tenant until the retention/grace period ends.

## 4. Monitoring & alerting

- Metrics: age of last successful L1/L2/L3 backup, WAL archive lag, backup size growth, duration, failures, object-store free space, restore-test status.
- Alerts (page): WAL archiving failing > 10 min, no successful full backup in 26 h, any tenant without a dump in 36 h, restore test failed.
- Daily "backup report" email to ops with per-tenant status.
- Platform `tenant_backups` table: tenant_id, type, location, size, sha256, started/finished, status, verified_at.

## 5. Restore procedures (runbooks to write and rehearse)

| Scenario | Procedure |
|---|---|
| **Single tenant data corruption / user error** (e.g. deleted vehicles) | Put tenant in read-only maintenance → restore latest suitable dump (or PITR to a scratch cluster) into **new DB** `t_<id>_restore` → verify → either swap names (rename DBs) or copy selected rows back → resume → record incident |
| **Single tenant disaster** | Create DB from dump, update `tenants` pointer, bump schema version via migration runner if the dump is older than current schema |
| **Accidental `DROP DATABASE` / bad migration on many tenants** | PITR to just before the event on a scratch cluster, `pg_dump` affected DBs, restore into production |
| **Platform DB loss** | Restore from L3, then replay WAL; tenant DBs are independent and unaffected |
| **VPS total loss** | Provision new VPS from IaC → install Postgres → restore L1 base + WAL → start PgBouncer/app → verify tenant_info assertions and login → DNS cutover |
| **Ransomware / compromise** | Rotate all secrets, rebuild from clean image, restore from immutable backups, forensic review |
| **Tenant requests their data** | On-demand export (§6), not a backup restore |

Every runbook lists commands, expected timings, validation queries (row counts, ledger balanced, `tenant_info` matches, last transaction date), and who to notify.

## 6. Tenant-facing data export (portability)

- Owner can request **"Export all my data"**: job produces a zip with CSV per table + signed documents/files + a `README` with schema notes. Link emailed, expires in 7 days, audited.
- Also the exit path when a tenant cancels (offered before archive/deletion).

## 7. Verification & drills

- **Automated weekly restore test**: pick N random tenant dumps + the latest platform dump, restore to a scratch Postgres, run integrity checks (migrations table present, `tenant_info` correct, foreign keys valid, ledger balanced, allocation sums), record result in `tenant_backups.verified_at`.
- **Monthly**: PITR to a random timestamp on a scratch instance and compare with a known marker row.
- **Quarterly game day**: rebuild from scratch from backups only, time it against RTO, update runbooks.
- Backup before every deployment that includes a data-changing migration (L2 on-demand for affected tenants or a cluster snapshot).

## 8. No deletion: retention, cold archive & privacy (decision 36)

Tenants are **never deleted**; they are deactivated and can be restored (doc 27 §3.3).

**Tiers for a deactivated tenant**

| Tier | When | What exists | Restore |
|---|---|---|---|
| **Deactivated (live)** | From deactivation, default up to 12 months | Live tenant DB stays on the cluster, still covered by L1/L2/L3 backups | Staff action, minutes |
| **Cold archive** | Staff-initiated for long-deactivated tenants (default ≥ 12 months) | Verified encrypted `pg_dump -Fc` + files manifest in immutable object storage, kept indefinitely; live DB dropped to free cluster capacity | Runbook: create DB from template → restore dump → run migration runner to current schema → verify → reactivate. Target RTO ≈ 1–4 h |

Rules:
- A cold archive is created only after a **verified** dump (restore-tested into a scratch DB, row counts and checksums recorded in `tenant_backups`) and with four-eyes approval.
- Archived dumps are kept **indefinitely**; their storage class moves to cheap/cold tiers. Budget for this (cost notes §9).
- **Annual integrity check**: restore a sample of cold archives to a scratch server; re-encrypt/rotate keys on schedule; keep the dump format restorable across Postgres major versions (logical dumps, not physical).
- Schema evolution: an old dump is migrated forward by the normal migration runner on restore (doc 22 §2.5), so migrations must keep supporting all historical versions (or the archive is re-dumped after each major schema change).
- Files for archived tenants stay in object storage (versioned/immutable) under `tenantId/…`.
- **Things that may be purged**: rejected or never-approved applications, failed-provisioning leftovers, expired demo/sandbox tenants, expired export download links. These never held real production data.

**Privacy and erasure requests**
- Because we don't delete, a legal request to erase personal data (Ghana Data Protection Act) is handled by **anonymising** personal fields in place (names, phones, emails, ID numbers → tokens), executed by a controlled, four-eyes platform action (doc 27 §3.15).
- An **erasure ledger** (platform DB) records what was anonymised; it is **re-applied automatically** if a backup or cold archive is ever restored, so erased data does not come back.
- Backups made before an erasure still contain the original data until they age out per the retention schedule (§3). Document this in the privacy policy and confirm with counsel. Needs legal review (doc 19 round 5).
- Backups contain personal data (IDs, phone numbers, licences): same access controls and encryption as production; backup-key access is logged and limited.

## 9. Cost notes

Roughly proportional to total data × retention. Mitigate with compression (`pg_dump -Fc -Z`), incremental L1 backups, lifecycle rules moving old monthly dumps to cheaper storage tiers. Estimate once real tenant sizes are known.

## 10. Implementation phasing

- **P0** (before real tenants): L1 (pgBackRest/WAL-G) to off-site bucket, L3, L2 nightly, encryption, alerts, one documented manual restore of each kind, automated restore test.
- **P1**: tenant export, backup dashboard in platform console, runbook rehearsals.
- **Later**: standby replica / managed Postgres, cross-region copy, trusted timestamping of signed documents.
