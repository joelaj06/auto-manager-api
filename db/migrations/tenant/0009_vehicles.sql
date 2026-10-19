-- Vehicles (P2-2, docs/06, docs/05 §2.3): the vehicle register with its lifecycle status and
-- history, compliance documents with expiry, odometer readings, photos and groups. Rentals,
-- assignments, sales and work-and-pay move vehicles through their states in later packages.

create table vehicle_groups (
  id          uuid primary key default uuidv7(),
  name        citext not null unique check (length(name) between 1 and 80),
  description text check (description is null or length(description) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table vehicles (
  id                      uuid primary key default uuidv7(),
  code                    text not null unique,
  -- As shown on the plate ("GR 1234-21"); stock awaiting registration may have none.
  plate_number            text,
  -- Letters and digits only, for uniqueness and search ("GR123421").
  plate_key               text,
  vin                     text check (vin is null or vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  engine_number           text,
  chassis_number          text,
  -- Platform catalogue ids (no foreign key: another database) plus the names at the time.
  make_id                 uuid,
  make                    text not null check (length(make) between 1 and 80),
  model_id                uuid,
  model                   text not null check (length(model) between 1 and 80),
  trim                    text,
  year                    smallint check (year between 1950 and 2100),
  colour                  text,
  body_type               text check (body_type in ('saloon', 'hatchback', 'suv', 'pickup',
                            'van', 'minibus', 'bus', 'truck', 'motorbike', 'tricycle', 'other')),
  fuel_type               text check (fuel_type in ('petrol', 'diesel', 'hybrid', 'electric',
                            'lpg', 'cng', 'other')),
  transmission            text check (transmission in ('manual', 'automatic', 'cvt', 'other')),
  engine_cc               integer check (engine_cc between 1 and 20000),
  seats                   smallint check (seats between 1 and 100),
  doors                   smallint check (doors between 0 and 10),
  drive                   text check (drive in ('2wd', '4wd', 'awd')),
  mileage_unit            text not null default 'km' check (mileage_unit in ('km', 'mi')),
  current_odometer        integer check (current_odometer >= 0),
  odometer_read_at        timestamptz,
  status                  text not null check (status in ('incoming', 'reconditioning',
                            'available', 'assigned', 'in_maintenance', 'for_sale', 'reserved',
                            'sold', 'reserved_rental', 'on_rent', 'on_workpay', 'transferred',
                            'repossessed', 'accident', 'impounded', 'stolen', 'written_off',
                            'retired', 'scrapped')),
  status_changed_at       timestamptz not null default now(),
  usage                   text not null default 'fleet'
                            check (usage in ('fleet', 'rental', 'workpay', 'stock', 'personal')),
  ownership_type          text not null default 'owned' check (ownership_type in
                            ('owned', 'financed', 'leased', 'consigned', 'driver_owned')),
  ownership_note          text,
  branch_id               uuid not null references branches (id),
  acquisition_date        date,
  -- Minor units of the business's base currency (financials are hidden without permission).
  acquisition_cost_minor  bigint check (acquisition_cost_minor >= 0),
  residual_value_minor    bigint check (residual_value_minor >= 0),
  depreciation_method     text not null default 'none'
                            check (depreciation_method in ('none', 'straight_line')),
  useful_life_months      integer check (useful_life_months between 1 and 600),
  primary_photo_file_id   uuid references files (id),
  tags                    text[] not null default '{}',
  specs                   jsonb not null default '{}'::jsonb,
  custom_fields           jsonb not null default '{}'::jsonb,
  notes                   text,
  created_by              uuid references users (id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- Removed entries are kept (with the reason) and hidden; their plate and VIN become free.
  deleted_at              timestamptz,
  deleted_reason          text,
  check ((plate_number is null) = (plate_key is null)),
  check ((deleted_at is null) = (deleted_reason is null)),
  check (depreciation_method = 'none' or (useful_life_months is not null
           and acquisition_cost_minor is not null and acquisition_date is not null))
);

create unique index vehicles_plate_key_idx on vehicles (plate_key)
  where plate_key is not null and deleted_at is null;
create unique index vehicles_vin_idx on vehicles (vin) where vin is not null and deleted_at is null;
create index vehicles_branch_status_idx on vehicles (branch_id, status) where deleted_at is null;
create index vehicles_listing_idx on vehicles (created_at desc, id desc) where deleted_at is null;

create table vehicle_group_members (
  vehicle_id uuid not null references vehicles (id),
  group_id   uuid not null references vehicle_groups (id) on delete cascade,
  primary key (vehicle_id, group_id)
);

create index vehicle_group_members_group_idx on vehicle_group_members (group_id);

-- Every status change (docs/06 §3): who, why, and which record caused it (a rental, a deal …).
create table vehicle_status_history (
  id          uuid primary key default uuidv7(),
  vehicle_id  uuid not null references vehicles (id),
  from_status text,
  to_status   text not null,
  reason      text,
  ref_type    text,
  ref_id      uuid,
  changed_by  uuid references users (id),
  changed_at  timestamptz not null default now(),
  check ((ref_type is null) = (ref_id is null))
);

create index vehicle_status_history_vehicle_idx on vehicle_status_history (vehicle_id, changed_at desc);

-- Compliance documents (docs/06 §4); scans are files owned by the document. A renewal is a new
-- document of the same type, the old one stays as history.
create table vehicle_documents (
  id            uuid primary key default uuidv7(),
  vehicle_id    uuid not null references vehicles (id),
  type          text not null check (type in ('registration', 'roadworthy', 'insurance',
                  'income_tax_sticker', 'permit', 'customs', 'other')),
  title         text check (title is null or length(title) <= 120),
  number        text,
  provider      text,
  issued_on     date,
  expires_on    date,
  cost_minor    bigint check (cost_minor >= 0),
  reminder_days integer[] not null default '{}',
  notes         text,
  created_by    uuid references users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (expires_on is null or issued_on is null or expires_on >= issued_on)
);

create index vehicle_documents_vehicle_idx on vehicle_documents (vehicle_id, type, expires_on desc);
create index vehicle_documents_expiry_idx on vehicle_documents (expires_on) where expires_on is not null;

-- Odometer readings (docs/06 §5): increasing over time, unless the odometer was replaced.
create table odometer_readings (
  id          uuid primary key default uuidv7(),
  vehicle_id  uuid not null references vehicles (id),
  value       integer not null check (value >= 0),
  read_at     timestamptz not null,
  source      text not null default 'manual' check (source in ('manual', 'import', 'rental',
                'fuel', 'service', 'inspection', 'assignment', 'telematics')),
  ref_id      uuid,
  -- A new odometer starts again from its own value (the reason is required).
  replacement boolean not null default false,
  note        text,
  recorded_by uuid references users (id),
  created_at  timestamptz not null default now(),
  check (not replacement or note is not null)
);

create index odometer_readings_vehicle_idx on odometer_readings (vehicle_id, read_at desc);
