-- Vehicle assignments (P2-4, docs/06 §6, docs/09 §2.1): which driver has which vehicle, when,
-- on which remittance terms, with the handover checklist and odometer at both ends.
-- Decision 9: one driver per vehicle at a time.

create table vehicle_assignments (
  id                 uuid primary key default uuidv7(),
  vehicle_id         uuid not null references vehicles (id),
  driver_id          uuid not null references drivers (id),
  -- The vehicle's branch when the assignment started (reports, scope of history).
  branch_id          uuid not null references branches (id),
  type               text not null check (type in ('remittance', 'salary', 'chauffeur', 'workpay')),
  remittance_mode    text not null check (remittance_mode in ('fixed_target', 'variable', 'none')),
  -- Minor units of the base currency per period.
  target_minor       bigint check (target_minor > 0),
  target_frequency   text check (target_frequency in ('daily', 'weekly', 'monthly')),
  -- Days without a target for daily targets (0 = Sunday … 6 = Saturday).
  days_off           smallint[] not null default '{}',
  started_at         timestamptz not null,
  start_odometer     integer not null check (start_odometer >= 0),
  -- { items: [{ key, label, ok, note }], fuelLevel, notes, driverAcknowledged }
  start_checklist    jsonb not null,
  started_by         uuid references users (id),
  ended_at           timestamptz,
  end_odometer       integer check (end_odometer >= 0),
  end_checklist      jsonb,
  end_reason         text,
  ended_by           uuid references users (id),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((remittance_mode = 'fixed_target') = (target_minor is not null and target_frequency is not null)),
  check ((ended_at is null) = (end_odometer is null)),
  check ((ended_at is null) = (end_checklist is null)),
  check (ended_at is null or ended_at > started_at),
  check (end_odometer is null or end_odometer >= start_odometer),
  -- Two assignments of the same vehicle (or driver) never overlap in time.
  constraint vehicle_assignments_vehicle_no_overlap exclude using gist
    (vehicle_id with =, tstzrange(started_at, ended_at, '[)') with &&),
  constraint vehicle_assignments_driver_no_overlap exclude using gist
    (driver_id with =, tstzrange(started_at, ended_at, '[)') with &&)
);

-- Decision 9: at most one open assignment per vehicle and per driver.
create unique index vehicle_assignments_open_vehicle_idx on vehicle_assignments (vehicle_id)
  where ended_at is null;
create unique index vehicle_assignments_open_driver_idx on vehicle_assignments (driver_id)
  where ended_at is null;
create index vehicle_assignments_vehicle_idx on vehicle_assignments (vehicle_id, started_at desc);
create index vehicle_assignments_driver_idx on vehicle_assignments (driver_id, started_at desc);
create index vehicle_assignments_open_idx on vehicle_assignments (branch_id) where ended_at is null;
