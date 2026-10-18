-- Subscriptions and manual billing (P1-10, docs/25 §1–3, §7): plans, one subscription per
-- tenant (trial on provisioning), licence type, billed branch count, invoices and manually
-- recorded payments. Gateway checkout, dunning and enterprise quotes come in phase 2.

create table plans (
  id                  uuid primary key default uuidv7(),
  code                text not null unique check (code ~ '^[a-z][a-z_]*$'),
  name                text not null,
  currency            char(3) not null default 'GHS' check (currency ~ '^[A-Z]{3}$'),
  -- Standard: flat price per branch per month (minor units); null until set by staff.
  -- Enterprise: priced by hand per tenant (no price here).
  pricing             text not null check (pricing in ('flat_per_branch', 'custom')),
  branch_price_minor  bigint check (branch_price_minor > 0),
  trial_days          integer not null default 14 check (trial_days between 0 and 90),
  -- Branches a trialing tenant may have.
  trial_branch_limit  integer not null default 3 check (trial_branch_limit >= 1),
  features            jsonb not null default '[]'::jsonb,
  is_active           boolean not null default true,
  updated_at          timestamptz not null default now(),
  check (pricing = 'flat_per_branch' or branch_price_minor is null)
);

insert into plans (code, name, pricing) values
  ('standard', 'Standard', 'flat_per_branch'),
  ('enterprise', 'Enterprise', 'custom');

create table subscriptions (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null unique references tenants (id),
  plan_id               uuid not null references plans (id),
  licence_type          text not null default 'standard' check (licence_type in ('standard', 'enterprise')),
  status                text not null default 'trialing'
                        check (status in ('trialing', 'active', 'past_due', 'canceled')),
  -- Branches paid for (the entitlement once out of trial).
  branch_count          integer not null default 1 check (branch_count >= 0),
  trial_ends_at         timestamptz,
  current_period_start  date,
  current_period_end    date,
  -- Set by the first payment; the licence type can no longer be changed (docs/25 §2.1).
  licence_locked_at     timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               integer not null default 1,
  check ((current_period_start is null) = (current_period_end is null)),
  check (current_period_end is null or current_period_end > current_period_start)
);

create table subscription_events (
  id               uuid primary key default uuidv7(),
  subscription_id  uuid not null references subscriptions (id),
  type             text not null check (type ~ '^[a-z][a-z_]*$'),
  details          jsonb not null default '{}'::jsonb,
  actor_type       text not null check (actor_type in ('platform_staff', 'user', 'system')),
  actor_id         uuid,
  created_at       timestamptz not null default now()
);

create index subscription_events_idx on subscription_events (subscription_id, created_at desc);

revoke update, delete, truncate on subscription_events from af_platform_rw;
create trigger subscription_events_append_only
  before update or delete on subscription_events
  for each row execute function forbid_mutation();

create table billing_invoices (
  id               uuid primary key default uuidv7(),
  code             text not null unique,
  tenant_id        uuid not null references tenants (id),
  subscription_id  uuid not null references subscriptions (id),
  period_start     date not null,
  period_end       date not null check (period_end > period_start),
  -- [{ kind, description, quantity, unitMinor, amountMinor, countsAsLicence }]
  lines            jsonb not null,
  subtotal_minor   bigint not null check (subtotal_minor >= 0),
  tax_minor        bigint not null default 0 check (tax_minor >= 0),
  total_minor      bigint not null check (total_minor = subtotal_minor + tax_minor),
  paid_minor       bigint not null default 0 check (paid_minor >= 0),
  currency         char(3) not null,
  status           text not null default 'open' check (status in ('open', 'paid', 'void')),
  issued_at        timestamptz not null default now(),
  due_at           timestamptz not null,
  paid_at          timestamptz,
  voided_at        timestamptz,
  void_reason      text,
  created_by       uuid references platform_users (id),
  version          integer not null default 1,
  check ((status = 'paid') = (paid_at is not null)),
  check ((status = 'void') = (voided_at is not null))
);

create index billing_invoices_tenant_idx on billing_invoices (tenant_id, issued_at desc);
create index billing_invoices_open_idx on billing_invoices (due_at) where status = 'open';
-- One invoice per subscription period (void ones excepted).
create unique index billing_invoices_period_idx on billing_invoices (subscription_id, period_start)
  where status <> 'void';

create table billing_payments (
  id            uuid primary key default uuidv7(),
  invoice_id    uuid not null references billing_invoices (id),
  tenant_id     uuid not null references tenants (id),
  -- Manual billing: staff record what was received (no gateway yet).
  method        text not null check (method in ('bank_transfer', 'momo', 'cash', 'cheque', 'other')),
  reference     text not null check (length(trim(reference)) between 1 and 120),
  amount_minor  bigint not null check (amount_minor > 0),
  currency      char(3) not null,
  received_at   timestamptz not null,
  notes         text check (length(notes) <= 1000),
  recorded_by   uuid not null references platform_users (id),
  created_at    timestamptz not null default now(),
  unique (method, reference)
);

create index billing_payments_tenant_idx on billing_payments (tenant_id, received_at desc);

revoke update, delete, truncate on billing_payments from af_platform_rw;
create trigger billing_payments_append_only
  before update or delete on billing_payments
  for each row execute function forbid_mutation();

-- Tenants provisioned before billing existed get a standard trial subscription.
insert into subscriptions (tenant_id, plan_id, status, trial_ends_at)
select t.id, p.id, 'trialing', coalesce(t.trial_ends_at, now() + interval '14 days')
  from tenants t cross join plans p
 where p.code = 'standard' and t.status not in ('provisioning', 'provisioning_failed');
