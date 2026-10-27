-- Rental money and risk (P5-5, docs/07 §5, §8): bookings invoiced through finance, payments and
-- the security deposit recorded through finance, corporate accounts with authorised drivers and
-- credit limits, and the blacklist checked at booking and check-out.

-- The security deposit a vehicle of the class needs before check-out; null: none.
alter table vehicle_classes
  add column deposit_minor bigint check (deposit_minor is null or deposit_minor > 0);

-- Who drives: the customer (null), or for a company one of its authorised drivers.
alter table rental_bookings add column driver_id uuid references customers (id);

-- Individuals a corporate customer authorises to drive its rentals.
create table customer_authorised_drivers (
  corporate_id uuid not null references customers (id),
  driver_id    uuid not null references customers (id),
  added_by     uuid references users (id),
  added_at     timestamptz not null default now(),
  primary key (corporate_id, driver_id),
  check (corporate_id <> driver_id)
);

create index customer_authorised_drivers_driver_idx on customer_authorised_drivers (driver_id);

-- Each charge is invoiced once; what is not yet invoiced goes on the next invoice.
alter table rental_booking_charges add column invoice_id uuid references invoices (id);
create index rental_booking_charges_uninvoiced_idx on rental_booking_charges (booking_id)
  where invoice_id is null;

-- The security deposit (held, not revenue): a payment kept as the customer's credit, applied to
-- the booking's invoices or refunded.
create table rental_deposits (
  id                uuid primary key default uuidv7(),
  booking_id        uuid not null unique references rental_bookings (id),
  payment_id        uuid not null unique references payments (id),
  currency          char(3) not null,
  amount_minor      bigint not null check (amount_minor > 0),
  applied_minor     bigint not null default 0 check (applied_minor >= 0),
  refunded_minor    bigint not null default 0 check (refunded_minor >= 0),
  refund_payment_id uuid references payments (id),
  status            text not null check (status in ('held', 'partially_applied', 'applied',
                      'released', 'reversed')),
  held_by           uuid references users (id),
  held_at           timestamptz not null,
  released_at       timestamptz,
  updated_at        timestamptz not null,
  check (applied_minor + refunded_minor <= amount_minor),
  check ((status = 'released') = (released_at is not null))
);

alter table rental_booking_events drop constraint rental_booking_events_type_check;
alter table rental_booking_events add constraint rental_booking_events_type_check
  check (type in ('reserved', 'confirmed', 'changed', 'vehicle_changed', 'checked_out',
    'extended', 'returned', 'closed', 'cancelled', 'no_show', 'damage_charged', 'driver_named',
    'invoiced', 'payment_recorded', 'deposit_held', 'deposit_applied', 'deposit_released'));
