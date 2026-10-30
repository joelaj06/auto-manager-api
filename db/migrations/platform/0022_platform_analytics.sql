-- Platform analytics (P8-4, docs/27 §3.16): what the nightly usage adds for adoption, health and
-- cost to serve, each tenant's onboarding milestones, and the cost rates of serving a tenant.

-- Server errors per tenant and day, counted with the calls.
alter table api_usage add column errors bigint not null default 0;

-- Background jobs run for the tenant that day and those that failed; work recorded per audited
-- entity type (the modules used).
alter table usage_daily
  add column jobs        integer not null default 0,
  add column failed_jobs integer not null default 0,
  add column api_errors  bigint  not null default 0,
  add column modules     jsonb   not null default '{}'::jsonb;

-- When each onboarding step was first done (step key → date), refreshed nightly.
create table tenant_onboarding (
  tenant_id   uuid primary key references tenants (id),
  steps       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- What serving a tenant costs a month, in minor units of the billing currency.
create table analytics_settings (
  id                         boolean primary key default true check (id),
  currency                   char(3) not null default 'GHS' check (currency ~ '^[A-Z]{3}$'),
  tenant_month_minor         bigint not null default 0 check (tenant_month_minor >= 0),
  database_gb_month_minor    bigint not null default 0 check (database_gb_month_minor >= 0),
  storage_gb_month_minor     bigint not null default 0 check (storage_gb_month_minor >= 0),
  api_calls_thousand_minor   bigint not null default 0 check (api_calls_thousand_minor >= 0),
  jobs_thousand_minor        bigint not null default 0 check (jobs_thousand_minor >= 0),
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid references platform_users (id)
);
insert into analytics_settings (tenant_month_minor, database_gb_month_minor, storage_gb_month_minor,
  api_calls_thousand_minor, jobs_thousand_minor)
values (2000, 1000, 200, 5, 10);
