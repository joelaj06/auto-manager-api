-- Driver app (P2-10, docs/09 §4): a driver's own login (a user holding the Driver role, linked
-- here) and the issues drivers or staff report about a vehicle.

alter table drivers add column user_id uuid unique references users (id);

create table vehicle_issues (
  id               uuid primary key default uuidv7(),
  number           text not null unique,
  vehicle_id       uuid not null references vehicles (id),
  branch_id        uuid not null references branches (id),
  -- The driver who reported it (driver app) or was driving.
  driver_id        uuid references drivers (id),
  reported_by      uuid references users (id),
  type             text not null check (type in ('breakdown', 'accident', 'damage', 'tyre',
                     'warning_light', 'police', 'theft', 'other')),
  severity         text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  -- Whether the vehicle can keep working.
  can_drive        boolean not null default true,
  description      text not null check (length(description) between 3 and 2000),
  odometer         integer check (odometer >= 0),
  location         text check (location is null or length(location) <= 300),
  occurred_at      timestamptz not null,
  status           text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  acknowledged_by  uuid references users (id),
  acknowledged_at  timestamptz,
  resolution       text,
  resolved_by      uuid references users (id),
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check ((status = 'resolved') = (resolved_at is not null)),
  check (status = 'open' or acknowledged_at is not null)
);

create index vehicle_issues_branch_idx on vehicle_issues (branch_id, status, id desc);
create index vehicle_issues_vehicle_idx on vehicle_issues (vehicle_id, id desc);
create index vehicle_issues_driver_idx on vehicle_issues (driver_id, id desc) where driver_id is not null;

-- Messages carrying a one-time link (driver app invitations): the text is hidden in the delivery
-- log and erased once sent.
alter table notification_deliveries add column sensitive boolean not null default false;
