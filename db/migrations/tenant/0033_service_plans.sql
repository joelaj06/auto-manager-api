-- Preventive maintenance (docs/12 §2, P6-1): service plans of tasks due by km and/or days,
-- whichever comes first; the due engine keeps one row per vehicle and task, recomputed on every
-- odometer reading and nightly; services done are kept as records.

-- A plan applies to every vehicle, a make (and model), a vehicle group, a rental class or one
-- vehicle; a vehicle follows the most specific active plan (decision 377).
create table service_plans (
  id           uuid primary key default uuidv7(),
  name         text not null check (length(name) between 1 and 120),
  description  text check (description is null or length(description) <= 1000),
  applies_to   text not null
                 check (applies_to in ('all', 'make_model', 'vehicle_group', 'rental_class', 'vehicle')),
  make         text check (make is null or length(make) between 1 and 80),
  model        text check (model is null or length(model) between 1 and 80),
  group_id     uuid references vehicle_groups (id),
  class_id     uuid references vehicle_classes (id),
  vehicle_id   uuid references vehicles (id),
  -- The built-in template it was copied from (oil, brakes …), for reference.
  template     text,
  active       boolean not null default true,
  created_by   uuid references users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((applies_to = 'make_model') = (make is not null)),
  check (model is null or make is not null),
  check ((applies_to = 'vehicle_group') = (group_id is not null)),
  check ((applies_to = 'rental_class') = (class_id is not null)),
  check ((applies_to = 'vehicle') = (vehicle_id is not null))
);

create table service_plan_tasks (
  id           uuid primary key default uuidv7(),
  plan_id      uuid not null references service_plans (id),
  name         text not null check (length(name) between 1 and 120),
  every_km     integer check (every_km > 0),
  every_days   integer check (every_days > 0),
  -- Upcoming this far ahead; overdue this far past.
  notice_km    integer not null default 1000 check (notice_km >= 0),
  notice_days  integer not null default 14 check (notice_days >= 0),
  grace_km     integer not null default 500 check (grace_km >= 0),
  grace_days   integer not null default 7 check (grace_days >= 0),
  position     integer not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (every_km is not null or every_days is not null)
);

create index service_plan_tasks_plan_idx on service_plan_tasks (plan_id, position);

-- What each vehicle owes of its plan: counted from the last service of the task, or from when
-- the plan first applied to the vehicle (base).
create table service_due (
  id             uuid primary key default uuidv7(),
  vehicle_id     uuid not null references vehicles (id),
  task_id        uuid not null references service_plan_tasks (id),
  plan_id        uuid not null references service_plans (id),
  -- The vehicle's branch, kept in step (scope and alerts).
  branch_id      uuid not null references branches (id),
  base_km        integer check (base_km >= 0),
  base_on        date not null,
  due_km         integer check (due_km >= 0),
  due_on         date,
  status         text not null check (status in ('scheduled', 'upcoming', 'due', 'overdue')),
  -- The status last alerted for this due point (alerts go once per status).
  alerted        text check (alerted in ('upcoming', 'due', 'overdue')),
  computed_at    timestamptz not null default now(),
  unique (vehicle_id, task_id),
  check (due_km is not null or due_on is not null)
);

create index service_due_status_idx on service_due (status, branch_id);

create table service_records (
  id              uuid primary key default uuidv7(),
  vehicle_id      uuid not null references vehicles (id),
  task_id         uuid not null references service_plan_tasks (id),
  done_on         date not null,
  odometer        integer check (odometer >= 0),
  note            text check (note is null or length(note) <= 1000),
  -- The work order (P6-2) or the workshop's job card.
  work_order_ref  text check (work_order_ref is null or length(work_order_ref) <= 80),
  recorded_by     uuid references users (id),
  created_at      timestamptz not null default now()
);

create index service_records_vehicle_idx on service_records (vehicle_id, task_id, done_on desc);
