-- P9-7: custom domains, dedicated clusters and a database login per tenant (decisions 528–532).

-- A business's own host name. Pending until the DNS proves it is theirs; suspended when the
-- records have gone. Only an active domain resolves to its tenant or gets a certificate.
create table tenant_domains (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references tenants (id),
  domain             text not null unique
                       check (domain = lower(domain) and length(domain) between 4 and 253),
  status             text not null default 'pending'
                       check (status in ('pending', 'active', 'suspended')),
  verification_token text not null,
  verified_at        timestamptz,
  last_checked_at    timestamptz,
  last_error         text check (length(last_error) <= 300),
  failed_checks      integer not null default 0 check (failed_checks >= 0),
  created_by         uuid references platform_users (id),
  created_at         timestamptz not null default now()
);

create index tenant_domains_tenant_idx on tenant_domains (tenant_id);

-- A cluster kept for one tenant: new tenants and moves of anyone else never land on it.
alter table clusters add column dedicated_to uuid references tenants (id);
create unique index clusters_dedicated_to_idx on clusters (dedicated_to)
  where dedicated_to is not null;

-- The tenant's own database login (docs/22 §2.4 safeguard 4). The password is sealed; the role
-- exists on the tenant's cluster. `version` retires the pools opened with an older password.
create table tenant_database_credentials (
  tenant_id       uuid primary key references tenants (id),
  role_name       text not null,
  sealed_password text not null,
  version         integer not null default 1 check (version >= 1),
  -- enabling: not used yet; active: used; disabling: used until the shared login is back.
  status          text not null check (status in ('enabling', 'active', 'disabling')),
  rotated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
