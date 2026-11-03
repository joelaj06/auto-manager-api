-- Cold archive and erasure by anonymisation (P9-2, docs/26 §8, docs/27 §3.3 and §3.15).

-- Backups taken to archive a tenant are kept indefinitely; routine ones age out (docs/26 §3).
alter table backups
  add column purpose text not null default 'routine' check (purpose in ('routine', 'archive'));

create index backups_archive_idx on backups (tenant_id, started_at desc) where purpose = 'archive';

-- A tenant's database moved to cold archive (decision 495): asked and approved (four-eyes),
-- queued, archiving (closed, dumped and checked while it is written), archived (the live
-- database dropped) or failed (the database reopened). Restoring is approved in the console
-- (four-eyes) and carried out by an operator holding the backup private key (`yarn archive
-- restore`): restoring, then restored (the tenant is deactivated again, its database back).
create table tenant_archives (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references tenants (id),
  status                text not null default 'queued'
                        check (status in ('queued', 'archiving', 'archived', 'failed',
                                          'restoring', 'restored')),
  reason                text not null check (length(trim(reason)) between 3 and 1000),
  approval_id           uuid references platform_approval_requests (id),
  requested_by          uuid not null references platform_users (id),
  requested_at          timestamptz not null default now(),
  -- Where the live database was.
  cluster_id            text references clusters (id),
  -- The verified dump; replaced when the archive is encrypted again for a new key.
  backup_id             uuid references backups (id),
  -- Files the tenant's records point at: count, bytes, those missing from storage, and the
  -- encrypted manifest (keys, sizes, types) next to the dump.
  files                 jsonb not null default '{}'::jsonb,
  -- The checks of the dump restored into a scratch database while it was written.
  report                jsonb not null default '{}'::jsonb,
  error                 text,
  started_at            timestamptz,
  archived_at           timestamptz,
  -- The yearly restore test of the archive (decision 497).
  last_verified_at      timestamptz,
  last_verification     jsonb,
  rekeyed_at            timestamptz,
  restore_reason        text check (length(trim(restore_reason)) between 3 and 1000),
  restore_approval_id   uuid references platform_approval_requests (id),
  restore_requested_by  uuid references platform_users (id),
  restore_approved_at   timestamptz,
  restore_started_at    timestamptz,
  restored_at           timestamptz,
  -- Who ran the restore (the operator's name from the command line) and its checks.
  restored_by_operator  text check (length(restored_by_operator) <= 120),
  restore_report        jsonb,
  updated_at            timestamptz not null default now(),
  check ((status = 'archived') <= (archived_at is not null and backup_id is not null)),
  check ((status = 'restored') <= (restored_at is not null))
);

-- One archive in progress or in force per tenant.
create unique index tenant_archives_open_idx on tenant_archives (tenant_id)
  where status in ('queued', 'archiving', 'archived', 'restoring');
create index tenant_archives_tenant_idx on tenant_archives (tenant_id, requested_at desc);
create index tenant_archives_cluster_id_idx on tenant_archives (cluster_id)
  where cluster_id is not null;
create index tenant_archives_backup_id_idx on tenant_archives (backup_id)
  where backup_id is not null;
create index tenant_archives_approval_id_idx on tenant_archives (approval_id)
  where approval_id is not null;
create index tenant_archives_restore_approval_id_idx on tenant_archives (restore_approval_id)
  where restore_approval_id is not null;
create index tenant_archives_verification_idx on tenant_archives (last_verified_at)
  where status = 'archived';

-- The erasure ledger (decision 498): every anonymisation of a person in a tenant, approved by a
-- Super Admin (four-eyes). Pending until applied to the tenant's database (later, when the
-- tenant is archived), and applied again whenever a backup or archive of the tenant is restored.
create table erasure_ledger (
  id                uuid primary key default uuidv7(),
  tenant_id         uuid not null references tenants (id),
  subject_type      text not null check (subject_type in ('driver', 'customer', 'user', 'lead')),
  subject_id        uuid not null,
  -- The data-protection request it answers.
  request_id        uuid references data_protection_requests (id),
  reason            text not null check (length(trim(reason)) between 3 and 1000),
  approval_id       uuid references platform_approval_requests (id),
  requested_by      uuid not null references platform_users (id),
  approved_by       uuid references platform_users (id),
  status            text not null default 'pending' check (status in ('pending', 'applied')),
  -- Rows changed per table, files removed.
  report            jsonb not null default '{}'::jsonb,
  error             text,
  created_at        timestamptz not null default now(),
  applied_at        timestamptz,
  reapplied         integer not null default 0 check (reapplied >= 0),
  last_reapplied_at timestamptz,
  unique (tenant_id, subject_type, subject_id),
  check ((status = 'applied') = (applied_at is not null))
);

create index erasure_ledger_pending_idx on erasure_ledger (created_at) where status = 'pending';
create index erasure_ledger_request_id_idx on erasure_ledger (request_id)
  where request_id is not null;
create index erasure_ledger_approval_id_idx on erasure_ledger (approval_id)
  where approval_id is not null;
