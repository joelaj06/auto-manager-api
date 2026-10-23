-- Enterprise licence (P4-4, docs/25 §2.1, docs/27 §3.6): hand-built, versioned quotes approved by a
-- Super Admin; the accepted quote becomes the subscription's price items (monthly and one-time).

create table enterprise_quotes (
  id               uuid primary key default uuidv7(),
  -- AF-QUO-2026-000001.
  code             text not null unique,
  tenant_id        uuid not null references tenants (id),
  subscription_id  uuid not null references subscriptions (id),
  -- 1, 2, 3 … per tenant.
  version          integer not null check (version > 0),
  status           text not null default 'draft'
                   check (status in ('draft', 'sent', 'accepted', 'superseded', 'withdrawn')),
  -- [{ kind, description, quantity, unitMinor, recurrence, countsAsLicence }]
  lines            jsonb not null default '[]'::jsonb,
  currency         char(3) not null,
  recurring_minor  bigint not null default 0,
  one_time_minor   bigint not null default 0,
  -- "Business size" is a judgement recorded on the quote (decision 53), not a computed input.
  size_band        text check (size_band in ('small', 'medium', 'large', 'very_large')),
  size_note        text check (length(size_note) <= 1000),
  notes            text check (length(notes) <= 2000),
  valid_until      date,
  created_by       uuid not null references platform_users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Sending is the Super Admin's approval.
  approved_by      uuid references platform_users (id),
  sent_at          timestamptz,
  accepted_at      timestamptz,
  accepted_by_type text check (accepted_by_type in ('user', 'platform_staff')),
  accepted_by      uuid,
  closed_at        timestamptz,
  unique (tenant_id, version),
  check ((status = 'draft') = (sent_at is null) or status = 'withdrawn'),
  check ((status in ('accepted', 'superseded')) = (accepted_at is not null))
);

create index enterprise_quotes_tenant_idx on enterprise_quotes (tenant_id, version desc);
create unique index enterprise_quotes_accepted_idx on enterprise_quotes (tenant_id)
  where status = 'accepted';

-- The tenant's price list from its accepted quote. Monthly items go on every invoice (the
-- per-branch rate × billed branches); one-time items on the next invoice only.
create table subscription_price_items (
  id                 uuid primary key default uuidv7(),
  subscription_id    uuid not null references subscriptions (id),
  quote_id           uuid not null references enterprise_quotes (id),
  kind               text not null
                     check (kind in ('branch_rate', 'size_adjustment', 'setup', 'other', 'discount')),
  description        text not null check (length(trim(description)) between 1 and 300),
  quantity           integer not null check (quantity >= 1),
  unit_minor         bigint not null,
  recurrence         text not null check (recurrence in ('monthly', 'one_time')),
  counts_as_licence  boolean not null,
  -- One-time items: the invoice that charged them (released when it is voided).
  invoice_id         uuid references billing_invoices (id),
  created_at         timestamptz not null default now(),
  ended_at           timestamptz,
  check ((kind = 'discount') = (unit_minor < 0)),
  check (recurrence = 'one_time' or invoice_id is null)
);

create index subscription_price_items_active_idx on subscription_price_items (subscription_id)
  where ended_at is null;
