-- Dealer CRM (P7-5, docs/10 §4–6): leads with their pipeline stage, activity log, follow-up tasks,
-- saved-search matches and round-robin assignment; test drives blocking the vehicle; quotes with
-- add-ons, a trade-in, a financing option and a validity date, issued as a PDF.

create table dealer_leads (
  id                 uuid primary key default uuidv7(),
  number             text not null unique,
  branch_id          uuid not null references branches (id),
  source             text not null check (source in ('walk_in', 'phone', 'whatsapp', 'website',
                       'social', 'referral', 'other')),
  stage              text not null default 'new' check (stage in ('new', 'contacted',
                       'appointment', 'test_drive', 'negotiation', 'won', 'lost')),
  lost_reason        text check (length(lost_reason) <= 500),
  customer_id        uuid references customers (id),
  name               text not null check (length(name) between 1 and 160),
  phone              text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  email              citext,
  -- What they are after: a stock vehicle, or a saved search (make, model, years, budget).
  vehicle_id         uuid references vehicles (id),
  make               text check (length(make) <= 80),
  model              text check (length(model) <= 80),
  year_from          smallint check (year_from between 1950 and 2100),
  year_to            smallint check (year_to between 1950 and 2100),
  budget_max_minor   bigint check (budget_max_minor >= 0),
  notify_matches     boolean not null default false,
  notes              text check (length(notes) <= 2000),
  assigned_to        uuid references users (id),
  assigned_at        timestamptz,
  stage_changed_at   timestamptz not null default now(),
  closed_at          timestamptz,
  created_by         uuid references users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((stage = 'lost') = (lost_reason is not null)),
  check ((stage in ('won', 'lost')) = (closed_at is not null)),
  check ((assigned_to is null) = (assigned_at is null)),
  check (year_from is null or year_to is null or year_from <= year_to),
  check (not notify_matches or make is not null)
);

create index dealer_leads_listing_idx on dealer_leads (created_at desc, id desc);
create index dealer_leads_assignee_idx on dealer_leads (assigned_to, stage);
create index dealer_leads_open_idx on dealer_leads (branch_id, stage)
  where stage not in ('won', 'lost');

create table dealer_lead_activities (
  id           uuid primary key default uuidv7(),
  lead_id      uuid not null references dealer_leads (id),
  kind         text not null check (kind in ('call', 'message', 'whatsapp', 'email', 'visit',
                 'note', 'stage', 'assignment', 'test_drive', 'quote')),
  note         text check (length(note) <= 2000),
  details      jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null,
  recorded_by  uuid references users (id),
  recorded_at  timestamptz not null default now()
);

create index dealer_lead_activities_lead_idx on dealer_lead_activities (lead_id, occurred_at);

create table dealer_lead_tasks (
  id           uuid primary key default uuidv7(),
  lead_id      uuid not null references dealer_leads (id),
  title        text not null check (length(title) between 1 and 300),
  due_on       date not null,
  assigned_to  uuid references users (id),
  done_at      timestamptz,
  done_by      uuid references users (id),
  created_by   uuid references users (id),
  created_at   timestamptz not null default now(),
  check ((done_at is null) = (done_by is null))
);

create index dealer_lead_tasks_open_idx on dealer_lead_tasks (due_on) where done_at is null;
create index dealer_lead_tasks_lead_idx on dealer_lead_tasks (lead_id);

-- A listed stock vehicle that fits a lead's saved search, told once.
create table dealer_lead_matches (
  lead_id      uuid not null references dealer_leads (id),
  vehicle_id   uuid not null references vehicles (id),
  matched_at   timestamptz not null default now(),
  primary key (lead_id, vehicle_id)
);

-- Who takes new leads in turn in a branch.
create table dealer_lead_pool (
  branch_id  uuid not null references branches (id),
  user_id    uuid not null references users (id),
  position   smallint not null check (position > 0),
  primary key (branch_id, user_id)
);

alter table vehicle_blocks drop constraint vehicle_blocks_reason_check;
alter table vehicle_blocks add constraint vehicle_blocks_reason_check
  check (reason in ('rental', 'maintenance', 'transfer', 'sale_hold', 'test_drive', 'other'));

