-- Cluster management (P9-1, docs/22 §2.2, docs/27 §3.14): the PostgreSQL clusters tenant
-- databases live on, the cluster of each tenant, moves of a tenant to another cluster and what
-- the orphan sweep finds on each cluster.

-- Every cluster is bootstrapped with the same roles and passwords (`yarn db:setup` against it),
-- so a cluster is only an address. `main` is the server in the configuration.
create table clusters (
  id              text primary key check (id ~ '^[a-z][a-z0-9-]{1,30}$'),
  name            text not null check (length(trim(name)) between 1 and 100),
  -- Null: DATABASE_HOST / DATABASE_PORT.
  host            text check (length(host) between 1 and 255),
  port            integer check (port between 1 and 65535),
  -- active: takes new tenants; draining: keeps its tenants, takes no new ones; retired: empty.
  status          text not null default 'active' check (status in ('active', 'draining', 'retired')),
  max_tenants     integer not null default 1000 check (max_tenants between 1 and 100000),
  notes           text check (length(notes) <= 1000),
  last_checked_at timestamptz,
  last_error      text,
  created_by      uuid references platform_users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check ((host is null) = (port is null))
);

insert into clusters (id, name) values ('main', 'Main cluster');

alter table tenants
  add column cluster_id   text not null default 'main' references clusters (id),
  -- Set while the tenant's database is copied to another cluster: the tenant is offline.
  add column moving_since timestamptz;

create index tenants_cluster_id_idx on tenants (cluster_id);

-- A tenant's database copied to another cluster (decision 492): queued once approved, then
-- blocking (writes stopped), copying (dump, restore, compare), switching, and completed or failed.
create table tenant_cluster_moves (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references tenants (id),
  from_cluster          text not null references clusters (id),
  to_cluster            text not null references clusters (id),
  status                text not null default 'queued'
                        check (status in ('queued', 'blocking', 'copying', 'switching',
                                          'completed', 'failed')),
  reason                text not null check (length(trim(reason)) between 3 and 500),
  -- Tables and rows compared, bytes and timings.
  report                jsonb not null default '{}'::jsonb,
  error                 text,
  approval_id           uuid references platform_approval_requests (id),
  requested_by          uuid not null references platform_users (id),
  requested_at          timestamptz not null default now(),
  started_at            timestamptz,
  finished_at           timestamptz,
  -- The old database is kept (closed to the app) until then, then reported for dropping.
  source_retained_until date,
  check (from_cluster <> to_cluster)
);

create unique index tenant_cluster_moves_open_idx on tenant_cluster_moves (tenant_id)
  where status not in ('completed', 'failed');
create index tenant_cluster_moves_tenant_idx on tenant_cluster_moves (tenant_id, requested_at desc);
create index tenant_cluster_moves_from_idx on tenant_cluster_moves (from_cluster);
create index tenant_cluster_moves_to_idx on tenant_cluster_moves (to_cluster);
create index tenant_cluster_moves_approval_id_idx on tenant_cluster_moves (approval_id)
  where approval_id is not null;

-- What the orphan sweep finds on a cluster (decision 493), kept while it is seen:
-- no_tenant: a tenant database no tenant record names; moved_away: the database a tenant left
-- behind when it moved; stray_copy: a tenant's database on a cluster it is not on, without a
-- move; missing: a tenant's database absent from its cluster.
create table cluster_database_findings (
  cluster_id    text not null references clusters (id),
  database_name text not null,
  kind          text not null check (kind in ('no_tenant', 'moved_away', 'stray_copy', 'missing')),
  tenant_id     uuid references tenants (id),
  size_bytes    bigint,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- No longer seen, or dropped.
  resolved_at   timestamptz,
  dropped_by    uuid references platform_users (id),
  primary key (cluster_id, database_name)
);

create index cluster_database_findings_open_idx on cluster_database_findings (kind)
  where resolved_at is null;
create index cluster_database_findings_tenant_id_idx on cluster_database_findings (tenant_id)
  where tenant_id is not null;
