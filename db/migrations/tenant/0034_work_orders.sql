-- Work orders (docs/12 §3, §5; P6-2): a job on a vehicle in the business's own workshop or at a
-- vendor, its labour, parts and sublet lines, the vehicle off the road while it lasts (a
-- maintenance block, downtime), and who pays when it is completed.

create table work_orders (
  id                 uuid primary key default uuidv7(),
  number             text not null unique,
  vehicle_id         uuid not null references vehicles (id),
  -- The vehicle's branch when opened (scope).
  branch_id          uuid not null references branches (id),
  type               text not null check (type in ('preventive', 'corrective', 'accident',
                       'reconditioning', 'inspection')),
  priority           text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status             text not null default 'open' check (status in ('open', 'in_progress',
                       'awaiting_parts', 'completed', 'cancelled')),
  title              text not null check (length(title) between 3 and 160),
  description        text check (description is null or length(description) <= 4000),
  -- What it came from: a reported issue, a damage on the damage map.
  issue_id           uuid references vehicle_issues (id),
  damage_id          uuid references vehicle_damages (id),
  -- Service plan tasks it carries out (closed as services done on completion).
  service_task_ids   uuid[] not null default '{}',
  -- An outside workshop (supplier), or the business's own mechanic.
  vendor_id          uuid references suppliers (id),
  assigned_to        uuid references users (id),
  warranty           boolean not null default false,
  -- Off the road: the maintenance block, the status it left, the Work & Pay downtime started.
  off_road           boolean not null default false,
  block_id           uuid references vehicle_blocks (id),
  status_before      text,
  workpay_agreement_id uuid references workpay_agreements (id),
  expected_back_at   timestamptz,
  downtime_started_at timestamptz,
  downtime_ended_at  timestamptz,
  odometer_in        integer check (odometer_in >= 0),
  odometer_out       integer check (odometer_out >= 0),
  currency           text not null,
  -- The vendor's invoice or job card, and how the vendor did (1–5).
  vendor_invoice_ref text check (vendor_invoice_ref is null or length(vendor_invoice_ref) <= 80),
  vendor_rating      smallint check (vendor_rating between 1 and 5),
  -- Expenses posted on completion: the business's share, and the driver's.
  expense_id         uuid references expenses (id),
  driver_expense_id  uuid references expenses (id),
  notes              text check (notes is null or length(notes) <= 4000),
  started_at         timestamptz,
  completed_at       timestamptz,
  completed_by       uuid references users (id),
  cancelled_at       timestamptz,
  cancelled_by       uuid references users (id),
  cancel_reason      text,
  created_by         uuid references users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((status = 'completed') = (completed_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((downtime_started_at is null) <= (downtime_ended_at is null))
);

create index work_orders_vehicle_idx on work_orders (vehicle_id, created_at desc);
create index work_orders_branch_status_idx on work_orders (branch_id, status);
create index work_orders_vendor_idx on work_orders (vendor_id) where vendor_id is not null;
-- One off-road work order at a time per vehicle.
create unique index work_orders_off_road_idx on work_orders (vehicle_id)
  where off_road and status not in ('completed', 'cancelled');

create table work_order_lines (
  id                uuid primary key default uuidv7(),
  work_order_id     uuid not null references work_orders (id) on delete cascade,
  position          smallint not null,
  kind              text not null check (kind in ('labour', 'part', 'sublet', 'other')),
  description       text not null check (length(description) between 1 and 300),
  -- Hours for labour, units for parts.
  quantity          numeric(10, 2) not null check (quantity > 0),
  unit_cost_minor   bigint not null check (unit_cost_minor >= 0),
  amount_minor      bigint not null check (amount_minor >= 0),
  -- The part's number (the parts catalogue arrives in P6-3).
  part_ref          text check (part_ref is null or length(part_ref) <= 80),
  unique (work_order_id, position)
);

-- Who pays besides the business (it pays the rest): the driver, the renter, an insurer.
create table work_order_allocations (
  id              uuid primary key default uuidv7(),
  work_order_id   uuid not null references work_orders (id) on delete cascade,
  payer           text not null check (payer in ('company', 'driver', 'customer', 'insurer')),
  amount_minor    bigint not null check (amount_minor >= 0),
  driver_id       uuid references drivers (id),
  customer_id     uuid references customers (id),
  insurer_id      uuid references suppliers (id),
  claim_ref       text check (claim_ref is null or length(claim_ref) <= 80),
  unique (work_order_id, payer),
  check ((payer = 'driver') = (driver_id is not null))
);
