-- Rental bookings (P5-3, docs/07 §2, §6, §7): reserved → confirmed → checked out → returned →
-- closed, or cancelled / no-show. A booking holds its vehicle through one vehicle block (P5-2),
-- keeps the terms it was priced with, and records what it costs as charge lines (the rental,
-- extensions, late return, mileage, cancellation and no-show fees) that invoicing (P5-5) bills.
-- Every step is an event. Nothing is deleted.

create table rental_bookings (
  id              uuid primary key default uuidv7(),
  number          text not null unique,
  status          text not null check (status in ('reserved', 'confirmed', 'checked_out',
                    'returned', 'closed', 'cancelled', 'no_show')),
  branch_id       uuid not null references branches (id),
  customer_id     uuid not null references customers (id),
  class_id        uuid references vehicle_classes (id),
  -- The block holding the vehicle: its vehicle is the booking's (a class booking's may move
  -- until check-out), its class_id says the booking is by class.
  block_id        uuid not null unique references vehicle_blocks (id),
  pickup_at       timestamptz not null,
  return_at       timestamptz not null,
  -- A reservation lapses then unless confirmed.
  expires_at      timestamptz,
  currency        char(3) not null,
  -- The resolved terms re-quotes use (plan, extras, zones, promo code, discount, agreed price).
  terms           jsonb not null,
  -- The latest quote (lines, discounts, tax, totals).
  quote           jsonb not null,
  confirmed_at    timestamptz,
  checked_out_at  timestamptz,
  odometer_out    integer check (odometer_out >= 0),
  fuel_out        text check (fuel_out in ('empty', 'quarter', 'half', 'three_quarters', 'full')),
  returned_at     timestamptz,
  odometer_in     integer check (odometer_in >= 0),
  fuel_in         text check (fuel_in in ('empty', 'quarter', 'half', 'three_quarters', 'full')),
  closed_at       timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text check (cancel_reason is null or length(cancel_reason) <= 300),
  notes           text check (notes is null or length(notes) <= 2000),
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (return_at > pickup_at),
  check ((status = 'reserved') = (expires_at is not null)),
  check ((checked_out_at is null) = (odometer_out is null)),
  check ((returned_at is null) = (odometer_in is null)),
  check (odometer_in is null or odometer_in >= odometer_out),
  check (returned_at is null or returned_at > checked_out_at),
  check (status not in ('checked_out', 'returned', 'closed') or checked_out_at is not null),
  check (status not in ('returned', 'closed') or returned_at is not null),
  check ((status = 'closed') = (closed_at is not null)),
  check ((status in ('cancelled', 'no_show')) = (cancelled_at is not null))
);

create index rental_bookings_branch_idx on rental_bookings (branch_id, pickup_at desc);
create index rental_bookings_customer_idx on rental_bookings (customer_id, pickup_at desc);
create index rental_bookings_open_idx on rental_bookings (status, return_at)
  where status in ('reserved', 'confirmed', 'checked_out');

create table rental_booking_events (
  id         uuid primary key default uuidv7(),
  booking_id uuid not null references rental_bookings (id),
  type       text not null check (type in ('reserved', 'confirmed', 'changed', 'vehicle_changed',
               'checked_out', 'extended', 'returned', 'closed', 'cancelled', 'no_show')),
  at         timestamptz not null default now(),
  actor_id   uuid references users (id),
  -- What changed: times, vehicle, odometer, the charge added …
  data       jsonb not null default '{}'::jsonb
);

create index rental_booking_events_booking_idx on rental_booking_events (booking_id, at);

-- What the booking costs; the balance is their sum less what is paid (P5-5).
create table rental_booking_charges (
  id          uuid primary key default uuidv7(),
  booking_id  uuid not null references rental_bookings (id),
  event_id    uuid not null references rental_booking_events (id),
  -- `cancellation` credits back what a cancelled booking was charged; the fee is charged apart.
  kind        text not null check (kind in ('rental', 'change', 'extension', 'late_return',
                'mileage', 'cancellation', 'cancellation_fee', 'no_show_fee')),
  description text not null check (length(description) between 1 and 300),
  -- Minor units of the booking's currency; negative credits a smaller charge.
  net_minor   bigint not null,
  tax_minor   bigint not null,
  total_minor bigint not null check (total_minor = net_minor + tax_minor),
  created_by  uuid references users (id),
  created_at  timestamptz not null default now()
);

create index rental_booking_charges_booking_idx on rental_booking_charges (booking_id, created_at);
