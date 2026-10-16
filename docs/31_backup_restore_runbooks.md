# 31 — Backup & restore runbooks

Operational procedures for the backup tooling built in P0-4 (design: [26](26_backup_and_disaster_recovery.md)). Every command below is `yarn backup …` (`src/framework/cli/backup.ts`). Rehearse each runbook before real tenants exist, and time it against the targets in doc 26 §1.

> **Status (2026-10-16): local part.** Logical backups (L2 per tenant, L3 platform), encryption, the backup catalogue, the automated restore test and restore-into-new-database run and are tested locally. **Deferred to hosting (decision 63):** off-site object storage, WAL archiving / PITR (L1, pgBackRest or WAL-G), the nightly schedule, alerts and the backup report.

## 1. What exists

| Piece | Where | Notes |
|---|---|---|
| Backup role | `backup` (group `af_backup`, `pg_read_all_data`) | Reads every application database, writes none. Created by `yarn db:setup`; tenant databases grant it `CONNECT` at provisioning |
| Dump | `pg_dump --format=custom` | One file per database. Runs on an **exported snapshot**; the row count of every table is taken in the same snapshot |
| Encryption | `AFBK` format (`infrastructure/backup/BackupCipher.ts`) | Fresh AES-256 key per file wrapped with the backup **RSA-4096 public key**; 64 KiB AES-GCM chunks — detects modification, truncation and reordering |
| Storage | `BACKUP_DIR` (default `./backups`, git-ignored) | `platform/<yyyy>/<mm>/<id>.dump.afbk`, `tenants/<tenantId>/<yyyy>/<mm>/<id>.dump.afbk`; files `0600`. No delete operation |
| Catalogue | platform table `backups` | Status, location, size, SHA-256 of the file, key fingerprint, schema version, row counts, verification result |
| Client tools | `BACKUP_PG_TOOLS=local` (PATH) or `docker` (`postgres:18-alpine`) | Tools must be ≥ the server's major version. Passwords go through the environment, never the command line |

## 2. One-time: create the backup key pair

The server holds only the **public** key: it can create backups but cannot read them.

```bash
BACKUP_PRIVATE_KEY_PASSPHRASE='<long passphrase>' yarn backup keygen --out ./backup-keys
```

1. Move `autoforce.backup-key.pem` (encrypted with the passphrase) **off the server**. Two people keep a copy and the passphrase separately (doc 26 §3).
2. Set `BACKUP_PUBLIC_KEY_FILE` to `autoforce-backup-public.pem`.
3. Record the printed fingerprint; every catalogue row stores the fingerprint of the key it was encrypted for.

`keygen` never overwrites an existing key. Losing the private key makes every backup encrypted for it unreadable — rotate by generating a new pair, switching `BACKUP_PUBLIC_KEY_FILE`, and keeping the old private key until its backups expire.

## 3. Take backups

```bash
yarn backup run                       # platform + every tenant with a database
yarn backup run --platform            # platform only (L3)
yarn backup run --tenant <tenantId>   # one tenant (before a risky operation)
yarn backup run --all-tenants         # tenants only, BACKUP_CONCURRENCY at a time (default 2)
yarn backup list                      # recent backups and verification status
```

A failed tenant does not stop the others; the command exits with 1 and lists failures. Deactivated tenants are backed up too (they still have a database, doc 26 §8).

**Before a deployment with a data-changing migration:** `yarn backup run` first, and do not migrate if it fails.

## 4. Automated restore test

```bash
BACKUP_PRIVATE_KEY_PASSPHRASE=… yarn backup verify --private-key <file> --sample 3   # latest platform + 3 random tenants
BACKUP_PRIVATE_KEY_PASSPHRASE=… yarn backup verify --private-key <file> --id <backupId>
```

Each backup is restored into a throw-away database `rv_<random>` (dropped afterwards — the only databases the tooling ever drops) and must pass:

| Check | Meaning |
|---|---|
| file checksum | The stored file still has the SHA-256 and size recorded at backup time |
| restore | Decryption (authenticated) and `pg_restore --single-transaction --exit-on-error` succeed |
| schema version | `schema_migrations` matches the version recorded at backup time |
| tenant identity | `tenant_info.tenant_id` is the backup's tenant (tenant backups) |
| row counts | Every table has exactly the rows counted in the dump's snapshot |
| foreign keys valid | No unvalidated foreign key after restore |

