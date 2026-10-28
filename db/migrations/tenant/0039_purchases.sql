-- Vehicle purchases (P7-3, docs/11 §3–6): a purchase from a seller with one line per vehicle,
-- cost components in any currency to any supplier raised as expenses capitalised to 1500
-- Vehicles, an import timeline, documents, and receiving a line creating its vehicle at its
-- landed cost.

insert into expense_categories (code, name, is_system, sort, ledger_account_id)
select 'vehicle_purchase', 'Vehicle purchases', true, 97, id from ledger_accounts where code = '1500'
on conflict (code) do nothing;

create table purchases (
  id                uuid primary key default uuidv7(),
  number            text not null unique,
  type              text not null check (type in ('local', 'import', 'auction')),
  status            text not null default 'draft'
                      check (status in ('draft', 'ordered', 'received', 'cancelled')),
  stage             text check (stage in ('ordered', 'paid', 'picked_up', 'at_origin_port',
                      'shipped', 'arrived_port', 'under_clearing', 'duty_paid', 'released',
                      'in_transit_local')),
  supplier_id       uuid not null references suppliers (id),
  branch_id         uuid not null references branches (id),
  currency          char(3) not null,
  reference         text check (length(reference) <= 100),
  expected_on       date,
  notes             text check (length(notes) <= 2000),
  vessel            text check (length(vessel) <= 100),
  bill_of_lading    text check (length(bill_of_lading) <= 60),
  container_number  text check (length(container_number) <= 30),
  eta               date,
  port_free_days    integer check (port_free_days between 0 and 90),
  ordered_on        date,
  ordered_by        uuid references users (id),
  arrived_on        date,
  released_on       date,
  received_on       date,
  cancelled_at      timestamptz,
  cancelled_by      uuid references users (id),
  cancel_reason     text,
  created_by        uuid references users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((status = 'draft') = (ordered_on is null)),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((status = 'received') = (received_on is not null)),
  check (type = 'import' or stage is null)
);

create index purchases_listing_idx on purchases (created_at desc, id desc);
create index purchases_open_idx on purchases (branch_id, status) where status in ('draft', 'ordered');
create index purchases_supplier_idx on purchases (supplier_id);

create table purchase_lines (
  id           uuid primary key default uuidv7(),
  purchase_id  uuid not null references purchases (id) on delete cascade,
  position     integer not null check (position > 0),
  vin          text check (vin is null or vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  make         text not null check (length(make) between 1 and 80),
  model        text not null check (length(model) between 1 and 80),
  year         smallint check (year between 1950 and 2100),
  colour       text check (length(colour) <= 40),
  description  text check (length(description) <= 300),
  price_minor  bigint not null check (price_minor >= 0),
  vehicle_id   uuid unique references vehicles (id),
  received_at  timestamptz,
  received_by  uuid references users (id),
  unique (purchase_id, position) deferrable initially deferred,
  check ((vehicle_id is null) = (received_at is null))
);

create index purchase_lines_purchase_idx on purchase_lines (purchase_id);

-- Each cost is an expense to its payee in its currency; what counts is what the expense posted.
create table purchase_costs (
  id           uuid primary key default uuidv7(),
  purchase_id  uuid not null references purchases (id),
  line_id      uuid references purchase_lines (id),
  kind         text not null check (kind in ('vehicle_price', 'auction_fee', 'origin_transport',
                 'shipping', 'marine_insurance', 'port_charges', 'import_duty', 'vat_levies',
                 'clearing', 'registration', 'number_plates', 'local_transport', 'repairs',
                 'other')),
  allocation   text not null default 'value' check (allocation in ('value', 'equal')),
  description  text not null check (length(description) between 1 and 300),
  supplier_id  uuid not null references suppliers (id),
  expense_id   uuid not null unique references expenses (id),
  created_by   uuid references users (id),
  created_at   timestamptz not null default now(),
  check (kind <> 'vehicle_price' or line_id is not null)
);

create index purchase_costs_purchase_idx on purchase_costs (purchase_id);

create table purchase_events (
  id           uuid primary key default uuidv7(),
  purchase_id  uuid not null references purchases (id),
  kind         text not null check (kind in ('created', 'ordered', 'stage', 'note', 'received',
                 'cancelled')),
  stage        text,
  occurred_on  date not null,
  note         text check (length(note) <= 1000),
  details      jsonb not null default '{}'::jsonb,
  recorded_by  uuid references users (id),
  recorded_at  timestamptz not null default now()
);

create index purchase_events_purchase_idx on purchase_events (purchase_id, recorded_at);
