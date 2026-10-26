-- Rental pricing (P5-1, docs/07 §4): vehicle classes customers book, rate plans per class or per
-- vehicle (optionally per branch, or a customer's negotiated rate) with their seasons, extras,
-- delivery and out-of-town zones, promo codes and public holidays. Amounts are minor units of the
-- business's base currency, entered as the business enters prices (tax inclusive or not).
-- Nothing here is deleted: rows are deactivated, since quotes and bookings point at them.

create table vehicle_classes (
  id                uuid primary key default uuidv7(),
  code              citext not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name              text not null check (length(name) between 1 and 80),
  description       text check (description is null or length(description) <= 500),
  min_driver_age    smallint check (min_driver_age between 16 and 99),
  min_licence_years smallint check (min_licence_years between 0 and 60),
  sort              integer not null default 1000,
  active            boolean not null default true,
  created_by        uuid references users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table vehicles add column rental_class_id uuid references vehicle_classes (id);
create index vehicles_rental_class_idx on vehicles (rental_class_id)
  where rental_class_id is not null and deleted_at is null;

create table rental_rate_plans (
  id                          uuid primary key default uuidv7(),
  code                        citext not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name                        text not null check (length(name) between 1 and 120),
  class_id                    uuid references vehicle_classes (id),
  vehicle_id                  uuid references vehicles (id),
  branch_id                   uuid references branches (id),
  customer_id                 uuid references customers (id),
  currency                    char(3) not null,
  hourly_minor                bigint check (hourly_minor > 0),
  daily_minor                 bigint not null check (daily_minor > 0),
  weekend_daily_minor         bigint check (weekend_daily_minor > 0),
  weekly_minor                bigint check (weekly_minor > 0),
  monthly_minor               bigint check (monthly_minor > 0),
  min_hours                   smallint not null default 1 check (min_hours between 1 and 23),
  -- Both null: unlimited mileage.
  included_km_per_day         integer check (included_km_per_day between 1 and 10000),
  extra_km_minor              bigint check (extra_km_minor >= 0),
  chauffeur_daily_minor       bigint check (chauffeur_daily_minor > 0),
  chauffeur_overnight_minor   bigint check (chauffeur_overnight_minor >= 0),
  chauffeur_out_of_town_minor bigint check (chauffeur_out_of_town_minor >= 0),
  -- Null: the business's default sales tax code.
  tax_code                    text,
  valid_from                  date,
  valid_to                    date,
  active                      boolean not null default true,
  notes                       text check (notes is null or length(notes) <= 2000),
  created_by                  uuid references users (id),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  check (num_nonnulls(class_id, vehicle_id) = 1),
  check ((included_km_per_day is null) = (extra_km_minor is null)),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create index rental_rate_plans_class_idx on rental_rate_plans (class_id) where class_id is not null;
create index rental_rate_plans_vehicle_idx on rental_rate_plans (vehicle_id)
  where vehicle_id is not null;

create table rental_rate_seasons (
  id                 uuid primary key default uuidv7(),
  plan_id            uuid not null references rental_rate_plans (id) on delete cascade,
  name               text not null check (length(name) between 1 and 80),
  starts_on          date not null,
  ends_on            date not null,
  adjustment_percent numeric(5, 2) not null check (adjustment_percent between -90 and 500),
  check (ends_on >= starts_on)
);

create index rental_rate_seasons_plan_idx on rental_rate_seasons (plan_id, starts_on);

create table rental_extras (
  id               uuid primary key default uuidv7(),
  code             citext not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name             text not null check (length(name) between 1 and 80),
  description      text check (description is null or length(description) <= 500),
  category         text not null check (category in ('equipment', 'insurance', 'driver',
                     'service', 'other')),
  charge           text not null check (charge in ('per_day', 'per_rental')),
  price_minor      bigint not null check (price_minor >= 0),
  max_charge_minor bigint check (max_charge_minor >= 0),
  max_quantity     smallint not null default 1 check (max_quantity between 1 and 20),
  tax_code         text,
  -- Empty: every class.
  class_ids        uuid[] not null default '{}',
  sort             integer not null default 1000,
  active           boolean not null default true,
  created_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (max_charge_minor is null or charge = 'per_day')
);

create table rental_zones (
  id                      uuid primary key default uuidv7(),
  name                    citext not null unique check (length(name) between 1 and 80),
  delivery_fee_minor      bigint not null default 0 check (delivery_fee_minor >= 0),
  collection_fee_minor    bigint not null default 0 check (collection_fee_minor >= 0),
  out_of_town_daily_minor bigint not null default 0 check (out_of_town_daily_minor >= 0),
  active                  boolean not null default true,
  created_by              uuid references users (id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table rental_promo_codes (
  id               uuid primary key default uuidv7(),
  code             citext not null unique check (code ~ '^[A-Z0-9]{3,20}$'),
  description      text check (description is null or length(description) <= 500),
  discount_percent numeric(5, 2) check (discount_percent between 1 and 100),
  discount_minor   bigint check (discount_minor > 0),
  valid_from       date,
  valid_to         date,
  min_days         smallint check (min_days between 1 and 365),
  max_uses         integer check (max_uses >= 1),
  -- Counted when a booking uses the code (P5-3).
  used_count       integer not null default 0 check (used_count >= 0),
  class_ids        uuid[] not null default '{}',
  active           boolean not null default true,
  created_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (num_nonnulls(discount_percent, discount_minor) = 1),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

-- The business's public holidays (priced at the weekend rate when the settings say so).
create table public_holidays (
  id         uuid primary key default uuidv7(),
  date       date not null unique,
  name       text not null check (length(name) between 1 and 80),
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);
