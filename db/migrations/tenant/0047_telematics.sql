-- Telematics and GPS (P9-4, docs/06 §9): providers push positions to the business's ingestion
-- address, each tracker is linked to a vehicle, and the positions drive trips, engine hours
-- (utilisation from ignition), over-speed events, geofence alerts and odometer sync.
-- Plain tables, no PostGIS or TimescaleDB: positions are kept for the days set and purged daily,
-- trips, daily totals and events are kept (decisions 504–509).

create table telematics_settings (
  id                     boolean primary key default true check (id),
  position_retention_days integer not null default 180 check (position_retention_days between 30 and 730),
  overspeed_kmh          integer not null default 100 check (overspeed_kmh between 30 and 250),
  overspeed_min_seconds  integer not null default 30 check (overspeed_min_seconds between 0 and 600),
  working_hours_per_day  numeric(4, 1) not null default 10 check (working_hours_per_day between 1 and 24),
  silent_after_hours     integer not null default 24 check (silent_after_hours between 1 and 720),
  updated_by             uuid references users (id),
  updated_at             timestamptz not null default now()
);
insert into telematics_settings default values;

-- A provider account pushing positions: its secret token is kept only as a hash.
create table telematics_connections (
  id               uuid primary key default uuidv7(),
  name             citext not null unique check (length(name) between 2 and 80),
  provider         text not null check (provider in ('generic', 'flespi', 'traccar')),
  token_hash       text not null unique,
  token_hint       text not null,
  status           text not null default 'active' check (status in ('active', 'disabled')),
  last_received_at timestamptz,
  accepted_count   bigint not null default 0,
  rejected_count   bigint not null default 0,
  last_error       text check (length(last_error) <= 500),
  created_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- A tracker, known by its identifier at the provider (IMEI, ident, unique id), on one vehicle.
create table telematics_devices (
  id                 uuid primary key default uuidv7(),
  connection_id      uuid not null references telematics_connections (id),
  identifier         text not null check (length(identifier) between 1 and 64),
  label              text check (length(label) <= 80),
  vehicle_id         uuid references vehicles (id),
  status             text not null default 'active' check (status in ('active', 'retired')),
  sync_odometer      boolean not null default true,
  -- Added to the tracker's odometer to match the dashboard's.
  odometer_offset_km numeric(10, 1) not null default 0,
  last_position_at   timestamptz,
  last_received_at   timestamptz,
  last_latitude      numeric(9, 6),
  last_longitude     numeric(9, 6),
  last_speed_kmh     numeric(6, 1),
  last_heading       smallint,
  last_ignition      boolean,
  last_odometer_km   numeric(10, 1),
  -- The trip under way and the over-speed spell, if any.
  trip_id            uuid,
  overspeed_since    timestamptz,
  overspeed_max_kmh  numeric(6, 1),
  silent_notified_at timestamptz,
  created_by         uuid references users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (connection_id, identifier)
);
create unique index telematics_devices_vehicle_idx on telematics_devices (vehicle_id)
  where status = 'active' and vehicle_id is not null;
create index telematics_devices_vehicle_all_idx on telematics_devices (vehicle_id)
  where vehicle_id is not null;

-- Every position received; the same tracker and time is kept once (providers resend).
create table telematics_positions (
  id           uuid primary key default uuidv7(),
  device_id    uuid not null references telematics_devices (id),
  vehicle_id   uuid references vehicles (id),
  recorded_at  timestamptz not null,
  received_at  timestamptz not null default now(),
  latitude     numeric(9, 6) not null check (latitude between -90 and 90),
  longitude    numeric(9, 6) not null check (longitude between -180 and 180),
  speed_kmh    numeric(6, 1) not null default 0 check (speed_kmh >= 0),
  heading      smallint check (heading between 0 and 359),
  ignition     boolean,
  odometer_km  numeric(10, 1) check (odometer_km >= 0),
  attributes   jsonb not null default '{}',
  unique (device_id, recorded_at)
);
create index telematics_positions_vehicle_idx on telematics_positions (vehicle_id, recorded_at desc)
  where vehicle_id is not null;
create index telematics_positions_time_brin on telematics_positions using brin (recorded_at);
alter table telematics_positions set (autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02);

-- A trip: ignition on to ignition off (or a long silence).
create table telematics_trips (
  id                uuid primary key default uuidv7(),
  device_id         uuid not null references telematics_devices (id),
  vehicle_id        uuid references vehicles (id),
  driver_id         uuid references drivers (id),
  started_at        timestamptz not null,
  ended_at          timestamptz,
  start_latitude    numeric(9, 6) not null,
  start_longitude   numeric(9, 6) not null,
  end_latitude      numeric(9, 6),
  end_longitude     numeric(9, 6),
  distance_m        numeric(12, 1) not null default 0 check (distance_m >= 0),
  moving_seconds    integer not null default 0 check (moving_seconds >= 0),
  idle_seconds      integer not null default 0 check (idle_seconds >= 0),
  max_speed_kmh     numeric(6, 1) not null default 0,
  positions         integer not null default 1,
  start_odometer_km numeric(10, 1),
  end_odometer_km   numeric(10, 1),
  last_position_at  timestamptz not null,
  check (ended_at is null or ended_at >= started_at)
);
create index telematics_trips_vehicle_idx on telematics_trips (vehicle_id, started_at desc);
create index telematics_trips_device_idx on telematics_trips (device_id, started_at desc);
create index telematics_trips_driver_idx on telematics_trips (driver_id, started_at desc)
  where driver_id is not null;
create index telematics_trips_open_idx on telematics_trips (last_position_at) where ended_at is null;

-- Engine hours, moving and idle time and distance per vehicle and local day.
create table telematics_daily (
  vehicle_id      uuid not null references vehicles (id),
  day             date not null,
  engine_seconds  integer not null default 0,
  moving_seconds  integer not null default 0,
  idle_seconds    integer not null default 0,
  distance_m      numeric(12, 1) not null default 0,
  trips           integer not null default 0,
  max_speed_kmh   numeric(6, 1) not null default 0,
  overspeed_events integer not null default 0,
  primary key (vehicle_id, day)
);
create index telematics_daily_day_idx on telematics_daily (day);

-- Areas to watch: a circle or a polygon, for one branch's vehicles or all of them.
create table geofences (
  id          uuid primary key default uuidv7(),
  name        citext not null unique check (length(name) between 2 and 80),
  kind        text not null check (kind in ('circle', 'polygon')),
  latitude    numeric(9, 6),
  longitude   numeric(9, 6),
  radius_m    integer check (radius_m between 50 and 500000),
  points      jsonb,
  branch_id   uuid references branches (id),
  alert_on    text not null default 'exit' check (alert_on in ('enter', 'exit', 'both')),
  active      boolean not null default true,
  created_by  uuid references users (id),
  updated_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check ((kind = 'circle') = (latitude is not null and longitude is not null and radius_m is not null)),
  check ((kind = 'polygon') = (points is not null))
);
create index geofences_branch_idx on geofences (branch_id) where branch_id is not null;

-- Whether each tracker was last seen inside each geofence.
create table telematics_geofence_states (
  device_id   uuid not null references telematics_devices (id),
  geofence_id uuid not null references geofences (id),
  inside      boolean not null,
  since       timestamptz not null,
  primary key (device_id, geofence_id)
);
create index telematics_geofence_states_geofence_idx on telematics_geofence_states (geofence_id);

-- What happened on the road: geofence entries and exits, and over-speed spells.
create table telematics_events (
  id              uuid primary key default uuidv7(),
  kind            text not null check (kind in ('geofence_enter', 'geofence_exit', 'overspeed')),
  device_id       uuid not null references telematics_devices (id),
  vehicle_id      uuid not null references vehicles (id),
  branch_id       uuid not null references branches (id),
  driver_id       uuid references drivers (id),
  geofence_id     uuid references geofences (id),
  started_at      timestamptz not null,
  ended_at        timestamptz,
  latitude        numeric(9, 6) not null,
  longitude       numeric(9, 6) not null,
  speed_kmh       numeric(6, 1) not null default 0,
  max_speed_kmh   numeric(6, 1),
  limit_kmh       integer,
  acknowledged_by uuid references users (id),
  acknowledged_at timestamptz,
  note            text check (length(note) <= 500),
  created_at      timestamptz not null default now(),
  check ((kind = 'overspeed') = (limit_kmh is not null)),
  check ((kind = 'overspeed') = (geofence_id is null)),
  check ((acknowledged_at is null) = (acknowledged_by is null))
);
create index telematics_events_time_idx on telematics_events (started_at desc);
create index telematics_events_vehicle_idx on telematics_events (vehicle_id, started_at desc);
create index telematics_events_branch_idx on telematics_events (branch_id, started_at desc);
create index telematics_events_device_idx on telematics_events (device_id);
create index telematics_events_driver_idx on telematics_events (driver_id) where driver_id is not null;
create index telematics_events_geofence_idx on telematics_events (geofence_id)
  where geofence_id is not null;
create index telematics_events_open_idx on telematics_events (started_at desc)
  where acknowledged_at is null;
