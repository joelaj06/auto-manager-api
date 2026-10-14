-- Tenant database foundation. Applied to the tenant_template database and every tenant database.
-- Runs as the migrator role, which owns the database. The application connects as a member of
-- af_tenant_rw and gets data access only (no DDL).

create extension if not exists citext;
create extension if not exists pgcrypto;
create extension if not exists btree_gist;
create extension if not exists pg_trgm;

-- Tables created by the migrator from now on are readable/writable by the tenant app role.
alter default privileges in schema public
  grant select, insert, update, delete on tables to af_tenant_rw;
alter default privileges in schema public
  grant usage, select on sequences to af_tenant_rw;

-- The migration runner creates schema_migrations before this file runs; the app may only read it.
grant select on schema_migrations to af_tenant_rw;

-- Append-only tables reject updates and deletes, even from roles that have DML grants.
create function forbid_mutation() returns trigger
  language plpgsql
as $$
begin
  raise exception 'table % is append-only', tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

-- Identity of the tenant this database belongs to (exactly one row, written at provisioning).
-- The connection pool checks it on every new pool so a request can never be served from
-- another tenant's database.
create table tenant_info (
  singleton  boolean primary key default true check (singleton),
  tenant_id  uuid not null,
  created_at timestamptz not null default now()
);

revoke insert, update, delete, truncate on tenant_info from af_tenant_rw;

-- Human-readable sequence numbers (RT-2026-000123 …), allocated inside transactions.
create table counters (
  key        text primary key,
  value      bigint not null check (value >= 0),
  updated_at timestamptz not null default now()
);

create table audit_logs (
  id          uuid primary key default uuidv7(),
  occurred_at timestamptz not null default now(),
  actor_type  text not null check (actor_type in ('user', 'platform_staff', 'system')),
  actor_id    uuid,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  request_id  text,
  ip          inet,
  user_agent  text,
  metadata    jsonb not null default '{}'::jsonb
);

create index audit_logs_occurred_idx on audit_logs (occurred_at desc);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id, occurred_at desc);
create index audit_logs_actor_idx on audit_logs (actor_id, occurred_at desc)
  where actor_id is not null;

revoke update, delete, truncate on audit_logs from af_tenant_rw;
create trigger audit_logs_append_only
  before update or delete on audit_logs
  for each row execute function forbid_mutation();

-- Transactional outbox: events written in the same transaction as the business change and
-- published afterwards by the job runner (P0-8).
create table outbox (
  id             uuid primary key default uuidv7(),
  event_type     text not null,
  aggregate_type text,
  aggregate_id   text,
  payload        jsonb not null,
  occurred_at    timestamptz not null default now(),
  available_at   timestamptz not null default now(),
  published_at   timestamptz,
  attempts       integer not null default 0 check (attempts >= 0),
  last_error     text
);

create index outbox_pending_idx on outbox (available_at, id) where published_at is null;
