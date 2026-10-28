-- Incidents, insurance claims, traffic offences and fuel anomalies (docs/06 §7–8; P6-4).

-- What insurers pay back; fines have their own expense category.
insert into ledger_accounts (code, name, type, system_key) values
  ('4910', 'Insurance recoveries', 'income', 'insurance_recoveries')
on conflict (code) do nothing;
insert into expense_categories (code, name, is_system, sort)
values ('fines', 'Fines & penalties', true, 96)
on conflict (code) do nothing;

-- An accident, a theft, an impound or anything else that happened to a vehicle.
create table incidents (
  id                 uuid primary key default uuidv7(),
  number             text not null unique,
  vehicle_id         uuid not null references vehicles (id),
  branch_id          uuid not null references branches (id),
  -- Who had the vehicle (default: its open assignment's driver then).
  driver_id          uuid references drivers (id),
  type               text not null check (type in ('accident', 'theft', 'impound', 'vandalism',
                       'fire', 'flood', 'other')),
  severity           text not null default 'minor' check (severity in ('minor', 'major', 'total_loss')),
  status             text not null default 'open' check (status in ('open', 'closed')),
  occurred_at        timestamptz not null,
  location           text check (location is null or length(location) <= 300),
  description        text not null check (length(description) between 3 and 4000),
  injuries           boolean not null default false,
  police_report_no   text check (police_report_no is null or length(police_report_no) <= 80),
  police_station     text check (police_station is null or length(police_station) <= 120),
  -- Others involved: [{name, phone, plateNumber, insurer, policyNo, notes}].
  third_parties      jsonb not null default '[]' check (jsonb_typeof(third_parties) = 'array'),
  issue_id           uuid references vehicle_issues (id),
  damage_id          uuid references vehicle_damages (id),
  -- The status the vehicle was moved into, and the one it left (put back on closing).
  vehicle_status     text,
  status_before      text,
  closed_at          timestamptz,
  closed_by          uuid references users (id),
  outcome            text check (outcome is null or length(outcome) <= 2000),
  created_by         uuid references users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((status = 'closed') = (closed_at is not null))
);

create index incidents_vehicle_idx on incidents (vehicle_id, occurred_at desc);
create index incidents_branch_status_idx on incidents (branch_id, status);
create index incidents_driver_idx on incidents (driver_id) where driver_id is not null;

-- Work orders and expenses that came from an incident (its cost).
alter table work_orders add column incident_id uuid references incidents (id);
create index work_orders_incident_idx on work_orders (incident_id) where incident_id is not null;
alter table expenses add column incident_id uuid references incidents (id);
create index expenses_incident_idx on expenses (incident_id) where incident_id is not null;

-- A claim on an insurer for an incident, and what the insurer paid.
create table insurance_claims (
  id                    uuid primary key default uuidv7(),
  incident_id           uuid not null references incidents (id),
  insurer_id            uuid not null references suppliers (id),
  policy_no             text check (policy_no is null or length(policy_no) <= 80),
  claim_no              text check (claim_no is null or length(claim_no) <= 80),
  status                text not null default 'submitted' check (status in ('submitted', 'approved',
                          'rejected', 'settled', 'withdrawn')),
  claimed_minor         bigint not null check (claimed_minor > 0),
  excess_minor          bigint not null default 0 check (excess_minor >= 0),
  approved_minor        bigint check (approved_minor >= 0),
  settled_minor         bigint check (settled_minor > 0),
  settled_on            date,
  settlement_method     text check (settlement_method in ('bank_transfer', 'momo', 'cheque')),
  settlement_reference  text check (settlement_reference is null or length(settlement_reference) <= 80),
  submitted_on          date not null,
  decided_at            timestamptz,
  reason                text check (reason is null or length(reason) <= 1000),
  notes                 text check (notes is null or length(notes) <= 2000),
  created_by            uuid references users (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check ((status = 'settled') = (settled_minor is not null))
);

create index insurance_claims_incident_idx on insurance_claims (incident_id);
create index insurance_claims_status_idx on insurance_claims (status);
-- One live claim per incident and insurer.
create unique index insurance_claims_live_idx on insurance_claims (incident_id, insurer_id)
  where status in ('submitted', 'approved');

-- A traffic offence on a vehicle (speeding, parking …) and its fine.
create table traffic_offences (
  id              uuid primary key default uuidv7(),
  vehicle_id      uuid not null references vehicles (id),
  branch_id       uuid not null references branches (id),
  driver_id       uuid references drivers (id),
  type            text not null check (type in ('speeding', 'red_light', 'parking', 'overloading',
                    'no_documents', 'dangerous_driving', 'other')),
  offence_at      timestamptz not null,
  location        text check (location is null or length(location) <= 300),
  authority       text not null check (length(authority) between 2 and 120),
  notice_ref      text check (notice_ref is null or length(notice_ref) <= 80),
  fine_minor      bigint not null check (fine_minor >= 0),
  due_on          date,
  -- Who pays the fine (decided when it is paid or before).
  driver_pays     boolean not null default true,
  status          text not null default 'unpaid' check (status in ('unpaid', 'contested',
                    'paid', 'waived')),
  paid_on         date,
  paid_by         text check (paid_by in ('business', 'driver')),
  expense_id      uuid references expenses (id),
  notes           text check (notes is null or length(notes) <= 2000),
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check ((status = 'paid') = (paid_on is not null))
);

create index traffic_offences_vehicle_idx on traffic_offences (vehicle_id, offence_at desc);
create index traffic_offences_driver_idx on traffic_offences (driver_id, offence_at desc)
  where driver_id is not null;
create index traffic_offences_status_idx on traffic_offences (branch_id, status);
create unique index traffic_offences_notice_idx on traffic_offences (authority, notice_ref)
  where notice_ref is not null;

-- A fill that looks wrong: far fewer km per litre than the vehicle's usual, or no km since the
-- last full fill.
create table fuel_anomalies (
  id               uuid primary key default uuidv7(),
  fuel_log_id      uuid not null unique references fuel_logs (id),
  vehicle_id       uuid not null references vehicles (id),
  branch_id        uuid not null references branches (id),
  driver_id        uuid references drivers (id),
  kind             text not null check (kind in ('low_efficiency', 'no_distance')),
  km_per_litre     numeric(8, 2),
  baseline         numeric(8, 2),
  litres           numeric(9, 2) not null,
  distance         integer not null,
  status           text not null default 'open' check (status in ('open', 'confirmed', 'dismissed')),
  reviewed_by      uuid references users (id),
  reviewed_at      timestamptz,
  note             text check (note is null or length(note) <= 1000),
  created_at       timestamptz not null default now()
);

create index fuel_anomalies_branch_status_idx on fuel_anomalies (branch_id, status);
create index fuel_anomalies_vehicle_idx on fuel_anomalies (vehicle_id, created_at desc);
