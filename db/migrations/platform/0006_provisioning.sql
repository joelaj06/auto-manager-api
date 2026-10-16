-- Provisioning saga and tenant permission catalogue (P1-3, docs/22 §2.6, docs/28 §3–§5).

-- Tenant permission catalogue and role templates: synced from code by `yarn db:migrate`; the
-- platform database is what provisioning and the catalogue sync read ("seeded from the database").
create table permission_catalog (
  key         text primary key check (key ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*){1,2}$'),
  module      text not null,
  description text not null,
  scopes      text[] not null check (scopes <@ array['own', 'branch', 'all'] and cardinality(scopes) > 0),
  sensitive   boolean not null default false,
  deprecated  boolean not null default false,
  synced_at   timestamptz not null default now()
);

create table role_templates (
  system_key  text primary key check (system_key ~ '^[a-z][a-z_]*$'),
  name        text not null,
  description text not null,
  sort_order  integer not null default 0
);

create table role_template_permissions (
  system_key     text not null references role_templates (system_key) on delete cascade,
  permission_key text not null references permission_catalog (key),
  scope          text not null check (scope in ('own', 'branch', 'all')),
  primary key (system_key, permission_key)
);

-- A new version whenever the catalogue or the templates change (checksum of their content).
create table catalogue_versions (
  version     integer primary key check (version > 0),
  checksum    text not null unique,
  released_at timestamptz not null default now(),
  summary     jsonb not null default '{}'::jsonb
);

-- Tenant ↔ application, trial and catalogue state.
alter table tenants
  add column application_id    uuid unique references tenant_applications (id),
  add column trial_ends_at     timestamptz,
  add column catalogue_version integer,
  add column provisioned_at    timestamptz;

-- One row per tenant: where its provisioning saga is (resumable, retryable).
create table tenant_provisioning (
  tenant_id     uuid primary key references tenants (id),
  status        text not null default 'running' check (status in ('running', 'failed', 'completed')),
  step          text not null default 'registered'
                check (step in ('registered', 'database_created', 'schema_migrated', 'seeded',
                                'directory_updated', 'welcomed', 'completed')),
  attempts      integer not null default 0 check (attempts >= 0),
  last_error    text,
  started_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create index tenant_provisioning_open_idx on tenant_provisioning (updated_at) where status <> 'completed';

-- Which tenants a person belongs to, for multi-tenant sign-in on the mobile app (docs/22 §2.7).
-- Identifiers are stored as keyed hashes, never in clear.
create table user_directory (
  identifier_hash text not null,
  kind            text not null check (kind in ('email', 'phone')),
  tenant_id       uuid not null references tenants (id),
  tenant_user_id  uuid not null,
  status          text not null default 'active' check (status in ('active', 'disabled')),
  updated_at      timestamptz not null default now(),
  primary key (identifier_hash, tenant_id)
);

create index user_directory_tenant_idx on user_directory (tenant_id, tenant_user_id);
