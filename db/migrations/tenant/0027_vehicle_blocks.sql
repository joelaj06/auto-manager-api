-- Availability (P5-2, docs/07 §3, docs/22 §4): vehicle_blocks is the single record of when a
-- vehicle is busy. Rental holds and bookings, maintenance, transfers and sale holds all block a
-- vehicle, and an exclusion constraint makes a double booking impossible, whoever writes.
-- A class booking is allocated a vehicle of the class straight away (class_id says it may still
-- be moved to another vehicle of the class until check-out).

-- Cleaning and checks after each rental; the vehicle stays blocked for these minutes.
alter table vehicle_classes
  add column turnaround_minutes smallint not null default 0
    check (turnaround_minutes between 0 and 1440);

create table vehicle_blocks (
  id              uuid primary key default uuidv7(),
  vehicle_id      uuid not null references vehicles (id),
  -- Where the vehicle is for the block (the pickup branch of a rental).
  branch_id       uuid not null references branches (id),
  -- Booked by class: the vehicle was allocated and may be swapped within the class.
  class_id        uuid references vehicle_classes (id),
  reason          text not null check (reason in ('rental', 'maintenance', 'transfer',
                    'sale_hold', 'other')),
  -- hold: soft, expires; confirmed: firm; out: the vehicle is with the customer or the workshop.
  status          text not null check (status in ('hold', 'confirmed', 'out', 'released')),
  starts_at       timestamptz not null,
  -- Null: until further notice (not for rentals).
  ends_at         timestamptz,
  -- ends_at plus the class turnaround for rentals; the vehicle is busy over [starts_at, blocked_until).
  blocked_until   timestamptz,
  expires_at      timestamptz,
  customer_id     uuid references customers (id),
  -- The record that owns the block (a booking, a work order …).
  ref_type        text check (ref_type is null or ref_type ~ '^[a-z_]{2,40}$'),
  ref_id          uuid,
  note            text check (note is null or length(note) <= 500),
  released_at     timestamptz,
  released_reason text check (released_reason is null or length(released_reason) <= 300),
  released_by     uuid references users (id),
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at),
  check ((ends_at is null) = (blocked_until is null)),
  check (blocked_until is null or blocked_until >= ends_at),
  check (reason <> 'rental' or ends_at is not null),
  check (expires_at is null or status in ('hold', 'released')),
  check ((status = 'released') = (released_at is not null)),
  check ((ref_type is null) = (ref_id is null)),
  -- docs/22 §4: no two live blocks of a vehicle overlap, turnaround included.
  constraint vehicle_blocks_no_overlap exclude using gist
    (vehicle_id with =, tstzrange(starts_at, blocked_until, '[)') with &&)
    where (status <> 'released')
);

-- The constraint's index serves the overlap queries; bookings find their blocks by reference.
create index vehicle_blocks_ref_idx on vehicle_blocks (ref_type, ref_id) where ref_id is not null;