The result is stored on the catalogue row (`verification`, `verified_at` when passed). Module-specific checks (ledger balanced, allocation sums — doc 26 §7) are added with those modules. **Target cadence:** weekly, scheduled with hosting; until then run it manually after notable changes.

## 5. Restore one tenant (data corruption / user error)

Never restore over a live database. Restore next to it, inspect, then either copy rows back or switch.

1. **Freeze the tenant**: set its status to `read_only` (or `deactivated` for a full stop) in the platform console / `tenants` table and note the incident.
2. **Pick the backup**: `yarn backup list` → the latest successful backup from before the problem (verified if possible).
3. **Restore next to it:**
   ```bash
   BACKUP_PRIVATE_KEY_PASSPHRASE=… yarn backup restore --private-key <file> --id <backupId> --into t_<tenantIdHex>_restore_<yyyymmdd>
   ```
   The new database gets the same access grants as a provisioned tenant database.
4. **Verify** with the queries in §8 against the restored database.
5. **Either copy rows back** (preferred for partial loss: targeted `INSERT … SELECT` through `dblink`/`postgres_fdw` or exported CSV, inside one transaction, reviewed by a second person), **or switch databases** (whole-database rollback):
   1. Stop traffic for the tenant (step 1) and wait until no session uses its database (`select count(*) from pg_stat_activity where datname = '<live>'`; restart the API/worker if pools hold idle connections).
   2. As the migrator: `alter database <live> rename to <live>_before_<yyyymmdd>;` then `alter database <restored> rename to <live>;`
   3. If the backup is older than the current schema: `yarn db:migrate` (the runner migrates it forward).
6. **Reactivate** the tenant, record what was lost between the backup time and the incident, inform the tenant.
7. Keep `<live>_before_<date>` until the incident is closed; it is never dropped automatically.

## 6. Restore the platform database

Tenant databases are independent and unaffected by platform loss.

1. Stop the API and worker (the platform database holds the job queue).
2. Restore the latest platform backup into a new database: `yarn backup restore --id <id> --into autoforce_platform_restore`.
3. Verify (§8), then rename: live → `autoforce_platform_before_<date>`, restored → `autoforce_platform`.
4. `yarn db:migrate`, start the worker, then the API. Jobs enqueued after the backup are lost; outbox sweeps (hourly) re-drain pending tenant events and the scheduler catches up daily jobs (doc 30, decisions 75–76).
5. With hosting: replay WAL to the moment before the loss instead (L1), losing at most minutes.

## 7. Whole server loss

Requires hosting (P0-3) and L1: provision → install PostgreSQL 18 → restore the base backup + WAL → `yarn db:setup` (re-syncs roles) → start services → verify (§8) → DNS. Until L1 exists, the logical backups are the fallback: create the cluster, `yarn db:setup`, restore the platform backup and each tenant's latest backup (§5 step 3 with the live names), `yarn db:migrate`.

## 8. Validation queries after any restore

```sql
-- tenant database
select tenant_id from tenant_info;                       -- the expected tenant
select max(version) from schema_migrations;              -- schema version
select count(*) from audit_logs;                         -- compare with backups.row_counts
select max(occurred_at) from audit_logs;                 -- last activity contained in the backup
-- platform database
select status, count(*) from tenants group by status;
select count(*) from pgboss.job where state in ('created', 'retry');
```

Compare counts with the `row_counts` of the catalogue row (`yarn backup list`, or `select row_counts from backups where id = …`).

## 9. Still to build with hosting

- Off-site, write-only, versioned object storage (replaces `BACKUP_DIR`; same keys).
- L1: pgBackRest or WAL-G with continuous WAL archiving; monthly PITR drill.
- Schedules: nightly tenant dumps (staggered, concurrency 2), hourly + nightly platform dumps, weekly `verify --sample`.
- Retention per doc 26 §3, alerts per doc 26 §4 (no backup in 36 h, restore test failed), daily backup report.
- Cold archive (doc 26 §8) and the erasure ledger re-applied after restores.
