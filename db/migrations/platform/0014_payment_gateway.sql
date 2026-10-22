-- Payment gateway (P4-2, docs/25 §4, §9, docs/27 §3.6): hosted checkout, charges on saved cards,
-- mobile money prompts, signed idempotent webhooks with an inspector, refunds and the daily
-- reconciliation against the provider's transactions.

-- Every attempt to collect an invoice through the gateway. The reference is what the provider
-- knows; a succeeded attempt points at the payment it became.
create table gateway_transactions (
  id                       uuid primary key default uuidv7(),
  reference                text not null unique check (reference ~ '^[A-Za-z0-9._=-]{6,100}$'),
  tenant_id                uuid not null references tenants (id),
  invoice_id               uuid not null references billing_invoices (id),
  provider                 text not null check (provider ~ '^[a-z][a-z_]*$'),
  kind                     text not null check (kind in ('checkout', 'saved_card', 'mobile_money')),
  amount_minor             bigint not null check (amount_minor > 0),
  currency                 char(3) not null,
  status                   text not null default 'pending'
                           check (status in ('pending', 'succeeded', 'failed', 'abandoned', 'review')),
  -- Saved card used, or to save the card / MoMo number after success.
  payment_method_id        uuid references payment_methods (id),
  save_method              boolean not null default false,
  momo_phone               text check (momo_phone ~ '^\+?[0-9]{9,15}$'),
  momo_network             text check (momo_network in ('mtn', 'telecel', 'at')),
  checkout_url             text,
  channel                  text,
  provider_transaction_id  text,
  fees_minor               bigint check (fees_minor >= 0),
  failure_reason           text check (length(failure_reason) <= 500),
  -- Who started it: a tenant user, staff, or the system (automatic charge).
  initiated_by_type        text not null check (initiated_by_type in ('user', 'platform_staff', 'system')),
  initiated_by             uuid,
  created_at               timestamptz not null default now(),
  completed_at             timestamptz,
  check ((status in ('pending')) = (completed_at is null))
);

create index gateway_transactions_invoice_idx on gateway_transactions (invoice_id, created_at desc);
create index gateway_transactions_status_idx on gateway_transactions (status, created_at desc);
create index gateway_transactions_completed_idx on gateway_transactions (completed_at)
  where status = 'succeeded';

-- Payments through the gateway: no staff recorded them; card is a method of its own.
alter table billing_payments
  drop constraint billing_payments_method_check,
  add constraint billing_payments_method_check
    check (method in ('bank_transfer', 'momo', 'cash', 'cheque', 'card', 'other')),
  alter column recorded_by drop not null,
  add column provider text,
  add column gateway_transaction_id uuid unique references gateway_transactions (id),
  add column fees_minor bigint check (fees_minor >= 0),
  add constraint billing_payments_source_check
    check (recorded_by is not null or gateway_transaction_id is not null);

-- Everything the provider POSTed, signed or not: the inspector, replay and idempotency.
create table webhook_events (
  id               uuid primary key default uuidv7(),
  provider         text not null,
  -- The provider's event identity (type + transaction); null for unusable or unsigned bodies.
  event_key        text,
  event_type       text,
  signature_valid  boolean not null,
  payload          jsonb not null,
  received_at      timestamptz not null default now(),
  attempts         integer not null default 0,
  processed_at     timestamptz,
  outcome          text check (outcome in ('applied', 'ignored', 'failed', 'rejected')),
  error            text check (length(error) <= 2000)
);

create unique index webhook_events_key_idx on webhook_events (provider, event_key)
  where event_key is not null;
create index webhook_events_received_idx on webhook_events (received_at desc);

-- Money given back (a mistaken or duplicate payment). Through the gateway when the payment came
-- through it; otherwise recorded by staff as paid back outside.
create table billing_refunds (
  id                  uuid primary key default uuidv7(),
  payment_id          uuid not null references billing_payments (id),
  invoice_id          uuid not null references billing_invoices (id),
  tenant_id           uuid not null references tenants (id),
  amount_minor        bigint not null check (amount_minor > 0),
  currency            char(3) not null,
  reason              text not null check (length(trim(reason)) between 5 and 1000),
  status              text not null default 'pending' check (status in ('pending', 'processed', 'failed')),
  provider            text,
  provider_refund_id  text,
  requested_by        uuid not null references platform_users (id),
  created_at          timestamptz not null default now(),
  processed_at        timestamptz,
  check ((status = 'processed') = (processed_at is not null))
);

create index billing_refunds_payment_idx on billing_refunds (payment_id);

-- The daily comparison of our gateway payments with the provider's.
create table gateway_reconciliations (
  id                 uuid primary key default uuidv7(),
  provider           text not null,
  day                date not null,
  status             text not null check (status in ('matched', 'mismatched', 'failed')),
  our_count          integer not null default 0,
  our_minor          bigint not null default 0,
  provider_count     integer not null default 0,
  provider_minor     bigint not null default 0,
  fees_minor         bigint not null default 0,
  -- [{ reference, … }] each.
  missing_here       jsonb not null default '[]'::jsonb,
  missing_there      jsonb not null default '[]'::jsonb,
  amount_mismatches  jsonb not null default '[]'::jsonb,
  error              text,
  ran_at             timestamptz not null default now(),
  unique (provider, day)
);
