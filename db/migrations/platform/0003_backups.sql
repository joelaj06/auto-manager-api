-- Backup catalogue (P0-4, docs/26 §4): one row per logical dump of a tenant database (L2) or the
-- platform database (L3), with what is needed to find, check and restore it.

create table backups (
  id              uuid primary key default uuidv7(),
  kind            text not null check (kind in ('tenant', 'platform')),
  tenant_id       uuid references tenants (id),
  database_name   text not null,
  status          text not null default 'running'
                  check (status in ('running', 'succeeded', 'failed')),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  -- Where the encrypted dump is, relative to the backup storage root.
  location        text,
  size_bytes      bigint check (size_bytes >= 0),
  -- SHA-256 of the stored (encrypted) file, checked before every restore.
  sha256          text check (sha256 ~ '^[0-9a-f]{64}$'),
  -- Fingerprint of the public key the dump was encrypted for (which private key restores it).
  key_fingerprint text,
  schema_version  text,
  -- Exact row count per table, taken in the same snapshot as the dump.
  row_counts      jsonb,
  error           text,
  verified_at     timestamptz,
  verification    jsonb,
  check ((kind = 'tenant') = (tenant_id is not null)),
  check (status <> 'succeeded'
         or (finished_at is not null and location is not null and sha256 is not null))
);

create index backups_tenant_idx on backups (tenant_id, started_at desc) where tenant_id is not null;
create index backups_kind_idx on backups (kind, started_at desc);
create index backups_unverified_idx on backups (started_at) where status = 'succeeded' and verified_at is null;
