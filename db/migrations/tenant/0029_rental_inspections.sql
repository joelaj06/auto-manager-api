-- Inspections and damages (P5-4, docs/07 §6): what the vehicle looked like when the keys went out
-- and came back (odometer, fuel, checklist, photos by side), the damages found (a register per
-- vehicle: the damage map), and the charges a return adds (refuelling, cleaning, damage).

-- Refuelling a vehicle of the class costs this much per quarter tank missing at check-in.
alter table vehicle_classes
  add column refuel_quarter_minor bigint check (refuel_quarter_minor is null or refuel_quarter_minor > 0);

create table rental_inspections (
  id           uuid primary key default uuidv7(),
  booking_id   uuid not null references rental_bookings (id),
  stage        text not null check (stage in ('check_out', 'check_in')),
  vehicle_id   uuid not null references vehicles (id),
  odometer     integer not null check (odometer >= 0),
  fuel         text not null check (fuel in ('empty', 'quarter', 'half', 'three_quarters', 'full')),
  -- [{ key, label, ok, note }] of the business's inspection items at the time.
  checklist    jsonb not null default '[]'::jsonb,
  -- The renter's ID and licence were seen (check-out).
  id_checked   boolean not null default false,
  notes        text check (notes is null or length(notes) <= 2000),
  inspected_by uuid references users (id),
  inspected_at timestamptz not null,
  unique (booking_id, stage),
  check (stage = 'check_in' or id_checked)
);

-- Photos of an inspection by side; each file is used once.
create table rental_inspection_photos (
  inspection_id uuid not null references rental_inspections (id),
  file_id       uuid not null unique references files (id),
  view          text not null check (view in ('front', 'back', 'left', 'right', 'interior', 'other')),
  primary key (inspection_id, file_id)
);

-- The damage register of the fleet (the damage map). A damage found at a rental inspection keeps
-- the booking; the renter is charged only when it is theirs (`liability = 'customer'`).
create table vehicle_damages (
  id             uuid primary key default uuidv7(),
  vehicle_id     uuid not null references vehicles (id),
  branch_id      uuid not null references branches (id),
  booking_id     uuid references rental_bookings (id),
  inspection_id  uuid references rental_inspections (id),
  area           text not null check (area in ('front', 'back', 'left', 'right', 'roof',
                   'interior', 'windscreen', 'wheels', 'underbody', 'other')),
  severity       text not null check (severity in ('minor', 'moderate', 'major')),
  description    text not null check (length(description) between 3 and 1000),
  status         text not null default 'open' check (status in ('open', 'repaired')),
  liability      text not null default 'undecided'
                   check (liability in ('undecided', 'customer', 'insurance', 'business')),
  currency       text not null check (currency ~ '^[A-Z]{3}$'),
  -- The repair estimate, then the final cost (from the work order or the garage's invoice).
  estimate_minor bigint check (estimate_minor is null or estimate_minor >= 0),
  final_minor    bigint check (final_minor is null or final_minor >= 0),
  -- The work order (P6-2) or the garage's job reference; the insurer's claim number.
  work_order_ref text check (work_order_ref is null or length(work_order_ref) between 1 and 60),
  claim_ref      text check (claim_ref is null or length(claim_ref) between 1 and 60),
  notes          text check (notes is null or length(notes) <= 2000),
  repaired_at    timestamptz,
  repaired_by    uuid references users (id),
  created_by     uuid references users (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((status = 'repaired') = (repaired_at is not null)),
  check (liability <> 'customer' or booking_id is not null),
  check (inspection_id is null or booking_id is not null)
);

create index vehicle_damages_vehicle_idx on vehicle_damages (vehicle_id, status, id desc);
create index vehicle_damages_booking_idx on vehicle_damages (booking_id) where booking_id is not null;

create table vehicle_damage_photos (
  damage_id uuid not null references vehicle_damages (id),
  file_id   uuid not null references files (id),
  primary key (damage_id, file_id)
);

-- Return charges and damage charges; a damage's charges add up to what the renter owes for it.
alter table rental_booking_charges add column damage_id uuid references vehicle_damages (id);
alter table rental_booking_charges drop constraint rental_booking_charges_kind_check;
alter table rental_booking_charges add constraint rental_booking_charges_kind_check
  check (kind in ('rental', 'change', 'extension', 'late_return', 'mileage', 'cancellation',
    'cancellation_fee', 'no_show_fee', 'fuel_refill', 'cleaning', 'damage'));
alter table rental_booking_charges add constraint rental_booking_charges_damage_check
  check ((kind = 'damage') = (damage_id is not null));
create index rental_booking_charges_damage_idx on rental_booking_charges (damage_id)
  where damage_id is not null;

alter table rental_booking_events drop constraint rental_booking_events_type_check;
alter table rental_booking_events add constraint rental_booking_events_type_check
  check (type in ('reserved', 'confirmed', 'changed', 'vehicle_changed', 'checked_out',
    'extended', 'returned', 'closed', 'cancelled', 'no_show', 'damage_charged'));
