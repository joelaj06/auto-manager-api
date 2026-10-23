-- Reseller commissions (P4-6, docs/29 §4–§5): versioned terms per reseller, the first-purchase
-- commission ledger with clawbacks and adjustments, and payouts with their records.

-- One percentage per commission type, set by the Super Admin, versioned (never retroactive).
create table partner_commission_terms (
  id                    uuid primary key default uuidv7(),
  partner_id            uuid not null references partners (id),
  version               integer not null check (version > 0),
  -- Null: no commission for that type.
  standard_percent      numeric(5, 2) check (standard_percent > 0 and standard_percent <= 100),
  enterprise_percent    numeric(5, 2) check (enterprise_percent > 0 and enterprise_percent <= 100),
  -- Days a commission waits (refund cover) before it is payable; 0: payable at once.
  hold_days             integer not null default 0 check (hold_days between 0 and 180),
  -- Below this a balance carries forward.
  min_payout_minor      bigint not null default 0 check (min_payout_minor >= 0),
  -- Most a reseller earns from one tenant; null: no cap.
  cap_per_tenant_minor  bigint check (cap_per_tenant_minor > 0),
  reason                text not null check (length(trim(reason)) between 5 and 1000),
  created_by            uuid not null references platform_users (id),
  effective_from        timestamptz not null default now(),
  unique (partner_id, version)
);

-- The terms a tenant is bound to (those in force when it was attributed, or when it first paid),
-- a per-tenant override, and the invoice that is its first licence purchase.
alter table partner_tenant_attributions
  add column terms_id                uuid references partner_commission_terms (id),
  add column override_percent        numeric(5, 2)
                                     check (override_percent >= 0 and override_percent <= 100),
  add column override_reason         text check (length(override_reason) <= 1000),
  add column commission_invoice_id   uuid references billing_invoices (id),
  add check ((override_percent is null) = (override_reason is null));

-- Commission earned, clawed back and adjusted. Amounts are signed: clawbacks and negative
-- adjustments net against what is payable.
create table partner_commission_entries (
  id                 uuid primary key default uuidv7(),
  partner_id         uuid not null references partners (id),
  tenant_id          uuid references tenants (id),
  kind               text not null check (kind in ('commission', 'clawback', 'adjustment')),
  invoice_id         uuid references billing_invoices (id),
  source_payment_id  uuid references billing_payments (id),
  source_refund_id   uuid,
  commission_type    text check (commission_type in ('standard', 'enterprise')),
  terms_id           uuid references partner_commission_terms (id),
  base_minor         bigint,
  rate_percent       numeric(5, 2),
  amount_minor       bigint not null check (amount_minor <> 0),
  currency           char(3) not null,
  status             text not null check (status in ('accrued', 'payable', 'paid')),
  release_at         timestamptz,
  reason             text check (length(reason) <= 1000),
  created_by         uuid references platform_users (id),
  payout_id          uuid,
  created_at         timestamptz not null default now(),
  check (kind <> 'commission' or (source_payment_id is not null and source_refund_id is null
                                 and amount_minor > 0)),
  check (kind <> 'clawback' or (source_payment_id is not null and source_refund_id is not null
                                and amount_minor < 0)),
  check (kind <> 'adjustment' or (reason is not null and created_by is not null)),
  check (status <> 'accrued' or release_at is not null)
);

create unique index partner_commission_entries_payment_idx
  on partner_commission_entries (source_payment_id) where kind = 'commission';
create unique index partner_commission_entries_refund_idx
  on partner_commission_entries (source_refund_id) where kind = 'clawback';
create index partner_commission_entries_partner_idx
  on partner_commission_entries (partner_id, created_at desc);
create index partner_commission_entries_open_idx
  on partner_commission_entries (partner_id, status) where payout_id is null;

-- Money paid to a reseller, by any method, always with a record (decision 52). Immutable:
-- mistakes are reversed, then paid again. Cash needs a second approver (decision 56).
create table partner_payouts (
  id                 uuid primary key default uuidv7(),
  -- AF-PPO-2026-000001.
  code               text not null unique,
  partner_id         uuid not null references partners (id),
  total_minor        bigint not null check (total_minor > 0),
  currency           char(3) not null,
  method             text not null check (method in ('momo', 'bank', 'cash', 'cheque', 'other')),
  reference          text check (length(reference) <= 120),
  -- MoMo network and number, bank and account (masked), witness …
  details            jsonb not null default '{}'::jsonb,
  proof_file_ids     uuid[] not null default '{}',
  notes              text check (length(notes) <= 1000),
  status             text not null check (status in ('awaiting_approval', 'paid', 'reversed')),
  paid_at            timestamptz not null,
  recorded_by        uuid not null references platform_users (id),
  recorded_at        timestamptz not null default now(),
  approved_by        uuid references platform_users (id),
  approved_at        timestamptz,
  acknowledged_by    uuid references platform_users (id),
  acknowledged_at    timestamptz,
  reversed_by        uuid references platform_users (id),
  reversed_at        timestamptz,
  reversal_reason    text check (length(reversal_reason) <= 1000),
  check (approved_by is null or approved_by <> recorded_by),
  check ((status = 'reversed') = (reversed_at is not null))
);

create index partner_payouts_partner_idx on partner_payouts (partner_id, recorded_at desc);
create index partner_payouts_unacknowledged_idx on partner_payouts (method, recorded_at)
  where acknowledged_at is null and status = 'paid';

-- The commission entries a payout settles.
create table partner_payout_items (
  payout_id     uuid not null references partner_payouts (id),
  entry_id      uuid not null references partner_commission_entries (id),
  amount_minor  bigint not null,
  primary key (payout_id, entry_id)
);

alter table partner_commission_entries
  add constraint partner_commission_entries_payout_fk
    foreign key (payout_id) references partner_payouts (id);
