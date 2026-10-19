-- Expenses (P2-6, docs/12 part B): expenses with split across vehicles, approval rules, receipts,
-- payment through finance, recurring expenses, monthly budgets and fuel logs. Amounts are in
-- minor units of the base currency.

-- Where a category's expenses are posted (null: vehicle or other expenses by the expense).
alter table expense_categories add column ledger_account_id uuid references ledger_accounts (id);

-- What a payment settles (an expense …), for reversals that must reopen it.
alter table payments
  add column source_type text,
  add column source_id   uuid,
  add constraint payments_source_check check ((source_type is null) = (source_id is null));

create index payments_source_idx on payments (source_type, source_id) where source_id is not null;

create table expense_approval_rules (
  id                uuid primary key default uuidv7(),
  name              text not null check (length(name) between 1 and 120),
  -- Lower first; the first matching rule decides.
  priority          integer not null default 100,
  -- A category also matches its subcategories; null: any.
  category_id       uuid references expense_categories (id),
  branch_id         uuid references branches (id),
  min_amount_minor  bigint not null default 0 check (min_amount_minor >= 0),
  max_amount_minor  bigint check (max_amount_minor is null or max_amount_minor >= min_amount_minor),
  action            text not null check (action in ('auto_approve', 'require_approval')),
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table expenses (
  id                uuid primary key default uuidv7(),
  -- Given when submitted (drafts have none).
  number            text unique,
  status            text not null check (status in ('draft', 'submitted', 'approved', 'rejected',
                      'paid', 'void')),
  category_id       uuid not null references expense_categories (id),
  description       text not null check (length(description) between 1 and 300),
  branch_id         uuid not null references branches (id),
  expense_date      date not null,
  -- Who is owed: a supplier, a driver who paid out of pocket, or a name.
  payee_type        text check (payee_type in ('supplier', 'driver')),
  payee_id          uuid,
  payee_name        text,
  -- The driver concerned; with charge_to_driver the cost is the driver's, not the business's.
  driver_id         uuid references drivers (id),
  charge_to_driver  boolean not null default false,
  amount_minor      bigint not null check (amount_minor > 0),
  tax_code          text,
  tax_components    jsonb not null default '[]'::jsonb,
  net_minor         bigint not null,
  tax_minor         bigint not null default 0,
  -- The supplier's invoice or receipt number.
  reference         text,
  notes             text,
  -- What created it: a fuel log, a recurring expense …
  source_type       text,
  source_id         uuid,
  submitted_by      uuid references users (id),
  submitted_at      timestamptz,
  approval_rule_id  uuid references expense_approval_rules (id),
  approved_by       uuid references users (id),
  approved_at       timestamptz,
  rejected_by       uuid references users (id),
  rejected_at       timestamptz,
  rejection_reason  text,
  payment_id        uuid references payments (id),
  paid_at           timestamptz,
  void_reason       text,
  voided_by         uuid references users (id),
  voided_at         timestamptz,
  created_by        uuid references users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((payee_type is null) = (payee_id is null)),
  check (payee_id is not null or payee_name is not null or status = 'draft'),
  check (not charge_to_driver or driver_id is not null),
  check ((source_type is null) = (source_id is null)),
  check (net_minor + tax_minor = amount_minor),
  check ((status = 'draft') <= (number is null)),
  check ((status = 'paid') = (payment_id is not null))
);

create index expenses_listing_idx on expenses (created_at desc, id desc);
create index expenses_branch_status_idx on expenses (branch_id, status);
create index expenses_date_idx on expenses (expense_date, category_id) where status in ('approved', 'paid');
create index expenses_source_idx on expenses (source_type, source_id) where source_id is not null;

-- How an expense is split across vehicles (one line without a vehicle: not split).
create table expense_lines (
  id           uuid primary key default uuidv7(),
  expense_id   uuid not null references expenses (id) on delete cascade,
  position     smallint not null,
  vehicle_id   uuid references vehicles (id),
  amount_minor bigint not null check (amount_minor >= 0),
  net_minor    bigint not null,
  tax_minor    bigint not null,
  unique (expense_id, position)
);

create index expense_lines_vehicle_idx on expense_lines (vehicle_id) where vehicle_id is not null;

create table recurring_expenses (
  id                uuid primary key default uuidv7(),
  name              text not null check (length(name) between 1 and 120),
  category_id       uuid not null references expense_categories (id),
  branch_id         uuid not null references branches (id),
  description       text not null,
  payee_type        text check (payee_type in ('supplier', 'driver')),
  payee_id          uuid,
  payee_name        text,
  amount_minor      bigint not null check (amount_minor > 0),
  tax_code          text,
  -- Split equally across these vehicles (empty: no vehicle).
  vehicle_ids       uuid[] not null default '{}',
  frequency         text not null check (frequency in ('weekly', 'monthly', 'quarterly', 'yearly')),
  next_run_on       date not null,
  end_on            date,
  -- Submit the generated expense (approval rules apply) instead of leaving a draft.
  auto_submit       boolean not null default false,
  active            boolean not null default true,
  last_run_on       date,
  created_by        uuid references users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((payee_type is null) = (payee_id is null))
);

create index recurring_expenses_due_idx on recurring_expenses (next_run_on) where active;

create table budgets (
  id                    uuid primary key default uuidv7(),
  name                  text not null check (length(name) between 1 and 120),
  -- Each null filter means "any".
  category_id           uuid references expense_categories (id),
  branch_id             uuid references branches (id),
  vehicle_id            uuid references vehicles (id),
  monthly_amount_minor  bigint not null check (monthly_amount_minor > 0),
  active                boolean not null default true,
  created_by            uuid references users (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table fuel_logs (
  id            uuid primary key default uuidv7(),
  vehicle_id    uuid not null references vehicles (id),
  driver_id     uuid references drivers (id),
  filled_at     timestamptz not null,
  litres        numeric(9, 2) not null check (litres > 0 and litres <= 2000),
  amount_minor  bigint not null check (amount_minor > 0),
  odometer      integer not null check (odometer >= 0),
  full_tank     boolean not null default true,
  station       text,
  expense_id    uuid references expenses (id),
  notes         text,
  recorded_by   uuid references users (id),
  created_at    timestamptz not null default now()
);

create index fuel_logs_vehicle_idx on fuel_logs (vehicle_id, filled_at desc);