create table dealer_test_drives (
  id                   uuid primary key default uuidv7(),
  branch_id            uuid not null references branches (id),
  vehicle_id           uuid not null references vehicles (id),
  lead_id              uuid references dealer_leads (id),
  status               text not null default 'booked' check (status in ('booked', 'out',
                         'returned', 'cancelled', 'no_show')),
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  driver_name          text not null check (length(driver_name) between 1 and 160),
  driver_phone         text not null check (driver_phone ~ '^\+[1-9][0-9]{7,14}$'),
  licence_number       text not null check (length(licence_number) between 3 and 40),
  licence_expires_on   date not null,
  accompanied_by       uuid not null references users (id),
  block_id             uuid not null unique references vehicle_blocks (id),
  odometer_out         integer check (odometer_out >= 0),
  odometer_in          integer check (odometer_in >= 0),
  went_out_at          timestamptz,
  came_back_at         timestamptz,
  waiver_document_id   uuid references documents (id),
  feedback             text check (length(feedback) <= 2000),
  cancel_reason        text check (length(cancel_reason) <= 500),
  notes                text check (length(notes) <= 2000),
  created_by           uuid references users (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (ends_at > starts_at),
  check ((status in ('out', 'returned')) = (went_out_at is not null)),
  check ((status = 'returned') = (came_back_at is not null)),
  check (odometer_in is null or odometer_in >= odometer_out)
);

create index dealer_test_drives_listing_idx on dealer_test_drives (starts_at desc, id desc);
create index dealer_test_drives_lead_idx on dealer_test_drives (lead_id) where lead_id is not null;

create table dealer_quotes (
  id                 uuid primary key default uuidv7(),
  number             text not null unique,
  branch_id          uuid not null references branches (id),
  lead_id            uuid references dealer_leads (id),
  customer_id        uuid references customers (id),
  customer_name      text not null check (length(customer_name) between 1 and 160),
  vehicle_id         uuid not null references vehicles (id),
  status             text not null default 'draft' check (status in ('draft', 'sent',
                       'accepted', 'rejected', 'expired', 'withdrawn')),
  price_minor        bigint not null check (price_minor >= 0),
  discount_minor     bigint not null default 0 check (discount_minor >= 0),
  trade_in_description text check (length(trade_in_description) <= 300),
  trade_in_minor     bigint not null default 0 check (trade_in_minor >= 0),
  financing          text not null default 'cash' check (financing in ('cash', 'bank',
                       'in_house')),
  deposit_minor      bigint check (deposit_minor >= 0),
  term_months        smallint check (term_months between 1 and 120),
  financing_note     text check (length(financing_note) <= 500),
  valid_until        date not null,
  notes              text check (length(notes) <= 2000),
  -- Below the minimum price: approved before it is sent.
  below_minimum      boolean not null default false,
  approved_by        uuid references users (id),
  approved_at        timestamptz,
  document_id        uuid references documents (id),
  sent_at            timestamptz,
  decided_at         timestamptz,
  decision_note      text check (length(decision_note) <= 500),
  created_by         uuid references users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (discount_minor <= price_minor),
  check ((approved_by is null) = (approved_at is null)),
  check ((status = 'draft') = (sent_at is null)),
  check ((trade_in_minor = 0) or trade_in_description is not null)
);

create index dealer_quotes_listing_idx on dealer_quotes (created_at desc, id desc);
create index dealer_quotes_lead_idx on dealer_quotes (lead_id) where lead_id is not null;
create index dealer_quotes_sent_idx on dealer_quotes (valid_until) where status = 'sent';

create table dealer_quote_items (
  id           uuid primary key default uuidv7(),
  quote_id     uuid not null references dealer_quotes (id) on delete cascade,
  position     smallint not null check (position > 0),
  kind         text not null check (kind in ('registration', 'tint', 'tracker', 'warranty',
                 'insurance', 'service_plan', 'other')),
  description  text not null check (length(description) between 1 and 300),
  amount_minor bigint not null check (amount_minor >= 0),
  unique (quote_id, position)
);
