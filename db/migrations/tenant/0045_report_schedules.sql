-- Scheduled reports, role dashboards and the complete vehicle P&L (P8-3, docs/14 §3, §4, §7):
-- reports built on a schedule and sent to users of the business, the widget list of each role's
-- dashboard, and the vehicle stats split into income by source with finance costs apart.

-- Finance costs of vehicles bought on credit (loan interest, hire-purchase charges).
insert into ledger_accounts (code, name, type, system_key) values
  ('5300', 'Finance costs', 'expense', 'finance_costs')
on conflict (code) do nothing;

insert into expense_categories (code, name, is_system, sort, ledger_account_id)
select 'finance_charges', 'Loan interest and finance charges', true, 96, id
  from ledger_accounts where code = '5300'
on conflict (code) do nothing;

-- Work & Pay and sale income apart from other income; finance costs apart from direct costs
-- (depreciation is charged from each vehicle's schedule and no longer counted in cost_minor).
alter table daily_vehicle_stats
  add column workpay_income_minor bigint not null default 0,
  add column sales_income_minor   bigint not null default 0,
  add column finance_cost_minor   bigint not null default 0;

-- Rebuilt from the first day on the next read.
update organisation set stats_built_through = null;

create table report_schedules (
  id           uuid primary key default uuidv7(),
  name         text not null check (length(name) between 1 and 120),
  report_id    text not null check (length(report_id) between 1 and 80),
  params       jsonb not null default '{}',
  period       text check (period in ('previous_day', 'previous_week', 'previous_month',
                 'week_to_date', 'month_to_date')),
  format       text not null check (format in ('csv', 'xlsx', 'pdf')),
  frequency    text not null check (frequency in ('daily', 'weekly', 'monthly')),
  weekday      smallint check (weekday between 1 and 7),
  month_day    smallint check (month_day between 1 and 28),
  hour         smallint not null check (hour between 0 and 23),
  recipients   uuid[] not null check (cardinality(recipients) between 1 and 20),
  status       text not null default 'active' check (status in ('active', 'paused')),
  owner_id     uuid not null references users (id),
  next_run_at  timestamptz not null,
  last_run_at  timestamptz,
  last_job_id  uuid references report_jobs (id),
  last_error   text check (length(last_error) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((frequency = 'weekly') = (weekday is not null)),
  check ((frequency = 'monthly') = (month_day is not null))
);
create index report_schedules_due on report_schedules (next_run_at) where status = 'active';
create index report_schedules_owner on report_schedules (owner_id, created_at desc);

-- A scheduled run is seen and downloaded by its recipients too.
alter table report_jobs
  add column schedule_id uuid references report_schedules (id),
  add column recipients  uuid[] not null default '{}';
create index report_jobs_recipients on report_jobs using gin (recipients)
  where cardinality(recipients) > 0;

-- The widgets of a role's dashboard, when the business changed them (else the defaults in code).
create table dashboard_layouts (
  role        text primary key check (role in ('owner', 'fleet_manager', 'rental_agent',
                'sales_executive', 'accountant')),
  widgets     text[] not null check (cardinality(widgets) between 1 and 20),
  updated_by  uuid references users (id),
  updated_at  timestamptz not null default now()
);
