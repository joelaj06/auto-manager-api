-- Platform (control-plane) database foundation.
-- Runs as the migrator role, which owns the database. The application connects as a member of
-- af_platform_rw and gets data access only (no DDL).

create extension if not exists citext;
create extension if not exists pgcrypto;

-- Tables created by the migrator from now on are readable/writable by the platform app role.
alter default privileges in schema public
  grant select, insert, update, delete on tables to af_platform_rw;
alter default privileges in schema public
  grant usage, select on sequences to af_platform_rw;

-- The migration runner creates schema_migrations before this file runs; the app may only read it.
grant select on schema_migrations to af_platform_rw;

-- Append-only tables reject updates and deletes, even from roles that have DML grants.
create function forbid_mutation() returns trigger
  language plpgsql
as $$
begin
  raise exception 'table % is append-only', tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

create table tenants (
  id            uuid primary key default uuidv7(),
  slug          citext not null unique
                check (slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$'),
  name          text not null check (length(trim(name)) > 0),
  status        text not null default 'provisioning'
                check (status in ('provisioning', 'provisioning_failed', 'trialing', 'active',
                                  'past_due', 'read_only', 'deactivated', 'archived')),
  database_name text unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       integer not null default 1
);

-- Result of the latest schema migration run per tenant database (written by the migration runner).
create table tenant_schema_status (
  tenant_id      uuid primary key references tenants (id),
  schema_version text,
  status         text not null check (status in ('ok', 'failed')),
  error          text,
  updated_at     timestamptz not null default now()
);

create index tenant_schema_status_failed_idx on tenant_schema_status (updated_at)
  where status = 'failed';

-- Human-readable sequence numbers (invoices, applications, …), allocated inside transactions.
create table counters (
  key        text primary key,
  value      bigint not null check (value >= 0),
  updated_at timestamptz not null default now()
);

create table platform_audit_logs (
  id               uuid primary key default uuidv7(),
  occurred_at      timestamptz not null default now(),
  actor_type       text not null check (actor_type in ('platform_staff', 'partner', 'system')),
  actor_id         uuid,
  action           text not null,
  entity_type      text not null,
  entity_id        text,
  target_tenant_id uuid,
  before           jsonb,
  after            jsonb,
  reason           text,
  request_id       text,
  ip               inet,
  user_agent       text,
  metadata         jsonb not null default '{}'::jsonb
);

create index platform_audit_logs_occurred_idx on platform_audit_logs (occurred_at desc);
create index platform_audit_logs_entity_idx
  on platform_audit_logs (entity_type, entity_id, occurred_at desc);
create index platform_audit_logs_tenant_idx
  on platform_audit_logs (target_tenant_id, occurred_at desc) where target_tenant_id is not null;
create index platform_audit_logs_actor_idx
  on platform_audit_logs (actor_id, occurred_at desc) where actor_id is not null;

revoke update, delete, truncate on platform_audit_logs from af_platform_rw;
create trigger platform_audit_logs_append_only
  before update or delete on platform_audit_logs
  for each row execute function forbid_mutation();
