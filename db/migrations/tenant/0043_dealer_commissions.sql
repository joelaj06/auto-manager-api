-- Dealer commissions and the cost of sales (P7-7, docs/10 §1, §8, docs/13): the sold vehicle's
-- cost moved out of the books at the sale, monthly depreciation posted to the ledger, and the
-- sales staff's commission plans, accruals at delivery, payouts and clawbacks.

insert into ledger_accounts (code, name, type, system_key) values
  ('5100', 'Cost of vehicles sold', 'expense', 'vehicle_cogs'),
  ('5200', 'Sales commissions', 'expense', 'sales_commissions'),
  ('2400', 'Commissions payable', 'liability', 'commissions_payable')
on conflict (code) do nothing;

-- What the sold vehicle cost the books (net of depreciation), and who shares the commission.
alter table dealer_deals
  add column cost_of_sale_minor bigint check (cost_of_sale_minor >= 0),
  add column commission_split jsonb not null default '[]';

-- Depreciation posted to the ledger: the monthly run (period = the month ended) and the catch-up
-- when a vehicle is sold (period = the month of the sale).
create table vehicle_depreciation (
  id           uuid primary key default uuidv7(),
  vehicle_id   uuid not null references vehicles (id),
  period       text not null check (period ~ '^\d{4}-\d{2}$'),
  amount_minor bigint not null check (amount_minor > 0),
  journal_id   uuid not null references journal_entries (id),
  posted_at    timestamptz not null default now()
);
create index vehicle_depreciation_vehicle on vehicle_depreciation (vehicle_id);

create table dealer_commission_plans (
  id          uuid primary key default uuidv7(),
  name        text not null check (length(name) between 1 and 120),
  -- Null: the plan for everyone without one of their own.
  user_id     uuid references users (id),
  basis       text not null check (basis in ('gross_profit_percent', 'price_percent', 'flat')),
  -- [{fromUnits, percent | amountMinor}] by units delivered in the month.
  tiers       jsonb not null,
  active      boolean not null default true,
  created_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index dealer_commission_plans_user on dealer_commission_plans
  (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)) where active;

create table dealer_commission_payouts (
  id           uuid primary key default uuidv7(),
  number       text not null unique,
  user_id      uuid not null references users (id),
  branch_id    uuid not null references branches (id),
  period       text not null check (period ~ '^\d{4}-\d{2}$'),
  amount_minor bigint not null check (amount_minor > 0),
  method       text not null check (method in ('cash', 'momo', 'bank_transfer')),
  paid_on      date not null,
  reference    text check (length(reference) <= 120),
  journal_id   uuid not null references journal_entries (id),
  paid_by      uuid references users (id),
  created_at   timestamptz not null default now()
);

create table dealer_commissions (
  id               uuid primary key default uuidv7(),
  deal_id          uuid not null references dealer_deals (id),
  user_id          uuid not null references users (id),
  branch_id        uuid not null references branches (id),
  -- The month of the delivery (or of the clawback), YYYY-MM.
  period           text not null check (period ~ '^\d{4}-\d{2}$'),
  kind             text not null default 'earned' check (kind in ('earned', 'clawback')),
  plan_id          uuid references dealer_commission_plans (id),
  basis            text not null check (basis in ('gross_profit_percent', 'price_percent', 'flat')),
  rate             text not null,
  base_minor       bigint not null,
  share_percent    smallint not null check (share_percent between 1 and 100),
  -- Negative for a clawback of a commission already paid.
  amount_minor     bigint not null,
  status           text not null check (status in ('accrued', 'payable', 'paid', 'clawed_back')),
  accrued_on       date not null,
  payable_on       date,
  payout_id        uuid references dealer_commission_payouts (id),
  claws_back_id    uuid references dealer_commissions (id),
  clawed_back_at   timestamptz,
  clawback_reason  text check (length(clawback_reason) <= 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check ((kind = 'earned') = (amount_minor >= 0)),
  check ((kind = 'clawback') = (claws_back_id is not null)),
  check ((status = 'paid') = (payout_id is not null)),
  check ((status = 'clawed_back') = (clawed_back_at is not null))
);
create unique index dealer_commissions_earned on dealer_commissions (deal_id, user_id)
  where kind = 'earned';
create index dealer_commissions_user_period on dealer_commissions (user_id, period);
create index dealer_commissions_accrued on dealer_commissions (deal_id) where status = 'accrued';
